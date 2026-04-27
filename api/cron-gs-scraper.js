/**
 * GS Line Scraper — Vercel Cron Job (v2)
 * Runs every 5 minutes (24/7), fetches sportsmemo.com's JSON endpoint and looks
 * for the MLB Grand Salami line in the Open or Consensus columns.
 *
 * Why v2:
 * The previous version scraped the rendered HTML, which never worked because
 * sportsmemo.com loads odds via XHR after page render. This version hits the
 * underlying data files directly.
 *
 * Two-step lookup:
 *   1. Fetch today.txt to find the team ID of the OVER RUNS row in the MLB
 *      Grand Salami section (the row ID shifts day-to-day based on slate size).
 *   2. Fetch lines-today.txt and pull the value of that team ID's row from
 *      either the Open or Consensus book column.
 *
 * Files used:
 *   https://www.sportsmemo.com/odds?action=getData&data=today.txt
 *   https://www.sportsmemo.com/odds?action=getData&data=lines-today.txt
 *
 * Book column mapping for GS:
 *   b115 = "Open" column
 *   b116 = "Consensus" column
 * GS rarely posts to actual books — almost always shows up only in Open/Consensus.
 *
 * Behavior:
 * - Fires Pushover ONCE per day on first detection of MLB OVER RUNS line
 * - Auto-saves the line to the tracker
 * - Uses gsNotifiedBooks marker on today's record to dedupe across cron runs
 * - Does NOT fire on AWAY RUNS / HOME RUNS (separate market, not the GS total)
 *
 * Env vars:
 *   PUSHOVER_TOKEN       — Pushover app token
 *   PUSHOVER_USER        — Pushover user key
 *   TRACKER_BASE_URL     — e.g. https://mlb-tracker-grandsalami.vercel.app
 *   AUTO_SAVE_LINE       — 'false' to disable auto-save (default: true)
 */

const SPORTSMEMO_BASE = 'https://www.sportsmemo.com/odds?action=getData';
const LINES_URL = `${SPORTSMEMO_BASE}&data=lines-today.txt`;
const SCHEDULE_URL = `${SPORTSMEMO_BASE}&data=today.txt`;
const BASE_URL = () => process.env.TRACKER_BASE_URL || 'https://mlb-tracker-grandsalami.vercel.app';

// Book ID -> display name (only the ones that actually carry GS)
const BOOK_NAMES = {
  b115: 'Open',
  b116: 'Consensus',
};

function getTodayPDT() {
  const pst = new Date(Date.now() + -7 * 60 * 60000);
  return pst.toISOString().split('T')[0];
}

/**
 * Parse a sportsmemo line value cell.
 *
 * Examples seen in the wild:
 *   "146"          -> just a total, no juice attached
 *   "146o-15"      -> total 146, over -115 (cents-style)
 *   "146u-15"      -> total 146, under -115
 *   "8½o-15"       -> total 8.5, over -115 (per-game style)
 *   "-137/+113"    -> moneyline pair (NOT a totals line — used for AWAY/HOME runs market)
 *
 * For GS we only care about the totals format, since the OVER RUNS row is t997.
 *
 * Returns: { line, juiceSide, juicePrice } or null
 *   juiceSide: 'o' or 'u' indicating which side carries the juice
 *   juicePrice: full odds (e.g. -115)
 */
function parseTotalsCell(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/½/g, '.5')
    .replace(/¼/g, '.25')
    .replace(/¾/g, '.75')
    .trim();

  if (!cleaned || cleaned === '-') return null;

  // Reject moneyline-pair format like "-137/+113"
  if (cleaned.includes('/')) return null;

  // Match: optional digits + optional decimal, optional o/u + optional cents
  // Examples: "146", "146o-15", "8.5u-12", "10.5o-25"
  const m = cleaned.match(/^(\d+\.?\d*)(?:([ou])([+-]?\d+))?$/i);
  if (!m) return null;

  const line = parseFloat(m[1]);
  if (isNaN(line) || line <= 0) return null;

  let juiceSide = null;
  let juicePrice = null;

  if (m[2] && m[3]) {
    juiceSide = m[2].toLowerCase();
    const cents = parseInt(m[3], 10);
    // sportsmemo uses cents-style: -15 means -115, +5 means +105
    juicePrice = cents < 0 ? -(100 + Math.abs(cents)) : (100 + cents);
  }

  return { line, juiceSide, juicePrice };
}

/**
 * Convert a parsed totals cell into {line, overPrice, underPrice}.
 * Sportsmemo only shows juice on one side; we infer the other side as the
 * complementary -110/-110 baseline rebalanced. If no juice is shown, default both to -110.
 */
