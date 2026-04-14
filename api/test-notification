/**
 * Test endpoint — forces a Pushover notification
 * Visit: /api/test-notification
 * DELETE THIS FILE after testing
 */
module.exports = async function handler(req, res) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;

  if (!token || !user) {
    return res.status(500).json({ 
      error: 'PUSHOVER_TOKEN or PUSHOVER_USER not set in environment variables' 
    });
  }

  const response = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: '⚾ GS Alert Test',
      message: '🎰 GS Line Posted: 132.5\nO -125 / U +105\nBook: DraftKings\n\nIf you got this, notifications are working!',
      priority: 1,
      sound: 'cashregister',
    }),
  });

  const data = await response.json();

  if (response.ok) {
    return res.status(200).json({ ok: true, message: 'Notification sent — check your phone!' });
  } else {
    return res.status(500).json({ error: 'Pushover failed', detail: data });
  }
};
