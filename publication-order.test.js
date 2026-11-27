const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { artifactDigest, buildPublication, readPublicationEntries } = require('./publication-order');
const { SPORTS } = require('./fetch-odds');

const parent = 'a'.repeat(40);
const nextParent = 'b'.repeat(40);
const firstAt = '2026-11-23T00:00:00.000Z';
const nextAt = '2026-11-23T00:05:00.000Z';
const epl = 'epl.json';
const ncaaf = 'ncaaf.json';
const priceBytes = '[{"id":"fixture","price":-110}]';
const baseline = {
  configuredFiles: [epl, ncaaf],
  activeFiles: new Set([epl, ncaaf]),
  attempts: new Map([[epl, { gameCount: 1 }], [ncaaf, { gameCount: 1 }]]),
  digests: new Map([[epl, artifactDigest(priceBytes)], [ncaaf, artifactDigest(priceBytes)]]),
  sourceParent: parent,
  observedAtUtc: firstAt
};
const initial = buildPublication(undefined, baseline);
assert.equal(initial.leagues[ncaaf].generation, 1);
assert.equal(initial.leagues[ncaaf].kind, 'available');
assert.equal(initial.leagues[ncaaf].artifactSha256, artifactDigest(priceBytes));
assert.notEqual(initial.leagues[ncaaf].artifactSha256, artifactDigest(priceBytes + '\n'));
assert.equal(initial.leagues[ncaaf].sourceParent, parent);

const next = { ...baseline, sourceParent: nextParent, observedAtUtc: nextAt };
const empty = buildPublication(initial, {
  ...next, attempts: new Map([[ncaaf, { gameCount: 0 }]]), digests: new Map([[ncaaf, artifactDigest('[]')]])
});
assert.equal(empty.leagues[ncaaf].generation, 2);
assert.equal(empty.leagues[ncaaf].kind, 'empty');
assert.equal(empty.leagues[ncaaf].artifactSha256, artifactDigest('[]'));
assert.deepEqual(empty.leagues[epl], initial.leagues[epl]);
const failed = buildPublication(empty, {
  ...next, attempts: new Map([[ncaaf, { error: { status: 429 } }]]), digests: new Map()
});
assert.deepEqual(failed.leagues, empty.leagues);
const omitted = buildPublication(empty, {
  ...next, activeFiles: new Set([epl]), attempts: new Map(), digests: new Map()
});
assert.equal(omitted.leagues[ncaaf].generation, 3);
assert.equal(omitted.leagues[ncaaf].kind, 'omitted');
assert.equal(omitted.leagues[ncaaf].artifactSha256, null);
const stillOmitted = buildPublication(omitted, {
  ...next, activeFiles: new Set([epl]), attempts: new Map(), digests: new Map()
});
assert.deepEqual(stillOmitted.leagues, omitted.leagues);
const resumed = buildPublication(omitted, next);
assert.equal(resumed.leagues[ncaaf].kind, 'available');
assert.equal(resumed.leagues[ncaaf].generation, 4);
assert.throws(() => buildPublication(initial, { ...next, digests: new Map() }), /no verified artifact/);
assert.throws(() => buildPublication(initial, { ...next, attempts: new Map() }), /without a successful attempt/);
assert.throws(() => readPublicationEntries({ ...initial, sourceParent: [parent] }), /Invalid odds publication manifest/);
assert.throws(() => readPublicationEntries({ ...initial, version: 2 }), /Invalid odds publication manifest/);
assert.throws(() => readPublicationEntries({
  ...initial, leagues: { [epl]: { ...initial.leagues[epl], artifactSha256: 'bogus' } }
}), /Invalid odds publication/);
const exhausted = structuredClone(initial);
exhausted.leagues[ncaaf].generation = Number.MAX_SAFE_INTEGER;
assert.throws(() => buildPublication(exhausted, next), /version exhausted/);

