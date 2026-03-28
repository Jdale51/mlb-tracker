const { put, get } = require('@vercel/blob');

const ODDS_API_KEY = 'aef1c06336685a4a20c89a57d3f56262';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;
const GRAND_SALAMI_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american&eventType=grand_salami`;

let cache = { data: null, grandSalami: null, fetchedAt: 0 };

function getCacheTTL() {
  const pstHour = ((new Date().getUTCHours() - 8) + 24) % 24;
  if (pstHour >= 23 || pstHour < 9) return Infinity;
  if (pstHour >= 9 && pstHour < 16) return 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function getTodayPST() {
  const pstOffset = -8 * 60;
  const pst = new Date(Date.now() + pstOffset * 60000);
  return pst.toISOString().split('T')[0];
}

function filterToday(data) {
  const todayPST = getTodayPST();
  const pstOffset = -8 * 60;
  return data.filter(game => {
    const gamePST = new Date(new Date(game.commence_time).getTime() + pstOffset * 60000);
    return gamePST.toISOString().split('T')[0] === todayPST;
  });
}

function extractGrandSalami(data) {
  // Grand Salami appears as a special event in the odds API
  // It's often listed under sport_key baseball_mlb with home_team/away_team as "Over"/"Under"
  // or as a separate entry with title containing "Grand Salami"
  for (const event of data) {
    const title = (event.sport_title || '').toLowerCase();
    const home = (event.home_team || '').toLowerCase();
    const away = (event.away_team || '').toLowerCase();
    if (title.includes('salami') || home.includes('salami') || away.includes('salami') ||
        home.includes('over') || away.includes('over')) {
      const books = event.bookmakers || [];
      const dk = books.find(b => b.key === 'draftkings') || books[0];
      if (!dk) continue;
      const mkt = dk.markets.find(m => m.key === 'totals');
      if (!mkt) continue;
      const ov = mkt.outcomes.find(o => o.name === 'Over');
      const un = mkt.outcomes.find(o => o.name === 'Under');
      if (ov && un) return { line: ov.point, overPrice: ov.price, underPrice: un.price, book: dk.title };
    }
  }
  return null;
}

async function saveRecord(record) {
  try {
    const today = getTodayPST();
    const key = `history.json`;
    let history = [];
    try {
      const existing = await get(key);
      if (existing) {
        const text = await existing.text();
        history = JSON.parse(text);
      }
    } catch(e) { history = []; }

    // Update or insert today's record
    const idx = history.findIndex(r => r.date === today);
    if (idx >= 0) history[idx] = { ...history[idx], ...record };
    else history.push(record);

    await put(key, JSON.stringify(history), { access: 'public', addRandomSuffix: false });
  } catch(e) {
    console.error('Failed to save record:', e);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  // Handle record update from client (called when day is complete)
  if (req.method === 'POST') {
    const { date, actualRuns, result } = req.body || {};
    if (date && actualRuns !== undefined) {
      await saveRecord({ date, actualRuns, result });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Missing fields' });
  }

  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  const cacheValid = cache.data && age < ttl;

  if (cacheValid) {
    res.setHeader('X-Cache', `HIT - ${Math.round(age / 60000)}m old`);
    res.setHeader('X-Fetched-At', cache.fetchedAt);
    return res.status(200).json({ games: filterToday(cache.data), grandSalami: cache.grandSalami });
  }

  try {
    const upstream = await fetch(ODDS_URL);
    if (!upstream.ok) throw new Error(`Odds API ${upstream.status}`);
    const data = await upstream.json();
    const grandSalami = extractGrandSalami(data);
    cache = { data, grandSalami, fetchedAt: Date.now() };

    // Save today's pregame record to blob
    const today = getTodayPST();
    const todayGames = filterToday(data);
    if (todayGames.length > 0) {
      const naiveTotal = todayGames.reduce((sum, g) => {
        const bk = (g.bookmakers || []).find(b => b.key === 'draftkings') || (g.bookmakers || [])[0];
        if (!bk) return sum;
        const mkt = (bk.markets || []).find(m => m.key === 'totals');
        const ov = mkt && mkt.outcomes.find(o => o.name === 'Over');
        return sum + (ov ? ov.point : 0);
      }, 0);
      await saveRecord({
        date: today,
        grandSalamLine: grandSalami ? grandSalami.line : null,
        naiveTotal: parseFloat(naiveTotal.toFixed(2)),
        gamesOnSlate: todayGames.length,
        actualRuns: null,
        result: null,
      });
    }

    res.setHeader('X-Cache', 'MISS - fresh fetch');
    res.setHeader('X-Fetched-At', cache.fetchedAt);
    return res.status(200).json({ games: filterToday(data), grandSalami });
  } catch (err) {
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE - upstream error');
      res.setHeader('X-Fetched-At', cache.fetchedAt);
      return res.status(200).json({ games: filterToday(cache.data), grandSalami: cache.grandSalami });
    }
    return res.status(500).json({ error: err.message });
  }
};
