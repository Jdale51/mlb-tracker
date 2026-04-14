/**
 * GS Line Scraper — Vercel Cron Job
 * Runs every 5 minutes, scrapes sportsmemo.com for the MLB Grand Salami line.
 *
 * Behavior:
 * - Checks ALL book columns every run
 * - First book to post: auto-saves to tracker + Pushover notification
 * - Subsequent books posting: Pushover notification only (no overwrite)
 * - Each book only notifies ONCE per day
 * - Line moves at existing book: silent (same book already notified)
 *
 * Env vars:
 *   PUSHOVER_TOKEN       — Pushover app token
 *   PUSHOVER_USER        — Pushover user key
 *   TRACKER_BASE_URL     — e.g. https://mlb-tracker-grandsalami.vercel.app
 *   AUTO_SAVE_LINE       — 'false' to disable auto-save (default: true)
 */

const SPORTSMEMO_URL = 'https://www.sportsmemo.com/odds';
const BASE_URL = () => process.env.TRACKER_BASE_URL || 'https://mlb-tracker-grandsalami.vercel.app';

// ALL columns to check — ordered by priority
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
// "132½-15" "132.5 -110" "132½ -26" "-154/+127"
// BetOnline style: "132½-15" where -15 means -115
function parseLine(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return null;

  let cleaned = raw
    .replace(/½/g, '.5')
    .replace(/¼/g, '.25')
    .replace(/¾/g, '.75')
    .replace(/&frac12;/g, '.5')
    .replace(/o/gi, ' ')
    .replace(/u/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
      line = abs;
    } else if (abs >= 100 && abs <= 600) {
      if (overPrice === null) overPrice = Math.round(n);
      else if (underPrice === null) underPrice = Math.round(n);
    } else if (abs < 50 && abs > 0 && line !== null) {
      // BetOnline cents-style: -15 = -115, +5 = +105
      const fullOdds = n < 0 ? -(100 + abs) : (100 + abs);
      if (overPrice === null) overPrice = fullOdds;
      else if (underPrice === null) underPrice = fullOdds;
    }
  }

  return line ? {
    line,
    overPrice: overPrice || -110,
    underPrice: underPrice || -110,
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

// Returns map of { bookName: { line, overPrice, underPrice } } for all books with values
async function scrapeAllBooks() {
  const res = await fetch(SPORTSMEMO_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });

  if (!res.ok) throw new Error(`Sportsmemo fetch failed: ${res.status}`);
  const html = await res.text();

  const gsIndex = html.search(/GRAND SALAMI/i);
  if (gsIndex === -1) {
    console.log('Grand Salami section not found');
    return {};
  }

  const gsHtml = html.slice(gsIndex);
  let gsOverCells = null;
  let gsUnderCells = null;

  const gsRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = gsRowRegex.exec(gsHtml)) !== null) {
    const rowHtml = match[0];
    const rowText = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (rowText.includes('OVER RUNS')) gsOverCells = parseRowCells(rowHtml);
    if (rowText.includes('UNDER RUNS')) gsUnderCells = parseRowCells(rowHtml);
    if (gsOverCells && gsUnderCells) break;
    if (gsOverCells && rowText.includes('NHL')) break;
  }

  if (!gsOverCells || gsOverCells.length === 0) {
    console.log('OVER RUNS row not found');
    return {};
  }

  const found = {};
  for (const [bookName, colIndex] of Object.entries(BOOK_COLUMNS)) {
    const overCell = (gsOverCells[colIndex] || '').trim();
    const underCell = gsUnderCells ? (gsUnderCells[colIndex] || '').trim() : '';

    if (!overCell || overCell === '' || overCell === '-') continue;

    const parsed = parseLine(overCell);
    if (!parsed || !parsed.line) continue;

    // Try to get under price from under row
    if (underCell && underCell !== '' && underCell !== '-') {
      const underParsed = parseLine(underCell);
      if (underParsed && underParsed.overPrice) {
        parsed.underPrice = underParsed.overPrice;
      }
    }

    found[bookName] = { line: parsed.line, overPrice: parsed.overPrice, underPrice: parsed.underPrice };
  }

  console.log('Books with lines:', Object.keys(found));
  return found;
}

