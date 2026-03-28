const { list, get } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    // List all blobs to find history.json
    const { blobs } = await list();
    const historyBlob = blobs.find(b => b.pathname === 'history.json');
    if (!historyBlob) return res.status(200).json([]);

    // Fetch using the full URL
    const response = await fetch(historyBlob.url);
    const text = await response.text();
    const history = JSON.parse(text);
    return res.status(200).json(history.sort((a,b) => b.date.localeCompare(a.date)));
  } catch(e) {
    console.error('History error:', e);
    return res.status(200).json([]);
  }
};
