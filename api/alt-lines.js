const { put, list } = require('@vercel/blob');

// Single API key (rotation disabled)
const ODDS_KEY = '5171b7947460f7f15abb11c465180901';

function nextKey() {
  return ODDS_KEY;
}

// Canonical team abbreviations — mirrors admin.html EXPORT_ABBR
const EXPORT_ABBR = {
  'New York Yankees': 'NYY', 'San Francisco Giants': 'SF', 'Athletics': 'ATH',const { put, list } = require('@vercel/blob');

// Single API key (rotation disabled)
const ODDS_KEY = '5171b7947460f7f15abb11c465180901';

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

// Preferred book order — API returns all that have data; we extract the first
// one in this list that actually has an alt ladder populated. Including
// multiple books in one request does NOT increase credit cost (up to 10 books
// still counts as 1 region per the Odds API pricing rules).
const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars'];
const BOOK_PARAM = BOOKS.join(',');
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

// Fetch alt totals for a single event (1 credit each — multi-book still 1 credit)
async function fetchAltForEvent(eventId) {
  const key = nextKey();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${key}&regions=us&markets=alternate_totals&oddsFormat=american&bookmakers=${BOOK_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Alt API ${res.status} for ${eventId}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

// Fetch main totals for ALL games in a single batched call (1 credit total).
// The alt ladder omits each book's current main line (e.g. DK's 7.5 gets
// published via the `totals` market, not `alternate_totals`), so we need a
// separate call to surface it in the displayed ladder. Returns a map:
//   eventId -> { byBook: { [bookKey]: { point, overPrice, underPrice, lastUpdate, title } } }
async function fetchMainLinesMap() {
  const key = nextKey();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals&oddsFormat=american&bookmakers=${BOOK_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Main totals API ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const g of (data || [])) {
    const byBook = {};
    for (const bk of (g.bookmakers || [])) {
      const mkt = (bk.markets || []).find(m => m.key === 'totals');
      if (!mkt) continue;
      const ov = (mkt.outcomes || []).find(o => o.name === 'Over');
      const un = (mkt.outcomes || []).find(o => o.name === 'Under');
      if (ov && un && ov.point != null) {
        byBook[bk.key] = {
          point: ov.point,
          overPrice: ov.price,
          underPrice: un.price,
          lastUpdate: mkt.last_update || bk.last_update || null,
          title: bk.title,
        };
      }
    }
    if (Object.keys(byBook).length) map[g.id] = { byBook };
  }
  return map;
}

// Pick the main line from the byBook map using BOOKS order, but prefer the
// book whose alt ladder we used for this game (so the MAIN row is consistent
// with the rest of the ladder).
function pickMainLine(mainRaw, preferredBookKey) {
  if (!mainRaw || !mainRaw.byBook) return null;
  const order = preferredBookKey
    ? [preferredBookKey, ...BOOKS.filter(b => b !== preferredBookKey)]
    : BOOKS;
  for (const k of order) {
    if (mainRaw.byBook[k]) return { ...mainRaw.byBook[k], bookKey: k };
  }
  return null;
}

// Extract alt ladder from event response, preferring DK but falling back to
// FanDuel (and further) if DK hasn't posted the market yet. Returns the first
// book in BOOKS order that has a non-empty ladder.
function extractLadder(eventData) {
  const bookmakers = eventData.bookmakers || [];

  for (const bookKey of BOOKS) {
    const bk = bookmakers.find(b => b.key === bookKey);
    if (!bk) continue;
    const mkt = (bk.markets || []).find(m => m.key === 'alternate_totals');
    if (!mkt || !mkt.outcomes || !mkt.outcomes.length) continue;

    // Group outcomes by point
    const byPoint = {};
    for (const o of mkt.outcomes) {
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

    if (!ladder.length) continue;

    return {
      book: bk.title,
      bookKey: bk.key,
      lastUpdate: mkt.last_update || bk.last_update || null,
      ladder,
    };
  }

  return null;
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

  // Batch main lines in one call (1 credit total). Don't fail the whole pull
  // if this errors — we can still render alt ladders without main-line data.
  let mainLinesMap = {};
  let mainLineCredits = 0;
  let mainLineError = null;
  try {
    mainLinesMap = await fetchMainLinesMap();
    mainLineCredits = 1;
  } catch (e) {
    mainLineError = e.message;
    console.error('[alt-lines] main lines fetch failed:', e.message);
  }

  const games = [];
  const errors = [];

  for (const ev of todayEvents) {
    try {
      const eventData = await fetchAltForEvent(ev.id);
      const alts = extractLadder(eventData);
      const awayAbbr = exportAbbr(ev.away_team);
      const homeAbbr = exportAbbr(ev.home_team);
      // Prefer the main line from the same book whose alt ladder we ended up
      // using so the MAIN row is consistent with the rest of the ladder.
      const mainRaw = mainLinesMap[ev.id] || null;
      const picked = pickMainLine(mainRaw, alts?.bookKey);
      const mainLine = picked ? (() => {
        const { overFair, underFair } = devig(picked.overPrice, picked.underPrice);
        return {
          point: picked.point,
          overPrice: picked.overPrice,
          underPrice: picked.underPrice,
          overImplied: americanToImplied(picked.overPrice),
          underImplied: americanToImplied(picked.underPrice),
          overFair,
          underFair,
          lastUpdate: picked.lastUpdate,
          book: picked.title,
          bookKey: picked.bookKey,
        };
      })() : null;
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
        mainLine, // { point, overPrice, underPrice, overFair, underFair, book, bookKey, ... } or null
        alts,    // { book, bookKey, lastUpdate, ladder } or null
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
    creditsUsed: games.length + errors.length + mainLineCredits,
    errorCount: errors.length,
    mainLineError,
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

// Preferred book order — API returns all that have data; we extract the first
// one in this list that actually has an alt ladder populated. Including
// multiple books in one request does NOT increase credit cost (up to 10 books
// still counts as 1 region per the Odds API pricing rules).
const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars'];
const BOOK_PARAM = BOOKS.join(',');
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

// Fetch alt totals for a single event (1 credit each — multi-book still 1 credit)
async function fetchAltForEvent(eventId) {
  const key = nextKey();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${key}&regions=us&markets=alternate_totals&oddsFormat=american&bookmakers=${BOOK_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Alt API ${res.status} for ${eventId}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

// Extract alt ladder from event response, preferring DK but falling back to
// FanDuel (and further) if DK hasn't posted the market yet. Returns the first
// book in BOOKS order that has a non-empty ladder.
function extractLadder(eventData) {
  const bookmakers = eventData.bookmakers || [];

  for (const bookKey of BOOKS) {
    const bk = bookmakers.find(b => b.key === bookKey);
    if (!bk) continue;
    const mkt = (bk.markets || []).find(m => m.key === 'alternate_totals');
    if (!mkt || !mkt.outcomes || !mkt.outcomes.length) continue;

    // Group outcomes by point
    const byPoint = {};
    for (const o of mkt.outcomes) {
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

    if (!ladder.length) continue;

    return {
      book: bk.title,
      bookKey: bk.key,
      lastUpdate: mkt.last_update || bk.last_update || null,
      ladder,
    };
  }

  return null;
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
