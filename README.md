# Odds Fetcher

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20Odds%20Cron/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Odds Fetcher collects current bookmaker lines from [The Odds API](https://the-odds-api.com/), stores one JSON file per league, and uses Git history as the snapshot archive for Prophet's steam-detection pipeline.

## How it works

```text
cron-job.org -> GitHub Actions -> The Odds API -> odds/*.json -> Prophet
                     |
                     +-> Git history (snapshots)
```

cron-job.org dispatches the GitHub Actions workflow. On each run, the fetcher decides which leagues are active, due, and within the available API quota. Successful results are written to `odds/` and committed only when the generated files change.

## Coverage

All timestamps returned by the API remain in ISO 8601 UTC format.

| League | API sport key | Active window | Collection scope | Output |
|---|---|---|---|---|
| FIFA World Cup | `soccer_fifa_world_cup` | Jun 7-Jul 20, 2026 | All available events | `odds/worldcup.json` |
| NFL | `americanfootball_nfl` | Sep-Feb | All available events | `odds/nfl.json` |
| NCAA Football | `americanfootball_ncaaf` | Aug-Jan | All available events | `odds/ncaaf.json` |
| WNBA | `basketball_wnba` | May-Oct | All available events | `odds/wnba.json` |
| MLB | `baseball_mlb` | Mar-Oct | Current and next New York-local slate | `odds/mlb.json` |
| KBO | `baseball_kbo` | Mar-Nov | Current and next Korea-local slate | `odds/kbo.json` |

Market profiles are defined once and shared by league configuration:

- **Standard:** `h2h,spreads,totals` for NFL, NCAA Football, WNBA, MLB, and KBO.
- **Soccer:** `h2h,totals` for the FIFA World Cup. Soccer `h2h` is a three-way market that includes `Draw`.

MLB and KBO use league-local windows (`America/New_York` and `Asia/Seoul`). The fetcher combines event-ID odds with a direct windowed odds request, de-duplicates by event ID, and writes the same response shape used by the other leagues.

## Scheduling and quota

### Fetch gating

There is one production cadence: a workflow dispatch every 15 minutes. On each dispatch, a league is fetched only when all three conditions are true:

1. The league is inside its configured active window.
2. At least its configured interval has elapsed since `lastFetched` in `odds/summary.json`.
3. The estimated request cost fits above the configured quota reserve.

`FORCE_FETCH=true` bypasses the elapsed-time check for active leagues. It does not bypass season or quota checks.

### Credit model

The Odds API charges one credit per market, per region, per paid odds request. This project uses the `us` region for every league.

Before any paid request, the fetcher calls the no-cost `/sports` endpoint and reads the quota headers. It reserves the following amount for each due league:

| Fetch profile | Leagues | Markets | Estimated paid odds calls | Reserved credits per fetch |
|---|---|---:|---:|---:|
| Soccer direct | FIFA World Cup | 2 | 1 | 2 |
| Standard direct | NFL, NCAA Football, WNBA | 3 | 1 | 3 |
| Windowed baseball | MLB, KBO | 3 | 2 | 6 |

For MLB and KBO, `/events` is free. A typical non-empty fetch makes one batched event-ID odds request and one direct windowed odds request. Event IDs are batched in groups of 50, so unusually large slates can cost more; empty API responses can cost less.

The default reserve is 20 credits. Set `ODDS_API_QUOTA_RESERVE_CREDITS` to change it. Monthly usage is not fixed: it depends on season overlap, successful dispatches, empty responses, and baseball batch counts. Current usage is recorded in `odds/summary.json` and in The Odds API dashboard.

## Configuration

League definitions live in the `SPORTS` array in `fetch-odds.js`. That array is the source of truth for sport keys, active windows, markets, regions, and fetch intervals.

| Environment variable | Default | Purpose |
|---|---:|---|
| `ODDS_API_KEY` | Required | The Odds API credential |
| `ODDS_API_TIMEOUT_MS` | `15000` | Per-request timeout; minimum 1,000 ms |
| `ODDS_API_QUOTA_RESERVE_CREDITS` | `20` | Credits kept in reserve |
| `FORCE_FETCH` | `false` | Fetch every active league immediately when set to `true` |

## Setup

### Local

```bash
git clone https://github.com/kevbowl/odds-fetcher.git
cd odds-fetcher
npm install

ODDS_API_KEY=your_key FORCE_FETCH=true npm start
```

### GitHub Actions

Add `ODDS_API_KEY` under **Settings -> Secrets and variables -> Actions**. The workflow in `.github/workflows/fetch-odds-cron.yml` reads the secret, runs the fetcher, and commits changes under `odds/`.

The workflow can also be started manually from **Actions -> Fetch Odds Cron -> Run workflow**. Manual runs follow the same gating rules as external dispatches.

### cron-job.org trigger

Production uses an external `workflow_dispatch`; there is no GitHub `schedule` trigger.

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `https://api.github.com/repos/kevbowl/odds-fetcher/actions/workflows/fetch-odds-cron.yml/dispatches` |
| Schedule | `*/15 * * * *` |
| Time zone | `Asia/Singapore` |
| Body | `{"ref":"main"}` |
| Expected response | `204 No Content` |

Required headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer <github_token>
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

Use a fine-grained GitHub token with `actions:write` access to this repository. Store it only in cron-job.org; never commit it. A `204` response confirms that GitHub accepted the dispatch, not that the fetch succeeded.

## Repository map

| Path | Role |
|---|---|
| `fetch-odds.js` | League gating, quota checks, API requests, merging, and file writes |
| `.github/workflows/fetch-odds-cron.yml` | GitHub Actions runner and commit workflow |
| `odds/<league>.json` | Latest raw odds array for one league |
| `odds/summary.json` | Fetch timestamps, game counts, quota state, and baseball diagnostics |
| `package.json` | Node.js runtime metadata and dependencies |

## Data access

Files are publicly available from:

```text
https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/<file>.json
```

Valid data files are `worldcup`, `nfl`, `ncaaf`, `wnba`, `mlb`, `kbo`, and `summary`. For example:

```bash
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/kbo.json
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/summary.json
```

## Data model

League files are arrays of The Odds API game objects. Direct responses retain the API shape; windowed baseball responses are merged and de-duplicated without reshaping individual game objects:

```json
[
  {
    "id": "game_id",
    "sport_key": "americanfootball_nfl",
    "sport_title": "NFL",
    "commence_time": "2026-09-15T20:00:00Z",
    "home_team": "Home Team",
    "away_team": "Away Team",
    "bookmakers": [
      {
        "key": "draftkings",
        "title": "DraftKings",
        "last_update": "2026-09-15T18:00:00Z",
        "markets": [
          {
            "key": "h2h",
            "outcomes": [
              {"name": "Home Team", "price": -110},
              {"name": "Away Team", "price": -110}
            ]
          }
        ]
      }
    ]
  }
]
```

`odds/summary.json` is the operational freshness record:

```json
{
  "lastUpdated": "2026-07-15T15:15:00.000Z",
  "quota": {
    "remaining": 1234,
    "used": 567,
    "lastRequestCost": 3,
    "reserveCredits": 20
  },
  "sports": [
    {
      "sport": "KBO",
      "gameCount": 5,
      "fileName": "kbo.json",
      "lastFetched": "2026-07-15T15:15:00.000Z"
    }
  ]
}
```

## Historical snapshots

Git stores each changed output as a repository snapshot. Use commits that touched a league file rather than assuming a fixed number of commits per hour:

```bash
git log --oneline -- odds/nfl.json
git show <commit>:odds/nfl.json
git diff <older-commit> <newer-commit> -- odds/nfl.json
```

A league file's Git timestamp advances only when its contents change. Use `lastFetched` in `odds/summary.json` to determine whether the API was queried recently.

## Operations

- **Workflow status:** [GitHub Actions](https://github.com/kevbowl/odds-fetcher/actions)
- **Fetch freshness:** inspect `lastFetched` and `gameCount` in `odds/summary.json`.
- **Baseball diagnostics:** inspect the MLB/KBO window, event count, direct odds count, and warning fields in `odds/summary.json`.
- **Quota:** inspect the summary quota object and The Odds API account dashboard.
- **Empty league file:** a recent `lastFetched` with `gameCount: 0` means the API returned no games; an old or missing `lastFetched` indicates the league was inactive, not due, quota-skipped, or failed.

## License

MIT
