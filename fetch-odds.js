const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';
const DEFAULT_REGIONS = 'us';
const parsedQuotaReserveCredits = Number.parseInt(
  process.env.ODDS_API_QUOTA_RESERVE_CREDITS || '20',
  10
);
const QUOTA_RESERVE_CREDITS = Number.isFinite(parsedQuotaReserveCredits)
  ? Math.max(parsedQuotaReserveCredits, 0)
  : 20;

// The workflow cron wakes the script this often; fetchEveryMinutes values are
// multiples of it. The Odds API bills 1 credit per market, per region, per
// request (World Cup h2h,totals x us = 2 credits).
const RUN_EVERY_MIN = 12;

// Per-sport config. See README "Scheduling & quota" for the gating model.
//   season: seasonMonths (recurring, 1-12, wraps year-end) or window {start,end}
//   cadence: fetchEveryMinutes (min minutes between fetches)
//   markets/regions determine the estimated API credit cost
const SPORTS = [
  {
    sport: 'FIFA World Cup', sportKey: 'soccer_fifa_world_cup', fileName: 'worldcup',
    markets: 'h2h,totals',
    regions: DEFAULT_REGIONS,
    window: { start: '2026-06-07T00:00:00Z', end: '2026-07-20T00:00:00Z' },
    fetchEveryMinutes: 12, // every scheduled run (~7,200 credits/30-day month)
  },
  {
    sport: 'NFL', sportKey: 'americanfootball_nfl', fileName: 'nfl',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [9, 10, 11, 12, 1, 2], // Sep - Feb
    fetchEveryMinutes: 12,
  },
  {
    sport: 'NCAA Football', sportKey: 'americanfootball_ncaaf', fileName: 'ncaaf',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [8, 9, 10, 11, 12, 1], // Aug - Jan
    fetchEveryMinutes: 12,
  },
];

function countCsvValues(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .length;
}

function estimateCredits(sport) {
  return countCsvValues(sport.markets || 'h2h') * countCsvValues(sport.regions || DEFAULT_REGIONS);
}

function readNumberHeader(headers, name) {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseQuotaHeaders(headers) {
  const remaining = readNumberHeader(headers, 'x-requests-remaining');
  const used = readNumberHeader(headers, 'x-requests-used');
  const last = readNumberHeader(headers, 'x-requests-last');
  if (remaining === null && used === null && last === null) return null;
  return { remaining, used, last };
}

// Whether a sport is in season right now (UTC).
function isSportActive(sport, now = new Date()) {
  if (sport.window) {
    const t = now.getTime();
    return t >= new Date(sport.window.start).getTime() && t < new Date(sport.window.end).getTime();
  }
  if (sport.seasonMonths) {
    return sport.seasonMonths.includes(now.getUTCMonth() + 1);
  }
  return true;
}

// Last-fetch state from the previous run (persisted in summary.json), keyed by
// "<fileName>.json".
function loadLastFetched() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(ODDS_DIR, 'summary.json'), 'utf8'));
    const map = {};
    (prev.sports || []).forEach(s => {
      if (s.fileName) map[s.fileName] = { lastFetched: s.lastFetched || null, gameCount: s.gameCount };
    });
    return map;
  } catch {
    return {};
  }
}

// Due based on elapsed time since last fetch (not wall-clock slots), so it's
// robust to GitHub cron jitter and skipped runs. Half-step slack avoids
// drifting a full cron step late.
function isSportDue(sport, lastFetchedIso, now = new Date()) {
  if (!lastFetchedIso) return true; // never fetched -> fetch now
  const every = sport.fetchEveryMinutes || RUN_EVERY_MIN;
  const elapsedMin = (now.getTime() - new Date(lastFetchedIso).getTime()) / 60000;
  return elapsedMin >= every - RUN_EVERY_MIN / 2;
}

// Ensure odds directory exists
if (!fs.existsSync(ODDS_DIR)) {
  fs.mkdirSync(ODDS_DIR, { recursive: true });
}