async function getTodayRecord() {
  try {
    const res = await fetch(`${BASE_URL()}/api/history`);
    const history = await res.json();
    const today = getTodayPDT();
    return history.find(r => r.date === today) || null;
  } catch(e) {
    return null;
  }
}

async function saveToTracker(gsData) {
  const today = getTodayPDT();
  const res = await fetch(`${BASE_URL()}/api/odds`, {
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
  if (!res.ok) console.error('Failed to save to tracker:', await res.text());
  else console.log(`Saved GS line ${gsData.line} from ${gsData.book}`);
}

async function markBooksNotified(bookNames) {
  const today = getTodayPDT();
  const res = await fetch(`${BASE_URL()}/api/odds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: today,
      gsNotifiedBooks: bookNames,
    }),
  });
  if (!res.ok) console.error('Failed to save notified books:', await res.text());
}

async function sendPushoverNotification({ line, overPrice, underPrice, book, isUpdate }) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) { console.log('Pushover not configured'); return; }

  const overStr = overPrice > 0 ? `+${overPrice}` : `${overPrice}`;
  const underStr = underPrice > 0 ? `+${underPrice}` : `${underPrice}`;
  const title = isUpdate
    ? `⚾ GS Line Now on ${book}`
    : `⚾ Grand Salami Line Is Live`;

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title,
      message: [
        `🎰 GS Line: ${line}`,
        `O ${overStr} / U ${underStr}`,
        `Book: ${book}`,
        isUpdate ? '' : '\nOpen tracker to set pick & units.',
      ].join('\n').trim(),
      priority: 1,
      sound: 'cashregister',
    }),
  });

  if (!res.ok) console.error('Pushover failed:', await res.text());
  else console.log(`Pushover sent for ${book}`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Only run 5am–1pm PT
  const pstHour = ((new Date().getUTCHours() - 7) + 24) % 24;
  if (pstHour < 5 || pstHour > 13) {
    return res.status(200).json({ ok: true, skipped: true, reason: `Outside active hours (PT hour: ${pstHour})` });
  }

  try {
    // Get today's record — check what's already saved and which books have notified
    const todayRecord = await getTodayRecord();
    const alreadySavedLine = !!(todayRecord && todayRecord.grandSalamLine);
    const notifiedBooks = todayRecord?.gsNotifiedBooks || [];
    const autoSave = process.env.AUTO_SAVE_LINE !== 'false';

    console.log(`Already saved: ${alreadySavedLine}, Notified books: ${notifiedBooks.join(', ') || 'none'}`);

    // Scrape all books
    const booksWithLines = await scrapeAllBooks();
    if (Object.keys(booksWithLines).length === 0) {
      return res.status(200).json({ ok: true, found: false, message: 'No lines posted yet' });
    }

    const newlyNotified = [];
    const actions = [];

    for (const [bookName, gsData] of Object.entries(booksWithLines)) {
      // Skip if we already notified for this book today
      if (notifiedBooks.includes(bookName)) continue;

      const isFirstLine = !alreadySavedLine;
      const payload = { ...gsData, book: bookName, isUpdate: !isFirstLine };

      console.log(`New book posting: ${bookName} — line ${gsData.line} (first: ${isFirstLine})`);

      // Auto-save only for the very first line of the day
      if (isFirstLine && autoSave) {
        actions.push(saveToTracker(payload));
      }

      // Always notify
      actions.push(sendPushoverNotification(payload));
      newlyNotified.push(bookName);
    }

    if (newlyNotified.length > 0) {
      // Save updated notified books list
      const allNotified = [...notifiedBooks, ...newlyNotified];
      actions.push(markBooksNotified(allNotified));
      await Promise.all(actions);
    }

    return res.status(200).json({
      ok: true,
      found: Object.keys(booksWithLines).length > 0,
      booksFound: Object.keys(booksWithLines),
      newlyNotified,
      alreadyNotified: notifiedBooks,
    });

  } catch(e) {
    console.error('Scraper error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
