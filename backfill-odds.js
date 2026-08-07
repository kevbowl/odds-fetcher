const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  BASEBALL_EVENT_WINDOW_SPORTS,
  BASEBALL_EVENT_ID_BATCH_SIZE,
  SPORTS,
  buildBaseballEventWindow,
  chunkArray,
  isGameWithinWindow,
  isSportActive,
  parseQuotaHeaders,
  RUN_EVERY_MIN
} = require('./fetch-odds');

const API_BASE_URL = 'https://api.the-odds-api.com/v4';
const ODDS_DIR = 'odds';
const DEFAULT_START_UTC = '2026-08-06T15:35:00Z';
const DEFAULT_END_UTC = '2026-08-06T22:00:00Z';
const DEFAULT_MAX_CREDITS = 10000;
const DEFAULT_TIMEOUT_MS = 30000;
const BACKFILL_ROOT = 'backfills/2026-08-06-actions-outage';

function requireUtcInstant(value, name) {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime()) || !String(value).endsWith('Z')) {
    throw new Error(`${name} must be an ISO-8601 UTC timestamp ending in Z`);
  }
  return parsed;
}

function floorToFiveMinuteBucket(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('timestamp must be a valid ISO-8601 instant');
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / RUN_EVERY_MIN) * RUN_EVERY_MIN);
  return date.toISOString();
}

function buildExpectedBuckets(startUtc, endUtc) {
  const start = requireUtcInstant(startUtc, 'BACKFILL_START_UTC');
  const end = requireUtcInstant(endUtc, 'BACKFILL_END_UTC');
  if (start > end) throw new Error('BACKFILL_START_UTC must be at or before BACKFILL_END_UTC');
  if (start.getUTCSeconds() !== 0 || start.getUTCMilliseconds() !== 0 || start.getUTCMinutes() % RUN_EVERY_MIN !== 0) {
    throw new Error(`BACKFILL_START_UTC must align to a ${RUN_EVERY_MIN}-minute boundary`);
  }
  if (end.getUTCSeconds() !== 0 || end.getUTCMilliseconds() !== 0 || end.getUTCMinutes() % RUN_EVERY_MIN !== 0) {
    throw new Error(`BACKFILL_END_UTC must align to a ${RUN_EVERY_MIN}-minute boundary`);
  }

  const buckets = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += RUN_EVERY_MIN * 60000) {
    buckets.push(new Date(cursor).toISOString());
  }
  return buckets;
}

function findMissingBuckets(expectedBuckets, observedCommitDates) {
  const observed = new Set(observedCommitDates.map(floorToFiveMinuteBucket));
  return expectedBuckets.filter(bucket => !observed.has(bucket));
}

function queryAtForBucket(bucket) {
  const start = requireUtcInstant(bucket, 'bucket');
  return new Date(start.getTime() + RUN_EVERY_MIN * 60000 - 1000)
    .toISOString()
    .replace('.000Z', 'Z');
}

function validateProviderTimestamp(bucket, queryAt, providerTimestamp) {
  const bucketStart = requireUtcInstant(bucket, 'bucket');
  const requested = requireUtcInstant(queryAt, 'queryAt');
  const provider = requireUtcInstant(providerTimestamp, 'provider timestamp');
  const bucketEnd = new Date(bucketStart.getTime() + RUN_EVERY_MIN * 60000);
  if (provider < bucketStart || provider >= bucketEnd || provider > requested) {
    throw new Error(
      `Provider snapshot ${providerTimestamp} does not belong to requested bucket ${bucket}`
    );
  }
  return provider.toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function git(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) }
  });
  return typeof output === 'string' ? output.trim() : '';
}

