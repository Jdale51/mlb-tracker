const { put } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { history } = body || {};
    if (!Array.isArray(history)) return res.status(400).json({ error: 'history must be an array' });

    await put('history.json', JSON.stringify(history), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
    return res.status(200).json({ ok: true, records: history.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
