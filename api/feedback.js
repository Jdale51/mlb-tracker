// /api/feedback.js
// Sends feedback form submissions to your inbox via Resend API.
// Setup:
//   1. Sign up free at https://resend.com
//   2. Add a domain (or use their onboarding@resend.dev sender for testing)
//   3. Create an API key
//   4. In Vercel: Settings -> Environment Variables, add:
//        RESEND_API_KEY   = re_xxx...
//        FEEDBACK_TO      = mlbgrandsalami@gmail.com
//        FEEDBACK_FROM    = feedback@yourdomain.com   (or onboarding@resend.dev for testing)
//   5. Redeploy.

export default async function handler(req, res) {
  // CORS / method guard
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { type, message, email, userAgent, pageUrl } = req.body || {};

    // Basic validation
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message too long' });
    }
    const typeLabel = type === 'model' ? 'Model' : type === 'site' ? 'Website' : 'Other';

    // Escape HTML for safety in the email body
    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.FEEDBACK_TO;
    const from = process.env.FEEDBACK_FROM || 'onboarding@resend.dev';

    if (!apiKey || !to) {
      console.error('[feedback] Missing env vars: RESEND_API_KEY or FEEDBACK_TO');
      return res.status(500).json({ error: 'Feedback service not configured' });
    }

    const html = `
      <div style="font-family:sans-serif;max-width:600px;">
        <h2 style="color:#222;">GST Feedback — ${esc(typeLabel)}</h2>
        <div style="background:#f5f5f5;padding:14px;border-radius:6px;white-space:pre-wrap;font-size:14px;line-height:1.5;">${esc(message)}</div>
        <hr style="border:none;border-top:1px solid #ddd;margin:18px 0;">
        <table style="font-size:12px;color:#666;">
          <tr><td><b>Type:</b></td><td>${esc(typeLabel)}</td></tr>
          ${email ? `<tr><td><b>Reply-to:</b></td><td>${esc(email)}</td></tr>` : ''}
          <tr><td><b>Page:</b></td><td>${esc(pageUrl)}</td></tr>
          <tr><td><b>User agent:</b></td><td>${esc(userAgent)}</td></tr>
          <tr><td><b>Submitted:</b></td><td>${new Date().toISOString()}</td></tr>
        </table>
      </div>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `GST Feedback <${from}>`,
        to: [to],
        reply_to: email || undefined,
        subject: `GST Feedback — ${typeLabel}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('[feedback] Resend error:', resendRes.status, errText);
      return res.status(502).json({ error: 'Failed to send — please try again' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[feedback] Exception:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
