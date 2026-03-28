const { list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) return res.status(200).json([]);
    const response = await fetch(blob.url);
    const text = await response.text();
    const history = JSON.parse(text);
    return res.status(200).json(history.sort((a,b) => b.date.localeCompare(a.date)));
  } catch(e) {
    console.error('History error:', e.message);
    return res.status(200).json([]);
  }
};
