const { list, head } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    const { blobs } = await list({ token: process.env.BLOB_READ_WRITE_TOKEN });
    console.log('Blobs found:', blobs.map(b => b.pathname));
    const blob = blobs.find(b => b.pathname === 'history.json');
    if (!blob) {
      console.log('No history.json found');
      return res.status(200).json([]);
    }
    const { downloadUrl } = await head(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const response = await fetch(downloadUrl || blob.url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
    });
    const text = await response.text();
    console.log('History:', text);
    const history = JSON.parse(text);
    return res.status(200).json(history.sort((a,b) => b.date.localeCompare(a.date)));
  } catch(e) {
    console.error('History error:', e.message);
    return res.status(200).json([]);
  }
};
