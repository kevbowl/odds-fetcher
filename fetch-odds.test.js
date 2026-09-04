const assert = require('node:assert/strict');
const {
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
} = require('./fetch-odds');

const sport = { sport: 'WNBA', fileName: 'wnba' };
const previous = {
  gameCount: 4,
  lastFetched: '2026-08-02T15:45:00.000Z',
  lastAttemptAt: '2026-08-02T15:45:00.000Z',
  lastAttemptStatus: 'success',
  lastError: null
};
const nowIso = '2026-08-02T16:00:00.000Z';

const success = buildSummarySport(sport, {
  sport: 'WNBA',
  gameCount: 7,
  debug: { warning: null }
}, previous, nowIso);
assert.equal(success.lastFetched, nowIso);
assert.equal(success.lastAttemptAt, nowIso);
assert.equal(success.lastAttemptStatus, 'success');
assert.equal(success.lastError, null);
assert.equal(success.gameCount, 7);
assert.deepEqual(success.debug, { warning: null });

const failure = buildSummarySport(sport, {
  sport: 'WNBA',
  error: { status: 503, message: 'Request failed with status code 503' }
}, previous, nowIso);
assert.equal(failure.lastFetched, previous.lastFetched);
assert.equal(failure.lastAttemptAt, nowIso);
assert.equal(failure.lastAttemptStatus, 'failed');
assert.deepEqual(failure.lastError, {
  status: 503,
  message: 'Request failed with status code 503'
});
assert.equal(failure.gameCount, previous.gameCount);
assert.equal(failure.debug, undefined);

const notDue = buildSummarySport(sport, undefined, previous, nowIso);
assert.equal(notDue.lastFetched, previous.lastFetched);
assert.equal(notDue.lastAttemptAt, previous.lastAttemptAt);
assert.equal(notDue.lastAttemptStatus, previous.lastAttemptStatus);
assert.equal(notDue.lastError, null);

const firstFailure = buildSummarySport(sport, {
  sport: 'WNBA',
  error: { status: null, message: 'network unavailable' }
}, undefined, nowIso);
assert.equal(firstFailure.gameCount, 0);
assert.equal(firstFailure.lastFetched, null);
assert.equal(firstFailure.lastAttemptStatus, 'failed');

