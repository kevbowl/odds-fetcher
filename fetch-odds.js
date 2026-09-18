const fs = require('fs');
const path = require('path');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';
const DEFAULT_REGIONS = 'us';
const POLYMARKET_BOOKMAKER_KEY = 'polymarket';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const GAMMA_EVENTS_PAGE_SIZE = 100;
const GAMMA_EVENTS_MAX_PAGES = 20;
const GAMMA_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const GAMMA_PRIMARY_SLUG = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/;
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
const GAMMA_SERIES_BY_SPORT_KEY = {
  soccer_fifa_world_cup: '11433',
  soccer_epl: '10188',
  [NFL_REGULAR_SPORT_KEY]: '12185',
  [NFL_PRESEASON_SPORT_KEY]: '12185',
  americanfootball_ncaaf: '12756',
  basketball_wnba: '10105',
  [MLB_SPORT_KEY]: '3',
  [KBO_SPORT_KEY]: '10370'
};

// The workflow cron wakes the script this often; fetchEveryMinutes values are
// multiples of it. The Odds API bills 1 credit per market, per region, per
// request (World Cup h2h,totals x us = 2 credits). Polymarket is read from
// Gamma for free and does not add Odds API credits.
const RUN_EVERY_MIN = 5;

// Per-sport config. See README "Scheduling & quota" for the gating model.
//   season: seasonMonths (recurring, 1-12, wraps year-end) or window {start,end}
//   cadence: fetchEveryMinutes (min minutes between fetches)
//   markets/regions determine the estimated Odds API credit cost. Polymarket
//   is merged from Gamma and is not part of that estimate.
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

function findBookmaker(bookmakers, key) {
  return (Array.isArray(bookmakers) ? bookmakers : [])
    .find(book => book?.key === key) || null;
}

function upsertBookmaker(bookmakers, book) {
  const next = Array.isArray(bookmakers) ? [...bookmakers] : [];
  const index = next.findIndex(existing => existing?.key === book.key);
  if (index >= 0) next[index] = book;
  else next.push(book);
  return next;
}

