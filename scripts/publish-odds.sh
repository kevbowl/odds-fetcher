#!/usr/bin/env bash
set -euo pipefail

parent="${ODDS_PUBLICATION_PARENT:?Capture the exact checkout SHA before fetching odds}"
[[ "$parent" =~ ^[a-f0-9]{40}$ ]]
test "$(git rev-parse HEAD)" = "$parent"

git add -- odds/
if git diff --cached --quiet; then
  echo "No odds changes to commit."
  exit 0
fi
if ! git diff --cached --quiet -- . ':(exclude)odds/'; then
  echo "Refusing to publish unrelated staged files." >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$script_dir/validate-staged-publication.js" "$parent"

remote_main() {
  local refs tip ref
  refs=$(git ls-remote --refs --exit-code origin refs/heads/main) || return 1
  read -r tip ref <<< "$refs" || return 1
  [[ "$tip" =~ ^[a-f0-9]{40}$ && "$ref" = refs/heads/main ]] || return 1
  printf '%s\n' "$tip"
}

tip=$(remote_main)
if test "$tip" != "$parent"; then
  echo "Main changed during the fetch. Discarding this odds publication."
  exit 0
fi

git commit -m "Update odds - $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
candidate=$(git rev-parse HEAD)
test "$(git rev-parse HEAD^1)" = "$parent"

# Only a normal fast-forward is permitted. The publisher branch must forbid
# rewinds and deletions. Never rebase provider data onto a new parent.
if git push origin "$candidate:refs/heads/main"; then
  exit 0
fi
tip=$(remote_main)
if test "$tip" = "$candidate"; then
  echo "The candidate reached main before the push connection closed."
  exit 0
fi
if test "$tip" != "$parent"; then
  echo "Odds publisher push failed and main advanced. Candidate $candidate, observed main $tip." >&2
  exit 1
fi
echo "Odds publisher push failed and main is still at the captured parent." >&2
exit 1
