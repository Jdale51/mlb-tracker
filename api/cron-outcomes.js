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
  // Apply -7h offset, then drop one day
  const d = new Date(Date.now() + -7 * 60 * 60 * 1000 - 86400000);
  return d.toISOString().split('T')[0];
}

// MLB reports IP as a float where .1 = 1/3 inning, .2 = 2/3. Keep native format.
function parseIP(s) {
  if (s == null || s === '') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// Pull the live feed for a gamePk and extract everything we need.
// Live feed has both boxscore-equivalent data and full play-by-play for HR breakdown.
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

  // ── HR breakdown: walk all plays, filter home_run events, count by RBI ──
  let hrTotal = 0, hrSolo = 0, hr2 = 0, hr3 = 0, hrGS = 0;
  let runsViaHr = 0, hrAway = 0, hrHome = 0;
  // We also need starter HR allowed / bullpen HR allowed per team — track by pitcher id.
  const hrByPitcher = {}; // { pitcherId: count }

  for (const p of plays) {
    if (p.result?.eventType !== 'home_run') continue;
    const rbi = p.result?.rbi || 1;
    hrTotal++;
    runsViaHr += rbi;
    if (rbi === 1) hrSolo++;
    else if (rbi === 2) hr2++;
    else if (rbi === 3) hr3++;
    else if (rbi === 4) hrGS++;

    // which team hit it? matchup.batter.parent team — easier: halfInning + home/away
    const halfInning = p.about?.halfInning; // 'top' = away batting, 'bottom' = home batting
    if (halfInning === 'top') hrAway++;
    else if (halfInning === 'bottom') hrHome++;

    // which pitcher allowed it?
    const pitcherId = p.matchup?.pitcher?.id;
    if (pitcherId) hrByPitcher[pitcherId] = (hrByPitcher[pitcherId] || 0) + 1;
  }

  // ── Pitching split: starter vs bullpen per team ──
  function pitchingSplit(side) {
    const teamBox = boxscore.teams?.[side];
    if (!teamBox) return { starter: null, bullpen: { ip: 0, runsAllowed: 0, earnedRuns: 0, hrAllowed: 0 } };
    const pitcherIds = teamBox.pitchers || [];
    // Starter = first pitcher in the pitchers array (MLB's convention)
    const starterId = pitcherIds[0];
    let starter = null;
    let bpIp = 0, bpR = 0, bpER = 0, bpHR = 0;
    for (const pid of pitcherIds) {
      const pData = teamBox.players?.[`ID${pid}`];
      if (!pData) continue;
      const ps = pData.stats?.pitching || {};
      const ip = parseIP(ps.inningsPitched);
      const r = ps.runs || 0;
      const er = ps.earnedRuns || 0;
      const hr = hrByPitcher[pid] || 0;
      if (pid === starterId) {
        starter = {
          name: pData.person?.fullName || `ID${pid}`,
          id: pid,
          ip,
          runsAllowed: r,
          earnedRuns: er,
          hrAllowed: hr,
          pulledEarly: ip < 5,
          wentDeep: ip >= 7,
          matchedProbable: null, // fill below
        };
      } else {
        bpIp += ip; bpR += r; bpER += er; bpHR += hr;
      }
    }
    // matchedProbable: compare starter id to gameData.probablePitchers[side].id
    if (starter) {
      const probId = probables[side]?.id;
      starter.matchedProbable = probId != null ? (starter.id === probId) : null;
    }
    return {
      starter,
      bullpen: { ip: Math.round(bpIp * 10) / 10, runsAllowed: bpR, earnedRuns: bpER, hrAllowed: bpHR },
    };
  }

  const awayPitching = pitchingSplit('away');
  const homePitching = pitchingSplit('home');

  // ── Defense: errors and unearned runs ──
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
    // Pull schedule for the date
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

    // Fetch outcomes in parallel, but cap concurrency so we don't hammer the API.
    // MLB Stats API is free but ~15 games × ~200ms each in serial = 3s, acceptable.
    // Parallel with modest concurrency is safer.
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
