const { put, list } = require('@vercel/blob');

// In-memory caches — rebuild on write, short TTL on read
let acesCache = { data: null, loadedAt: 0 };
let lineupCache = { data: null, loadedAt: 0 };
let bullpenCache = { data: null, loadedAt: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 min

let acesBlobUrl = null;
let lineupBlobUrl = null;
let bullpenBlobUrl = null;

const EMPTY_ACES = { updated: null, pitchers: {} }; // { "Pitcher Name": "tier1" | "tier2" | "default" }
const EMPTY_LINEUPS = { updated: null, profiles: {} }; // { "NYY": "power_boom_bust" | "balanced" | "contact" }
const EMPTY_BULLPENS = { updated: null, tiers: {} }; // { "NYY": "tier1" | "tier2" | "tier3" }

async function readBlob(filename, cache, setUrl, getUrl, empty) {
  const age = Date.now() - cache.loadedAt;
  if (cache.data && age < CACHE_MS) return cache.data;
  try {
    let url = getUrl();
    if (!url) {
      const { blobs } = await list();
      const blob = blobs.find(b => b.pathname === filename);
      if (!blob) return empty;
      url = blob.url;
      setUrl(url);
    }
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return empty;
    const data = await res.json();
    cache.data = data;
    cache.loadedAt = Date.now();
    return data;
  } catch(e) {
    console.error(`readBlob ${filename} error:`, e.message);
    return cache.data || empty;
  }
}

async function writeBlob(filename, data, cache, setUrl) {
  const result = await put(filename, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  if (result && result.url) setUrl(result.url);
  cache.data = data;
  cache.loadedAt = Date.now();
}

const readAces   = () => readBlob('aces.json', acesCache,
  (u) => { acesBlobUrl = u; }, () => acesBlobUrl, EMPTY_ACES);
const readLineups = () => readBlob('lineup-profiles.json', lineupCache,
  (u) => { lineupBlobUrl = u; }, () => lineupBlobUrl, EMPTY_LINEUPS);
const readBullpens = () => readBlob('bullpen-strength.json', bullpenCache,
  (u) => { bullpenBlobUrl = u; }, () => bullpenBlobUrl, EMPTY_BULLPENS);
const writeAces   = (d) => writeBlob('aces.json', d, acesCache,
  (u) => { acesBlobUrl = u; });
const writeLineups = (d) => writeBlob('lineup-profiles.json', d, lineupCache,
  (u) => { lineupBlobUrl = u; });
const writeBullpens = (d) => writeBlob('bullpen-strength.json', d, bullpenCache,
  (u) => { bullpenBlobUrl = u; });

// Fetch all pitchers with games started this season from MLB Stats API
async function fetchAllStarters(season) {
  try {
    // Pull pitchers with gamesStarted > 0 for the season
    // Using the stats leaders endpoint with a high limit to get everyone
    const url = `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${season}&gameType=R&sportId=1&limit=1000&sortStat=gamesStarted`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits || [];
    const starters = [];
    for (const s of splits) {
      const gs = s.stat?.gamesStarted || 0;
      if (gs > 0) {
        starters.push({
          name: s.player?.fullName || 'Unknown',
          id: s.player?.id,
          team: s.team?.abbreviation || '',
          gamesStarted: gs,
        });
      }
    }
    return starters;
  } catch(e) {
    console.error('fetchAllStarters error:', e.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Content-Type', 'application/json');

  const action = (req.query?.action || '').toLowerCase();

  if (req.method === 'GET') {
    try {
      if (action === 'sync') {
        // Sync new starters from MLB API into the aces list with "default" tier
        const season = req.query?.season || new Date().getFullYear();
        const starters = await fetchAllStarters(season);
        const aces = await readAces();
        const pitchers = { ...(aces.pitchers || {}) };
        let added = 0;
        for (const s of starters) {
          if (!(s.name in pitchers)) {
            pitchers[s.name] = 'default';
            added++;
          }
        }
        const updated = { updated: new Date().toISOString().split('T')[0], pitchers };
        await writeAces(updated);
        // Also send back the full starter list with their tiers so admin can render
        const enriched = starters.map(s => ({
          ...s,
          tier: pitchers[s.name] || 'default',
        }));
        return res.status(200).json({ ok: true, added, total: starters.length, starters: enriched });
      }

      // Default GET: return all three lists
      const [aces, lineups, bullpens] = await Promise.all([readAces(), readLineups(), readBullpens()]);
      return res.status(200).json({ aces, lineups, bullpens });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { type, pitcherName, tier, teamAbbr, profile, bulkAces, bulkLineups } = body || {};

      if (type === 'ace') {
        if (!pitcherName || !tier) return res.status(400).json({ error: 'Missing pitcherName or tier' });
        if (!['tier1', 'tier2', 'default'].includes(tier)) {
          return res.status(400).json({ error: 'Invalid tier' });
        }
        const aces = await readAces();
        const pitchers = { ...(aces.pitchers || {}) };
        pitchers[pitcherName] = tier;
        const updated = { updated: new Date().toISOString().split('T')[0], pitchers };
        await writeAces(updated);
        return res.status(200).json({ ok: true });
      }

      if (type === 'lineup') {
        if (!teamAbbr || !profile) return res.status(400).json({ error: 'Missing teamAbbr or profile' });
        if (!['power_boom_bust', 'balanced', 'contact'].includes(profile)) {
          return res.status(400).json({ error: 'Invalid profile' });
        }
        const lineups = await readLineups();
        const profiles = { ...(lineups.profiles || {}) };
        profiles[teamAbbr] = profile;
        const updated = { updated: new Date().toISOString().split('T')[0], profiles };
        await writeLineups(updated);
        return res.status(200).json({ ok: true });
      }

      if (type === 'bulkAces' && bulkAces) {
        const updated = { updated: new Date().toISOString().split('T')[0], pitchers: bulkAces };
        await writeAces(updated);
        return res.status(200).json({ ok: true });
      }

      if (type === 'bulkLineups' && bulkLineups) {
        const updated = { updated: new Date().toISOString().split('T')[0], profiles: bulkLineups };
        await writeLineups(updated);
        return res.status(200).json({ ok: true });
      }

      if (type === 'bullpen') {
        if (!teamAbbr || !tier) return res.status(400).json({ error: 'Missing teamAbbr or tier' });
        if (!['tier1', 'tier2', 'tier3'].includes(tier)) {
          return res.status(400).json({ error: 'Invalid bullpen tier' });
        }
        const bullpens = await readBullpens();
        const tiers = { ...(bullpens.tiers || {}) };
        tiers[teamAbbr] = tier;
        const updated = { updated: new Date().toISOString().split('T')[0], tiers };
        await writeBullpens(updated);
        return res.status(200).json({ ok: true });
      }

      if (type === 'bulkBullpens' && body.bulkBullpens) {
        const updated = { updated: new Date().toISOString().split('T')[0], tiers: body.bulkBullpens };
        await writeBullpens(updated);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Invalid request' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
