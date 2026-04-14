const { put, list } = require('@vercel/blob');

const ODDS_KEYS = [
  'aef1c06336685a4a20c89a57d3f56262', // key 1
  'bfe46983fa21466f8f89042dcc9b77d9', // key 2
  'e7dce86e70cf94b32d45eb9c1f2847fb', // key 3
];
let keyIndex = 0; // persists within same server instance, alternates each fetch

function getOddsUrl() {
  const key = ODDS_KEYS[keyIndex % ODDS_KEYS.length];
  keyIndex++;
  return `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals&oddsFormat=american`;
}

let cache = { data: null, grandSalami: null, fetchedAt: 0 };
// In-memory history cache — avoids repeated blob reads
let historyCache = { data: null, loadedAt: 0 };
const HISTORY_CACHE_MS = 24 * 60 * 60 * 1000; // cache all day — only changes on explicit POST

function getCacheTTL() {
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  const pstMin  = new Date().getUTCMinutes();
  const pstTime = pstHour + pstMin / 60; // e.g. 5:30 = 5.5

  if (pstTime >= 22.5 || pstTime < 5.5)  return 3 * 60 * 60 * 1000;   // 10:30pm–5:30am  → 3hr
  if (pstTime >= 5.5  && pstTime < 10)   return 60 * 60 * 1000;        // 5:30am–10am     → 1hr
  if (pstTime >= 10   && pstTime < 16)   return 30 * 60 * 1000;        // 10am–4pm        → 30min
  return 15 * 60 * 1000;                                                // 4pm–10:30pm     → 15min
}

function getSecondsUntilNext() {
  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  return Math.max(0, Math.ceil((ttl - age) / 1000));
}

function getTodayPDT() {
  const pst = new Date(Date.now() + -7 * 60 * 60000);
  return pst.toISOString().split('T')[0];
}

function filterToday(data) {
  const todayPDT = getTodayPDT();
  return data.filter(game => {
    const gamePDT = new Date(new Date(game.commence_time).getTime() + -7 * 60 * 60000);
    return gamePDT.toISOString().split('T')[0] === todayPDT;
  });
}

// Cached blob URL — avoids list() on every request
let blobUrl = null;

async function getBlobUrl() {
  if (blobUrl) return blobUrl;
  const { blobs } = await list();
  const blob = blobs.find(b => b.pathname === 'history.json');
  if (blob) blobUrl = blob.url;
  return blobUrl;
}

async function readHistory(forceRefresh = false) {
  const age = Date.now() - historyCache.loadedAt;
  if (!forceRefresh && historyCache.data && age < HISTORY_CACHE_MS) {
    return historyCache.data;
  }
  try {
    const url = await getBlobUrl();
    if (!url) return [];
    // Cache-bust to bypass CDN and always get fresh data from blob storage
    const res = await fetch(`${url}?t=${Date.now()}`);
    const data = await res.json();
    historyCache = { data, loadedAt: Date.now() };
    return data;
  } catch(e) {
    console.error('readHistory error:', e.message);
    return historyCache.data || [];
  }
}

