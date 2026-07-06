const QUOTA_RESERVE_CREDITS = Number.isFinite(parsedQuotaReserveCredits)
  ? Math.max(parsedQuotaReserveCredits, 0)
  : 20;
const MLB_SPORT_KEY = 'baseball_mlb';
const MLB_TIME_ZONE = 'America/New_York';
const MLB_WINDOW_START_BUFFER_HOURS = 2;
const MLB_EVENT_ID_BATCH_SIZE = 50;

// The workflow cron wakes the script this often; fetchEveryMinutes values are
// multiples of it. The Odds API bills 1 credit per market, per region, per
    fetchEveryMinutes: 12,
  },
  {
    sport: 'MLB', sportKey: 'baseball_mlb', fileName: 'mlb',
    sport: 'MLB', sportKey: MLB_SPORT_KEY, fileName: 'mlb',
    markets: 'h2h,spreads,totals',
    regions: DEFAULT_REGIONS,
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10], // Mar - Oct
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

function buildMlbEventWindow(now = new Date()) {
  const today = getZonedParts(now, MLB_TIME_ZONE);
  const todayDate = { year: today.year, month: today.month, day: today.day };
  const endDate = addDaysToPlainDate(todayDate, 3);
  const todayStartUtc = zonedTimeToUtcDate(todayDate, MLB_TIME_ZONE);
  const windowEndUtc = zonedTimeToUtcDate(endDate, MLB_TIME_ZONE);
  const windowStartUtc = new Date(
    todayStartUtc.getTime() - MLB_WINDOW_START_BUFFER_HOURS * 60 * 60 * 1000
  );

  return {
    timeZone: MLB_TIME_ZONE,
    startBufferHours: MLB_WINDOW_START_BUFFER_HOURS,
    commenceTimeFrom: windowStartUtc.toISOString(),
    commenceTimeTo: windowEndUtc.toISOString()
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
