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
const NFL_REGULAR_SPORT_KEY = 'americanfootball_nfl';
const NFL_PRESEASON_SPORT_KEY = 'americanfootball_nfl_preseason';
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
// request (World Cup h2h,totals x us = 2 credits).
const RUN_EVERY_MIN = 5;

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
    fetchEveryMinutes: 5, // every scheduled run
  },
  {
    // Same soccer profile as World Cup: three-way h2h (home/away/Draw) + totals.
    // Dedicated epl.json so Prophet never mixes this feed with worldcup.json.
    sport: 'epl', sportKey: 'soccer_epl', fileName: 'epl',
    markets: 'h2h,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [8, 9, 10, 11, 12, 1, 2, 3, 4, 5], // Aug - May
    fetchEveryMinutes: 5,
  },
  {
    sport: 'NFL', sportKey: NFL_REGULAR_SPORT_KEY, fileName: 'nfl',
    preseasonSportKey: NFL_PRESEASON_SPORT_KEY,
    preseasonFallbackWindow: {
      start: { month: 8, day: 1 },
      end: { month: 9, day: 10 }
    },
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [8, 9, 10, 11, 12, 1, 2], // Aug - Feb
    fetchEveryMinutes: 5,
  },
  {
    sport: 'NCAA Football', sportKey: 'americanfootball_ncaaf', fileName: 'ncaaf',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [8, 9, 10, 11, 12, 1], // Aug - Jan
    fetchEveryMinutes: 5,
  },
  {
    sport: 'WNBA', sportKey: 'basketball_wnba', fileName: 'wnba',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [5, 6, 7, 8, 9, 10], // May - Oct
    fetchEveryMinutes: 5,
  },
  {
    sport: 'MLB', sportKey: MLB_SPORT_KEY, fileName: 'mlb',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10], // Mar - Oct
    estimatedPaidRequests: 2,
    fetchEveryMinutes: 5,
  },
  {
    sport: 'KBO', sportKey: KBO_SPORT_KEY, fileName: 'kbo',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11], // Mar - Nov
    estimatedPaidRequests: 2,
    fetchEveryMinutes: 5,
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
  const paidRequests = (sport.estimatedPaidRequests || 1)
    + (sport.includePreseason ? 1 : 0);
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

function parseAvailableSportKeys(sportsData) {
  if (!Array.isArray(sportsData)) return null;
  return new Set(
    sportsData
      .filter(sport => sport?.key && sport.active !== false)
      .map(sport => sport.key)
  );
}

function monthDayValue({ month, day }) {
  return month * 100 + day;
}

function isPreseasonActive(sport, availableSportKeys, now = new Date()) {
  if (!sport.preseasonSportKey) return false;

  // The no-cost /sports response is the strongest signal: by default it lists
  // sports that are currently offered. An empty Set is known availability with
  // no preseason feed; null means the availability request failed.
  if (availableSportKeys instanceof Set) {
    return availableSportKeys.has(sport.preseasonSportKey);
  }

  const fallback = sport.preseasonFallbackWindow;
  if (!fallback) return false;
  const current = monthDayValue({
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate()
  });
  return current >= monthDayValue(fallback.start)
    && current < monthDayValue(fallback.end);
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

function compareOddsGames(left, right) {
  const leftTime = String(left?.commence_time || '');
  const rightTime = String(right?.commence_time || '');
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;

  const leftId = String(left?.id || '');
  const rightId = String(right?.id || '');
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function mergeOddsGames(...feeds) {
  const gamesById = new Map();
  feeds.forEach(feed => {
    (Array.isArray(feed) ? feed : []).forEach(game => {
      if (game?.id) gamesById.set(game.id, game);
    });
  });
  return Array.from(gamesById.values()).sort(compareOddsGames);
}

function assertExpectedSportKey(oddsData, sportKey) {
  const games = Array.isArray(oddsData) ? oddsData : [];
  const unexpectedKeys = [...new Set(
    games
      .filter(game => game?.sport_key !== sportKey)
      .map(game => game?.sport_key || '(missing)')
  )];
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `Refusing to write ${sportKey} odds: feed included foreign sport_key(s) ${unexpectedKeys.join(', ')}`
    );
  }
}

function countNflGamesByFeed(games) {
  const list = Array.isArray(games) ? games : [];
  return {
    regularSeasonGameCount: list.filter(
      game => game?.sport_key === NFL_REGULAR_SPORT_KEY
    ).length,
    preseasonGameCount: list.filter(
      game => game?.sport_key === NFL_PRESEASON_SPORT_KEY
    ).length
  };
}

