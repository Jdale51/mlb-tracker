const { put, list } = require('@vercel/blob');

let cache = {}; // { "2026-04-17": { games: [...], url: "..." } }

async function readForDate(date) {
  if (cache[date]?.games) return cache[date].games;
  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === `park-weather-${date}.json`);
    if (!blob) return [];
    const res = await fetch(`${blob.url}?t=${Date.now()}`);
    if (!res.ok) return [];
    const data = await res.json();
    cache[date] = { games: data.games || [], url: blob.url };
    return data.games || [];
  } catch(e) {
    console.error('park-weather read error:', e.message);
    return [];
  }
}

async function writeForDate(date, games) {
  const result = await put(`park-weather-${date}.json`, JSON.stringify({ date, games }), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  cache[date] = { games, url: result?.url };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const date = req.query?.date || new Date(Date.now() + -7*60*60*1000).toISOString().split('T')[0];

  if (req.method === 'GET') {
    try {
      const games = await readForDate(date);
      return res.status(200).json({ date, games });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { date: bodyDate, games } = body || {};
      const targetDate = bodyDate || date;
      if (!games || !Array.isArray(games)) {
        return res.status(400).json({ error: 'games array required' });
      }
      // Validate each entry — allow p12 as optional numeric field
      const clean = games.filter(g => g.matchup && typeof g.runAdj === 'number').map(g => ({
        matchup: g.matchup,
        runAdj: g.runAdj,
        note: g.note || '',
        p12: typeof g.p12 === 'number' ? g.p12 : null,
      }));
      await writeForDate(targetDate, clean);
      return res.status(200).json({ ok: true, date: targetDate, count: clean.length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