function toOverUnderPrices(parsed) {
  if (!parsed) return null;

  const { line, juiceSide, juicePrice } = parsed;
  let overPrice = -110;
  let underPrice = -110;

  if (juiceSide && juicePrice != null) {
    if (juiceSide === 'o') {
      overPrice = juicePrice;
      // If over is e.g. -115, the under is roughly -105 (standard 20¢ market)
      underPrice = juicePrice < 0 ? -(220 + juicePrice) : (juicePrice - 220);
    } else {
      underPrice = juicePrice;
      overPrice = juicePrice < 0 ? -(220 + juicePrice) : (juicePrice - 220);
    }
  }

  return { line, overPrice, underPrice };
}

/**
 * Parse today.txt to find the team ID of the OVER RUNS row in the MLB Grand Salami section.
 *
 * The schedule file is structured as nested groups:
 *   {{header_meta, "...SECTION TITLE..."}, {teamId, ..., {AwayTeamName,...,HomeTeamName,...}}, ...}
 *
 * For the MLB Grand Salami section, the rows are:
 *   {AWAY_RUNS_ID, ..., {AWAY RUNS, AWAY RUNS, ..., HOME RUNS, HOME RUNS, ...}}
 *   {OVER_RUNS_ID, ..., {OVER RUNS, OVER RUNS, ..., UNDER RUNS, UNDER RUNS, ...}}
 *
 * We need OVER_RUNS_ID — that's the team ID we'll look up in lines-today.txt.
 *
 * Returns: numeric team ID (e.g. 993) or null if not found.
 */
