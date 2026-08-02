const assert = require('node:assert/strict');
const { buildSummarySport } = require('./fetch-odds');

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

console.log('odds-fetcher summary receipt tests passed');