function addOddsGamesById(target, oddsData) {
  (Array.isArray(oddsData) ? oddsData : []).forEach(game => {
    if (game?.id) target.set(game.id, game);
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
      if (s.fileName) {
        map[s.fileName] = {
          lastFetched: s.lastFetched || null,
          gameCount: s.gameCount,
          lastAttemptAt: s.lastAttemptAt || null,
          lastAttemptStatus: s.lastAttemptStatus || null,
          lastError: s.lastError || null,
          regularSeasonGameCount: s.regularSeasonGameCount,
          preseasonGameCount: s.preseasonGameCount
        };
      }
    });
    const nflState = map['nfl.json'];
    if (nflState && (
      !Number.isInteger(nflState.regularSeasonGameCount)
      || !Number.isInteger(nflState.preseasonGameCount)
    )) {
      try {
        const existingNfl = JSON.parse(
          fs.readFileSync(path.join(ODDS_DIR, 'nfl.json'), 'utf8')
        );
        Object.assign(nflState, countNflGamesByFeed(existingNfl));
      } catch {
        nflState.regularSeasonGameCount ??= 0;
        nflState.preseasonGameCount ??= 0;
      }
    }
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

function buildApiRequestUrl(url, params = {}) {
  const requestUrl = new URL(url);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== null) {
      requestUrl.searchParams.set(name, String(value));
    }
  });
  return requestUrl;
}

async function fetchJson(url, params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || ODDS_API_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildApiRequestUrl(url, params), {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    const rawBody = await response.text();
    let data = null;
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = rawBody;
      }
    }
    const headers = Object.fromEntries(response.headers.entries());

    if (!response.ok) {
      const error = new Error(`Request failed with status code ${response.status}`);
      error.response = { status: response.status, data, headers };
      throw error;
    }

    return { data, headers, status: response.status };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Retry logic for API calls
async function fetchWithRetry(url, params, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`API attempt ${attempt}/${maxRetries}...`);
      return await fetchJson(url, params);
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

