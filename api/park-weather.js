const { put, list } = require('@vercel/blob');

let bpCache = {};
let betaCache = {};

async function readBlob(pathname, fallback) {
  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === pathname);
    if (!blob) return fallback;
    const res = await fetch(`${blob.url}?t=${Date.now()}`);
    if (!res.ok) return fallback;
    return await res.json();
  } catch(e) {
    console.error(`readBlob ${pathname}:`, e.message);
    return fallback;
  }
}

async function writeBlob(pathname, data) {
  return put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json',
  });
}

async function readBP(date) {
  if (bpCache[date]) return bpCache[date];
  const data = await readBlob(`park-weather-${date}.json`, { games: [] });
  bpCache[date] = data.games || [];
  return bpCache[date];
}

async function writeBP(date, games) {
  const clean = games.filter(g => g.matchup && typeof g.runAdj === 'number').map(g => ({
    matchup: g.matchup, runAdj: g.runAdj, note: g.note || '',
    p12: typeof g.p12 === 'number' ? g.p12 : null,
  }));
  await writeBlob(`park-weather-${date}.json`, { date, games: clean });
  bpCache[date] = clean;
  return clean;
}

async function readBeta(date) {
  if (betaCache[date]) return betaCache[date];
  const data = await readBlob(`beta-results-${date}.json`, null);
  if (data) betaCache[date] = data;
  return data;
}

async function writeBeta(date, payload) {
  await writeBlob(`beta-results-${date}.json`, payload);
  betaCache[date] = payload;
}

async function readOutlierHistory() {
  return readBlob('outlier-history.json', { entries: [] });
}

async function writeOutlierHistory(entries) {
  await writeBlob('outlier-history.json', { entries });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const date = req.query?.date || new Date(Date.now() + -7*60*60*1000).toISOString().split('T')[0];
  const type = req.query?.type || 'bp';

  if (req.method === 'GET') {
    try {
      if (type === 'beta') {
        const data = await readBeta(date);
        return res.status(200).json({ date, betaResults: data });
      }
      if (type === 'outlier-history') {
        const data = await readOutlierHistory();
        return res.status(200).json(data);
      }
      const games = await readBP(date);
      return res.status(200).json({ date, games });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { type: bodyType, date: bodyDate } = body || {};
      const targetDate = bodyDate || date;

      if (bodyType === 'beta') {
        const { gsLine, naive, ceiling, floor, neutral, lean, signal, games } = body;
        await writeBeta(targetDate, {
          date: targetDate, gsLine, naive, ceiling, floor, neutral, lean, signal,
          games, savedAt: new Date().toISOString(),
        });
        return res.status(200).json({ ok: true });
      }

      if (bodyType === 'outlier-history') {
        await writeOutlierHistory(body.entries || []);
        return res.status(200).json({ ok: true });
      }

      // default: BP
      const { games } = body || {};
      if (!games || !Array.isArray(games)) return res.status(400).json({ error: 'games array required' });
      const clean = await writeBP(targetDate, games);
      return res.status(200).json({ ok: true, date: targetDate, count: clean.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
