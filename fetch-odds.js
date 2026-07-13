const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';
const DEFAULT_REGIONS = 'us';
const parsedOddsApiTimeoutMs = Number.parseInt(
  process.env.ODDS_API_TIMEOUT_MS || '15000',
  10
);
const ODDS_API_TIMEOUT_MS = Number.isFinite(parsedOddsApiTimeoutMs)
  ? Math.max(parsedOddsApiTimeoutMs, 1000)
  : 15000;
const parsedQuotaReserveCredits = Number.parseInt(
  process.env.ODDS_API_QUOTA_RESERVE_CREDITS || '20',
  10
);
const QUOTA_RESERVE_CREDITS = Number.isFinite(parsedQuotaReserveCredits)
  ? Math.max(parsedQuotaReserveCredits, 0)
  : 20;
const WORLDCUP_SPORT_KEY = 'soccer_fifa_world_cup';
const MLB_SPORT_KEY = 'baseball_mlb';
const KBO_SPORT_KEY = 'baseball_kbo';
const MLB_TIME_ZONE = 'America/New_York';
const KBO_TIME_ZONE = 'Asia/Seoul';
const BASEBALL_WINDOW_START_BUFFER_HOURS = 2;
const BASEBALL_WINDOW_END_DAYS = 2;
const BASEBALL_EVENT_ID_BATCH_SIZE = 50;
const BASEBALL_EVENT_WINDOW_SPORTS = {
  [MLB_SPORT_KEY]: {
    timeZone: MLB_TIME_ZONE,
    debugPrefix: 'mlb',
    slateLabel: 'NY slate window'
  },
  [KBO_SPORT_KEY]: {
    timeZone: KBO_TIME_ZONE,
    debugPrefix: 'kbo',
    slateLabel: 'Korea slate window'
  }
};

// The workflow cron wakes the script this often; fetchEveryMinutes values are
// multiples of it. The Odds API bills 1 credit per market, per region, per
// request. World Cup featured odds cost 2 credits, plus up to 1 credit per
// event when a to_qualify market is returned by the event-odds endpoint.
const RUN_EVERY_MIN = 12;

