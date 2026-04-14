/**
 * GS Line Scraper — Vercel Cron Job
 * Runs every 5 minutes, scrapes sportsmemo.com for the MLB Grand Salami line,
 * notifies via Pushover when found, and auto-saves to the tracker.
 *
 * Setup:
 * 1. Add to vercel.json crons (see vercel.json in this folder)
 * 2. Set env vars: PUSHOVER_TOKEN, PUSHOVER_USER, TRACKER_BASE_URL
 * 3. Deploy — it runs automatically every 5 minutes
 */

const SPORTSMEMO_URL = 'https://www.sportsmemo.com/odds';

// Book column indices in the sportsmemo table (0-based after fixed columns)
// Columns: Time | Gm# | Teams | Score | blank | Tickets | Money | Open | DraftKings | Fanduel | Circa | SuperBook | Caesars | BetMGM | SouthPoint | HardRock | ESPNBet | Fanatics | Consensus
const BOOK_COLUMNS = {
  'DraftKings': 8,
  'FanDuel': 9,
  'Circa': 10,
  'SuperBook': 11,
  'Caesars': 12,
  'BetMGM': 13,
  'HardRock': 15,
  'ESPNBet': 16,
  'Fanatics': 17,
};

function getTodayPDT() {
  const pst = new Date(Date.now() + -7 * 60 * 60000);
  return pst.toISOString().split('T')[0];
}

// Parse American odds line like "128½ -110" or "128.5 -115"
function parseLine(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return null;
  
  // Replace ½ with .5
  const cleaned = raw.replace('½', '.5').replace('¼', '.25').replace('¾', '.75').trim();
  
  // Try to extract line and price — format varies by book
  // Could be "128.5 -110" or just "128.5" or "-110\n128.5"
  const parts = cleaned.split(/\s+/).filter(Boolean);
  
  let line = null;
  let overPrice = null;
  let underPrice = null;
  
  for (const part of parts) {
    const num = parseFloat(part.replace(/[+]/g, ''));
    if (isNaN(num)) continue;
    if (Math.abs(num) > 50 && Math.abs(num) < 200) {
      // This is a run total line (e.g. 128.5)
      line = Math.abs(num);
    } else if (Math.abs(num) >= 100 && Math.abs(num) <= 500) {
      // This is odds (e.g. -110, +105)
      if (overPrice === null) overPrice = parseInt(part);
      else underPrice = parseInt(part);
    }
  }
  
  return line ? { line, overPrice, underPrice } : null;
}

async function scrapeGSLine() {
  const res = await fetch(SPORTSMEMO_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });
  
  if (!res.ok) throw new Error(`Sportsmemo fetch failed: ${res.status}`);
  
  const html = await res.text();
  
  // Find the Grand Salami OVER/UNDER rows
  // Looking for rows with game numbers 997/998 or containing "OVER RUNS"
  const lines = html.split('\n');
  
  let inGSSalami = false;
  let overRow = null;
  let underRow = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect entering Grand Salami section
    if (line.includes('GRAND SALAMI') && line.includes('BASEBALL')) {
      inGSSalami = true;
    }
    
    // Detect leaving (next sport section)
    if (inGSSalami && line.includes('[-]') && !line.includes('GRAND SALAMI')) {
      inGSSalami = false;
    }
    
    if (inGSSalami) {
      if (line.includes('OVER RUNS')) overRow = line;
      if (line.includes('UNDER RUNS')) underRow = line;
    }
  }
  
  if (!overRow) return null;
  
  // Parse table cells from the row
  // Extract <td> content
  const tdRegex = /<td[^>]*>(.*?)<\/td>/gi;
  
  const parseRow = (row) => {
    const cells = [];
    let match;
    const regex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((match = regex.exec(row)) !== null) {
      // Strip HTML tags from cell content
      const content = match[1].replace(/<[^>]+>/g, '').trim();
      cells.push(content);
    }
    return cells;
  };
  
  // Try to find the full row in HTML (multi-line rows)
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let gsOverCells = null;
  let gsUnderCells = null;
  let match;
  
  while ((match = rowRegex.exec(html)) !== null) {
    const rowContent = match[1];
    if (rowContent.includes('OVER RUNS')) {
      gsOverCells = parseRow(match[0]);
    }
    if (rowContent.includes('UNDER RUNS')) {
      gsUnderCells = parseRow(match[0]);
    }
  }
  
  if (!gsOverCells || gsOverCells.length === 0) return null;
  
  // Check each book column for a value
  for (const [bookName, colIndex] of Object.entries(BOOK_COLUMNS)) {
    const overCell = gsOverCells[colIndex] || '';
    const underCell = gsUnderCells ? (gsUnderCells[colIndex] || '') : '';
    
    if (overCell && overCell !== '' && overCell !== '-') {
      const parsed = parseLine(overCell);
      if (parsed && parsed.line) {
        // Get under price from under row if available
        if (!parsed.underPrice && underCell) {
          const underParsed = parseLine(underCell);
          if (underParsed) parsed.underPrice = underParsed.overPrice;
        }
        
        return {
          line: parsed.line,
          overPrice: parsed.overPrice || -110,
          underPrice: parsed.underPrice || -110,
          book: bookName,
          rawOver: overCell,
          rawUnder: underCell,
        };
      }
    }
  }
  
  return null;
}

