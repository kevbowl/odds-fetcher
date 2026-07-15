# Repository instructions

## Git workflow

GitHub Actions updates `main` about every 15 minutes. Assume `origin/main` may advance while local work is in progress.

Before changing files:

- Start from the latest `origin/main` when the worktree is clean.
- Preserve all automated odds updates under `odds/`.

Before every push:

1. Commit only the files intended for the current task.
2. Run `git pull --rebase origin main` immediately before pushing.
3. Re-run relevant checks if the rebase changes executable code.
4. Run `git push origin main`.

If the push is rejected because the workflow advanced `main`, repeat the pull/rebase and push. Never force-push `main`, and do not replace automated odds commits with local versions.

If Apple system Git is unavailable, load the bundled workspace dependencies and use the provided fallback Git executable.