// Per-sport config. See README "Scheduling & quota" for the gating model.
//   season: seasonMonths (recurring, 1-12, wraps year-end) or window {start,end}
//   cadence: fetchEveryMinutes (min minutes between fetches)
//   markets/regions determine the estimated API credit cost
const SPORTS = [
  {
    sport: 'FIFA World Cup', sportKey: WORLDCUP_SPORT_KEY, fileName: 'worldcup',
    markets: 'h2h,totals',
    eventMarkets: 'to_qualify',
    estimatedCredits: 6,
    regions: DEFAULT_REGIONS,
    window: { start: '2026-06-07T00:00:00Z', end: '2026-07-20T00:00:00Z' },
    fetchEveryMinutes: 12, // every 15-minute dispatch (~8,640 credits/30-day month)
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
  {
    sport: 'MLB', sportKey: MLB_SPORT_KEY, fileName: 'mlb',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10], // Mar - Oct
    estimatedPaidRequests: 2,
    fetchEveryMinutes: 12,
  },
  {
    sport: 'KBO', sportKey: KBO_SPORT_KEY, fileName: 'kbo',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11], // Mar - Nov
    estimatedPaidRequests: 2,
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
  if (Number.isFinite(sport.estimatedCredits)) {
    return sport.estimatedCredits;
  }

  const paidRequests = sport.estimatedPaidRequests || 1;
  return countCsvValues(sport.markets || 'h2h')
    * countCsvValues(sport.regions || DEFAULT_REGIONS)
    * paidRequests;
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

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const values = {};
  formatter.formatToParts(date).forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtcDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const firstDate = new Date(utcGuess - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(firstDate, timeZone);
  return secondOffset === firstOffset
    ? firstDate
    : new Date(utcGuess - secondOffset);
}

function addDaysToPlainDate({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function formatOddsApiIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildBaseballEventWindow(timeZone, now = new Date()) {
  const today = getZonedParts(now, timeZone);
  const todayDate = { year: today.year, month: today.month, day: today.day };
  const endDate = addDaysToPlainDate(todayDate, BASEBALL_WINDOW_END_DAYS);
  const todayStartUtc = zonedTimeToUtcDate(todayDate, timeZone);
  const windowEndUtc = zonedTimeToUtcDate(endDate, timeZone);
  const windowStartUtc = new Date(
    todayStartUtc.getTime() - BASEBALL_WINDOW_START_BUFFER_HOURS * 60 * 60 * 1000
  );

  return {
    timeZone,
    startBufferHours: BASEBALL_WINDOW_START_BUFFER_HOURS,
    commenceTimeFrom: formatOddsApiIso(windowStartUtc),
    commenceTimeTo: formatOddsApiIso(windowEndUtc)
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getCommenceTimeRange(games) {
  const times = games
    .map(game => game.commence_time)
    .filter(Boolean)
    .sort();
  return {
    earliest: times[0] || null,
    latest: times[times.length - 1] || null
  };
}

function summarizeGames(oddsData) {
  return oddsData.map(game => ({
    id: game.id,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    bookmakers: game.bookmakers?.length || 0
  }));
}

function addOddsGamesById(target, oddsData) {
  (Array.isArray(oddsData) ? oddsData : []).forEach(game => {
    if (game?.id) target.set(game.id, game);
  });
}

function mergeAdditionalMarkets(targetGame, sourceGame) {
  if (!targetGame || !sourceGame) return;

  if (!Array.isArray(targetGame.bookmakers)) targetGame.bookmakers = [];
  (sourceGame.bookmakers || []).forEach(sourceBookmaker => {
    const targetBookmaker = targetGame.bookmakers.find(bookmaker =>
      bookmaker.key === sourceBookmaker.key
    );
    if (!targetBookmaker) {
      targetGame.bookmakers.push(sourceBookmaker);
      return;
    }

    if (!Array.isArray(targetBookmaker.markets)) targetBookmaker.markets = [];
    (sourceBookmaker.markets || []).forEach(sourceMarket => {
      const existingIndex = targetBookmaker.markets.findIndex(market =>
        market.key === sourceMarket.key
      );
      if (existingIndex >= 0) {
        targetBookmaker.markets[existingIndex] = sourceMarket;
      } else {
        targetBookmaker.markets.push(sourceMarket);
      }
    });

    if (sourceBookmaker.last_update) {
      targetBookmaker.last_update = sourceBookmaker.last_update;
    }
  });
}

function isGameWithinWindow(game, window) {
  const commenceTime = Date.parse(game?.commence_time);
  return Number.isFinite(commenceTime)
    && commenceTime >= new Date(window.commenceTimeFrom).getTime()
    && commenceTime < new Date(window.commenceTimeTo).getTime();
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
      const response = await axios.get(url, {
        params,
        timeout: ODDS_API_TIMEOUT_MS
      });
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

async function fetchBaseballOddsByEventWindow(config, windowConfig) {
  const {
    sport,
    sportKey,
    fileName,
    markets = 'h2h,spreads,totals',
    regions = DEFAULT_REGIONS
  } = config;
  const { timeZone, debugPrefix, slateLabel } = windowConfig;
  const window = buildBaseballEventWindow(timeZone);
  console.log(
    `Fetching ${sport} events from ${window.commenceTimeFrom} to ${window.commenceTimeTo} (${window.timeZone})...`
  );

  const eventsResponse = await fetchWithRetry(`https://api.the-odds-api.com/v4/sports/${sportKey}/events`, {
    apiKey: ODDS_API_KEY,
    dateFormat: 'iso',
    commenceTimeFrom: window.commenceTimeFrom,
    commenceTimeTo: window.commenceTimeTo
  });
  const events = Array.isArray(eventsResponse.data) ? eventsResponse.data : [];
  const eventIds = [...new Set(events.map(event => event.id).filter(Boolean))];
  console.log(`Fetched ${events.length} ${sport} events in ${slateLabel}`);

  const eventOddsById = new Map();
  let latestQuota = parseQuotaHeaders(eventsResponse.headers);
  const batches = chunkArray(eventIds, BASEBALL_EVENT_ID_BATCH_SIZE);

  for (const batch of batches) {
    console.log(`Fetching ${sport} odds for ${batch.length} event ids...`);
    const response = await fetchWithRetry(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
      apiKey: ODDS_API_KEY,
      regions,
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
      eventIds: batch.join(',')
    });
    latestQuota = parseQuotaHeaders(response.headers) || latestQuota;
    addOddsGamesById(eventOddsById, response.data);
  }

  const eventOddsData = eventIds
    .map(id => eventOddsById.get(id))
    .filter(Boolean);

  console.log(`Fetching ${sport} direct odds for ${slateLabel}...`);
  const directResponse = await fetchWithRetry(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
    apiKey: ODDS_API_KEY,
    regions,
    markets,
    oddsFormat: 'american',
    dateFormat: 'iso',
    commenceTimeFrom: window.commenceTimeFrom,
    commenceTimeTo: window.commenceTimeTo
  });
  latestQuota = parseQuotaHeaders(directResponse.headers) || latestQuota;
  const directOddsById = new Map();
  addOddsGamesById(directOddsById, directResponse.data);

  const mergedOddsById = new Map();
  addOddsGamesById(mergedOddsById, eventOddsData);
  addOddsGamesById(mergedOddsById, Array.from(directOddsById.values()));

  const oddsData = Array.from(mergedOddsById.values())
    .filter(game => isGameWithinWindow(game, window));
  const missingOddsEventIds = eventIds.filter(id => !mergedOddsById.has(id));
  const warning = events.length > 0 && missingOddsEventIds.length > 0
    ? `${missingOddsEventIds.length} ${sport} event(s) returned by /events had no odds after event-id and direct /odds fetches`
    : null;
  const commenceRange = getCommenceTimeRange(oddsData);

  if (warning) {
    console.warn(`Warning: ${warning}`);
  }

  const filePath = path.join(ODDS_DIR, `${fileName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(oddsData, null, 2));

  console.log(`Fetched odds for ${oddsData.length} ${sport} events`);
  console.log(`${sport} odds saved to ${filePath}`);

  return {
    sport,
    gameCount: oddsData.length,
    estimatedCredits: countCsvValues(markets) * countCsvValues(regions) * (batches.length + 1),
    quota: latestQuota,
    debug: {
      [`${debugPrefix}WindowStart`]: window.commenceTimeFrom,
      [`${debugPrefix}WindowEnd`]: window.commenceTimeTo,
      [`${debugPrefix}WindowTimeZone`]: window.timeZone,
      [`${debugPrefix}EventCount`]: events.length,
      [`${debugPrefix}EventOddsCount`]: eventOddsData.length,
      [`${debugPrefix}DirectOddsCount`]: directOddsById.size,
      [`${debugPrefix}MergedOddsCount`]: oddsData.length,
      earliestCommenceTime: commenceRange.earliest,
      latestCommenceTime: commenceRange.latest,
      warning,
      missingOddsEventIds
    },
    games: summarizeGames(oddsData)
  };
}

async function fetchWorldCupOdds(config) {
  const {
    sport,
    sportKey,
    fileName,
    markets = 'h2h,totals',
    eventMarkets = 'to_qualify',
    regions = DEFAULT_REGIONS
  } = config;

  console.log(`Fetching ${sport} featured odds (${markets})...`);
  const featuredResponse = await fetchWithRetry(
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`,
    {
      apiKey: ODDS_API_KEY,
      regions,
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso'
    }
  );
  const oddsData = Array.isArray(featuredResponse.data) ? featuredResponse.data : [];
  let latestQuota = parseQuotaHeaders(featuredResponse.headers);
  let toQualifyMarketCount = 0;

  await Promise.all(oddsData.map(async game => {
    try {
      console.log(`Fetching ${sport} ${eventMarkets} odds for event ${game.id}...`);
      const eventResponse = await fetchWithRetry(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${game.id}/odds`,
        {
          apiKey: ODDS_API_KEY,
          regions,
          markets: eventMarkets,
          oddsFormat: 'american',
          dateFormat: 'iso'
        }
      );
      latestQuota = parseQuotaHeaders(eventResponse.headers) || latestQuota;
      mergeAdditionalMarkets(game, eventResponse.data);
      toQualifyMarketCount += (eventResponse.data?.bookmakers || [])
        .flatMap(bookmaker => bookmaker.markets || [])
        .filter(market => market.key === 'to_qualify')
        .length;
    } catch (error) {
      console.warn(
        `Unable to fetch ${eventMarkets} for ${sport} event ${game.id}; preserving featured odds: ${error.message}`
      );
    }
  }));

  const filePath = path.join(ODDS_DIR, `${fileName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(oddsData, null, 2));
  console.log(
    `Fetched ${oddsData.length} ${sport} games; merged ${toQualifyMarketCount} bookmaker to_qualify markets`
  );
  console.log(`${sport} odds saved to ${filePath}`);

  return {
    sport,
    gameCount: oddsData.length,
    estimatedCredits: estimateCredits(config),
    quota: latestQuota,
    debug: {
      featuredMarkets: markets,
      eventMarkets,
      eventMarketRequests: oddsData.length,
      toQualifyMarketCount
    },
    games: summarizeGames(oddsData)
  };
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
    if (sportKey === WORLDCUP_SPORT_KEY) {
      return await fetchWorldCupOdds(config);
    }

    const baseballWindowConfig = BASEBALL_EVENT_WINDOW_SPORTS[sportKey];
    if (baseballWindowConfig) {
      return await fetchBaseballOddsByEventWindow(config, baseballWindowConfig);
    }

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
      games: summarizeGames(oddsData)
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
      const summarySport = {
        sport: s.sport,
        gameCount: fetched ? fetched.gameCount : (prev ? prev.gameCount : 0),
        fileName: fileKey,
        lastFetched: fetched ? nowIso : (prev ? prev.lastFetched : null)
      };
      if (fetched?.debug) summarySport.debug = fetched.debug;
      summary.sports.push(summarySport);
    });
    
    // Save combined summary
    const summaryPath = path.join(ODDS_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`Summary saved to ${summaryPath}`);
    console.log('Enhanced odds fetching completed successfully!');
    
  } catch (error) {
    console.error('Error in fetchAllOdds:', error.message);
    process.exit(1);
  }
}

// Run the enhanced fetch
fetchAllOdds();