async function writeHistory(history) {
  const result = await put('history.json', JSON.stringify(history), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  // Cache the URL so we never need to list() again
  if (result && result.url) blobUrl = result.url;
  // Update in-memory cache after write
  historyCache = { data: history, loadedAt: Date.now() };
}

async function saveRecord(record) {
  try {
    let history = await readHistory(true); // always fresh on write
    history = history.filter(r => r.date !== record.date);
    history.push(record);
    await writeHistory(history);
  } catch(e) {
    console.error('Failed to save record:', e.message);
  }
}

async function getTodayGrandSalami() {
  try {
    const history = await readHistory();
    const today = getTodayPDT();
    const todayRecord = history.find(r => r.date === today);
    if (todayRecord && todayRecord.grandSalamLine) {
      return {
        line: todayRecord.grandSalamLine,
        overPrice: todayRecord.gsOverPrice || null,
        underPrice: todayRecord.gsUnderPrice || null,
        book: todayRecord.gsBook || 'DraftKings'
      };
    }
    return null;
  } catch(e) { return null; }
}

async function getTodayRecord() {
  try {
    const history = await readHistory();
    return history.find(r => r.date === getTodayPDT()) || null;
  } catch(e) { return null; }
}

function buildPregameLines(todayGames) {
  // Build key->line map from raw odds data
  // key format: "awaylastname-homelastname" e.g. "yankees-giants"
  const lines = {};
  for (const g of todayGames) {
    const hk = g.home_team.split(' ').pop().toLowerCase();
    const ak = g.away_team.split(' ').pop().toLowerCase();
    const key = `${ak}-${hk}`;
    const bk = (g.bookmakers || []).find(b => b.key === 'draftkings') || (g.bookmakers || [])[0];
    if (!bk) continue;
    const mkt = (bk.markets || []).find(m => m.key === 'totals');
    if (!mkt) continue;
    const ov = mkt.outcomes.find(o => o.name === 'Over');
    const un = mkt.outcomes.find(o => o.name === 'Under');
    if (ov && un) {
      lines[key] = {
        line: ov.point,
        overPrice: ov.price,
        underPrice: un.price,
        book: bk.title
      };
    }
  }
  return lines;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Content-Type', 'application/json');

  // POST: save fields to today's record
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { date, actualRuns, result, grandSalamLine, naiveTotal, gamesOnSlate,
              gsOverPrice, gsUnderPrice, gsBook, todayPick, units,
              gsNotifiedBooks } = body || {};
      if (date) {
        let history = await readHistory(true); // force refresh on POST
        const existing = history.find(r => r.date === date) || {};
        await saveRecord({
          ...existing,
          date,
          ...(actualRuns !== undefined && { actualRuns }),
          ...(result !== undefined && { result }),
          ...(grandSalamLine !== undefined && { grandSalamLine }),
          ...(naiveTotal !== undefined && { naiveTotal }),
          ...(gamesOnSlate !== undefined && { gamesOnSlate }),
          ...(gsOverPrice !== undefined && { gsOverPrice }),
          ...(gsUnderPrice !== undefined && { gsUnderPrice }),
          ...(gsBook !== undefined && { gsBook }),
          ...(todayPick !== undefined && { todayPick }),
          ...(units !== undefined && { units }),
          ...(gsNotifiedBooks !== undefined && { gsNotifiedBooks }),
        });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Missing date' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET: return odds + check if pregame lines need saving
  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  const cacheValid = cache.data && age < ttl;

  if (cacheValid) {
    res.setHeader('X-Cache', `HIT - ${Math.round(age / 60000)}m old`);
    const gs = cache.grandSalami || await getTodayGrandSalami();
    const todayRec = await getTodayRecord();
    return res.status(200).json({
      games: filterToday(cache.data),
      grandSalami: gs,
      todayPick: todayRec?.todayPick || null,
      todayUnits: todayRec?.units || null,
      secondsUntilNext: getSecondsUntilNext(),
      oddsLastFetched: cache.fetchedAt || todayRec?.oddsLastFetched || null,
    });
  }

  try {
    const upstream = await fetch(getOddsUrl());
    if (!upstream.ok) throw new Error(`Odds API ${upstream.status}`);
    const data = await upstream.json();
    cache = { data, grandSalami: null, fetchedAt: Date.now() };

    const todayGames = filterToday(data);

    if (todayGames.length > 0) {
      const today = getTodayPDT();
      let history = await readHistory();
      const existing = history.find(r => r.date === today) || {};

      const naive = todayGames.reduce((sum, g) => {
        const bk = (g.bookmakers || []).find(b => b.key === 'draftkings') || (g.bookmakers || [])[0];
        if (!bk) return sum;
        const mkt = (bk.markets || []).find(m => m.key === 'totals');
        const ov = mkt && mkt.outcomes.find(o => o.name === 'Over');
        return sum + (ov ? ov.point : 0);
      }, 0);

      // Only save pregame lines if not already set for today
      // This preserves the opening line even as live lines move
      const pregameLines = existing.pregameLines && Object.keys(existing.pregameLines).length > 0
        ? existing.pregameLines
        : buildPregameLines(todayGames);

      await saveRecord({
        ...existing,
        date: today,
        // Only save naiveTotal and gamesOnSlate if not already set — preserves morning values
        naiveTotal: existing.naiveTotal ?? parseFloat(naive.toFixed(2)),
        gamesOnSlate: existing.gamesOnSlate ?? todayGames.length,
        pregameLines,
        actualRuns: existing.actualRuns ?? null,
        result: existing.result ?? null,
        oddsLastFetched: cache.fetchedAt,
      });
    }

    const gs = await getTodayGrandSalami();
    res.setHeader('X-Cache', 'MISS - fresh fetch');
    return res.status(200).json({
      games: filterToday(data),
      grandSalami: gs,
      secondsUntilNext: getSecondsUntilNext(),
      oddsLastFetched: cache.fetchedAt
    });
  } catch (err) {
    if (cache.data) {
      const gs = cache.grandSalami || await getTodayGrandSalami();
      const todayRec = await getTodayRecord();
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({
        games: filterToday(cache.data),
        grandSalami: gs,
        todayPick: todayRec?.todayPick || null,
        todayUnits: todayRec?.units || null,
        secondsUntilNext: getSecondsUntilNext(),
        oddsLastFetched: cache.fetchedAt || todayRec?.oddsLastFetched || null,
      });
    }
    return res.status(500).json({ error: err.message });
  }
};