function findMLBGrandSalamiTeamId(scheduleText) {
  if (!scheduleText) return null;

  // Find the MLB Grand Salami section header. The title format is:
  //   "MAJOR LEAGUE BASEBALL - <day>, <date> - GRAND SALAMI"
  // We need to be specific about MLB to avoid matching NHL Grand Salami.
  const headerRegex = /\{header\d+,[^}]*?"MAJOR LEAGUE BASEBALL[^"]*GRAND SALAMI[^"]*"\}/gi;
  const headerMatch = headerRegex.exec(scheduleText);
  if (!headerMatch) return null;

  const sectionStart = headerMatch.index + headerMatch[0].length;

  // The MLB GS section ends at the next {header...} or end of string.
  const nextHeaderRegex = /\{header\d+,/g;
  nextHeaderRegex.lastIndex = sectionStart;
  const nextHeaderMatch = nextHeaderRegex.exec(scheduleText);
  const sectionEnd = nextHeaderMatch ? nextHeaderMatch.index : scheduleText.length;

  const sectionText = scheduleText.slice(sectionStart, sectionEnd);

  // Within the section, find the row whose team-name field contains "OVER RUNS".
  // Row format: {teamId,...,{OVER RUNS,OVER RUNS,...,UNDER RUNS,UNDER RUNS,...}}
  // The teamId is the first field after the opening brace.
  const rowRegex = /\{(\d+),[^{}]*?\{OVER RUNS\b/i;
  const rowMatch = rowRegex.exec(sectionText);
  if (!rowMatch) return null;

  const teamId = parseInt(rowMatch[1], 10);
  if (isNaN(teamId)) return null;

  return teamId;
}

/**
 * Parse the sportsmemo lines-today.txt file and pull out the MLB GS over/under line.
 *
 * Takes the team ID resolved from the schedule (e.g. 993 today, 997 yesterday).
 * Returns the first found populated cell, preferring Open over Consensus.
 * Returns null if the team ID's row has no parseable totals value posted yet.
 */
function findGSLine(rawText, teamId) {
  if (!rawText || !teamId) return null;

  const targetPrefix = `t${teamId}p0b`;

  // Each entry is wrapped in {} — parse them out
  // Format inside braces: tTEAMpPbBOOKrROW,,timestamp,value
  const entryRegex = /\{([^{}]+)\}/g;

  const candidates = []; // collected hits, will sort by preferred book order
  let match;

  while ((match = entryRegex.exec(rawText)) !== null) {
    const entry = match[1];

    // Quick filter — must match the GS team ID we're hunting for
    if (!entry.startsWith(targetPrefix)) continue;

    // Split on comma — expect 4 parts: key, _, timestamp, value
    const parts = entry.split(',');
    if (parts.length < 4) continue;

    const key = parts[0]; // e.g. "t993p0b115r1"
    const value = parts.slice(3).join(',').trim();

    if (!value) continue;

    // Extract book ID and row number from key
    const keyMatch = key.match(/^t\d+p0(b\d+)r(\d+)$/);
    if (!keyMatch) continue;

    const bookId = keyMatch[1];
    const rowNum = parseInt(keyMatch[2], 10);

    // r1 = primary market (the totals number); r2 = secondary (we don't care for GS)
    if (rowNum !== 1) continue;

    const parsed = parseTotalsCell(value);
    if (!parsed) continue;

    const bookName = BOOK_NAMES[bookId] || bookId;

    candidates.push({
      bookId,
      bookName,
      ...parsed,
      raw: value,
    });
  }

  if (candidates.length === 0) return null;

  // Prefer Open (b115), then Consensus (b116), then anything else
  const preference = ['b115', 'b116'];
  candidates.sort((a, b) => {
    const ai = preference.indexOf(a.bookId);
    const bi = preference.indexOf(b.bookId);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const winner = candidates[0];
  const prices = toOverUnderPrices(winner);

  return {
    ...prices,
    book: winner.bookName,
    bookId: winner.bookId,
    raw: winner.raw,
    allCandidates: candidates.map(c => ({ book: c.bookName, line: c.line, raw: c.raw })),
  };
}

async function fetchSportsmemoFile(url) {
  // Cache-buster — sportsmemo's frontend uses a random number in `cb=`
  const fullUrl = `${url}&cb=${Date.now()}`;
  const res = await fetch(fullUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/plain,*/*',
      'Referer': 'https://www.sportsmemo.com/odds',
    },
  });

  if (!res.ok) {
    throw new Error(`Sportsmemo fetch failed (${url}): ${res.status}`);
  }

  return await res.text();
}

async function getTodayRecord() {
  try {
    const res = await fetch(`${BASE_URL()}/api/history`);
    const history = await res.json();
    const today = getTodayPDT();
    return history.find(r => r.date === today) || null;
  } catch (e) {
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

async function markNotified(bookName) {
  const today = getTodayPDT();
  const res = await fetch(`${BASE_URL()}/api/odds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: today,
      gsNotifiedBooks: [bookName],
    }),
  });
  if (!res.ok) console.error('Failed to mark notified:', await res.text());
}

async function sendPushoverNotification({ line, overPrice, underPrice, book }) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    console.log('Pushover not configured');
    return;
  }

  const overStr = overPrice > 0 ? `+${overPrice}` : `${overPrice}`;
  const underStr = underPrice > 0 ? `+${underPrice}` : `${underPrice}`;

  const pushRes = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      user,
      title: '⚾ Grand Salami Line Is Live',
      message: [
        `🎰 GS Line: ${line}`,
        `O ${overStr} / U ${underStr}`,
        `Source: ${book}`,
        '',
        'Open tracker to set pick & units.',
      ].join('\n'),
      priority: 1,
      sound: 'cashregister',
    }),
  });

  if (!pushRes.ok) console.error('Pushover failed:', await pushRes.text());
  else console.log(`Pushover sent (${book})`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const todayRecord = await getTodayRecord();
    const alreadyNotified = !!(todayRecord && Array.isArray(todayRecord.gsNotifiedBooks) && todayRecord.gsNotifiedBooks.length > 0);
    const alreadySavedLine = !!(todayRecord && todayRecord.grandSalamLine);
    const autoSave = process.env.AUTO_SAVE_LINE !== 'false';

    if (alreadyNotified) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'Already notified for today',
      });
    }

    // Step 1: fetch the schedule and resolve today's MLB GS team ID dynamically.
    // Row IDs shift day-to-day based on slate composition (e.g. 993 today, 997 yesterday).
    const scheduleText = await fetchSportsmemoFile(SCHEDULE_URL);
    const gsTeamId = findMLBGrandSalamiTeamId(scheduleText);

    if (!gsTeamId) {
      // No MLB Grand Salami section in schedule — likely off-season or schedule glitch
      return res.status(200).json({
        ok: true,
        found: false,
        message: 'No MLB Grand Salami section in today\'s schedule',
      });
    }

    // Step 2: fetch the lines and look up that team ID's row
    const rawText = await fetchSportsmemoFile(LINES_URL);
    const gsLine = findGSLine(rawText, gsTeamId);

    if (!gsLine) {
      return res.status(200).json({
        ok: true,
        found: false,
        teamId: gsTeamId,
        message: `No GS line posted yet (watching t${gsTeamId})`,
      });
    }

    console.log(`GS line found: ${gsLine.line} from ${gsLine.book} (raw: "${gsLine.raw}", t${gsTeamId})`);

    const actions = [];

    // Fire Pushover (once per day — controlled by gsNotifiedBooks check above)
    actions.push(sendPushoverNotification(gsLine));

    // Save line to tracker if not already there
    if (!alreadySavedLine && autoSave) {
      actions.push(saveToTracker(gsLine));
    }

    // Mark notified so we don't fire again today
    actions.push(markNotified(gsLine.book));

    await Promise.all(actions);

    return res.status(200).json({
      ok: true,
      found: true,
      teamId: gsTeamId,
      line: gsLine.line,
      overPrice: gsLine.overPrice,
      underPrice: gsLine.underPrice,
      book: gsLine.book,
      raw: gsLine.raw,
      allCandidates: gsLine.allCandidates,
      saved: !alreadySavedLine && autoSave,
      notified: true,
    });

  } catch (e) {
    console.error('Scraper error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
