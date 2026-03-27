// Vercel serverless function — odds proxy with time-aware PST caching

const ODDS_API_KEY = 'aef1c06336685a4a20c89a57d3f56262';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;

let cache = { data: null, fetchedAt: 0 };

function getCacheTTL() {
  const nowUTC = new Date();
  const pstHour = ((nowUTC.getUTCHours() - 8) + 24) % 24;
  if (pstHour >= 23 || pstHour < 9) return Infinity;        // dead zone 11pm-9am
  if (pstHour >= 9 && pstHour < 16) return 60 * 60 * 1000; // pregame 1hr
  return 15 * 60 * 1000;                                     // live window 15min
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  const cacheValid = cache.data && age < ttl;

  if (cacheValid) {
    res.setHeader('X-Cache', `HIT - ${Math.round(age / 60000)}m old`);
    return res.status(200).json(cache.data);
  }

  try {
    const upstream = await fetch(ODDS_URL);
    if (!upstream.ok) throw new Error(`Odds API ${upstream.status}`);
    const data = await upstream.json();
    cache = { data, fetchedAt: Date.now() };
    res.setHeader('X-Cache', 'MISS - fresh fetch');
    return res.status(200).json(data);
  } catch (err) {
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE - upstream error');
      return res.status(200).json(cache.data);
    }
    return res.status(500).json({ error: err.message });
  }
};
