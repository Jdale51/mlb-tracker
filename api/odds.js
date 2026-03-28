const { put, list } = require('@vercel/blob');

const ODDS_API_KEY = 'aef1c06336685a4a20c89a57d3f56262';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;

let cache = { data: null, grandSalami: null, fetchedAt: 0 };

function getCacheTTL() {
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  if (pstHour >= 23 || pstHour < 9) return Infinity;
  if (pstHour >= 9 && pstHour < 16) return 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function getSecondsUntilNext() {
  const ttl = getCacheTTL();
  if (ttl === Infinity) return Infinity;
  const age = Date.now() - cache.fetchedAt;
  return Math.max(0, Math.ceil((ttl - age) / 1000));
}

function getTodayPST() {
  const pst = new Date(Date.now() + -7 * 60 * 60000);
  return pst.toISOString().split('T')[0];
}

function filterToday(data) {
  const todayPST = getTodayPST();
  return data.filter(game => {
    const gamePST = new Date(new Date(game.commence_time).getTime() + -7 * 60 * 60000);
    return gamePST.toISOString().split('T')[0] === todayPST;
  });
}

async function readHistory() {
  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) return [];
    const res = await fetch(blob.url);
    return await res.json();
  } catch(e) {
    console.error('readHistory error:', e.message);
    return [];
  }
}

async function saveRecord(record) {
  try {
    let history = await readHistory();
    // Remove ALL existing records for this date to prevent duplicates
    history = history.filter(r => r.date !== record.date);
    history.push(record);
    await put('history.json', JSON.stringify(history), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
  } catch(e) {
    console.error('Failed to save record:', e.message);
  }
}

async function getTodayGrandSalami() {
  // Pull Grand Salami from today's history record if API didn't return one
  // Only returns if date matches today — no stale bleed from yesterday
  try {
    const history = await readHistory();
    const today = getTodayPST();
    const todayRecord = history.find(r => r.date === today);
    if (todayRecord && todayRecord.grandSalamLine) {
      return { line: todayRecord.grandSalamLine, overPrice: todayRecord.gsOverPrice || null, underPrice: todayRecord.gsUnderPrice || null, book: todayRecord.gsBook || 'DraftKings' };
    }
    return null;
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { date, actualRuns, result, grandSalamLine, naiveTotal, gamesOnSlate, gsOverPrice, gsUnderPrice, gsBook } = body || {};
      if (date) {
        // Read existing record to merge, don't overwrite fields not included in this POST
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

  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  const cacheValid = cache.data && age < ttl;

  if (cacheValid) {
    res.setHeader('X-Cache', `HIT - ${Math.round(age / 60000)}m old`);
    const gs = cache.grandSalami || await getTodayGrandSalami();
    return res.status(200).json({ games: filterToday(cache.data), grandSalami: gs, secondsUntilNext: getSecondsUntilNext() });
  }

  try {
    const upstream = await fetch(ODDS_URL);
    if (!upstream.ok) throw new Error(`Odds API ${upstream.status}`);
    const data = await upstream.json();
    cache = { data, grandSalami: null, fetchedAt: Date.now() };

    const todayGames = filterToday(data);
    if (todayGames.length > 0) {
      const naive = todayGames.reduce((sum, g) => {
        const bk = (g.bookmakers || []).find(b => b.key === 'draftkings') || (g.bookmakers || [])[0];
        if (!bk) return sum;
        const mkt = (bk.markets || []).find(m => m.key === 'totals');
        const ov = mkt && mkt.outcomes.find(o => o.name === 'Over');
        return sum + (ov ? ov.point : 0);
      }, 0);

      // Read existing today record to preserve grandSalamLine if already set manually
      const history = await readHistory();
      const existing = history.find(r => r.date === getTodayPST()) || {};
      await saveRecord({
        ...existing,
        date: getTodayPST(),
        naiveTotal: parseFloat(naive.toFixed(2)),
        gamesOnSlate: todayGames.length,
        actualRuns: existing.actualRuns ?? null,
        result: existing.result ?? null,
      });
    }

    const gs = await getTodayGrandSalami();
    res.setHeader('X-Cache', 'MISS - fresh fetch');
    return res.status(200).json({ games: filterToday(data), grandSalami: gs, secondsUntilNext: getSecondsUntilNext() });
  } catch (err) {
    if (cache.data) {
      const gs = cache.grandSalami || await getTodayGrandSalami();
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ games: filterToday(cache.data), grandSalami: gs, secondsUntilNext: getSecondsUntilNext() });
    }
    return res.status(500).json({ error: err.message });
  }
};