async function fetchProviderStatus() {
  try {
    const response = await fetchWithRetry('https://api.the-odds-api.com/v4/sports/', {
      apiKey: ODDS_API_KEY
    }, 2);
    const quota = parseQuotaHeaders(response.headers);
    if (quota) {
      console.log(`Quota check: ${quota.remaining ?? 'unknown'} credits remaining, ${quota.used ?? 'unknown'} used`);
    }
    return {
      quota,
      availableSportKeys: parseAvailableSportKeys(response.data)
    };
  } catch (error) {
    console.warn(`Quota check failed (${error.message}); proceeding with cadence guards only.`);
    return { quota: null, availableSportKeys: null };
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

async function fetchNflOdds(config, dependencies = {}) {
  const request = dependencies.fetchRequest || fetchWithRetry;
  const writeFile = dependencies.writeFile || fs.writeFileSync;
  const {
    sport,
    sportKey,
    preseasonSportKey,
    fileName,
    markets = 'h2h,spreads,totals',
    regions = DEFAULT_REGIONS,
    includePreseason = false
  } = config;
  const requestParams = {
    apiKey: ODDS_API_KEY,
    regions,
    markets,
    oddsFormat: 'american',
    dateFormat: 'iso'
  };

  console.log(`Fetching ${sport} regular-season odds...`);
  const regularPromise = request(
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`,
    requestParams
  );
  const preseasonPromise = includePreseason
    ? request(
      `https://api.the-odds-api.com/v4/sports/${preseasonSportKey}/odds/`,
      requestParams
    )
    : Promise.resolve(null);

  // Wait for both required feeds before publishing. Promise.all rejects if
  // either request fails, leaving the last known-good nfl.json untouched.
  const [regularResponse, preseasonResponse] = await Promise.all([
    regularPromise,
    preseasonPromise
  ]);
  const regularSeasonOdds = Array.isArray(regularResponse.data)
    ? regularResponse.data
    : [];
  const preseasonOdds = Array.isArray(preseasonResponse?.data)
    ? preseasonResponse.data
    : [];
  const oddsData = mergeOddsGames(regularSeasonOdds, preseasonOdds);
  const filePath = path.join(ODDS_DIR, `${fileName}.json`);

  writeFile(filePath, JSON.stringify(oddsData, null, 2));
  console.log(
    `Fetched ${regularSeasonOdds.length} regular-season and ${preseasonOdds.length} preseason ${sport} games with odds`
  );
  console.log(`${sport} odds saved to ${filePath}`);

  return {
    sport,
    gameCount: oddsData.length,
    regularSeasonGameCount: regularSeasonOdds.length,
    preseasonGameCount: preseasonOdds.length,
    estimatedCredits: estimateCredits(config),
    quota: parseQuotaHeaders(preseasonResponse?.headers)
      || parseQuotaHeaders(regularResponse.headers),
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
    if (config.preseasonSportKey) {
      return await fetchNflOdds(config);
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

    const oddsData = Array.isArray(response.data) ? response.data : null;
    if (!oddsData) {
      throw new Error(`Unexpected ${sport} odds payload`);
    }
    assertExpectedSportKey(oddsData, sportKey);
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
    return {
      sport,
      error: {
        status: Number.isInteger(error.response?.status) ? error.response.status : null,
        message: String(error.message || 'Unknown provider failure').slice(0, 500)
      }
    };
  }
}

function buildSummarySport(sportConfig, attempt, previous, nowIso) {
  const successful = Boolean(attempt && !attempt.error);
  const failed = Boolean(attempt?.error);
  const summarySport = {
    sport: sportConfig.sport,
    gameCount: successful ? attempt.gameCount : (previous ? previous.gameCount : 0),
    fileName: `${sportConfig.fileName}.json`,
    lastFetched: successful ? nowIso : (previous ? previous.lastFetched : null)
  };

  if (successful) {
    summarySport.lastAttemptAt = nowIso;
    summarySport.lastAttemptStatus = 'success';
    summarySport.lastError = null;
  } else if (failed) {
    summarySport.lastAttemptAt = nowIso;
    summarySport.lastAttemptStatus = 'failed';
    summarySport.lastError = attempt.error;
  } else if (previous?.lastAttemptAt || previous?.lastAttemptStatus || previous?.lastError) {
    summarySport.lastAttemptAt = previous.lastAttemptAt || null;
    summarySport.lastAttemptStatus = previous.lastAttemptStatus || null;
    summarySport.lastError = previous.lastError || null;
  }

  if (successful && attempt.debug) summarySport.debug = attempt.debug;
  if (sportConfig.preseasonSportKey) {
    summarySport.regularSeasonGameCount = successful
      ? attempt.regularSeasonGameCount
      : (previous?.regularSeasonGameCount ?? 0);
    summarySport.preseasonGameCount = successful
      ? attempt.preseasonGameCount
      : (previous?.preseasonGameCount ?? 0);
  }
  return summarySport;
}

async function fetchAllOdds() {
  try {
    console.log('Starting odds fetching...');

    if (!ODDS_API_KEY) {
      throw new Error('ODDS_API_KEY is required');
    }
    
    const now = new Date();
    // Production uses workflow_dispatch at RUN_EVERY_MIN cadence, so only
    // FORCE_FETCH bypasses cadence. The quota reserve still applies before
    // paid API calls.
    const isForced = process.env.FORCE_FETCH === 'true';
    const lastFetched = loadLastFetched();
    
    // Fetch sports that are in season and due by elapsed time, unless forced.
    const inSeason = SPORTS.filter(s => isSportActive(s, now));
    const due = inSeason.filter(s =>
      isForced || isSportDue(s, lastFetched[`${s.fileName}.json`]?.lastFetched, now)
    );
    if (due.length === 0) {
      console.log(inSeason.length === 0
        ? 'No sports in season; skipping. No API quota used.'
        : 'In-season sports not due yet; skipping. No API quota used.');
      return;
    }
    console.log(`Fetching this run${isForced ? ' (forced)' : ''}: ${due.map(s => s.sport).join(', ')}`);

    const providerStatus = await fetchProviderStatus();
    const dueWithAvailability = due.map(sport => {
      if (!sport.preseasonSportKey) return sport;
      const includePreseason = isPreseasonActive(
        sport,
        providerStatus.availableSportKeys,
        now
      );
      console.log(
        `NFL preseason feed ${includePreseason ? 'is available; including it' : 'is not active; skipping it'} this run.`
      );
      return { ...sport, includePreseason };
    });
    const quotaBefore = providerStatus.quota;
    const { selected: quotaAllowed, skipped: quotaSkipped } = selectSportsWithinQuota(
      dueWithAvailability,
      quotaBefore
    );
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
    
    // Map every selected league's attempt, including failures. A green workflow is
    // not proof that every league refreshed; summary.json is the per-league receipt.
    const nowIso = now.toISOString();
    const attemptedByFile = {};
    quotaAllowed.forEach((s, i) => {
      if (results[i]) attemptedByFile[`${s.fileName}.json`] = results[i];
    });
    const latestQuota = results
      .map(result => result?.quota)
      .filter(Boolean)
      .pop() || quotaBefore;
    const failedAttempts = results.filter(result => result?.error);
    
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
      status: failedAttempts.length > 0 || quotaSkipped.length > 0
        ? 'degraded'
        : 'healthy',
      sports: []
    };
    inSeason.forEach(s => {
      const fileKey = `${s.fileName}.json`;
      summary.sports.push(buildSummarySport(
        s,
        attemptedByFile[fileKey],
        lastFetched[fileKey],
        nowIso
      ));
    });
    
    // Save combined summary
    const summaryPath = path.join(ODDS_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`Summary saved to ${summaryPath}`);
    if (failedAttempts.length > 0) {
      console.warn(
        `Odds fetching completed with ${failedAttempts.length} failed league attempt(s): ${failedAttempts.map(result => result.sport).join(', ')}`
      );
    } else {
      console.log('Enhanced odds fetching completed successfully!');
    }
    
  } catch (error) {
    console.error('Error in fetchAllOdds:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  fetchAllOdds();
}

module.exports = {
  SPORTS,
  assertExpectedSportKey,
  buildApiRequestUrl,
  buildSummarySport,
  countNflGamesByFeed,
  estimateCredits,
  fetchJson,
  fetchNflOdds,
  isSportActive,
  isSportDue,
  isPreseasonActive,
  mergeOddsGames,
  parseAvailableSportKeys,
  RUN_EVERY_MIN
};
