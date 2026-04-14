/**
 * GS Line Scraper — Vercel Cron Job
 * Runs every 5 minutes, scrapes sportsmemo.com for the MLB Grand Salami line,
 * notifies via Pushover when found, and auto-saves to the tracker.
 *
 * Checks ALL columns: Open, DraftKings, FanDuel, Circa, SuperBook,
 * Caesars, BetMGM, SouthPoint, HardRock, ESPNBet, Fanatics, Consensus
 * Fires as soon as ANY column has a value.
 */

const SPORTSMEMO_URL = 'https://www.sportsmemo.com/odds';

// ALL columns to check — ordered by preference
// Columns: Time | Gm# | Teams | Score | blank | Tickets | Money | Open | DraftKings | Fanduel | Circa | SuperBook | Caesars | BetMGM | SouthPoint | HardRock | ESPNBet | Fanatics | Consensus
const BOOK_COLUMNS = {
  'Open':       7,
  'DraftKings': 8,
  'FanDuel':    9,
  'Circa':      10,
  'SuperBook':  11,
  'Caesars':    12,
  'BetMGM':     13,
  'SouthPoint': 14,
  'HardRock':   15,
  'ESPNBet':    16,
  'Fanatics':   17,
  'Consensus':  18,
};

function getTodayPDT() {
  const pst = new Date(Date.now() + -7 * 60 * 60000);
  return pst.toISOString().split('T')[0];
}

// Parse a GS line cell — handles formats like:
// "132½-15" "132.5 -110" "132½ -26" "-154/+127" "132½o-15" 
function parseLine(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return null;

  // Normalize fractions
  let cleaned = raw
    .replace(/½/g, '.5')
    .replace(/¼/g, '.25')
    .replace(/¾/g, '.75')
    .replace(/&frac12;/g, '.5')
    .replace(/o/gi, ' ') // remove over/under letters
    .replace(/u/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract all numbers including negatives
  const numRegex = /[+-]?\d+\.?\d*/g;
  const nums = [];
  let match;
  while ((match = numRegex.exec(cleaned)) !== null) {
    nums.push(parseFloat(match[0]));
  }

  if (nums.length === 0) return null;

  let line = null;
  let overPrice = null;
  let underPrice = null;

  for (const n of nums) {
    const abs = Math.abs(n);
    if (abs >= 100 && abs < 200 && line === null) {
      // Total line (e.g. 132.5)
      line = abs;
    } else if (abs >= 100 && abs <= 600) {
      // Odds (e.g. -110, +105)
      if (overPrice === null) overPrice = Math.round(n);
      else if (underPrice === null) underPrice = Math.round(n);
    } else if (abs < 50 && abs > 0 && line !== null) {
      // BetOnline style — shows cents only e.g. -15 means -115
      const fullOdds = n < 0 ? -(100 + abs) : (100 + abs);
      if (overPrice === null) overPrice = fullOdds;
      else if (underPrice === null) underPrice = fullOdds;
    }
  }

  return line ? { 
    line, 
    overPrice: overPrice || -110, 
    underPrice: underPrice || -110 
  } : null;
}

function parseRowCells(rowHtml) {
  const cells = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    const content = match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&frac12;/g, '½')
      .replace(/\s+/g, ' ')
      .trim();
    cells.push(content);
  }
  return cells;
}

async function scrapeGSLine() {
  const res = await fetch(SPORTSMEMO_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });

  if (!res.ok) throw new Error(`Sportsmemo fetch failed: ${res.status}`);

  const html = await res.text();

  // Find MLB Grand Salami section
  const gsIndex = html.search(/GRAND SALAMI/i);
  if (gsIndex === -1) {
    console.log('Grand Salami section not found on page');
    return null;
  }

  // Only parse HTML after GS section header
  const gsHtml = html.slice(gsIndex);

  let gsOverCells = null;
  let gsUnderCells = null;

  const gsRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = gsRowRegex.exec(gsHtml)) !== null) {
    const rowHtml = match[0];
    const rowText = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    if (rowText.includes('OVER RUNS')) {
      gsOverCells = parseRowCells(rowHtml);
      console.log('OVER RUNS row found, cells:', gsOverCells);
    }
    if (rowText.includes('UNDER RUNS')) {
      gsUnderCells = parseRowCells(rowHtml);
      console.log('UNDER RUNS row found, cells:', gsUnderCells);
    }

    // Stop once we have both rows
    if (gsOverCells && gsUnderCells) break;

    // Stop if we hit NHL Grand Salami section
    if (gsOverCells && rowText.includes('NHL')) break;
  }

  if (!gsOverCells || gsOverCells.length === 0) {
    console.log('Could not find OVER RUNS row in Grand Salami section');
    return null;
  }

  // Check each book column for a value — fire on first hit
  for (const [bookName, colIndex] of Object.entries(BOOK_COLUMNS)) {
    const overCell = (gsOverCells[colIndex] || '').trim();
    const underCell = gsUnderCells ? (gsUnderCells[colIndex] || '').trim() : '';

    if (!overCell || overCell === '' || overCell === '-') continue;

    console.log(`Checking ${bookName} (col ${colIndex}): over="${overCell}" under="${underCell}"`);

    const parsed = parseLine(overCell);
    if (!parsed || !parsed.line) continue;

    // Try to get under price from under row
    if (underCell && underCell !== '' && underCell !== '-') {
      const underParsed = parseLine(underCell);
      if (underParsed && underParsed.overPrice) {
        parsed.underPrice = underParsed.overPrice;
      }
    }

    console.log(`✅ GS line found from ${bookName}:`, parsed);
    return {
      line: parsed.line,
      overPrice: parsed.overPrice,
      underPrice: parsed.underPrice,
      book: bookName,
    };
  }

  console.log('GS section found but no lines posted in any column yet');
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

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: '⚾ Grand Salami Line Is Live',
      message: [
        `🎰 GS Line: ${gsData.line}`,
        `O ${overStr} / U ${underStr}`,
        `Book: ${gsData.book}`,
        ``,
        `Open tracker to set pick & units.`,
      ].join('\n'),
      priority: 1,
      sound: 'cashregister',
    }),
  });

  if (!res.ok) {
    console.error('Pushover notification failed:', await res.text());
  } else {
    console.log('Pushover notification sent');
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
    console.error('Failed to save to tracker:', await res.text());
  } else {
    console.log(`Saved GS line ${gsData.line} from ${gsData.book} to tracker`);
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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Only run 5am–1pm PT
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  if (pstHour < 5 || pstHour > 13) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: `Outside active hours (PT hour: ${pstHour})`
    });
  }

  try {
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
      return res.status(200).json({ ok: true, found: false, message: 'Line not posted yet' });
    }

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
    console.error('Scraper error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
