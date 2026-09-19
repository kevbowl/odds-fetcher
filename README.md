# Odds Fetcher

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20Odds%20Cron/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Current US sportsbook lines from [The Odds API](https://the-odds-api.com/) with Polymarket prices from [Gamma](https://docs.polymarket.com/) merged onto the same games. One public JSON file per league; Git history is the snapshot archive.

## Get the data

```text
https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/<file>.json
```

`file` is `worldcup`, `epl`, `nfl`, `ncaaf`, `wnba`, `mlb`, `kbo`, or `summary`.

```bash
curl -s https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/nfl.json
curl -s https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/summary.json
```

Each league file is an [Odds API v4](https://the-odds-api.com/liveapi/guides/v4/) event array. Timestamps are ISO 8601 UTC. A successful per-league fetch is attempted every five minutes in season; treat `lastFetched` in `odds/summary.json` as the source of truth, not the Git commit time. Files are rewritten only when contents change.

## Example payloads

Live files include every US-region sportsbook. The excerpts below keep one US book plus Polymarket so the join is obvious. Prices move; copy structure, not these numbers.

**NFL** (`h2h`, spreads, totals). Polymarket outcome `sid` is the CLOB token; book `sid` is the Gamma event id.

```json
{
  "id": "0283a29e1b38ef78b29b904fd56a16dd",
  "sport_key": "americanfootball_nfl",
  "sport_title": "NFL",
  "commence_time": "2026-09-20T17:00:00Z",
  "home_team": "Chicago Bears",
  "away_team": "Minnesota Vikings",
  "bookmakers": [
    {
      "key": "draftkings",
      "title": "DraftKings",
      "last_update": "2026-09-19T09:52:59Z",
      "markets": [
        {
          "key": "h2h",
          "outcomes": [
            {"name": "Chicago Bears", "price": -205},
            {"name": "Minnesota Vikings", "price": 170}
          ]
        },
        {
          "key": "spreads",
          "outcomes": [
            {"name": "Chicago Bears", "price": -110, "point": -4.5},
            {"name": "Minnesota Vikings", "price": -110, "point": 4.5}
          ]
        },
        {
          "key": "totals",
          "outcomes": [
            {"name": "Over", "price": -110, "point": 48.5},
            {"name": "Under", "price": -110, "point": 48.5}
          ]
        }
      ]
    },
    {
      "key": "polymarket",
      "title": "Polymarket",
      "last_update": "2026-09-19T09:55:24Z",
      "sid": "827181",
      "markets": [
        {
          "key": "h2h",
          "outcomes": [
            {"name": "Minnesota Vikings", "price": 199, "sid": "14179870506260397153360889305482131481742900211448738393022157488041699646758"},
            {"name": "Chicago Bears", "price": -199, "sid": "87419678683693163900726344026250582268274683976262936197752440741634418461512"}
          ]
        },
        {
          "key": "spreads",
          "outcomes": [
            {"name": "Chicago Bears", "price": 102, "sid": "5336290554606110173497389487867652338741637743197066362266388025938735836464", "point": -4.5},
            {"name": "Minnesota Vikings", "price": -102, "sid": "64681445124749753063425190177509719812527301014672174782673511576640338135021", "point": 4.5}
          ]
        },
        {
          "key": "totals",
          "outcomes": [
            {"name": "Over", "price": -106, "sid": "76363249597109605412887381146535562542163672373714852310023988938354295936970", "point": 47.5},
            {"name": "Under", "price": 106, "sid": "42795583281594762287054165249968120202790415790036742373415970962917593606241", "point": 47.5}
          ]
        }
      ]
    }
  ]
}
```

**Premier League** (three-way `h2h` with `Draw`). Soccer files do not include spreads.

```json
{
  "id": "d02ff636f652d5b5bb65f6b24330c4fe",
  "sport_key": "soccer_epl",
  "sport_title": "EPL",
  "commence_time": "2026-09-19T11:30:00Z",
  "home_team": "Tottenham Hotspur",
  "away_team": "Aston Villa",
  "bookmakers": [
    {
      "key": "fanduel",
      "title": "FanDuel",
      "last_update": "2026-09-19T09:55:03Z",
      "markets": [
        {
          "key": "h2h",
          "outcomes": [
            {"name": "Aston Villa", "price": 300},
            {"name": "Tottenham Hotspur", "price": -110},
            {"name": "Draw", "price": 260}
          ]
        }
      ]
    },
    {
      "key": "polymarket",
      "title": "Polymarket",
      "last_update": "2026-09-19T09:55:24Z",
      "sid": "973629",
      "markets": [
        {
          "key": "h2h",
          "outcomes": [
            {"name": "Tottenham Hotspur", "price": -102, "sid": "110224733210041131679014459885672088479785652252594597634309518568227972935874"},
            {"name": "Draw", "price": 277, "sid": "112472234277593329441809935457825874883960516422397922796962048352846886451118"},
            {"name": "Aston Villa", "price": 308, "sid": "27524852841755679662782494694835026990013491277928016488550923195502712855061"}
          ]
        }
      ]
    }
  ]
}
```

A game with no Gamma match has US books only: no `"key": "polymarket"` entry.

## How a snapshot is built

```text
                          +------------------+
                          | cron-job.org     |
                          | POST every 5 min |
                          +--------+---------+
                                   |
                                   v
                          +------------------+
                          | GitHub Actions   |
                          | checkout main    |
                          +--------+---------+
                                   |
                                   v
                          +------------------+
                          | fetch-odds.js    |
                          | /sports quota    |
                          +--------+---------+
                                   |
                    +-----yes------+------no------+
                    |                             |
                    v                             v
           +------------------+          +------------------+
           | Odds API /odds   |          | Leave last       |
           | regions=us paid  |          | snapshot         |
           +--------+---------+          +--------+---------+
                    |                             |
                    v                             |
           +------------------+                   |
           | Gamma /events    |                   |
           | free, no key     |                   |
           +--------+---------+                   |
                    |                             |
                    v                             |
           +------------------+                   |
           | Match + upsert   |                   |
           | key: polymarket  |                   |
           +--------+---------+                   |
                    |                             |
                    v                             |
           +------------------+                   |
           | odds/*.json      |                   |
           | commit on change |                   |
           +--------+---------+                   |
                    |                             |
                    +--------------+--------------+
                                   |
                                   v
                          +------------------+
                          | GitHub           |
                          | JSON + history   |
                          +------------------+
```

The Odds API US response is the skeleton: event ids, teams, kickoff, and sportsbook books. Gamma is read afterward and merged onto those games. A skipped or unchanged run leaves the last committed files in place.

## Coverage

| League | Sport key | Active window (UTC) | Collection | Output |
|---|---|---|---|---|
| FIFA World Cup | `soccer_fifa_world_cup` | 7 Jun 2026 00:00 until 20 Jul 2026 00:00 | All available events | `odds/worldcup.json` |
| Premier League | `soccer_epl` | Aug–May | All available events | `odds/epl.json` |
| NFL | `americanfootball_nfl` + `americanfootball_nfl_preseason` | Aug–Feb | Regular season plus provider-listed preseason | `odds/nfl.json` |
| NCAA Football | `americanfootball_ncaaf` | Aug–Jan | All available events | `odds/ncaaf.json` |
| WNBA | `basketball_wnba` | May–Oct | All available events | `odds/wnba.json` |
| MLB | `baseball_mlb` | Mar–Oct | Current and next New York–local slate | `odds/mlb.json` |
| KBO | `baseball_kbo` | Mar–Nov | Current and next Korea–local slate | `odds/kbo.json` |

Season months are UTC. World Cup uses a closed-open UTC window.

**Markets**

- **Standard** (`h2h,spreads,totals`): NFL, NCAA Football, WNBA, MLB, KBO.
- **Soccer** (`h2h,totals`): World Cup and Premier League. Soccer `h2h` is three-way and includes `Draw`. Premier League is written only to `odds/epl.json`; every event `sport_key` is `soccer_epl`.

**NFL.** Regular-season and preseason feeds are combined, de-duplicated by event id, and sorted by `commence_time` then id. Each game keeps its provider `sport_key`. The free `/sports` response decides whether preseason is polled; if that check fails, polling is limited to 1 Aug through 9 Sep UTC. Both required US requests must succeed before `odds/nfl.json` is replaced. Polymarket is merged after that publish gate and cannot block it.

**MLB and KBO.** Windows are league-local (`America/New_York`, `Asia/Seoul`). The fetcher uses the free `/events` list, then odds by event id. A direct windowed `/odds` call runs only when `/events` is empty or at least one listed event is missing from the event-id response. Results are de-duplicated by event id and keep the same object shape as the other leagues.

## Polymarket

Polymarket is not a second tape and is not stored under `odds/polymarket/`. It is the `"key": "polymarket"` book on the same Odds API game objects.

After the US sportsbook request succeeds, the fetcher pages Gamma `/events` for that league (no API key, no Odds API credits). A Gamma event is attached only when all of the following hold:

1. It is a primary game market (props are ignored).
2. Both Gamma teams match the Odds API home and away names.
3. Gamma start time is within six hours of `commence_time`.
4. Exactly one Gamma event wins that match.

On a hit, Polymarket is upserted onto that game. Outcome names use the Odds API home/away labels (and soccer `Draw`). Gamma probabilities are converted to American odds. Outcome `sid` is the Polymarket CLOB token for that selection; book `sid` is the Gamma event id.

On a miss, an ambiguous match, or a Gamma failure, the US books still publish and any previous `polymarket` book on that game is removed so the snapshot does not carry stale prediction-market prices. Gamma-only events never appear.

## Scheduling and quota

A league is fetched on a dispatch only when it is in season, at least five minutes have passed since its successful `lastFetched`, and the estimated Odds API cost fits above the reserve. `FORCE_FETCH=true` skips the elapsed-time check. It does not skip season or quota checks.

### Credits

The Odds API bills **1 credit per market, per region, per paid `/odds` request**. This project uses `regions=us` and does not set `bookmakers=`. `/sports` and baseball `/events` are free. Gamma does not use Odds API credits. This job never calls the historical Odds API.

Before any paid request, the fetcher reads quota headers from `/sports` and reserves the following for each due league:

| Fetch profile | Leagues | Markets | Paid `/odds` calls | Reserved credits |
|---|---|---:|---:|---:|
| Soccer | World Cup, Premier League | 2 | 1 | 2 |
| Standard | NFL regular season, NCAA Football, WNBA | 3 | 1 | 3 |
| NFL preseason add-on | NFL, only while available | 3 | 1 | 3 |
| Windowed baseball | MLB, KBO | 3 | 1 typical (event-id batch); 2 in fallback | 6 |

Baseball event ids are batched 50 per request, so a very large slate can cost more than one paid call. The quota gate always reserves the two-call baseball maximum (6 credits) before starting that league.

Default reserve is 20 credits (`ODDS_API_QUOTA_RESERVE_CREDITS`). Usage is recorded in `odds/summary.json` and in The Odds API dashboard.

Worked example, September after NFL preseason: EPL 2 + NFL 3 + NCAAF 3 + WNBA 3 + MLB 3 + KBO 3 = **17 credits** on a clean run (about 4,896/day, 146,880/30 days at a five-minute cadence). Both baseball fallbacks raise that run to 23. A 100,000-credit month cannot hold every active league every five minutes.

The gate uses the reserved column, not typical spend. Selecting every September league therefore needs 23 spendable credits (remaining ≥ 43 with the default reserve), even when the run later spends 17.

## Data model

League files are Odds API v4 event arrays. US books keep that shape. When Gamma matches, `"key": "polymarket"` is one more bookmaker on the same game (see [Example payloads](#example-payloads)). Outcome names on that book use the Odds API home/away labels (and soccer `Draw`). Outcome `sid` is the Polymarket CLOB token; book `sid` is the Gamma event id.

`odds/summary.json` is the freshness record:

```json
{
  "lastUpdated": "2026-09-19T09:35:21.767Z",
  "quota": {
    "remaining": 1234,
    "used": 567,
    "lastRequestCost": 3,
    "reserveCredits": 20
  },
  "status": "healthy",
  "sports": [
    {
      "sport": "NFL",
      "gameCount": 29,
      "regularSeasonGameCount": 29,
      "preseasonGameCount": 0,
      "fileName": "nfl.json",
      "lastFetched": "2026-09-19T09:35:21.767Z",
      "lastAttemptAt": "2026-09-19T09:35:21.767Z",
      "lastAttemptStatus": "success",
      "lastError": null
    }
  ]
}
```

`status` is `degraded` when a selected league attempt fails or a due league is skipped by the quota reserve. A failed attempt keeps the last successful `lastFetched` and game count.

## Snapshots

Git stores each changed league file. Do not assume a commit every five minutes:

```bash
git log --oneline -- odds/nfl.json
git show <commit>:odds/nfl.json
git diff <older-commit> <newer-commit> -- odds/nfl.json
```

## Configuration

`SPORTS` in `fetch-odds.js` is the source of truth for sport keys, windows, markets, regions, and intervals. Gamma needs no credential.

| Environment variable | Default | Purpose |
|---|---|---|
| `ODDS_API_KEY` | Required | The Odds API credential |
| `ODDS_API_TIMEOUT_MS` | `15000` | Per-request timeout; minimum 1,000 ms |
| `ODDS_API_QUOTA_RESERVE_CREDITS` | `20` | Credits kept in reserve |
| `FORCE_FETCH` | `false` | Fetch every active league immediately when `true` |

## Setup

Node.js 18+.

```bash
git clone https://github.com/kevbowl/odds-fetcher.git
cd odds-fetcher
ODDS_API_KEY=your_key FORCE_FETCH=true npm start
```

### GitHub Actions

Store `ODDS_API_KEY` under **Settings → Secrets and variables → Actions**. [`.github/workflows/fetch-odds-cron.yml`](.github/workflows/fetch-odds-cron.yml) checks out `main`, runs tests, fetches, and commits `odds/` when files change. It uses only Node.js built-ins.

Manual runs: **Actions → Fetch Odds Cron → Run workflow**. They follow the same gating as external dispatches. There is no GitHub `schedule` trigger.

### cron-job.org

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `https://api.github.com/repos/kevbowl/odds-fetcher/actions/workflows/fetch-odds-cron.yml/dispatches` |
| Schedule | `*/5 * * * *` |
| Time zone | `Asia/Singapore` |
| Body | `{"ref":"main"}` |
| Expected response | `204 No Content` |

```text
Accept: application/vnd.github+json
Authorization: Bearer <github_token>
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

Use a fine-grained token with `actions:write` on this repository. Store it only in cron-job.org. `204` means GitHub accepted the dispatch, not that the fetch succeeded.

## Repository map

| Path | Role |
|---|---|
| `fetch-odds.js` | Gating, quota, Odds API, Gamma merge, writes |
| `fetch-odds.test.js` | Contract tests run on every workflow job |
| `.github/workflows/fetch-odds-cron.yml` | Checkout, fetch, commit |
| `odds/<league>.json` | Latest event array for one league |
| `odds/summary.json` | Freshness, quota, and per-league attempt health |

## Operations

- **Workflow:** [GitHub Actions](https://github.com/kevbowl/odds-fetcher/actions)
- **Freshness:** `lastFetched` and `gameCount` in `odds/summary.json`
- **Attempt health:** `lastAttemptAt`, `lastAttemptStatus`, `lastError`. A green workflow is not per-league proof.
- **NFL:** `regularSeasonGameCount` and `preseasonGameCount`; `gameCount` is the de-duplicated total
- **Baseball:** window, event count, fallback, and warning fields on the MLB/KBO summary entries
- **Quota:** summary quota object and The Odds API dashboard
- **Empty file:** recent `lastFetched` with `gameCount: 0` means the provider returned no games; a missing or old `lastFetched` means inactive, not due, quota-skipped, or failed

## License

MIT