function getObservedSummaryCommitDates() {
  const output = git(['log', '--format=%aI', '--', `${ODDS_DIR}/summary.json`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function readLiveOddsSnapshot() {
  const snapshot = {};
  for (const entry of fs.readdirSync(ODDS_DIR)) {
    if (entry.endsWith('.json')) {
      snapshot[entry] = fs.readFileSync(path.join(ODDS_DIR, entry));
    }
  }
  return snapshot;
}

function restoreLiveOddsSnapshot(snapshot) {
  for (const [entry, contents] of Object.entries(snapshot)) {
    fs.writeFileSync(path.join(ODDS_DIR, entry), contents);
  }
}

function assertCleanWorktree() {
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status) throw new Error(`Backfill requires a clean worktree; found:\n${status}`);
}

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

class HistoricalOddsClient {
  constructor({ apiKey, maxCredits, timeoutMs }) {
    this.apiKey = apiKey;
    this.maxCredits = maxCredits;
    this.timeoutMs = timeoutMs;
    this.observedCredits = 0;
    this.latestQuota = null;
    this.requests = [];
  }

  async checkQuota() {
    const response = await axios.get(`${API_BASE_URL}/sports/`, {
      params: { apiKey: this.apiKey },
      timeout: this.timeoutMs
    });
    this.latestQuota = parseQuotaHeaders(response.headers);
    const remaining = this.latestQuota?.remaining;
    if (remaining !== null && remaining !== undefined && remaining < this.maxCredits) {
      throw new Error(
        `Historical backfill ceiling is ${this.maxCredits} credits but only ${remaining} remain`
      );
    }
    return this.latestQuota;
  }

  async get(endpoint, params, plannedCredits, label) {
    if (this.observedCredits + plannedCredits > this.maxCredits) {
      throw new Error(
        `Refusing ${label}: planned spend would exceed ${this.maxCredits}-credit ceiling`
      );
    }

    let response;
    try {
      response = await axios.get(`${API_BASE_URL}${endpoint}`, {
        params: { ...params, apiKey: this.apiKey },
        timeout: this.timeoutMs
      });
    } catch (error) {
      const status = Number.isInteger(error.response?.status) ? error.response.status : null;
      throw new Error(`${label} failed${status ? ` with HTTP ${status}` : ''}: ${error.message}`);
    }

    const quota = parseQuotaHeaders(response.headers);
    const actualCredits = quota?.last ?? plannedCredits;
    this.observedCredits += Math.max(actualCredits, 0);
    this.latestQuota = quota || this.latestQuota;
    this.requests.push({
      label,
      endpoint,
      params,
      plannedCredits,
      actualCredits,
      quota
    });
    if (this.observedCredits > this.maxCredits) {
      throw new Error(
        `Provider-reported spend ${this.observedCredits} exceeded ${this.maxCredits}-credit ceiling`
      );
    }
    return response;
  }
}

function unwrapHistoricalResponse(response, label) {
  const payload = response.data;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error(`${label} returned an invalid historical response envelope`);
  }
  const timestamp = requireUtcInstant(payload.timestamp, `${label} timestamp`).toISOString();
  return {
    timestamp,
    previousTimestamp: payload.previous_timestamp || null,
    nextTimestamp: payload.next_timestamp || null,
    data: payload.data
  };
}

function addGamesById(target, games) {
  for (const game of Array.isArray(games) ? games : []) {
    if (game?.id) target.set(game.id, game);
  }
}

function summarizeRange(games) {
  const times = games.map(game => game?.commence_time).filter(Boolean).sort();
  return {
    earliestCommenceTime: times[0] || null,
    latestCommenceTime: times[times.length - 1] || null
  };
}

function historicalOddsParams(sport, queryAt) {
  return {
    date: queryAt,
    regions: sport.regions,
    markets: sport.markets,
    oddsFormat: 'american',
    dateFormat: 'iso'
  };
}

function historicalOddsCost(sport) {
  const markets = String(sport.markets).split(',').filter(Boolean).length;
  const regions = String(sport.regions).split(',').filter(Boolean).length;
  return 10 * markets * regions;
}

async function fetchStandardHistoricalOdds(client, sport, bucket, queryAt) {
  const response = await client.get(
    `/historical/sports/${sport.sportKey}/odds`,
    historicalOddsParams(sport, queryAt),
    historicalOddsCost(sport),
    `${sport.sport} historical odds for ${bucket}`
  );
  const envelope = unwrapHistoricalResponse(response, `${sport.sport} historical odds`);
  validateProviderTimestamp(bucket, queryAt, envelope.timestamp);
  return {
    data: envelope.data,
    providerTimestamp: envelope.timestamp,
    debug: null,
    response: envelope
  };
}

async function fetchBaseballHistoricalOdds(client, sport, bucket, queryAt, windowConfig) {
  const window = buildBaseballEventWindow(windowConfig.timeZone, new Date(bucket));
  const baseParams = historicalOddsParams(sport, queryAt);
  const eventResponse = await client.get(
    `/historical/sports/${sport.sportKey}/events`,
    {
      date: queryAt,
      dateFormat: 'iso',
      commenceTimeFrom: window.commenceTimeFrom,
      commenceTimeTo: window.commenceTimeTo
    },
    0,
    `${sport.sport} historical events for ${bucket}`
  );
  const eventsEnvelope = unwrapHistoricalResponse(eventResponse, `${sport.sport} historical events`);
  validateProviderTimestamp(bucket, queryAt, eventsEnvelope.timestamp);

  const directResponse = await client.get(
    `/historical/sports/${sport.sportKey}/odds`,
    {
      ...baseParams,
      commenceTimeFrom: window.commenceTimeFrom,
      commenceTimeTo: window.commenceTimeTo
    },
    historicalOddsCost(sport),
    `${sport.sport} historical direct odds for ${bucket}`
  );
  const directEnvelope = unwrapHistoricalResponse(directResponse, `${sport.sport} historical direct odds`);
  validateProviderTimestamp(bucket, queryAt, directEnvelope.timestamp);

  const eventIds = [...new Set(eventsEnvelope.data.map(event => event?.id).filter(Boolean))];
  const directById = new Map();
  addGamesById(directById, directEnvelope.data);
  const missingEventIds = eventIds.filter(id => !directById.has(id));
  const supplementalById = new Map();
  const supplementalTimestamps = [];

  for (const batch of chunkArray(missingEventIds, BASEBALL_EVENT_ID_BATCH_SIZE)) {
    const response = await client.get(
      `/historical/sports/${sport.sportKey}/odds`,
      { ...baseParams, eventIds: batch.join(',') },
      historicalOddsCost(sport),
      `${sport.sport} historical event-id odds for ${bucket}`
    );
    const envelope = unwrapHistoricalResponse(response, `${sport.sport} historical event-id odds`);
    validateProviderTimestamp(bucket, queryAt, envelope.timestamp);
    supplementalTimestamps.push(envelope.timestamp);
    addGamesById(supplementalById, envelope.data);
  }

  const timestamps = new Set([
    eventsEnvelope.timestamp,
    directEnvelope.timestamp,
    ...supplementalTimestamps
  ]);
  if (timestamps.size !== 1) {
    throw new Error(`${sport.sport} historical endpoints returned mismatched snapshot timestamps`);
  }

  const merged = new Map();
  addGamesById(merged, Array.from(supplementalById.values()));
  addGamesById(merged, directEnvelope.data);
  const oddsData = Array.from(merged.values()).filter(game => isGameWithinWindow(game, window));
  const stillMissing = eventIds.filter(id => !merged.has(id));
  const range = summarizeRange(oddsData);

  return {
    data: oddsData,
    providerTimestamp: directEnvelope.timestamp,
    response: directEnvelope,
    debug: {
      [`${windowConfig.debugPrefix}WindowStart`]: window.commenceTimeFrom,
      [`${windowConfig.debugPrefix}WindowEnd`]: window.commenceTimeTo,
      [`${windowConfig.debugPrefix}WindowTimeZone`]: window.timeZone,
      [`${windowConfig.debugPrefix}EventCount`]: eventsEnvelope.data.length,
      [`${windowConfig.debugPrefix}EventOddsCount`]: supplementalById.size,
      [`${windowConfig.debugPrefix}DirectOddsCount`]: directById.size,
      [`${windowConfig.debugPrefix}MergedOddsCount`]: oddsData.length,
      ...range,
      warning: eventsEnvelope.data.length > 0 && stillMissing.length > 0
        ? `${stillMissing.length} ${sport.sport} event(s) had no historical odds`
        : null,
      missingOddsEventIds: stillMissing
    }
  };
}

async function fetchSportHistoricalOdds(client, sport, bucket, queryAt) {
  const windowConfig = BASEBALL_EVENT_WINDOW_SPORTS[sport.sportKey];
  return windowConfig
    ? fetchBaseballHistoricalOdds(client, sport, bucket, queryAt, windowConfig)
    : fetchStandardHistoricalOdds(client, sport, bucket, queryAt);
}

function buildHistoricalSummary(results, providerTimestamp, client, bucket, queryAt) {
  return {
    lastUpdated: providerTimestamp,
    quota: client.latestQuota ? {
      remaining: client.latestQuota.remaining,
      used: client.latestQuota.used,
      lastRequestCost: client.latestQuota.last,
      reserveCredits: 20
    } : null,
    status: 'healthy',
    source: {
      type: 'the-odds-api-historical-backfill',
      incident: '2026-08-06-actions-outage',
      bucketUtc: bucket,
      requestedAtUtc: queryAt,
      providerTimestampUtc: providerTimestamp
    },
    sports: results.map(({ sport, result }) => {
      const summary = {
        sport: sport.sport,
        gameCount: result.data.length,
        fileName: `${sport.fileName}.json`,
        lastFetched: providerTimestamp,
        lastAttemptAt: providerTimestamp,
        lastAttemptStatus: 'success',
        lastError: null
      };
      if (result.debug) summary.debug = result.debug;
      return summary;
    })
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stableJson(value));
}

function commitHistoricalBucket(bucket, providerTimestamp, receiptPath) {
  git(['add', ODDS_DIR, receiptPath], { capture: false });
  const message = `Backfill odds snapshot - ${providerTimestamp}`;
  git(['commit', '-m', message], {
    capture: false,
    env: {
      GIT_AUTHOR_DATE: providerTimestamp,
      GIT_COMMITTER_DATE: providerTimestamp
    }
  });
  return git(['rev-parse', 'HEAD']);
}

async function executeBackfill({ startUtc, endUtc, maxCredits, timeoutMs }) {
  assertCleanWorktree();
  const originalHead = git(['rev-parse', 'HEAD']);
  const liveOdds = readLiveOddsSnapshot();
  const liveHashes = Object.fromEntries(
    Object.entries(liveOdds).map(([name, contents]) => [name, sha256(contents)])
  );
  const expectedBuckets = buildExpectedBuckets(startUtc, endUtc);
  const missingBuckets = findMissingBuckets(expectedBuckets, getObservedSummaryCommitDates());
  const activeSports = SPORTS.filter(sport => isSportActive(sport, new Date(startUtc)));

  if (missingBuckets.length === 0) {
    console.log('No missing five-minute buckets remain; no paid requests or commits are needed.');
    return { originalHead, expectedBuckets, missingBuckets, commits: [], observedCredits: 0 };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY is required for an executed backfill');
  const client = new HistoricalOddsClient({ apiKey, maxCredits, timeoutMs });
  const quotaBefore = await client.checkQuota();
  const commits = [];
  const receipts = [];

  git(['config', '--local', 'user.email', 'action@github.com']);
  git(['config', '--local', 'user.name', 'GitHub Action']);

  try {
    for (const bucket of missingBuckets) {
      const queryAt = queryAtForBucket(bucket);
      const creditsBefore = client.observedCredits;
      const results = [];
      for (const sport of activeSports) {
        console.log(`Fetching ${sport.sport} historical snapshot for ${bucket}...`);
        const result = await fetchSportHistoricalOdds(client, sport, bucket, queryAt);
        results.push({ sport, result });
      }

      const timestamps = new Set(results.map(item => item.result.providerTimestamp));
      if (timestamps.size !== 1) {
        throw new Error(`Sports returned mismatched provider timestamps for bucket ${bucket}`);
      }
      const providerTimestamp = [...timestamps][0];
      validateProviderTimestamp(bucket, queryAt, providerTimestamp);

      const sportsReceipt = [];
      for (const { sport, result } of results) {
        const serialized = stableJson(result.data);
        fs.writeFileSync(path.join(ODDS_DIR, `${sport.fileName}.json`), serialized);
        sportsReceipt.push({
          sport: sport.sport,
          sportKey: sport.sportKey,
          fileName: `${sport.fileName}.json`,
          regions: sport.regions,
          markets: sport.markets,
          gameCount: result.data.length,
          providerTimestampUtc: result.providerTimestamp,
          sha256: sha256(serialized),
          debug: result.debug
        });
      }

      writeJson(
        path.join(ODDS_DIR, 'summary.json'),
        buildHistoricalSummary(results, providerTimestamp, client, bucket, queryAt)
      );
      const receipt = {
        schemaVersion: 1,
        incident: '2026-08-06-actions-outage',
        bucketUtc: bucket,
        requestedAtUtc: queryAt,
        providerTimestampUtc: providerTimestamp,
        creditsObserved: client.observedCredits - creditsBefore,
        quotaAfter: client.latestQuota,
        sports: sportsReceipt
      };
      const receiptName = `${bucket.replace(/[:.]/g, '-').replace('Z', 'Z')}.json`;
      const receiptPath = path.join(BACKFILL_ROOT, 'receipts', receiptName);
      writeJson(receiptPath, receipt);
      const commitSha = commitHistoricalBucket(bucket, providerTimestamp, receiptPath);
      commits.push({ bucketUtc: bucket, providerTimestampUtc: providerTimestamp, commitSha });
      receipts.push(receiptPath);
    }
  } catch (error) {
    restoreLiveOddsSnapshot(liveOdds);
    throw error;
  }

  restoreLiveOddsSnapshot(liveOdds);
  const manifest = {
    schemaVersion: 1,
    incident: '2026-08-06-actions-outage',
    startUtc,
    endUtc,
    intervalMinutes: RUN_EVERY_MIN,
    originalHead,
    expectedBucketCount: expectedBuckets.length,
    recoveredBucketCount: commits.length,
    missingBuckets,
    activeSports: activeSports.map(sport => sport.sport),
    maxCredits,
    observedCredits: client.observedCredits,
    quotaBefore,
    quotaAfter: client.latestQuota,
    liveOddsSha256: liveHashes,
    commits,
    receipts
  };
  const manifestPath = path.join(BACKFILL_ROOT, 'manifest.json');
  writeJson(manifestPath, manifest);
  git(['add', ODDS_DIR, BACKFILL_ROOT], { capture: false });
  git(['commit', '-m', 'Complete Aug 6 odds backfill and restore live snapshot'], { capture: false });
  git(['diff', '--exit-code', originalHead, 'HEAD', '--', ODDS_DIR]);

  const finalHead = git(['rev-parse', 'HEAD']);
  console.log(stableJson({ ...manifest, finalHead }));
  return { ...manifest, finalHead };
}

function buildPlan({ startUtc, endUtc }) {
  const expectedBuckets = buildExpectedBuckets(startUtc, endUtc);
  const observedDates = getObservedSummaryCommitDates();
  const missingBuckets = findMissingBuckets(expectedBuckets, observedDates);
  const activeSports = SPORTS.filter(sport => isSportActive(sport, new Date(startUtc)));
  return {
    startUtc,
    endUtc,
    intervalMinutes: RUN_EVERY_MIN,
    expectedBucketCount: expectedBuckets.length,
    observedBucketCount: expectedBuckets.length - missingBuckets.length,
    missingBucketCount: missingBuckets.length,
    missingBuckets,
    activeSports: activeSports.map(sport => ({
      sport: sport.sport,
      sportKey: sport.sportKey,
      regions: sport.regions,
      markets: sport.markets
    }))
  };
}

async function main() {
  const startUtc = process.env.BACKFILL_START_UTC || DEFAULT_START_UTC;
  const endUtc = process.env.BACKFILL_END_UTC || DEFAULT_END_UTC;
  const execute = process.env.BACKFILL_EXECUTE === 'true';
  const maxCredits = parsePositiveInteger(
    process.env.BACKFILL_MAX_CREDITS,
    DEFAULT_MAX_CREDITS,
    'BACKFILL_MAX_CREDITS'
  );
  const timeoutMs = parsePositiveInteger(
    process.env.ODDS_API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'ODDS_API_TIMEOUT_MS'
  );

  const plan = buildPlan({ startUtc, endUtc });
  console.log(stableJson(plan));
  if (!execute) {
    console.log('Dry run only. Set BACKFILL_EXECUTE=true to spend credits and create commits.');
    return;
  }
  await executeBackfill({ startUtc, endUtc, maxCredits, timeoutMs });
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Historical odds backfill failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildExpectedBuckets,
  findMissingBuckets,
  floorToFiveMinuteBucket,
  queryAtForBucket,
  validateProviderTimestamp
};
