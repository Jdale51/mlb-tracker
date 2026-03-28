const { list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    const { blobs } = await list();
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) return res.status(200).json({ pregameLines: {} });

    const response = await fetch(blob.url);
    const history = await response.json();

    const pst = new Date(Date.now() + -7 * 60 * 60000);
    const today = pst.toISOString().split('T')[0];

    const todayRecord = history.find(r => r.date === today);
    return res.status(200).json({
      date: today,
      pregameLines: todayRecord?.pregameLines || {}
    });
  } catch(e) {
    console.error('Lines error:', e.message);
    return res.status(200).json({ pregameLines: {} });
  }
};