async function sendPushoverNotification(gsData) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  
  if (!token || !user) {
    console.log('Pushover not configured — skipping notification');
    return;
  }
  
  const overStr = gsData.overPrice > 0 ? `+${gsData.overPrice}` : `${gsData.overPrice}`;
  const underStr = gsData.underPrice > 0 ? `+${gsData.underPrice}` : `${gsData.underPrice}`;
  
  const message = [
    `🎰 GS Line Posted: ${gsData.line}`,
    `O ${overStr} / U ${underStr}`,
    `Book: ${gsData.book}`,
    ``,
    `Check your tracker to set pick & units.`,
  ].join('\n');
  
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: '⚾ Grand Salami Line Is Live',
      message,
      priority: 1, // high priority — bypasses quiet hours
      sound: 'cashregister',
    }),
  });
  
  if (!res.ok) {
    console.error('Pushover notification failed:', await res.text());
  } else {
    console.log('Pushover notification sent successfully');
  }
}

async function saveToTracker(gsData) {
  const baseUrl = process.env.TRACKER_BASE_URL || 'https://mlb-tracker-grandsalami.vercel.app';
  const today = getTodayPDT();
  
  const res = await fetch(`${baseUrl}/api/odds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: today,
      grandSalamLine: gsData.line,
      gsOverPrice: gsData.overPrice,
      gsUnderPrice: gsData.underPrice,
      gsBook: gsData.book,
    }),
  });
  
  if (!res.ok) {
    console.error('Failed to save GS line to tracker:', await res.text());
  } else {
    console.log(`GS line ${gsData.line} saved to tracker from ${gsData.book}`);
  }
}

async function hasLineAlreadyBeenSaved() {
  const baseUrl = process.env.TRACKER_BASE_URL || 'https://mlb-tracker-grandsalami.vercel.app';
  
  try {
    const res = await fetch(`${baseUrl}/api/history`);
    const history = await res.json();
    const today = getTodayPDT();
    const todayRecord = history.find(r => r.date === today);
    return !!(todayRecord && todayRecord.grandSalamLine);
  } catch(e) {
    return false;
  }
}

// Main handler — called by Vercel cron
module.exports = async function handler(req, res) {
  // Only allow cron calls (GET from Vercel) or manual triggers
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }
  
  // Only run during morning hours PT (5am - 12pm)
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  if (pstHour < 5 || pstHour > 12) {
    return res.status(200).json({ 
      ok: true, 
      skipped: true, 
      reason: `Outside active hours (current PT hour: ${pstHour})` 
    });
  }
  
  try {
    // Check if line is already saved — avoid duplicate notifications
    const alreadySaved = await hasLineAlreadyBeenSaved();
    if (alreadySaved) {
      return res.status(200).json({ 
        ok: true, 
        skipped: true, 
        reason: 'GS line already saved for today' 
      });
    }
    
    console.log('Scraping sportsmemo for GS line...');
    const gsData = await scrapeGSLine();
    
    if (!gsData) {
      console.log('GS line not yet posted');
      return res.status(200).json({ ok: true, found: false });
    }
    
    console.log('GS line found:', gsData);
    
    // Save to tracker and notify in parallel
    await Promise.all([
      saveToTracker(gsData),
      sendPushoverNotification(gsData),
    ]);
    
    return res.status(200).json({ 
      ok: true, 
      found: true,
      line: gsData.line,
      book: gsData.book,
      overPrice: gsData.overPrice,
      underPrice: gsData.underPrice,
    });
    
  } catch(e) {
    console.error('GS scraper error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
