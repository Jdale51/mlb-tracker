// Vercel serverless function — odds proxy with time-aware PST caching
// Sits between the app and The Odds API so no CORS issues and credits are conserved

const ODDS_API_KEY = 'aef1c06336685a4a20c89a57d3f56262';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;

// Simple in-memory cache (persists across warm invocations on same Vercel instance)
let cache = { data: null, fetchedAt: 0 };

function getCacheTTL() {
  // All times in PST (UTC-8). Using UTC hours to determine PST hour.
  const nowUTC = new Date();
  const pstHour = ((nowUTC.getUTCHours() - 8) + 24) % 24;

  if (pstHour >= 23 || pstHour < 9) {
    // Dead zone: 11pm–9am PST — never refresh, serve whatever we have
    return Infinity;
  } else if (pstHour >= 9 && pstHour < 16) {
    // Pregame: 9am–4pm PST — refresh every 60 minutes
    return 60 * 60 * 1000;
  } else {
    // Live window: 4pm–11pm PST — refresh every 15 minutes
    return 15 * 60 * 1000;
  }
}

export default async function handler(req, res) {
  // Allow requests from any origin (our app on Vercel or CodePen)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const ttl = getCacheTTL();
  const age = Date.now() - cache.fetchedAt;
  const cacheValid = cache.data && age < ttl;

  if (cacheValid) {
    const ageMin = Math.round(age / 60000);
    res.setHeader('X-Cache', `HIT - ${ageMin}m old`);
    return res.status(200).json(cache.data);
  }

  // Dead zone but no cache yet — fetch once to populate
  try {
    const upstream = await fetch(ODDS_URL);
    if (!upstream.ok) throw new Error(`Odds API responded ${upstream.status}`);
    const data = await upstream.json();
    cache = { data, fetchedAt: Date.now() };
    res.setHeader('X-Cache', 'MISS - fresh fetch');
    return res.status(200).json(data);
  } catch (err) {
    // If fetch fails but we have stale cache, return it rather than erroring
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE - upstream error');
      return res.status(200).json(cache.data);
    }
    return res.status(500).json({ error: err.message });
  }
}
