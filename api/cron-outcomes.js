/**
 * Game Outcomes Fetcher — Vercel Serverless Function
 *
 * Pulls post-game outcomes from MLB Stats API for a given date and writes
 * game-outcomes-{date}.json to Vercel Blob storage.
 *
 * Usage:
 *   GET /api/cron-outcomes                  → defaults to yesterday PT (cron use)
 *   GET /api/cron-outcomes?date=YYYY-MM-DD  → specific date (backfill use)
 *
 * Output blob: game-outcomes-{date}.json with schema v2.
 */

const { put, list } = require('@vercel/blob');

// ── ABBR MAP (mirrors admin.html EXPORT_ABBR so matchup keys join cleanly) ──
const EXPORT_ABBR = {
  'New York Yankees': 'NYY', 'San Francisco Giants': 'SF', 'Athletics': 'ATH',
  'Oakland Athletics': 'ATH', 'Toronto Blue Jays': 'TOR', 'Colorado Rockies': 'COL',
  'Miami Marlins': 'MIA', 'Kansas City Royals': 'KC', 'Atlanta Braves': 'ATL',
  'Los Angeles Angels': 'LAA', 'Houston Astros': 'HOU', 'Detroit Tigers': 'DET',
  'San Diego Padres': 'SD', 'Cleveland Guardians': 'CLE', 'Seattle Mariners': 'SEA',
  'Arizona Diamondbacks': 'AZ', 'Los Angeles Dodgers': 'LAD', 'New York Mets': 'NYM',
  'Chicago Cubs': 'CHC', 'Milwaukee Brewers': 'MIL', 'St. Louis Cardinals': 'STL',
  'Pittsburgh Pirates': 'PIT', 'Chicago White Sox': 'CWS',
  'Washington Nationals': 'WSH', 'Minnesota Twins': 'MIN', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Cincinnati Reds': 'CIN', 'Philadelphia Phillies': 'PHI',
  'Texas Rangers': 'TEX', 'Tampa Bay Rays': 'TB',
};
function exportAbbr(name) {
  return EXPORT_ABBR[name] || (name || '').split(' ').pop().slice(0, 3).toUpperCase();
}

function getYesterdayPT() {
  const d = new Date(Date.now() + -7 * 60 * 60 * 1000 - 86400000);
  return d.toISOString().split('T')[0];
}

