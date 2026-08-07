const assert = require('node:assert/strict');
const {
  buildExpectedBuckets,
  buildHistoricalSummary,
  findMissingBuckets,
  floorToFiveMinuteBucket,
  queryAtForBucket,
  readCarriedForwardSportSnapshot,
  validateProviderTimestamp
} = require('./backfill-odds');
const { SPORTS } = require('./fetch-odds');

assert.equal(
  floorToFiveMinuteBucket('2026-08-06T15:46:20Z'),
  '2026-08-06T15:45:00.000Z'
);
assert.equal(
  queryAtForBucket('2026-08-06T15:40:00Z'),
  '2026-08-06T15:44:59Z'
);
assert.equal(
  validateProviderTimestamp(
    '2026-08-06T15:40:00Z',
    '2026-08-06T15:44:59Z',
    '2026-08-06T15:40:39Z'
  ),
  '2026-08-06T15:40:39.000Z'
);
assert.throws(() => validateProviderTimestamp(
  '2026-08-06T15:40:00Z',
  '2026-08-06T15:44:59Z',
  '2026-08-06T15:35:39Z'
));

const expected = buildExpectedBuckets(
  '2026-08-06T15:35:00Z',
  '2026-08-06T15:50:00Z'
);
assert.deepEqual(expected, [
  '2026-08-06T15:35:00.000Z',
  '2026-08-06T15:40:00.000Z',
  '2026-08-06T15:45:00.000Z',
  '2026-08-06T15:50:00.000Z'
]);
assert.deepEqual(
  findMissingBuckets(expected, [
    '2026-08-06T15:35:36Z',
    '2026-08-06T15:46:20Z'
  ]),
  [
    '2026-08-06T15:40:00.000Z',
    '2026-08-06T15:50:00.000Z'
  ]
);

const kbo = SPORTS.find(sport => sport.sportKey === 'baseball_kbo');
const carriedKbo = readCarriedForwardSportSnapshot(
  'HEAD',
  kbo,
  '2026-08-06T15:44:59Z'
);
assert.ok(Array.isArray(carriedKbo.data));
assert.equal(carriedKbo.reconstructionMethod, 'git-carry-forward');
assert.ok(new Date(carriedKbo.providerTimestamp) <= new Date('2026-08-06T15:44:59Z'));

const summary = buildHistoricalSummary(
  [{
    sport: kbo,
    result: {
      data: carriedKbo.data,
      providerTimestamp: carriedKbo.providerTimestamp,
      debug: carriedKbo.debug
    }
  }],
  '2026-08-06T15:44:59.000Z',
  { latestQuota: null },
  '2026-08-06T15:40:00.000Z',
  '2026-08-06T15:44:59Z'
);
assert.equal(summary.lastUpdated, '2026-08-06T15:44:59.000Z');
assert.equal(summary.sports[0].lastFetched, carriedKbo.providerTimestamp);

console.log('historical backfill planning tests passed');
