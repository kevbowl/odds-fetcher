const assert = require('node:assert/strict');
const {
  buildExpectedBuckets,
  findMissingBuckets,
  floorToFiveMinuteBucket,
  queryAtForBucket,
  validateProviderTimestamp
} = require('./backfill-odds');

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

console.log('historical backfill planning tests passed');
