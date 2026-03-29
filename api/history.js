const { list } = require('@vercel/blob');

let historyCache = { data: null, loadedAt: 0 };
const CACHE_MS = 24 * 60 * 60 * 1000; // cache all day — only changes on explicit POST

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const age = Date.now() - historyCache.loadedAt;
  if (historyCache.data && age < CACHE_MS) {
    return res.status(200).json(historyCache.data);
  }

  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) return res.status(200).json([]);
    const response = await fetch(blob.url);
    const text = await response.text();
    const history = JSON.parse(text);
    const sorted = history.sort((a,b) => b.date.localeCompare(a.date));
    historyCache = { data: sorted, loadedAt: Date.now() };
    return res.status(200).json(sorted);
  } catch(e) {
    console.error('History error:', e.message);
    return res.status(200).json(historyCache.data || []);
  }
};
