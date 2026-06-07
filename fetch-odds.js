const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';

// How often the GitHub Actions workflow wakes this script (its cron cadence).
// Per-sport fetchEveryMinutes must be a multiple of this.
const RUN_EVERY_MIN = 12;

// Sports to fetch, each gated to its own season AND its own fetch frequency, so
// we only spend API quota when a sport is live and only as often as we want.
// The Odds API bills 1 credit per market, per region, per request (e.g. World
// Cup h2h,totals x us = 2 credits/request).
//
// Season gating per sport:
//   - seasonMonths: recurring annual season as a list of months (1-12). Handles
//     year-end wraparound automatically (e.g. NFL Sep-Feb = [9,10,11,12,1,2]).
//   - window: a fixed one-off date range { start, end } for non-recurring events.
//   - neither: always in season.
// Frequency gating per sport:
//   - fetchEveryMinutes: minimum minutes between fetches (default RUN_EVERY_MIN).
//     World Cup is throttled to 4h to fit a 500-credit plan; football fetches
//     every run (12 min) for high-resolution steam detection.
const SPORTS = [
  {
    sport: 'FIFA World Cup', sportKey: 'soccer_fifa_world_cup', fileName: 'worldcup',
    markets: 'h2h,totals',
    window: { start: '2026-06-07T00:00:00Z', end: '2026-07-20T00:00:00Z' }, // through the final (Jul 19, 2026)
    fetchEveryMinutes: 240, // every 4h (~370 credits/month)
  },
  {
    sport: 'NFL', sportKey: 'americanfootball_nfl', fileName: 'nfl',
    markets: 'h2h,spreads,totals',
    seasonMonths: [9, 10, 11, 12, 1, 2], // September - February
    fetchEveryMinutes: 12, // every run, for steam detection
  },
  {
    sport: 'NCAA Football', sportKey: 'americanfootball_ncaaf', fileName: 'ncaaf',
    markets: 'h2h,spreads,totals',
    seasonMonths: [8, 9, 10, 11, 12, 1], // August - January
    fetchEveryMinutes: 12, // every run, for steam detection
  },
];

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

// Whether a sport should fetch on this run, based on its fetchEveryMinutes.
// Uses the run's time slot (rounded to the cron cadence) so it fires once per
// interval and tolerates GitHub's cron jitter without double-firing.
function isSportDue(sport, now = new Date()) {
  const every = sport.fetchEveryMinutes || RUN_EVERY_MIN;
  const slotsPerInterval = Math.max(1, Math.round(every / RUN_EVERY_MIN));
  const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slotIndex = Math.round(minutesSinceMidnight / RUN_EVERY_MIN);
  return slotIndex % slotsPerInterval === 0;
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

async function fetchOdds(sport, sportKey, fileName, markets = 'h2h,spreads,totals') {
  try {
    console.log(`Fetching ${sport} odds...`);
    
    const response = await fetchWithRetry(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
      apiKey: ODDS_API_KEY,
      regions: 'us',
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
    
    // Fetch only sports that are in season AND due this run (no quota otherwise).
    const now = new Date();
    const activeSports = SPORTS.filter(s => isSportActive(s, now) && isSportDue(s, now));
    if (activeSports.length === 0) {
      console.log('No sports in season and due this run; skipping. No API quota used.');
      return;
    }
    console.log(`Fetching this run: ${activeSports.map(s => s.sport).join(', ')}`);
    
    const results = await Promise.all(
      activeSports.map(s => fetchOdds(s.sport, s.sportKey, s.fileName, s.markets))
    );
    
    // Create combined summary
    const summary = {
      lastUpdated: new Date().toISOString(),
      sports: []
    };
    
    results.forEach((result, i) => {
      if (result) {
        summary.sports.push({
          sport: result.sport,
          gameCount: result.gameCount,
          fileName: `${activeSports[i].fileName}.json`
        });
      }
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
