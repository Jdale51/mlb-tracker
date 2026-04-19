const { put, list } = require('@vercel/blob');

// Single API key (rotation disabled)
const ODDS_KEY = 'aef1c06336685a4a20c89a57d3f56262';

function nextKey() {
  return ODDS_KEY;
}

// Canonical team abbreviations — mirrors admin.html EXPORT_ABBR
const EXPORT_ABBR = {
  'New York Yankees': 'NYY', 'San Francisco Giants': 'SF', 'Athletics': 'ATH',
  'Oakland Athletics': 'ATH', 'Toronto Blue Jays': 'TOR', 'Colorado Rockies': 'COL',
  'Miami Marlins': 'MIA', 'Kansas City Royals': 'KC', 'Atlanta Braves': 'ATL',
  'Los Angeles Angels': 'LAA', 'Houston Astros': 'HOU', 'Detroit Tigers': 'DET',
  'San Diego Padres': 'SD', 'Cleveland Guardians': 'CLE', 'Seattle Mariners': 'SEA',
  'Arizona Diamondbacks': 'AZ', 'Los Angeles Dodgers': 'LAD', 'New York Mets': 'NYM',
  'Chicago Cubs': 'CHC', 'Milwaukee Brewers': 'MIL', 'St. Louis Cardinals': 'STL',
  'Pittsburgh Pirates': 'PIT', 'Chicago White Sox': 'CWS',
  'Washington Nationals': 'WSH', 'Minnesota Twins': 'MIN', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Cincinnati Reds': 'CIN', 'Philadelphia Phillies': 'PHI',
  'Texas Rangers': 'TEX', 'Tampa Bay Rays': 'TB',
};
function exportAbbr(name) {
  return EXPORT_ABBR[name] || (name || '').split(' ').pop().slice(0, 3).toUpperCase();
}

// Outlier thresholds: flag a game if DK implied (de-vigged) fair probability
// clears this bar on either tail.
const OUTLIER_PROB_THRESHOLD = 0.30;
const OVER_TAIL_POINT = 11.5;
const UNDER_TAIL_POINT = 5.5;

const BOOK = 'draftkings';
const BLOB_PREFIX = 'alt-lines-';

function blobNameFor(date) {
  return `${BLOB_PREFIX}${date}.json`;
}

// In-memory cache, keyed by date
let cacheByDate = {}; // { '2026-04-18': { data, loadedAt }, ... }
let blobUrlByDate = {}; // { '2026-04-18': url, ... }
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

async function getBlobUrl(date) {
  if (blobUrlByDate[date]) return blobUrlByDate[date];
  const { blobs } = await list();
  const target = blobNameFor(date);
  const blob = blobs.find(b => b.pathname === target);
  if (blob) blobUrlByDate[date] = blob.url;
  return blobUrlByDate[date];
}

async function readStored(date) {
  try {
    const url = await getBlobUrl(date);
    if (!url) return null;
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[alt-lines] readStored error:', e.message);
    return null;
  }
}

async function writeStored(date, payload) {
  const result = await put(blobNameFor(date), JSON.stringify(payload), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  if (result && result.url) blobUrlByDate[date] = result.url;
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

// Compute Vegas outlier flag given a ladder
// Returns: { isOutlier, outlierType, overProb, underProb }
// outlierType: 'ceiling' | 'floor' | null
function computeOutlierFlag(ladder) {
  if (!ladder || !ladder.length) {
    return { isOutlier: false, outlierType: null, overProb: null, underProb: null };
  }
  const overRow = ladder.find(r => r.point === OVER_TAIL_POINT);
  const underRow = ladder.find(r => r.point === UNDER_TAIL_POINT);

  const overProb = overRow?.overFair ?? null;
  const underProb = underRow?.underFair ?? null;

  const hitsCeiling = overProb != null && overProb >= OUTLIER_PROB_THRESHOLD;
  const hitsFloor = underProb != null && underProb >= OUTLIER_PROB_THRESHOLD;

  // If somehow both flag, pick the stronger one
  let outlierType = null;
  if (hitsCeiling && hitsFloor) {
    outlierType = overProb >= underProb ? 'ceiling' : 'floor';
  } else if (hitsCeiling) {
    outlierType = 'ceiling';
  } else if (hitsFloor) {
    outlierType = 'floor';
  }

  return {
    isOutlier: outlierType != null,
    outlierType,
    overProb,
    underProb,
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
      const awayAbbr = exportAbbr(ev.away_team);
      const homeAbbr = exportAbbr(ev.home_team);
      const outlier = computeOutlierFlag(alts?.ladder);
      games.push({
        eventId: ev.id,
        away: ev.away_team,
        home: ev.home_team,
        awayAbbr,
        homeAbbr,
        matchup: `${awayAbbr}@${homeAbbr}`,
        commenceTime: ev.commence_time,
        outlier, // { isOutlier, outlierType, overProb, underProb }
        alts,    // { book, lastUpdate, ladder } or null
      });
    } catch (e) {
      errors.push({ eventId: ev.id, away: ev.away_team, home: ev.home_team, error: e.message });
    }
  }

  const outliers = games.filter(g => g.outlier?.isOutlier);
  const ceilingCount = outliers.filter(g => g.outlier.outlierType === 'ceiling').length;
  const floorCount = outliers.filter(g => g.outlier.outlierType === 'floor').length;

  return {
    date: targetDate,
    fetchedAt: new Date().toISOString(),
    fetchMs: Date.now() - startedAt,
    gameCount: games.length,
    creditsUsed: games.length + errors.length, // 1 credit per per-event call attempted
    errorCount: errors.length,
    outlierSummary: {
      threshold: OUTLIER_PROB_THRESHOLD,
      overPoint: OVER_TAIL_POINT,
      underPoint: UNDER_TAIL_POINT,
      totalOutliers: outliers.length,
      ceilingCount,
      floorCount,
    },
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
  const cached = cacheByDate[target];
  if (!isRefresh && cached && cached.data && (Date.now() - cached.loadedAt) < CACHE_MS) {
    res.setHeader('X-Cache', `HIT - ${Math.round((Date.now() - cached.loadedAt) / 60000)}m`);
    return res.status(200).json(cached.data);
  }

  // If not refresh, try stored blob first
  if (!isRefresh) {
    const stored = await readStored(target);
    if (stored && stored.date === target) {
      cacheByDate[target] = { data: stored, loadedAt: Date.now() };
      res.setHeader('X-Cache', 'BLOB');
      return res.status(200).json(stored);
    }
  }

  // Pull fresh
  try {
    const payload = await pullAltLines(target);
    await writeStored(target, payload);
    cacheByDate[target] = { data: payload, loadedAt: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[alt-lines] pull error:', e.message);
    // Fall back to stored if pull failed
    const stored = await readStored(target);
    if (stored) {
      return res.status(200).json({ ...stored, warning: `Fresh pull failed: ${e.message}` });
    }
    return res.status(500).json({ error: e.message });
  }
};
