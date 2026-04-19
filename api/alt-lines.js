const { put, list } = require('@vercel/blob');

// Reuse the same rotating keys as odds.js
const ODDS_KEYS = [
  'aef1c06336685a4a20c89a57d3f56262',
  'bfe46983fa21466f8f89042dcc9b77d9',
  'e7dce86e70cf94b32d45eb9c1f2847fb',
];
let keyIndex = 0;

function nextKey() {
  const k = ODDS_KEYS[keyIndex % ODDS_KEYS.length];
  keyIndex++;
  return k;
}

const BOOK = 'draftkings';
const BLOB_NAME = 'alt-lines.json';

// In-memory cache
let cache = { data: null, loadedAt: 0 };
let blobUrl = null;
const CACHE_MS = 30 * 60 * 1000; // 30 min

function getTodayPDT(offsetDays = 0) {
  const pst = new Date(Date.now() + -7 * 60 * 60000 + offsetDays * 86400000);
  return pst.toISOString().split('T')[0];
}

function filterForDate(data, targetDate) {
  return data.filter(game => {
    const gamePDT = new Date(new Date(game.commence_time).getTime() + -7 * 60 * 60000);
    return gamePDT.toISOString().split('T')[0] === targetDate;
  });
}

// American odds -> implied probability (no vig removal)
function americanToImplied(price) {
  if (price == null) return null;
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

// De-vig a two-way market (Over/Under at same point)
function devig(overPrice, underPrice) {
  const po = americanToImplied(overPrice);
  const pu = americanToImplied(underPrice);
  if (po == null || pu == null) return { overFair: null, underFair: null };
  const sum = po + pu;
  return { overFair: po / sum, underFair: pu / sum };
}

async function getBlobUrl() {
  if (blobUrl) return blobUrl;
  const { blobs } = await list();
  const blob = blobs.find(b => b.pathname === BLOB_NAME);
  if (blob) blobUrl = blob.url;
  return blobUrl;
}

async function readStored() {
  try {
    const url = await getBlobUrl();
    if (!url) return null;
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[alt-lines] readStored error:', e.message);
    return null;
  }
}

async function writeStored(payload) {
  const result = await put(BLOB_NAME, JSON.stringify(payload), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  if (result && result.url) blobUrl = result.url;
}

// Fetch event IDs (free - does NOT cost credits)
async function fetchEvents() {
  const key = nextKey();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Events API ${res.status}`);
  return res.json();
}

// Fetch alt totals for a single event (1 credit each)
async function fetchAltForEvent(eventId) {
  const key = nextKey();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${key}&regions=us&markets=alternate_totals&oddsFormat=american&bookmakers=${BOOK}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Alt API ${res.status} for ${eventId}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

// Extract DK alt ladder from event response
function extractLadder(eventData) {
  const bk = (eventData.bookmakers || []).find(b => b.key === BOOK);
  if (!bk) return null;
  const mkt = (bk.markets || []).find(m => m.key === 'alternate_totals');
  if (!mkt) return null;

  // Group outcomes by point
  const byPoint = {};
  for (const o of mkt.outcomes || []) {
    const p = o.point;
    if (p == null) continue;
    if (!byPoint[p]) byPoint[p] = {};
    if (o.name === 'Over') byPoint[p].over = o.price;
    if (o.name === 'Under') byPoint[p].under = o.price;
  }

  const ladder = Object.keys(byPoint)
    .map(p => parseFloat(p))
    .sort((a, b) => a - b)
    .map(p => {
      const row = byPoint[p];
      const { overFair, underFair } = devig(row.over, row.under);
      return {
        point: p,
        overPrice: row.over ?? null,
        underPrice: row.under ?? null,
        overImplied: americanToImplied(row.over),
        underImplied: americanToImplied(row.under),
        overFair,
        underFair,
      };
    });

  return {
    book: bk.title,
    lastUpdate: mkt.last_update || bk.last_update || null,
    ladder,
  };
}

// Main pull: events → per-game alts → structured payload
async function pullAltLines(targetDate) {
  const startedAt = Date.now();
  const allEvents = await fetchEvents();
  const todayEvents = filterForDate(allEvents, targetDate);

  const games = [];
  const errors = [];

  for (const ev of todayEvents) {
    try {
      const eventData = await fetchAltForEvent(ev.id);
      const alts = extractLadder(eventData);
      games.push({
        eventId: ev.id,
        away: ev.away_team,
        home: ev.home_team,
        commenceTime: ev.commence_time,
        alts, // { book, lastUpdate, ladder } or null
      });
    } catch (e) {
      errors.push({ eventId: ev.id, away: ev.away_team, home: ev.home_team, error: e.message });
    }
  }

  return {
    date: targetDate,
    fetchedAt: new Date().toISOString(),
    fetchMs: Date.now() - startedAt,
    gameCount: games.length,
    creditsUsed: games.length + errors.length, // 1 credit per per-event call attempted
    errorCount: errors.length,
    errors,
    games,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Content-Type', 'application/json');

  const isRefresh = req.method === 'POST' || (req.query && req.query.refresh === 'true');
  const target = (req.query && req.query.date) || getTodayPDT();

  // If cache is fresh and not a forced refresh, return it
  if (!isRefresh && cache.data && (Date.now() - cache.loadedAt) < CACHE_MS) {
    if (cache.data.date === target) {
      res.setHeader('X-Cache', `HIT - ${Math.round((Date.now() - cache.loadedAt) / 60000)}m`);
      return res.status(200).json(cache.data);
    }
  }

  // If not refresh, try stored blob first
  if (!isRefresh) {
    const stored = await readStored();
    if (stored && stored.date === target) {
      cache = { data: stored, loadedAt: Date.now() };
      res.setHeader('X-Cache', 'BLOB');
      return res.status(200).json(stored);
    }
  }

  // Pull fresh
  try {
    const payload = await pullAltLines(target);
    await writeStored(payload);
    cache = { data: payload, loadedAt: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[alt-lines] pull error:', e.message);
    // Fall back to stored if pull failed
    const stored = await readStored();
    if (stored) {
      return res.status(200).json({ ...stored, warning: `Fresh pull failed: ${e.message}` });
    }
    return res.status(500).json({ error: e.message });
  }
};