const script = path.join(__dirname, 'scripts', 'publish-odds.sh');
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function configure(repo) {
  git(repo, 'config', 'user.name', 'Publication fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'commit.gpgSign', 'false');
}
function publish(repo, expectedParent) {
  return spawnSync('bash', [script], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, ODDS_PUBLICATION_PARENT: expectedParent }
  });
}
function successfulReceipts(publication) {
  return Object.entries(publication.leagues).filter(([, entry]) => entry.kind !== 'omitted')
    .map(([fileName, entry]) => ({
      fileName, gameCount: entry.kind === 'empty' ? 0 : 1, lastFetched: entry.observedAtUtc,
      lastAttemptAt: entry.observedAtUtc, lastAttemptStatus: 'success'
    }));
}
function writeSummary(repo, publication, sports = successfulReceipts(publication)) {
  fs.writeFileSync(path.join(repo, 'odds', 'summary.json'), JSON.stringify({ sports, publication }));
}
function writeArtifact(repo, file, value) {
  fs.writeFileSync(path.join(repo, 'odds', file), value);
}
function stageNcaafObservation(repo, observationParent, bytes) {
  const previous = JSON.parse(git(repo, 'show', `${observationParent}:odds/summary.json`)).publication;
  const gameCount = JSON.parse(bytes).length;
  const publication = buildPublication(previous, {
    ...next, sourceParent: observationParent, attempts: new Map([[ncaaf, { gameCount }]]),
    digests: new Map([[ncaaf, artifactDigest(bytes)]])
  });
  const receipts = successfulReceipts(publication);
  receipts.find(receipt => receipt.fileName === ncaaf).gameCount = gameCount;
  writeArtifact(repo, ncaaf, bytes);
  writeSummary(repo, publication, receipts);
  return publication.leagues[ncaaf];
}
function acquire(repo, expectedParent) {
  const env = { ...process.env, GITHUB_ACTIONS: 'true', FORCE_FETCH: 'false' };
  delete env.ODDS_API_KEY;
  delete env.ODDS_PUBLICATION_PARENT;
  if (expectedParent) env.ODDS_PUBLICATION_PARENT = expectedParent;
  return spawnSync(process.execPath, [path.join(__dirname, 'fetch-odds.js')], {
    cwd: repo, encoding: 'utf8', env
  });
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-publication-'));
try {
  const remote = path.join(root, 'remote.git');
  const winner = path.join(root, 'winner');
  const delayed = path.join(root, 'delayed');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, winner);
  configure(winner);
  fs.mkdirSync(path.join(winner, 'odds'));
  fs.writeFileSync(path.join(winner, 'odds', 'summary.json'), '{"sports":[]}');
  git(winner, 'add', 'odds/summary.json');
  git(winner, 'commit', '-m', 'Bootstrap the fixture');
  git(winner, 'push', 'origin', 'HEAD:refs/heads/main');
  const capturedParent = git(winner, 'rev-parse', 'HEAD');
  git(root, 'clone', remote, delayed);
  configure(delayed);

  const missingCapture = acquire(winner);
  assert.notEqual(missingCapture.status, 0);
  assert.match(missingCapture.stderr, /must capture the exact odds publication parent/);

  const initialAccepted = buildPublication(undefined, { ...baseline, sourceParent: capturedParent });
  for (const worktree of [winner, delayed]) {
    writeSummary(worktree, initialAccepted);
    writeArtifact(worktree, epl, priceBytes);
    writeArtifact(worktree, ncaaf, priceBytes);
  }
  writeSummary(winner, initialAccepted, []);
  const missingSportReceipts = publish(winner, capturedParent);
  assert.notEqual(missingSportReceipts.status, 0);
  assert.match(missingSportReceipts.stderr, /do not match the successful sports receipt/);
  writeSummary(winner, initialAccepted);

  const approved = publish(winner, capturedParent);
  assert.equal(approved.status, 0, approved.stderr);
  const approvedHead = git(remote, 'rev-parse', 'refs/heads/main');
  assert.equal(git(winner, 'rev-parse', 'HEAD^1'), capturedParent);
  const discarded = publish(delayed, capturedParent);
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.match(discarded.stdout, /Discarding this odds publication/);
  assert.equal(git(delayed, 'rev-parse', 'HEAD'), capturedParent);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), approvedHead);

  writeSummary(winner, empty);
  const mismatched = publish(winner, approvedHead);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /does not bind the exact producer parent/);

  const advanced = buildPublication(initialAccepted, {
    ...next, sourceParent: approvedHead, attempts: new Map([[ncaaf, { gameCount: 0 }]]),
    digests: new Map([[ncaaf, artifactDigest('[]')]])
  });
  writeSummary(winner, advanced);
  writeArtifact(winner, ncaaf, '[]\n');
  const byteMismatch = publish(winner, approvedHead);
  assert.notEqual(byteMismatch.status, 0);
  assert.match(byteMismatch.stderr, /Staged odds bytes do not match the summary/);
  writeArtifact(winner, ncaaf, '[]');

  const later = path.join(root, 'later');
  git(root, 'clone', remote, later);
  configure(later);
  fs.writeFileSync(path.join(later, 'code-only.txt'), 'Concurrent code change.');
  git(later, 'add', 'code-only.txt');
  git(later, 'commit', '-m', 'Advance main during push');
  const laterHead = git(later, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(winner, '.git', 'hooks', 'pre-push'),
    '#!/bin/sh\ncd "$(dirname "$0")/../../../later" && git push origin HEAD:refs/heads/main\n',
    { mode: 0o755 });
  const raced = publish(winner, approvedHead);
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /push failed and main advanced/);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), laterHead);
  assert.equal(git(winner, 'rev-parse', 'HEAD^1'), approvedHead);

  const noRemote = path.join(root, 'missing.git');
  git(later, 'remote', 'set-url', 'origin', noRemote);
  writeSummary(later, { ...advanced, sourceParent: laterHead });
  writeArtifact(later, ncaaf, '[]');
  const unavailable = publish(later, laterHead);
  assert.notEqual(unavailable.status, 0);
  assert.doesNotMatch(unavailable.stdout, /Discarding/);

  // The old result contains both events and must never restore either one
  // when a competing empty or partial observation commits from the same parent.
  const previousBoard = '[{"id":"fixture","price":-110},{"id":"disappeared","price":-120}]';
  for (const [scenario, latestBoard] of [['empty', '[]'], ['partial', priceBytes]]) {
    const current = path.join(root, `current-${scenario}`);
    const stale = path.join(root, `stale-${scenario}`);
    git(root, 'clone', remote, current);
    configure(current);
    const beforeInitial = git(current, 'rev-parse', 'HEAD');
    const initialBoard = stageNcaafObservation(current, beforeInitial, previousBoard);
    const initialPublish = publish(current, beforeInitial);
    assert.equal(initialPublish.status, 0, initialPublish.stderr);

    const sharedParent = git(current, 'rev-parse', 'HEAD');
    git(root, 'clone', remote, stale);
    configure(stale);
    const oldObservation = stageNcaafObservation(stale, sharedParent, previousBoard);
    const winningObservation = stageNcaafObservation(current, sharedParent, latestBoard);
    assert.equal(winningObservation.generation, initialBoard.generation + 1);
    assert.equal(oldObservation.generation, winningObservation.generation);
    assert.notEqual(oldObservation.artifactSha256, winningObservation.artifactSha256);

    const newer = publish(current, sharedParent);
    assert.equal(newer.status, 0, newer.stderr);
    const newerHead = git(current, 'rev-parse', 'HEAD');
    const older = publish(stale, sharedParent);
    assert.equal(older.status, 0, older.stderr);
    assert.match(older.stdout, /Discarding this odds publication/);
    assert.equal(git(stale, 'rev-parse', 'HEAD'), sharedParent);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), newerHead);
    assert.equal(git(remote, 'show', `refs/heads/main:odds/${ncaaf}`), latestBoard);
    const storedSummary = JSON.parse(git(remote, 'show', 'refs/heads/main:odds/summary.json'));
    assert.deepEqual(storedSummary.publication.leagues[ncaaf], winningObservation);
  }

  const quiet = path.join(root, 'quiet');
  git(root, 'clone', remote, quiet);
  configure(quiet);
  const quietParent = git(quiet, 'rev-parse', 'HEAD');
  const now = new Date().toISOString();
  const quietSports = SPORTS.map(sport => ({ sport: sport.sport, fileName: `${sport.fileName}.json`,
    gameCount: 7, lastFetched: now, lastAttemptAt: now, lastAttemptStatus: 'success' }));
  const withdrawn = 'withdrawn.json';
  const quietManifest = { ...initialAccepted, leagues: {
    [withdrawn]: { ...initialAccepted.leagues[epl] }
  } };
  writeSummary(quiet, quietManifest, quietSports);
  const seasonOnly = acquire(quiet, quietParent);
  assert.equal(seasonOnly.status, 0, seasonOnly.stderr);
  assert.match(seasonOnly.stdout, /without a paid odds request/);
  const quietSummary = JSON.parse(fs.readFileSync(path.join(quiet, 'odds', 'summary.json'), 'utf8'));
  assert.equal(quietSummary.publication.leagues[withdrawn].kind, 'omitted');
  assert.equal(quietSummary.publication.leagues[withdrawn].generation, 2);
  assert.ok(quietSummary.sports.length > 0);
  for (const row of quietSummary.sports) {
    assert.deepEqual(row, quietSports.find(old => old.fileName === row.fileName));
  }
  const again = acquire(quiet, quietParent);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /without a paid odds request/);
  fs.unlinkSync(path.join(quiet, 'odds', 'summary.json'));
  const missingSummary = acquire(quiet, quietParent);
  assert.notEqual(missingSummary.status, 0);
  assert.match(missingSummary.stderr, /summary.json/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Publication generations, exact staged bytes, season transitions and Git push races passed.');
