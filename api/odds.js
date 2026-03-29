const { put, list } = require('@vercel/blob');

const ODDS_API_KEY = 'aef1c06336685a4a20c89a57d3f56262';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;

let cache = { data: null, grandSalami: null, fetchedAt: 0 };
// In-memory history cache — avoids repeated blob reads
let historyCache = { data: null, loadedAt: 0 };
const HISTORY_CACHE_MS = 24 * 60 * 60 * 1000; // cache all day — only changes on explicit POST

function getCacheTTL() {
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  if (pstHour >= 23 || pstHour < 7) return Infinity;
  if (pstHour >= 7 && pstHour < 16) return 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function getSecondsUntilNext() {
  const ttl = getCacheTTL();
  if (ttl === Infinity) return Infinity;
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

async function readHistory(forceRefresh = false) {
  const age = Date.now() - historyCache.loadedAt;
  if (!forceRefresh && historyCache.data && age < HISTORY_CACHE_MS) {
    return historyCache.data;
  }
  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) return [];
    const res = await fetch(blob.url);
    const data = await res.json();
    historyCache = { data, loadedAt: Date.now() };
    return data;
  } catch(e) {
    console.error('readHistory error:', e.message);
    return historyCache.data || [];
  }
}

async function writeHistory(history) {
  await put('history.json', JSON.stringify(history), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  // Update in-memory cache after write
  historyCache = { data: history, loadedAt: Date.now() };
}

async function saveRecord(record) {
  try {
    let history = await readHistory();
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

  // POST: save actual runs + result
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { date, actualRuns, result, grandSalamLine, naiveTotal, gamesOnSlate,
              gsOverPrice, gsUnderPrice, gsBook } = body || {};
      if (date) {
        let history = await readHistory();
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
    return res.status(200).json({
      games: filterToday(cache.data),
      grandSalami: gs,
      secondsUntilNext: getSecondsUntilNext(),
      oddsLastFetched: cache.fetchedAt
    });
  }

  try {
    const upstream = await fetch(ODDS_URL);
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
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({
        games: filterToday(cache.data),
        grandSalami: gs,
        secondsUntilNext: getSecondsUntilNext(),
        oddsLastFetched: cache.fetchedAt
      });
    }
    return res.status(500).json({ error: err.message });
  }
};
