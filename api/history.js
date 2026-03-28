const { get } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    const blob = await get('history.json');
    if (!blob) return res.status(200).json([]);
    const text = await blob.text();
    const history = JSON.parse(text);
    // Return sorted newest first
    return res.status(200).json(history.sort((a,b) => b.date.localeCompare(a.date)));
  } catch(e) {
    return res.status(200).json([]);
  }
};