assert.equal(RUN_EVERY_MIN, 5);
const epl = SPORTS.find(candidate => candidate.sportKey === 'soccer_epl');
assert.ok(epl, 'EPL configuration should exist');
assert.equal(epl.sport, 'epl');
assert.equal(epl.fileName, 'epl');
assert.equal(epl.markets, 'h2h,totals');
assert.equal(epl.regions, 'us');
assert.equal(epl.fetchEveryMinutes, 5);
assert.equal(epl.preseasonSportKey, undefined);
assert.equal(estimateCredits(epl), 2);
assert.equal(isSportActive(epl, new Date('2026-08-20T00:00:00Z')), true);
assert.equal(isSportActive(epl, new Date('2026-05-31T23:59:59Z')), true);
assert.equal(isSportActive(epl, new Date('2026-06-01T00:00:00Z')), false);
assert.equal(isSportActive(epl, new Date('2026-07-19T00:00:00Z')), false);
assert.doesNotThrow(() => assertExpectedSportKey([
  { id: 'epl-1', sport_key: 'soccer_epl' }
], 'soccer_epl'));
assert.doesNotThrow(() => assertExpectedSportKey([], 'soccer_epl'));
assert.throws(
  () => assertExpectedSportKey([
    { id: 'epl-1', sport_key: 'soccer_epl' },
    { id: 'wcup-1', sport_key: 'soccer_fifa_world_cup' }
  ], 'soccer_epl'),
  /soccer_fifa_world_cup/
);
assert.throws(
  () => assertExpectedSportKey([
    { id: 'mls-1', sport_key: 'soccer_usa_mls' }
  ], 'soccer_epl'),
  /soccer_usa_mls/
);
const worldcup = SPORTS.find(candidate => candidate.sportKey === 'soccer_fifa_world_cup');
assert.ok(worldcup, 'World Cup configuration should remain separate');
assert.equal(worldcup.fileName, 'worldcup');
assert.notEqual(epl.fileName, worldcup.fileName);
assert.notEqual(epl.sportKey, worldcup.sportKey);
const eplSummary = buildSummarySport(epl, {
  sport: 'epl',
  gameCount: 10
}, undefined, nowIso);
assert.equal(eplSummary.fileName, 'epl.json');
assert.equal(eplSummary.sport, 'epl');
assert.equal(eplSummary.gameCount, 10);
assert.equal(eplSummary.lastFetched, nowIso);
assert.equal(eplSummary.lastAttemptAt, nowIso);
assert.equal(eplSummary.lastAttemptStatus, 'success');
const failedEplSummary = buildSummarySport(epl, {
  sport: 'epl',
  error: { status: 503, message: 'provider failure' }
}, undefined, nowIso);
assert.equal(failedEplSummary.lastFetched, null);
assert.equal(failedEplSummary.gameCount, 0);
assert.equal(failedEplSummary.lastAttemptStatus, 'failed');
assert.notEqual(failedEplSummary.lastAttemptStatus, 'success');
const nfl = SPORTS.find(candidate => candidate.sportKey === 'americanfootball_nfl');
assert.ok(nfl, 'NFL configuration should exist');
assert.equal(isSportActive(nfl, new Date('2026-08-01T00:00:00Z')), true);
assert.equal(isSportActive(nfl, new Date('2026-07-31T23:59:59Z')), false);
assert.equal(nfl.preseasonSportKey, 'americanfootball_nfl_preseason');

const providerSports = parseAvailableSportKeys([
  { key: 'americanfootball_nfl', active: true },
  { key: 'americanfootball_nfl_preseason', active: true },
  { key: 'baseball_mlb', active: false }
]);
assert.deepEqual(
  [...providerSports].sort(),
  ['americanfootball_nfl', 'americanfootball_nfl_preseason']
);
assert.equal(isPreseasonActive(nfl, providerSports, new Date('2026-10-01T00:00:00Z')), true);
assert.equal(isPreseasonActive(nfl, new Set(), new Date('2026-08-15T00:00:00Z')), false);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-08-01T00:00:00Z')), true);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-09-09T23:59:59Z')), true);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-09-10T00:00:00Z')), false);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-07-31T23:59:59Z')), false);
assert.equal(estimateCredits({ ...nfl, includePreseason: false }), 3);
assert.equal(estimateCredits({ ...nfl, includePreseason: true }), 6);

const regularGame = {
  id: 'regular-later',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-10T00:15:00Z'
};
const preseasonGame = {
  id: 'preseason-earlier',
  sport_key: 'americanfootball_nfl_preseason',
  commence_time: '2026-08-13T23:00:00Z'
};
const duplicateRegular = {
  id: 'duplicate',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-01T00:00:00Z'
};
const duplicatePreseason = {
  id: 'duplicate',
  sport_key: 'americanfootball_nfl_preseason',
  commence_time: '2026-09-01T00:00:00Z'
};
const mergedNfl = mergeOddsGames(
  [regularGame, duplicateRegular],
  [duplicatePreseason, preseasonGame]
);
assert.deepEqual(
  mergedNfl.map(game => game.id),
  ['preseason-earlier', 'duplicate', 'regular-later']
);
assert.equal(mergedNfl.length, 3);
assert.equal(mergedNfl[0].sport_key, 'americanfootball_nfl_preseason');
assert.equal(mergedNfl[1].sport_key, 'americanfootball_nfl_preseason');
assert.deepEqual(countNflGamesByFeed(mergedNfl), {
  regularSeasonGameCount: 1,
  preseasonGameCount: 2
});