// Union a Polymarket book onto this run's US-region games by Odds API event id.
// Matching ids keep the US skeleton (commence_time, teams, sport_key, existing
// books) and only upsert bookmaker key "polymarket".
function mergePolymarketBookmakers(usGames, ...polymarketFeeds) {
  const polymarketById = new Map();
  polymarketFeeds.forEach(feed => {
    (Array.isArray(feed) ? feed : []).forEach(game => {
      if (!game?.id) return;
      const book = findBookmaker(game.bookmakers, POLYMARKET_BOOKMAKER_KEY);
      if (book) polymarketById.set(game.id, book);
    });
  });

  return (Array.isArray(usGames) ? usGames : []).map(game => {
    const existingBooks = Array.isArray(game?.bookmakers) ? game.bookmakers : [];
    const polymarketBook = game?.id ? polymarketById.get(game.id) : null;

    if (polymarketBook) {
      return {
        ...game,
        bookmakers: upsertBookmaker(existingBooks, polymarketBook)
      };
    }

    const withoutPolymarket = existingBooks.filter(
      book => book?.key !== POLYMARKET_BOOKMAKER_KEY
    );
    if (withoutPolymarket.length === existingBooks.length) return game;
    return { ...game, bookmakers: withoutPolymarket };
  });
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requestedMarketSet(markets) {
  return new Set(
    String(markets || 'h2h')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function parseTimestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return formatOddsApiIso(new Date());
  return formatOddsApiIso(date);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function gammaTeamLabels(team) {
  const name = String(team?.name || '').trim();
  const alias = String(team?.alias || '').trim();
  const abbreviation = String(team?.abbreviation || '').trim();
  const labels = [name, alias, abbreviation];
  if (alias && name && normalizeName(alias) !== normalizeName(name)) {
    labels.push(`${alias} ${name}`);
    const aliasWithoutParen = alias.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (aliasWithoutParen && aliasWithoutParen !== alias) {
      labels.push(`${aliasWithoutParen} ${name}`);
    }
  }
  return labels.filter(Boolean);
}

function teamMatches(oddsName, gammaTeam) {
  const odds = normalizeName(oddsName);
  if (!odds) return false;
  return gammaTeamLabels(gammaTeam).some(label => {
    const normalized = normalizeName(label);
    if (!normalized) return false;
    if (odds === normalized) return true;
    if (normalized.split(' ').length >= 2 && odds.startsWith(`${normalized} `)) return true;
    return odds.split(' ').length >= 2 && normalized.startsWith(`${odds} `);
  });
}

function pairGammaTeams(game, gammaTeams) {
  const teams = Array.isArray(gammaTeams) ? gammaTeams.filter(Boolean) : [];
  if (teams.length !== 2) return null;
  const homeMatches = teams.filter(team => teamMatches(game.home_team, team));
  const awayMatches = teams.filter(team => teamMatches(game.away_team, team));
  if (homeMatches.length !== 1 || awayMatches.length !== 1) return null;
  if (homeMatches[0] === awayMatches[0]) return null;
  return { home: homeMatches[0], away: awayMatches[0] };
}

function isPrimaryGammaGameEvent(event) {
  const slug = String(event?.slug || '');
  const teams = Array.isArray(event?.teams) ? event.teams : [];
  return GAMMA_PRIMARY_SLUG.test(slug) && teams.length === 2;
}

function probabilityToAmerican(probability) {
  const value = Number(probability);
  if (!(value > 0) || !(value < 1)) return null;
  const clamped = Math.min(0.999, Math.max(0.001, value));
  if (clamped >= 0.5) return Math.round((-clamped / (1 - clamped)) * 100);
  return Math.round(((1 - clamped) / clamped) * 100);
}

function yesNoProbability(market) {
  if (Number.isFinite(market?.bestBid) && Number.isFinite(market?.bestAsk)) {
    return (Number(market.bestBid) + Number(market.bestAsk)) / 2;
  }
  const outcomes = parseJsonField(market?.outcomes).map(value => String(value));
  const prices = parseJsonField(market?.outcomePrices).map(Number);
  const yesIndex = outcomes.findIndex(name => name.toLowerCase() === 'yes');
  const index = yesIndex >= 0 ? yesIndex : 0;
  return prices[index];
}

function yesNoToken(market) {
  const outcomes = parseJsonField(market?.outcomes).map(value => String(value));
  const tokens = parseJsonField(market?.clobTokenIds).map(value => String(value));
  const yesIndex = outcomes.findIndex(name => name.toLowerCase() === 'yes');
  const index = yesIndex >= 0 ? yesIndex : 0;
  return tokens[index] || null;
}

function isYesNoOutcomes(outcomes) {
  const names = outcomes.map(value => String(value).toLowerCase());
  return names.length === 2 && names.includes('yes') && names.includes('no');
}

function isDrawMarket(market) {
  const title = String(market?.groupItemTitle || '');
  const question = String(market?.question || '');
  return /\bdraw\b/i.test(title) || /\bdraw\b/i.test(question);
}

function mapOutcomeNameToUs(outcomeName, pairing, game) {
  const name = String(outcomeName || '');
  if (/^over$/i.test(name)) return 'Over';
  if (/^under$/i.test(name)) return 'Under';
  if (teamMatches(name, pairing.home) || normalizeName(name) === normalizeName(game.home_team)) {
    return game.home_team;
  }
  if (teamMatches(name, pairing.away) || normalizeName(name) === normalizeName(game.away_team)) {
    return game.away_team;
  }
  return null;
}

function buildPricedOutcome(name, probability, sid, point) {
  const price = probabilityToAmerican(probability);
  if (price == null || !name) return null;
  const outcome = { name, price };
  if (sid) outcome.sid = sid;
  if (point != null && Number.isFinite(Number(point))) outcome.point = Number(point);
  return outcome;
}

function twoWayOutcomes(market, pairing, game, { swapPoints = false } = {}) {
  const names = parseJsonField(market?.outcomes);
  const prices = parseJsonField(market?.outcomePrices).map(Number);
  const tokens = parseJsonField(market?.clobTokenIds).map(value => String(value));
  const line = Number(market?.line);
  const hasLine = Number.isFinite(line);
  const outcomes = [];
  for (let index = 0; index < names.length; index += 1) {
    const usName = mapOutcomeNameToUs(names[index], pairing, game);
    if (!usName) return null;
    let point;
    if (hasLine && swapPoints) {
      point = index === 0 ? line : -line;
    }
    const outcome = buildPricedOutcome(usName, prices[index], tokens[index], point);
    if (!outcome) continue;
    outcomes.push(outcome);
  }
  return outcomes;
}

function pickBalancedMarket(markets, type) {
  const candidates = (Array.isArray(markets) ? markets : [])
    .filter(market => market?.sportsMarketType === type && market?.closed !== true)
    .map(market => {
      const prices = parseJsonField(market.outcomePrices).map(Number);
      const probability = prices.find(value => Number.isFinite(value) && value > 0 && value < 1);
      return { market, probability };
    })
    .filter(item => Number.isFinite(item.probability));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => (
    Math.abs(left.probability - 0.5) - Math.abs(right.probability - 0.5)
  ));
  return candidates[0].market;
}

function buildGammaH2hMarket(event, pairing, game) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const moneylines = markets.filter(market => (
    market?.sportsMarketType === 'moneyline' && market?.closed !== true
  ));
  const yesNoMarkets = moneylines.filter(market => isYesNoOutcomes(parseJsonField(market.outcomes)));
  const twoWayMarkets = moneylines.filter(market => !isYesNoOutcomes(parseJsonField(market.outcomes)));

  if (yesNoMarkets.length >= 2) {
    const outcomes = [];
    yesNoMarkets.forEach(market => {
      if (isDrawMarket(market)) {
        const outcome = buildPricedOutcome('Draw', yesNoProbability(market), yesNoToken(market));
        if (outcome) outcomes.push(outcome);
        return;
      }
      const title = market.groupItemTitle || market.question || '';
      const usName = mapOutcomeNameToUs(title, pairing, game)
        || (teamMatches(title, pairing.home) ? game.home_team : null)
        || (teamMatches(title, pairing.away) ? game.away_team : null);
      const outcome = buildPricedOutcome(usName, yesNoProbability(market), yesNoToken(market));
      if (outcome) outcomes.push(outcome);
    });
    const unique = [];
    const seen = new Set();
    outcomes.forEach(outcome => {
      if (seen.has(outcome.name)) return;
      seen.add(outcome.name);
      unique.push(outcome);
    });
    if (unique.length < 2) return null;
    return { key: 'h2h', last_update: isoTimestamp(), outcomes: unique };
  }

  const twoWay = twoWayMarkets[0];
  if (!twoWay) return null;
  const outcomes = twoWayOutcomes(twoWay, pairing, game);
  if (!outcomes || outcomes.length < 2) return null;
  return { key: 'h2h', last_update: isoTimestamp(), outcomes };
}

function buildGammaSideMarket(event, pairing, game, type) {
  const market = pickBalancedMarket(event?.markets, type);
  if (!market) return null;
  const outcomes = type === 'totals'
    ? twoWayOutcomes(market, pairing, game)
    : twoWayOutcomes(market, pairing, game, { swapPoints: true });
  if (!outcomes || outcomes.length < 2) return null;
  if (type === 'totals') {
    const line = Number(market.line);
    if (!Number.isFinite(line)) return null;
    if (!outcomes.every(outcome => outcome.name === 'Over' || outcome.name === 'Under')) {
      return null;
    }
    return {
      key: type,
      last_update: isoTimestamp(),
      outcomes: outcomes.map(outcome => ({ ...outcome, point: line }))
    };
  }
  if (!outcomes.every(outcome => Number.isFinite(outcome.point))) return null;
  return { key: type, last_update: isoTimestamp(), outcomes };
}

function gammaEventToPolymarketBook(event, game, markets) {
  const pairing = pairGammaTeams(game, event?.teams);
  if (!pairing) return null;
  const wanted = requestedMarketSet(markets);
  const bookMarkets = [];
  if (wanted.has('h2h')) {
    const h2h = buildGammaH2hMarket(event, pairing, game);
    if (h2h) bookMarkets.push(h2h);
  }
  if (wanted.has('spreads')) {
    const spreads = buildGammaSideMarket(event, pairing, game, 'spreads');
    if (spreads) bookMarkets.push(spreads);
  }
  if (wanted.has('totals')) {
    const totals = buildGammaSideMarket(event, pairing, game, 'totals');
    if (totals) bookMarkets.push(totals);
  }
  if (bookMarkets.length === 0) return null;
  const book = {
    key: POLYMARKET_BOOKMAKER_KEY,
    title: 'Polymarket',
    last_update: isoTimestamp(),
    markets: bookMarkets
  };
  if (event?.id != null) book.sid = String(event.id);
  return book;
}

function findMatchingGammaEvent(game, events) {
  const commenceMs = parseTimestampMs(game?.commence_time);
  if (commenceMs == null) return null;
  const matches = [];
  (Array.isArray(events) ? events : []).forEach(event => {
    if (!isPrimaryGammaGameEvent(event)) return;
    if (!pairGammaTeams(game, event.teams)) return;
    const startMs = parseTimestampMs(event.startTime);
    if (startMs == null) return;
    const delta = Math.abs(startMs - commenceMs);
    if (delta > GAMMA_MATCH_WINDOW_MS) return;
    matches.push({ event, delta });
  });
  if (matches.length === 0) return null;
  matches.sort((left, right) => left.delta - right.delta);
  if (matches.length > 1 && matches[1].delta === matches[0].delta) return null;
  return matches[0].event;
}

function mergeGammaPolymarketBookmakers(usGames, gammaEvents, markets) {
  const primaryEvents = (Array.isArray(gammaEvents) ? gammaEvents : [])
    .filter(isPrimaryGammaGameEvent);
  const synthetic = (Array.isArray(usGames) ? usGames : [])
    .map(game => {
      try {
        const event = findMatchingGammaEvent(game, primaryEvents);
        if (!event) return null;
        const book = gammaEventToPolymarketBook(event, game, markets);
        if (!book) return null;
        return { id: game.id, bookmakers: [book] };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return mergePolymarketBookmakers(usGames, synthetic);
}

function logPolymarketFailure(sport, error) {
  const status = Number.isInteger(error?.response?.status)
    ? error.response.status
    : null;
  const detail = status ? `${error.message} (HTTP ${status})` : String(error?.message || error);
  console.warn(
    `Polymarket odds unavailable for ${sport}; publishing US odds without it (${detail})`
  );
}

async function fetchGammaEvents(sportKey, request, commenceRange = {}) {
  const seriesId = GAMMA_SERIES_BY_SPORT_KEY[sportKey];
  if (!seriesId) return [];

  const events = [];
  for (let page = 0; page < GAMMA_EVENTS_MAX_PAGES; page += 1) {
    const params = {
      series_id: seriesId,
      closed: false,
      active: true,
      limit: GAMMA_EVENTS_PAGE_SIZE,
      offset: page * GAMMA_EVENTS_PAGE_SIZE
    };
    if (commenceRange.earliest) {
      const fromMs = parseTimestampMs(commenceRange.earliest);
      if (fromMs != null) {
        params.start_time_min = isoTimestamp(new Date(fromMs - GAMMA_MATCH_WINDOW_MS));
      }
    }
    if (commenceRange.latest) {
      const toMs = parseTimestampMs(commenceRange.latest);
      if (toMs != null) {
        params.start_time_max = isoTimestamp(new Date(toMs + GAMMA_MATCH_WINDOW_MS));
      }
    }
    const response = await request(`${GAMMA_API_BASE}/events`, params);
    const pageEvents = Array.isArray(response?.data) ? response.data : [];
    events.push(...pageEvents);
    if (pageEvents.length < GAMMA_EVENTS_PAGE_SIZE) break;
  }
  return events;
}

async function attachGammaPolymarket(sport, sportKey, usGames, markets, request) {
  const games = Array.isArray(usGames) ? usGames : [];
  if (games.length === 0 || !GAMMA_SERIES_BY_SPORT_KEY[sportKey]) {
    return { games, polymarketGameCount: 0 };
  }
  try {
    const gammaEvents = await fetchGammaEvents(sportKey, request, getCommenceTimeRange(games));
    const merged = mergeGammaPolymarketBookmakers(games, gammaEvents, markets);
    const polymarketGameCount = merged.filter(
      game => findBookmaker(game.bookmakers, POLYMARKET_BOOKMAKER_KEY)
    ).length;
    console.log(`Merged Polymarket into ${polymarketGameCount}/${merged.length} ${sport} games`);
    return { games: merged, polymarketGameCount };
  } catch (error) {
    logPolymarketFailure(sport, error);
    return { games, polymarketGameCount: 0 };
  }
}

function buildUsOddsParams({
  markets,
  regions = DEFAULT_REGIONS,
  eventIds,
  commenceTimeFrom,
  commenceTimeTo
}) {
  const params = {
    apiKey: ODDS_API_KEY,
    regions,
    markets,
    oddsFormat: 'american',
    dateFormat: 'iso'
  };
  if (eventIds != null) params.eventIds = eventIds;
  if (commenceTimeFrom != null) params.commenceTimeFrom = commenceTimeFrom;
  if (commenceTimeTo != null) params.commenceTimeTo = commenceTimeTo;
  return params;
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

function needsBaseballDirectFallback(events, eventOddsData) {
  const eventIds = new Set(
    (Array.isArray(events) ? events : [])
      .map(event => event?.id)
      .filter(Boolean)
  );
  if (eventIds.size === 0) return true;

  const oddsIds = new Set(
    (Array.isArray(eventOddsData) ? eventOddsData : [])
      .map(game => game?.id)
      .filter(Boolean)
  );
  return [...eventIds].some(id => !oddsIds.has(id));
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
      headers: {
        accept: 'application/json',
        'user-agent': 'odds-fetcher'
      },
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

async function fetchBaseballOddsByEventWindow(config, windowConfig, dependencies = {}) {
  const request = dependencies.fetchRequest || fetchWithRetry;
  const writeFile = dependencies.writeFile || fs.writeFileSync;
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

  const eventsResponse = await request(`https://api.the-odds-api.com/v4/sports/${sportKey}/events`, {
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
  const oddsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`;

  for (const batch of batches) {
    console.log(`Fetching ${sport} odds for ${batch.length} event ids...`);
    const usParams = buildUsOddsParams({
      markets,
      regions,
      eventIds: batch.join(',')
    });
    const response = await request(oddsUrl, usParams);
    latestQuota = parseQuotaHeaders(response.headers) || latestQuota;
    addOddsGamesById(eventOddsById, response.data);
  }

  const eventOddsData = eventIds
    .map(id => eventOddsById.get(id))
    .filter(Boolean);

  const directOddsById = new Map();
  const directFallbackUsed = needsBaseballDirectFallback(events, eventOddsData);
  const fallbackUsParams = buildUsOddsParams({
    markets,
    regions,
    commenceTimeFrom: window.commenceTimeFrom,
    commenceTimeTo: window.commenceTimeTo
  });
  if (directFallbackUsed) {
    console.log(`Fetching ${sport} direct odds fallback for ${slateLabel}...`);
    const directResponse = await request(oddsUrl, fallbackUsParams);
    latestQuota = parseQuotaHeaders(directResponse.headers) || latestQuota;
    addOddsGamesById(directOddsById, directResponse.data);
  } else {
    console.log(`Skipping ${sport} direct odds fallback; event-ID odds were complete.`);
  }

  const mergedOddsById = new Map();
  addOddsGamesById(mergedOddsById, eventOddsData);
  addOddsGamesById(mergedOddsById, Array.from(directOddsById.values()));

  let oddsData = Array.from(mergedOddsById.values())
    .filter(game => isGameWithinWindow(game, window));
  const missingOddsEventIds = eventIds.filter(id => !mergedOddsById.has(id));
  const warning = events.length > 0 && missingOddsEventIds.length > 0
    ? `${missingOddsEventIds.length} ${sport} event(s) returned by /events had no odds after event-id and direct /odds fetches`
    : null;
  const commenceRange = getCommenceTimeRange(oddsData);
  const gammaMerge = await attachGammaPolymarket(
    sport,
    sportKey,
    oddsData,
    markets,
    request
  );
  oddsData = gammaMerge.games;
  const polymarketGameCount = gammaMerge.polymarketGameCount;

  if (warning) {
    console.warn(`Warning: ${warning}`);
  }

  const filePath = path.join(ODDS_DIR, `${fileName}.json`);
  writeFile(filePath, JSON.stringify(oddsData, null, 2));

  console.log(`Fetched odds for ${oddsData.length} ${sport} events`);
  console.log(`${sport} odds saved to ${filePath}`);

  const usPaidRequests = batches.length + (directFallbackUsed ? 1 : 0);
  return {
    sport,
    gameCount: oddsData.length,
    estimatedCredits: countCsvValues(markets) * countCsvValues(regions) * usPaidRequests,
    quota: latestQuota,
    debug: {
      [`${debugPrefix}WindowStart`]: window.commenceTimeFrom,
      [`${debugPrefix}WindowEnd`]: window.commenceTimeTo,
      [`${debugPrefix}WindowTimeZone`]: window.timeZone,
      [`${debugPrefix}EventCount`]: events.length,
      [`${debugPrefix}EventOddsCount`]: eventOddsData.length,
      [`${debugPrefix}DirectFallbackUsed`]: directFallbackUsed,
      [`${debugPrefix}DirectOddsCount`]: directOddsById.size,
      [`${debugPrefix}MergedOddsCount`]: oddsData.length,
      [`${debugPrefix}PolymarketGameCount`]: polymarketGameCount,
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
  const requestParams = buildUsOddsParams({ markets, regions });
  const regularUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`;
  const preseasonUrl = `https://api.the-odds-api.com/v4/sports/${preseasonSportKey}/odds/`;

  console.log(`Fetching ${sport} regular-season odds...`);
  const regularPromise = request(regularUrl, requestParams);
  const preseasonPromise = includePreseason
    ? request(preseasonUrl, requestParams)
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
  let oddsData = mergeOddsGames(regularSeasonOdds, preseasonOdds);
  let latestQuota = parseQuotaHeaders(preseasonResponse?.headers)
    || parseQuotaHeaders(regularResponse.headers);

  const gammaMerge = await attachGammaPolymarket(
    sport,
    sportKey,
    oddsData,
    markets,
    request
  );
  oddsData = gammaMerge.games;

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
    quota: latestQuota,
    games: summarizeGames(oddsData)
  };
}

async function fetchOdds(config, dependencies = {}) {
  const request = dependencies.fetchRequest || fetchWithRetry;
  const writeFile = dependencies.writeFile || fs.writeFileSync;
  const {
    sport,
    sportKey,
    fileName,
    markets = 'h2h,spreads,totals',
    regions = DEFAULT_REGIONS
  } = config;

  try {
    if (config.preseasonSportKey) {
      return await fetchNflOdds(config, { fetchRequest: request, writeFile });
    }

    const baseballWindowConfig = BASEBALL_EVENT_WINDOW_SPORTS[sportKey];
    if (baseballWindowConfig) {
      return await fetchBaseballOddsByEventWindow(config, baseballWindowConfig, {
        fetchRequest: request,
        writeFile
      });
    }

    console.log(`Fetching ${sport} odds (${estimateCredits(config)} estimated credits)...`);
    const oddsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`;
    const usParams = buildUsOddsParams({ markets, regions });
    const response = await request(oddsUrl, usParams);

    let oddsData = Array.isArray(response.data) ? response.data : null;
    if (!oddsData) {
      throw new Error(`Unexpected ${sport} odds payload`);
    }
    assertExpectedSportKey(oddsData, sportKey);
    console.log(`Fetched ${oddsData.length} ${sport} games with odds`);

    let latestQuota = parseQuotaHeaders(response.headers);
    const gammaMerge = await attachGammaPolymarket(
      sport,
      sportKey,
      oddsData,
      markets,
      request
    );
    oddsData = gammaMerge.games;

    const filePath = path.join(ODDS_DIR, `${fileName}.json`);
    writeFile(filePath, JSON.stringify(oddsData, null, 2));

    console.log(`${sport} odds saved to ${filePath}`);

    return {
      sport,
      gameCount: oddsData.length,
      estimatedCredits: estimateCredits(config),
      quota: latestQuota,
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
  DEFAULT_REGIONS,
  GAMMA_SERIES_BY_SPORT_KEY,
  POLYMARKET_BOOKMAKER_KEY,
  SPORTS,
  assertExpectedSportKey,
  buildApiRequestUrl,
  buildSummarySport,
  buildUsOddsParams,
  countNflGamesByFeed,
  estimateCredits,
  fetchJson,
  fetchNflOdds,
  fetchOdds,
  isPrimaryGammaGameEvent,
  isSportActive,
  isSportDue,
  isPreseasonActive,
  mergeGammaPolymarketBookmakers,
  mergeOddsGames,
  mergePolymarketBookmakers,
  needsBaseballDirectFallback,
  parseAvailableSportKeys,
  probabilityToAmerican,
  RUN_EVERY_MIN,
  selectSportsWithinQuota,
  teamMatches
};
