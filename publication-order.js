const { createHash } = require('node:crypto');

const VERSION = 1;
const PARENT_SHA = /^[a-f0-9]{40}$/;
const CONTENT_SHA = /^[a-f0-9]{64}$/;
const ARTIFACT_PATH = /^[a-z0-9-]+\.json$/;

function matches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function readPublicationEntries(publication) {
  // Existing checkouts can have an older summary without a publication witness.
  // Only a new successful fetch or intentional omission can establish its order.
  if (publication === undefined) return {};
  if (!publication || publication.version !== VERSION || !matches(publication.sourceParent, PARENT_SHA)
      || !publication.leagues || typeof publication.leagues !== 'object' || Array.isArray(publication.leagues)) {
    throw new Error('Invalid odds publication manifest');
  }
  for (const [fileName, entry] of Object.entries(publication.leagues)) {
    if (!ARTIFACT_PATH.test(fileName) || !entry || !Number.isSafeInteger(entry.generation)
        || entry.generation < 1 || !isTimestamp(entry.observedAtUtc) || !matches(entry.sourceParent, PARENT_SHA)
        || !['available', 'empty', 'omitted'].includes(entry.kind)
        || (entry.kind === 'omitted' ? entry.artifactSha256 !== null : !matches(entry.artifactSha256, CONTENT_SHA))) {
      throw new Error(`Invalid odds publication for ${fileName}`);
    }
  }
  return publication.leagues;
}

function artifactDigest(contents) {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

function buildPublication(previous, { configuredFiles, activeFiles, attempts, digests, sourceParent, observedAtUtc }) {
  if (!matches(sourceParent, PARENT_SHA) || !isTimestamp(observedAtUtc)) {
    throw new Error('Odds publication requires an exact Git parent and UTC observation time');
  }
  const leagues = { ...readPublicationEntries(previous) };

  for (const fileName of new Set([...configuredFiles, ...Object.keys(leagues)])) {
    if (!ARTIFACT_PATH.test(fileName)) throw new Error('Invalid odds artifact path');
    const current = leagues[fileName];
    const attempt = attempts.get(fileName);
    const digest = digests.get(fileName);
    let kind;
    if (!activeFiles.has(fileName)) {
      if (attempt || digest) throw new Error(`Unexpected write for inactive league ${fileName}`);
      if (current?.kind === 'omitted') continue;
      kind = 'omitted';
    } else if (attempt && !attempt.error) {
      if (!Number.isSafeInteger(attempt.gameCount) || attempt.gameCount < 0 || !matches(digest, CONTENT_SHA)) {
        throw new Error(`Successful odds attempt has no verified artifact for ${fileName}`);
      }
      kind = attempt.gameCount === 0 ? 'empty' : 'available';
    } else {
      if (digest) throw new Error(`Artifact changed without a successful attempt for ${fileName}`);
      continue;
    }

    const generation = (current?.generation || 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error(`Odds publication version exhausted for ${fileName}`);
    leagues[fileName] = { generation, kind, sourceParent, observedAtUtc, artifactSha256: digest ?? null };
  }

  return { version: VERSION, sourceParent, leagues };
}

module.exports = { artifactDigest, buildPublication, readPublicationEntries };