// ── IP helpers — baseball IP is NOT a decimal. .1 = 1/3 inning, .2 = 2/3. ──
// Convert an IP string like "5.2" → 17 outs. Convert 17 outs → "5.2".
function ipToOuts(s) {
  if (s == null || s === '') return 0;
  const str = String(s);
  const [whole, frac] = str.split('.');
  const w = parseInt(whole) || 0;
  const f = frac ? parseInt(frac) : 0;
  const fracOuts = (f === 1 || f === 2) ? f : 0;
  return w * 3 + fracOuts;
}
function outsToIp(outs) {
  if (!outs || outs < 0) return 0;
  const whole = Math.floor(outs / 3);
  const frac = outs % 3;
  return parseFloat(`${whole}.${frac}`);
}
// For display on individual pitcher lines we keep MLB's native format verbatim.
function parseIPDisplay(s) {
  if (s == null || s === '') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchGameOutcome(game) {
  const gamePk = game.gamePk;
  const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  const boxscore = feed.liveData?.boxscore || {};
  const plays = feed.liveData?.plays?.allPlays || [];
  const gameData = feed.gameData || {};
  const teamsGD = gameData.teams || {};
  const weather = gameData.weather || {};
  const probables = gameData.probablePitchers || {};

  const awayName = teamsGD.away?.name || game.teams?.away?.team?.name || '';
  const homeName = teamsGD.home?.name || game.teams?.home?.team?.name || '';
  const awayAbbr = exportAbbr(awayName);
  const homeAbbr = exportAbbr(homeName);

  const awayR = game.teams?.away?.score ?? boxscore.teams?.away?.teamStats?.batting?.runs ?? 0;
  const homeR = game.teams?.home?.score ?? boxscore.teams?.home?.teamStats?.batting?.runs ?? 0;
  const total = awayR + homeR;

  // ── Pitcher-to-team lookup from the boxscore pitchers arrays ──
  // Canonical structural signal: if a pitcher id is in home.pitchers, they pitched
  // for the home team. We use this to determine which team HIT each HR
  // (opposite of the pitcher's team).
  const awayPitcherSet = new Set(boxscore.teams?.away?.pitchers || []);
  const homePitcherSet = new Set(boxscore.teams?.home?.pitchers || []);

  // ── HR breakdown ──
  let hrTotal = 0, hrSolo = 0, hr2 = 0, hr3 = 0, hrGS = 0;
  let runsViaHr = 0, hrAway = 0, hrHome = 0;
  const hrByPitcher = {};

  for (const p of plays) {
    if (p.result?.eventType !== 'home_run') continue;
    const rbi = p.result?.rbi || 1;
    hrTotal++;
    runsViaHr += rbi;
    if (rbi === 1) hrSolo++;
    else if (rbi === 2) hr2++;
    else if (rbi === 3) hr3++;
    else if (rbi === 4) hrGS++;

    const pitcherId = p.matchup?.pitcher?.id;
    if (pitcherId) {
      hrByPitcher[pitcherId] = (hrByPitcher[pitcherId] || 0) + 1;
      // Team that hit it = opposite of the team the pitcher plays for.
      if (homePitcherSet.has(pitcherId)) hrAway++;
      else if (awayPitcherSet.has(pitcherId)) hrHome++;
      else {
        // Fallback if pitcher id isn't in either set (shouldn't happen)
        const half = p.about?.halfInning;
        if (half === 'top') hrAway++;
        else if (half === 'bottom') hrHome++;
      }
    }
  }

  // ── Pitching split: starter vs bullpen per team ──
  function pitchingSplit(side) {
    const teamBox = boxscore.teams?.[side];
    if (!teamBox) return { starter: null, bullpen: { ip: 0, runsAllowed: 0, earnedRuns: 0, hrAllowed: 0 } };
    const pitcherIds = teamBox.pitchers || [];
    const starterId = pitcherIds[0];
    let starter = null;
    // Sum bullpen in OUTS, not raw float IP, then convert back.
    let bpOuts = 0, bpR = 0, bpER = 0, bpHR = 0;
    for (const pid of pitcherIds) {
      const pData = teamBox.players?.[`ID${pid}`];
      if (!pData) continue;
      const ps = pData.stats?.pitching || {};
      const rawIp = ps.inningsPitched;
      const r = ps.runs || 0;
      const er = ps.earnedRuns || 0;
      const hr = hrByPitcher[pid] || 0;
      if (pid === starterId) {
        const displayIp = parseIPDisplay(rawIp);
        const starterOuts = ipToOuts(rawIp);
        starter = {
          name: pData.person?.fullName || `ID${pid}`,
          id: pid,
          ip: displayIp,
          runsAllowed: r,
          earnedRuns: er,
          hrAllowed: hr,
          pulledEarly: starterOuts < 15,   // < 5 IP
          wentDeep: starterOuts >= 21,     // >= 7 IP
          matchedProbable: null,
        };
      } else {
        bpOuts += ipToOuts(rawIp);
        bpR += r; bpER += er; bpHR += hr;
      }
    }
    if (starter) {
      const probId = probables[side]?.id;
      starter.matchedProbable = probId != null ? (starter.id === probId) : null;
    }
    return {
      starter,
      bullpen: {
        ip: outsToIp(bpOuts),
        runsAllowed: bpR,
        earnedRuns: bpER,
        hrAllowed: bpHR,
      },
    };
  }

  const awayPitching = pitchingSplit('away');
  const homePitching = pitchingSplit('home');

  // ── Defense ──
  function defenseStats(side) {
    const teamBox = boxscore.teams?.[side];
    if (!teamBox) return { errors: 0, unearnedRunsAllowed: 0 };
    const fielding = teamBox.teamStats?.fielding || {};
    const pitching = teamBox.teamStats?.pitching || {};
    const r = pitching.runs || 0;
    const er = pitching.earnedRuns || 0;
    return {
      errors: fielding.errors || 0,
      unearnedRunsAllowed: Math.max(0, r - er),
    };
  }

  return {
    matchup: `${awayAbbr}@${homeAbbr}`,
    away: awayAbbr,
    home: homeAbbr,
    gamePk,
    park: gameData.venue?.name || null,
    status: 'final',

    totals: {
      awayRuns: awayR,
      homeRuns: homeR,
      total,
      ceiling: total >= 12,
      floor: total <= 5,
    },

    homeRuns: {
      total: hrTotal,
      solo: hrSolo,
      twoRun: hr2,
      threeRun: hr3,
      grandSlam: hrGS,
      runsViaHr,
      byTeam: { away: hrAway, home: hrHome },
    },

    pitching: {
      away: awayPitching,
      home: homePitching,
    },

    defense: {
      away: defenseStats('away'),
      home: defenseStats('home'),
    },

    weatherActual: {
      temp: weather.temp ? parseInt(weather.temp) : null,
      condition: weather.condition || null,
      wind: weather.wind || null,
    },
  };
}

async function writeOutcomes(date, payload) {
  await put(`game-outcomes-${date}.json`, JSON.stringify(payload), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json',
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const date = req.query?.date || getYesterdayPT();

  try {
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
    const sched = await fetchJson(schedUrl);
    const allGames = sched?.dates?.[0]?.games || [];
    const finalGames = allGames.filter(g => g.status?.detailedState === 'Final');

    if (finalGames.length === 0) {
      return res.status(200).json({
        date, ok: true, games: 0,
        note: allGames.length > 0 ? `${allGames.length} games, none final` : 'no games scheduled',
      });
    }

    const CONCURRENCY = 5;
    const outcomes = [];
    const errors = [];
    for (let i = 0; i < finalGames.length; i += CONCURRENCY) {
      const batch = finalGames.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(fetchGameOutcome));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          outcomes.push(results[j].value);
        } else {
          errors.push({ gamePk: batch[j].gamePk, error: results[j].reason?.message || 'unknown' });
        }
      }
    }

    const payload = {
      date,
      fetchedAt: new Date().toISOString(),
      games: outcomes,
    };
    await writeOutcomes(date, payload);

    return res.status(200).json({
      date, ok: true,
      games: outcomes.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    return res.status(500).json({ date, ok: false, error: e.message });
  }
};
