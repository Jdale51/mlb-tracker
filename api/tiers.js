const { put, list } = require('@vercel/blob');

// In-memory caches — rebuild on write, short TTL on read
let acesCache = { data: null, loadedAt: 0 };
let lineupCache = { data: null, loadedAt: 0 };
let bullpenCache = { data: null, loadedAt: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 min

let acesBlobUrl = null;
let lineupBlobUrl = null;
let bullpenBlobUrl = null;

const EMPTY_ACES = { updated: null, pitchers: {} }; // { "Pitcher Name": "tier1" | "tier2" | "tier3" | "tier4" | "tier5" }
// Tier system (5-tier, established 2026-04-27):
//   tier1 = Elite ace (Cy Young candidates, sub-1.10 WHIP)
//   tier2 = Strong #2 (1.10-1.20 WHIP, sub-3.50 ERA)
//   tier3 = Average MLB starter (true neutral)
//   tier4 = Below-average / fragile (volatile arms, 1.30-1.45 WHIP) — DEFAULT for unrated
//   tier5 = Soft starter (replacement-level, WHIP >=1.45)
// Legacy 'default' is treated as 'tier4' on read until explicitly upgraded by admin.
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
      if (action === 'backfill-history') {
        // Walk every beta-results-{date}.json blob, join with game-outcomes-{date}.json
        // to recover starter names, then look up the CURRENT tier in aces.json
        // and write it back to the beta blob.
        //
        // Per Jordan's 2026-04-27 spec: preserve 'tier1' historical values
        // (they're still T1 in the new system) but rewrite empty/'tier2'/'default'
        // values to whatever the pitcher's current tier is in aces.json.
        // Untouched if the matchup can't be resolved to a starter name.
        const aces = await readAces();
        const pitcherTiers = aces.pitchers || {};
        const { blobs } = await list();
        const betaBlobs = blobs.filter(b => /^beta-results-\d{4}-\d{2}-\d{2}\.json$/.test(b.pathname));
        const outcomesBlobs = {};
        for (const b of blobs) {
          const m = b.pathname.match(/^game-outcomes-(\d{4}-\d{2}-\d{2})\.json$/);
          if (m) outcomesBlobs[m[1]] = b;
        }

        let datesProcessed = 0, datesSkipped = 0, gamesUpdated = 0, gamesUnchanged = 0, gamesNoMatch = 0;
        const dryRun = req.query?.dryRun === '1';
        const PRESERVE_VALUES = new Set(['tier1']); // never overwrite — already correct
        const REWRITE_VALUES = new Set(['', 'tier2', 'default', null, undefined, 'tier3']); // upgrade from old system
        // Note: we explicitly DO want to rewrite legacy 'tier3' (which used to mean "default")
        // — those rows were tagged with a legacy label that has different meaning now.

        for (const betaBlob of betaBlobs) {
          const dateMatch = betaBlob.pathname.match(/(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) { datesSkipped++; continue; }
          const date = dateMatch[1];
          const outBlob = outcomesBlobs[date];
          if (!outBlob) { datesSkipped++; continue; }

          try {
            const [betaRes, outRes] = await Promise.all([
              fetch(`${betaBlob.url}?t=${Date.now()}`),
              fetch(`${outBlob.url}?t=${Date.now()}`),
            ]);
            if (!betaRes.ok || !outRes.ok) { datesSkipped++; continue; }
            const betaData = await betaRes.json();
            const outData = await outRes.json();

            // Build matchup → starter names lookup from outcomes
            const starterByMatchup = {};
            for (const o of (outData.games || [])) {
              starterByMatchup[o.matchup] = {
                away: o.pitching?.away?.starter?.name || null,
                home: o.pitching?.home?.starter?.name || null,
              };
            }

            let dirty = false;
            for (const g of (betaData.games || [])) {
              const starters = starterByMatchup[g.matchup];
              if (!starters) { gamesNoMatch++; continue; }
              let touched = false;
              for (const side of ['away', 'home']) {
                const tierKey = side + 'Tier';
                const currentVal = g[tierKey];
                if (PRESERVE_VALUES.has(currentVal)) continue;
                if (!REWRITE_VALUES.has(currentVal)) continue;
                const pitcherName = starters[side];
                if (!pitcherName) continue;
                const newTier = pitcherTiers[pitcherName] || 'tier4';
                if (newTier !== currentVal) {
                  g[tierKey] = newTier;
                  touched = true;
                  dirty = true;
                }
              }
              if (touched) gamesUpdated++; else gamesUnchanged++;
            }

            if (dirty && !dryRun) {
              await put(betaBlob.pathname, JSON.stringify(betaData), {
                access: 'public', addRandomSuffix: false, contentType: 'application/json',
              });
            }
            datesProcessed++;
          } catch(e) {
            console.error(`backfill ${date} error:`, e.message);
            datesSkipped++;
          }
        }

        return res.status(200).json({
          ok: true, dryRun,
          datesProcessed, datesSkipped,
          gamesUpdated, gamesUnchanged, gamesNoMatch,
        });
      }

      if (action === 'migrate-tiers') {
        // One-time migration: convert all 'default' tiers in aces.json to 'tier4'.
        // Safe to run multiple times — only touches pitchers still on legacy values.
        const aces = await readAces();
        const pitchers = { ...(aces.pitchers || {}) };
        let migrated = 0;
        for (const name of Object.keys(pitchers)) {
          if (pitchers[name] === 'default' || !pitchers[name]) {
            pitchers[name] = 'tier4';
            migrated++;
          }
        }
        const updated = { updated: new Date().toISOString().split('T')[0], pitchers };
        await writeAces(updated);
        return res.status(200).json({ ok: true, migrated, total: Object.keys(pitchers).length });
      }

      if (action === 'sync') {
        // Sync new starters from MLB API into the aces list with "default" tier
        const season = req.query?.season || new Date().getFullYear();
        const starters = await fetchAllStarters(season);
        const aces = await readAces();
        const pitchers = { ...(aces.pitchers || {}) };
        let added = 0;
        for (const s of starters) {
          if (!(s.name in pitchers)) {
            // New unrated starters land in tier4 (below-avg/fragile) by default,
            // matching the empirical T3-default population from the 3-tier era.
            pitchers[s.name] = 'tier4';
            added++;
          }
        }
        const updated = { updated: new Date().toISOString().split('T')[0], pitchers };
        await writeAces(updated);
        // Also send back the full starter list with their tiers so admin can render
        const enriched = starters.map(s => ({
          ...s,
          tier: pitchers[s.name] || 'tier4',
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
        // Accept any of the 5 tiers. Legacy 'default' aliases to tier4 on write
        // so admin POSTs from older UI builds don't silently drop pitchers.
        const VALID_TIERS = ['tier1', 'tier2', 'tier3', 'tier4', 'tier5'];
        let normalized = tier === 'default' ? 'tier4' : tier;
        if (!VALID_TIERS.includes(normalized)) {
          return res.status(400).json({ error: 'Invalid tier' });
        }
        const aces = await readAces();
        const pitchers = { ...(aces.pitchers || {}) };
        pitchers[pitcherName] = normalized;
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