// Retry logic for API calls
async function fetchWithRetry(url, params, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`API attempt ${attempt}/${maxRetries}...`);
      const response = await axios.get(url, { params });
      return response;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (error.response?.status === 429) {
        // Rate limit - wait longer
        const waitTime = delay * Math.pow(2, attempt - 1);
        console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else if (attempt === maxRetries) {
        throw error;
      } else {
        // Other errors - wait and retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

async function fetchQuotaStatus() {
  try {
    const response = await fetchWithRetry('https://api.the-odds-api.com/v4/sports/', {
      apiKey: ODDS_API_KEY
    }, 2);
    const quota = parseQuotaHeaders(response.headers);
    if (quota) {
      console.log(`Quota check: ${quota.remaining ?? 'unknown'} credits remaining, ${quota.used ?? 'unknown'} used`);
    }
    return quota;
  } catch (error) {
    console.warn(`Quota check failed (${error.message}); proceeding with cadence guards only.`);
    return null;
  }
}

function selectSportsWithinQuota(sports, quota) {
  if (!quota || quota.remaining === null) {
    return { selected: sports, skipped: [] };
  }

  let spendable = quota.remaining - QUOTA_RESERVE_CREDITS;
  const selected = [];
  const skipped = [];

  sports.forEach(sport => {
    const estimatedCredits = estimateCredits(sport);
    if (spendable >= estimatedCredits) {
      selected.push(sport);
      spendable -= estimatedCredits;
    } else {
      skipped.push({ sport, estimatedCredits });
    }
  });

  return { selected, skipped };
}

async function fetchOdds(config) {
  const {
    sport,
    sportKey,
    fileName,
    markets = 'h2h,spreads,totals',
    regions = DEFAULT_REGIONS
  } = config;

  try {
    console.log(`Fetching ${sport} odds (${estimateCredits(config)} estimated credits)...`);
    
    const response = await fetchWithRetry(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
      apiKey: ODDS_API_KEY,
      regions,
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso'
    });

    const oddsData = response.data;
    console.log(`Fetched ${oddsData.length} ${sport} games with odds`);

    // Save to sport-specific JSON file
    const filePath = path.join(ODDS_DIR, `${fileName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(oddsData, null, 2));
    
    console.log(`${sport} odds saved to ${filePath}`);
    
    return {
      sport,
      gameCount: oddsData.length,
      estimatedCredits: estimateCredits(config),
      quota: parseQuotaHeaders(response.headers),
      games: oddsData.map(game => ({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        bookmakers: game.bookmakers?.length || 0
      }))
    };
    
  } catch (error) {
    console.error(`Error fetching ${sport} odds:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return null;
  }
}

async function fetchAllOdds() {
  try {
    console.log('Starting odds fetching...');

    if (!ODDS_API_KEY) {
      throw new Error('ODDS_API_KEY is required');
    }
    
    const now = new Date();
    // Manual "Run workflow" triggers (or FORCE_FETCH=true) bypass the frequency
    // throttle. The quota reserve still applies before any paid API call.
    const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      || process.env.FORCE_FETCH === 'true';
    const lastFetched = loadLastFetched();
    
    // Fetch sports that are in season and (due by elapsed time OR a manual run).
    const inSeason = SPORTS.filter(s => isSportActive(s, now));
    const due = inSeason.filter(s =>
      isManual || isSportDue(s, lastFetched[`${s.fileName}.json`]?.lastFetched, now)
    );
    if (due.length === 0) {
      console.log(inSeason.length === 0
        ? 'No sports in season; skipping. No API quota used.'
        : 'In-season sports not due yet; skipping. No API quota used.');
      return;
    }
    console.log(`Fetching this run${isManual ? ' (manual)' : ''}: ${due.map(s => s.sport).join(', ')}`);

    const quotaBefore = await fetchQuotaStatus();
    const { selected: quotaAllowed, skipped: quotaSkipped } = selectSportsWithinQuota(due, quotaBefore);
    quotaSkipped.forEach(({ sport, estimatedCredits }) => {
      console.log(
        `Skipping ${sport.sport}: needs ${estimatedCredits} credits and reserve is ${QUOTA_RESERVE_CREDITS}`
      );
    });

    if (quotaAllowed.length === 0) {
      console.log('No due sports fit within the remaining quota reserve. No paid API quota used.');
      return;
    }
    
    const results = await Promise.all(
      quotaAllowed.map(s => fetchOdds(s))
    );
    
    // Map this run's successful fetches by output file.
    const nowIso = now.toISOString();
    const fetchedByFile = {};
    quotaAllowed.forEach((s, i) => { if (results[i]) fetchedByFile[`${s.fileName}.json`] = results[i]; });
    const latestQuota = results
      .map(result => result?.quota)
      .filter(Boolean)
      .pop() || quotaBefore;
    
    // Build summary for all in-season sports, carrying forward last-fetch state
    // for any in-season sport not (successfully) fetched on this run.
    const summary = {
      lastUpdated: nowIso,
      quota: latestQuota ? {
        remaining: latestQuota.remaining,
        used: latestQuota.used,
        lastRequestCost: latestQuota.last,
        reserveCredits: QUOTA_RESERVE_CREDITS
      } : null,
      sports: []
    };
    inSeason.forEach(s => {
      const fileKey = `${s.fileName}.json`;
      const fetched = fetchedByFile[fileKey];
      const prev = lastFetched[fileKey];
      summary.sports.push({
        sport: s.sport,
        gameCount: fetched ? fetched.gameCount : (prev ? prev.gameCount : 0),
        fileName: fileKey,
        lastFetched: fetched ? nowIso : (prev ? prev.lastFetched : null)
      });
    });
    
    // Save combined summary
    const summaryPath = path.join(ODDS_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`Summary saved to ${summaryPath}`);
    console.log('Enhanced odds fetching completed successfully!');
    
    // Git version control for historical data
    try {
      console.log('Committing odds changes to Git...');
      execSync('git add odds/', { stdio: 'inherit' });
      execSync(`git commit -m "Odds update $(date '+%Y-%m-%d %H:%M')"`, { stdio: 'inherit' });
      console.log('Git commit successful');
    } catch (gitError) {
      console.error('Git commit failed:', gitError.message);
      // Don't fail the entire process if Git fails
    }
    
  } catch (error) {
    console.error('Error in fetchAllOdds:', error.message);
    process.exit(1);
  }
}

// Run the enhanced fetch
fetchAllOdds();
