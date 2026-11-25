const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { artifactDigest, readPublicationEntries } = require('../publication-order');

const parent = process.argv[2];
function gitOutput(...args) {
  return execFileSync('git', args, { maxBuffer: 8 * 1024 * 1024 });
}

const { publication, sports } = JSON.parse(gitOutput('show', ':odds/summary.json'));
if (!Array.isArray(sports)) throw new Error('Staged odds summary has no sports receipts');
const receipts = new Map();
for (const receipt of sports) {
  const file = receipt?.fileName?.toLowerCase();
  if (!file || receipt.fileName !== file || receipts.has(file)) {
    throw new Error('Staged odds summary has invalid or duplicate sports receipts');
  }
  receipts.set(file, receipt);
}
if (publication?.sourceParent !== parent) {
  throw new Error('Odds summary does not bind the exact producer parent');
}
const entries = readPublicationEntries(publication);
const previousPublication = JSON.parse(gitOutput('show', `${parent}:odds/summary.json`)).publication;
const previousEntries = readPublicationEntries(previousPublication);
const updatedArtifacts = new Set();

for (const [file, previous] of Object.entries(previousEntries)) {
  if (!Object.hasOwn(entries, file)) throw new Error(`Missing prior odds publication for ${file}`);
  if (entries[file].generation === previous.generation && !isDeepStrictEqual(entries[file], previous)) {
    throw new Error(`Existing odds publication changed for ${file}`);
  }
}

for (const [file, entry] of Object.entries(entries)) {
  const generation = previousEntries[file]?.generation ?? 0;
  const advanced = entry.generation !== generation;
  if (advanced && (entry.generation !== generation + 1 || entry.sourceParent !== parent)) {
    throw new Error(`Odds publication must advance from the exact parent for ${file}`);
  }

  const receipt = receipts.get(file);
  if (entry.kind === 'omitted') {
    if (advanced && receipt) throw new Error(`An omitted publication must have no sports receipt for ${file}`);
    continue;
  }

  const artifactPath = `odds/${file}`;
  const bytes = gitOutput('show', `:${artifactPath}`);
  if (artifactDigest(bytes) !== entry.artifactSha256) {
    throw new Error(`Staged odds bytes do not match the summary for ${file}`);
  }
  if (!advanced) continue;

  const events = JSON.parse(bytes);
  if (!Array.isArray(events) || entry.kind !== (events.length === 0 ? 'empty' : 'available') ||
      receipt?.gameCount !== events.length || receipt.lastAttemptStatus !== 'success' ||
      receipt.lastFetched !== entry.observedAtUtc || receipt.lastAttemptAt !== entry.observedAtUtc) {
    throw new Error(`Staged odds events do not match the successful sports receipt for ${file}`);
  }

  updatedArtifacts.add(artifactPath);
}

const staged = gitOutput('diff', '--cached', '--no-renames', '--name-only', '-z', '--', 'odds/')
  .toString('utf8').split('\0').filter(Boolean);
for (const file of staged) {
  if (file !== 'odds/summary.json' && !updatedArtifacts.has(file)) {
    throw new Error(`No new odds publication covers staged changes to ${file}`);
  }
}
