// Scheduled at 10:00 UTC = 3:00 AM PDT (Mar-Nov) / 2:00 AM PST (Nov-Mar)
// Pulls alternate totals for today's slate and stores in alt-lines.json blob

const altHandler = require('./alt-lines.js');

module.exports = async function handler(req, res) {
  // Force refresh by proxying through alt-lines.js with refresh=true
  const fakeReq = {
    method: 'GET',
    query: { refresh: 'true' },
  };
  const capturedRes = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await altHandler(fakeReq, capturedRes);
    console.log('[cron-alt-lines] OK', {
      games: capturedRes.body?.gameCount,
      credits: capturedRes.body?.creditsUsed,
      errors: capturedRes.body?.errorCount,
    });
    return res.status(200).json({
      ok: true,
      date: capturedRes.body?.date,
      gameCount: capturedRes.body?.gameCount,
      creditsUsed: capturedRes.body?.creditsUsed,
      errorCount: capturedRes.body?.errorCount,
    });
  } catch (e) {
    console.error('[cron-alt-lines] FAIL', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
