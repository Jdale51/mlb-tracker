const { list } = require('@vercel/blob');

let linesCache = { data: null, loadedAt: 0 };
const CACHE_MS = 24 * 60 * 60 * 1000; // cache all day — lines only saved once in morning
let blobUrl = null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  // Serve from memory if fresh
  const age = Date.now() - linesCache.loadedAt;
  if (linesCache.data && age < CACHE_MS) {
    return res.status(200).json(linesCache.data);
  }

  try {
    // Use cached URL or fetch from list() once
    if (!blobUrl) {
      const { blobs } = await list();
      const blob = blobs.find(b => b.pathname === 'history.json');
      if (!blob) return res.status(200).json({ pregameLines: {} });
      blobUrl = blob.url;
    }

    const response = await fetch(blobUrl);
    const history = await response.json();

    const pst = new Date(Date.now() + -7 * 60 * 60000);
    const today = pst.toISOString().split('T')[0];

    const todayRecord = history.find(r => r.date === today);
    const result = { date: today, pregameLines: todayRecord?.pregameLines || {} };
    linesCache = { data: result, loadedAt: Date.now() };
    return res.status(200).json(result);
  } catch(e) {
    console.error('Lines error:', e.message);
    return res.status(200).json(linesCache.data || { pregameLines: {} });
  }
};
