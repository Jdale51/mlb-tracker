/**
 * Game Outcomes Reader — GET-only endpoint for reading game-outcomes-{date}.json blobs.
 *
 * Paired with cron-outcomes.js which writes the blobs. This one only reads them
 * so the Game Log tab can join outcomes with beta-results in the browser.
 *
 * Usage:
 *   GET /api/game-outcomes?date=YYYY-MM-DD → { date, fetchedAt, games: [...] } | null
 */

const { list } = require('@vercel/blob');

// Per-date cache + blob URL cache so we don't list() on every request.
const cache = {}; // { "2026-04-17": { data, loadedAt, url } }
const CACHE_MS = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const date = req.query?.date;
  if (!date) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });

  const entry = cache[date];
  const age = entry ? Date.now() - entry.loadedAt : Infinity;
  if (entry?.data && age < CACHE_MS) {
    return res.status(200).json(entry.data);
  }

  try {
    let url = entry?.url;
    if (!url) {
      const { blobs } = await list();
      const blob = blobs.find(b => b.pathname === `game-outcomes-${date}.json`);
      if (!blob) return res.status(404).json({ error: 'not found', date });
      url = blob.url;
    }
    const r = await fetch(`${url}?t=${Date.now()}`);
    if (!r.ok) return res.status(404).json({ error: 'blob fetch failed', date, status: r.status });
    const data = await r.json();
    cache[date] = { data, loadedAt: Date.now(), url };
    return res.status(200).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message, date });
  }
};