const nflSummary = buildSummarySport(nfl, {
  sport: 'NFL',
  gameCount: 3,
  regularSeasonGameCount: 1,
  preseasonGameCount: 2
}, undefined, nowIso);
assert.equal(nflSummary.gameCount, 3);
assert.equal(nflSummary.regularSeasonGameCount, 1);
assert.equal(nflSummary.preseasonGameCount, 2);
const failedNflSummary = buildSummarySport(nfl, {
  sport: 'NFL',
  error: { status: 503, message: 'preseason unavailable' }
}, {
  gameCount: 285,
  regularSeasonGameCount: 272,
  preseasonGameCount: 13,
  lastFetched: previous.lastFetched
}, nowIso);
assert.equal(failedNflSummary.gameCount, 285);
assert.equal(failedNflSummary.regularSeasonGameCount, 272);
assert.equal(failedNflSummary.preseasonGameCount, 13);
assert.equal(failedNflSummary.lastAttemptStatus, 'failed');
const fiveMinuteSport = { fetchEveryMinutes: 5 };
const cadenceNow = new Date('2026-08-02T16:05:00.000Z');
assert.equal(
  isSportDue(fiveMinuteSport, '2026-08-02T16:03:00.000Z', cadenceNow),
  false
);
assert.equal(
  isSportDue(fiveMinuteSport, '2026-08-02T16:02:00.000Z', cadenceNow),
  true
);

async function testNflPublication() {
  const writes = [];
  const result = await fetchNflOdds(
    { ...nfl, includePreseason: true },
    {
      fetchRequest: async url => ({
        data: url.includes('nfl_preseason') ? [] : [regularGame],
        headers: {}
      }),
      writeFile: (filePath, contents) => writes.push({ filePath, contents })
    }
  );
  assert.equal(result.gameCount, 1);
  assert.equal(result.regularSeasonGameCount, 1);
  assert.equal(result.preseasonGameCount, 0);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].contents), [regularGame]);

  let partialFailureWrites = 0;
  await assert.rejects(
    fetchNflOdds(
      { ...nfl, includePreseason: true },
      {
        fetchRequest: async url => {
          if (url.includes('nfl_preseason')) {
            throw new Error('preseason provider failure');
          }
          return { data: [regularGame], headers: {} };
        },
        writeFile: () => { partialFailureWrites += 1; }
      }
    ),
    /preseason provider failure/
  );
  assert.equal(partialFailureWrites, 0);
}

async function testNativeHttpClient() {
  const requestUrl = buildApiRequestUrl('https://example.test/odds', {
    markets: 'h2h,spreads',
    regions: 'us',
    omitted: null
  });
  assert.equal(requestUrl.searchParams.get('markets'), 'h2h,spreads');
  assert.equal(requestUrl.searchParams.get('regions'), 'us');
  assert.equal(requestUrl.searchParams.has('omitted'), false);

  const response = await fetchJson('https://example.test/odds', { regions: 'us' }, {
    fetchImpl: async url => {
      assert.equal(url.searchParams.get('regions'), 'us');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 'game-1' }]),
        headers: { entries: () => [['x-requests-remaining', '42']] }
      };
    },
    timeoutMs: 1000
  });
  assert.deepEqual(response.data, [{ id: 'game-1' }]);
  assert.equal(response.headers['x-requests-remaining'], '42');

  await assert.rejects(
    fetchJson('https://example.test/odds', {}, {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'unavailable' }),
        headers: { entries: () => [] }
      }),
      timeoutMs: 1000
    }),
    error => error.response?.status === 503
      && error.response?.data?.message === 'unavailable'
  );

  await assert.rejects(
    fetchJson('https://example.test/odds', {}, {
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
      timeoutMs: 10
    }),
    error => error.code === 'ETIMEDOUT'
  );
}

Promise.all([testNflPublication(), testNativeHttpClient()])
  .then(() => console.log('odds-fetcher fetch and receipt tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
