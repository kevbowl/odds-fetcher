# Odds Fetcher - Steam Detection System

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20Odds%20Cron/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **High-frequency odds collection system with Git-based historical tracking for steam detection analysis**

## 🎯 Purpose

This system provides **real-time odds data** and **historical tracking** for detecting coordinated line movements (steam events) in NFL, NCAA Football, MLB, KBO, and FIFA World Cup betting markets. Built for the Prophet betting application's steam detection algorithms.

## 🏗️ Architecture

```text
+--------------------+    +--------------------+    +--------------------+
| cron-job.org       | -> | GitHub Actions     | -> | The Odds API       |
| every 15 min       |    | workflow dispatch  |    | events + odds      |
+--------------------+    +--------------------+    +--------------------+
                                                              |
                                                              v
                                                    +--------------------+
                                                    | GitHub odds repo   |
                                                    | latest + history   |
                                                    +--------------------+
                                                              |
                                                              v
                                                    +--------------------+
                                                    | Prophet            |
                                                    | live odds +        |
                                                    | odds snapshots     |
                                                    +--------------------+
```

## 📊 Data Collection

| Metric | Value |
|--------|-------|
| **Workflow cadence** | cron-job.org dispatches the GitHub workflow every 15 minutes |
| **Sports** | NFL \| NCAA Football \| MLB \| KBO \| FIFA World Cup |
| **Per-sport frequency** | NFL/NCAAF/MLB/KBO every run while in season; World Cup every run while active |
| **Historical Retention** | Unlimited (Git compression) |
| **Data Format** | JSON with full bookmaker details |

### Scheduling & quota (per-sport gating)

cron-job.org sends a `workflow_dispatch` request to GitHub every 15 minutes.
The GitHub Actions workflow then runs `fetch-odds.js`, which decides **per
sport** whether to actually call the API on a given run. This keeps quota usage
tied to what's in season and how frequently each sport needs sampling. The Odds
API bills **1 credit per market, per region, per request**.

Before a paid `/odds` request, the script calls the no-cost `/sports` endpoint
to read the quota headers (`x-requests-remaining`, `x-requests-used`, and
`x-requests-last`). If the due fetches would dip into the configured reserve,
the script skips the paid request for that run.

| Sport | Season (gating) | Markets | Fetch frequency | Credits/request |
|-------|-----------------|---------|-----------------|-----------------|
| FIFA World Cup | Jun 7 – Jul 20, 2026 (fixed window) | Featured `h2h,totals`; event `to_qualify` | Every dispatched run (15 min) | 2 + up to 1/event |
| NFL | September – February | `h2h,spreads,totals` | Every dispatched run (15 min) | 3 |
| NCAA Football | August – January | `h2h,spreads,totals` | Every dispatched run (15 min) | 3 |
| MLB | March – October | `h2h,spreads,totals` | Every dispatched run (15 min; current NY slate + tomorrow's NY slate) | 3 per odds call |
| KBO | March – November | `h2h,spreads,totals` | Every dispatched run (15 min; current Korea slate + tomorrow's Korea slate) | 3 per odds call |

- A sport is fetched only when it is **in season** *and* **due** this run.
- "Due" is based on **elapsed time since the last fetch** (tracked per sport via
  `lastFetched` in `summary.json`), not wall-clock slots — so it's robust to
  cron-job.org jitter and skipped dispatches (a late/missed run just fetches on
  the next wake-up rather than waiting a full interval).
- **Manual runs bypass cadence, not quota.** Triggering the workflow via *Run
  workflow* (`workflow_dispatch`) fetches every in-season sport that still fits
  inside the quota reserve. Set `FORCE_FETCH=true` to do the same locally.
- World Cup featured odds use the sport endpoint for `h2h,totals` (2 credits
  per dispatch in `us`). Knockout `to_qualify` is requested separately through
  the event-odds endpoint for each returned event and costs up to 1 additional
  credit per event when that market is available.
- The quota reserve defaults to 20 credits. Override it with
  `ODDS_API_QUOTA_RESERVE_CREDITS` if you need a larger safety buffer.
- Each `h2h,spreads,totals` sport costs 3 credits per fetch (~8,640
  credits/mo at 15-minute cadence), so overlapping seasons add quickly.
- Configure all of this in the `SPORTS` array in `fetch-odds.js`
  (`seasonMonths` / `window` for season, `fetchEveryMinutes` for cadence,
  `markets` / `regions` for quota cost).

### External trigger: cron-job.org

This repository does not rely on a GitHub `schedule` trigger for the production
cadence. Instead, cron-job.org calls the GitHub Actions workflow dispatch API.

cron-job.org job settings:

| Setting | Value |
|---------|-------|
| Title | `Fetch Odds Cron` |
| URL | `https://api.github.com/repos/kevbowl/odds-fetcher/actions/workflows/fetch-odds-cron.yml/dispatches` |
| Schedule | Every 15 minutes (`*/15 * * * *`) |
| Time zone | `Asia/Singapore` |
| Request method | `POST` |
| Timeout | 30 seconds |
| Request body | `{"ref":"main"}` |
| Success response | `204 No Content` from GitHub |

Required headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer <github_token>
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

The GitHub token is stored only in cron-job.org and must not be committed to
this repository. It needs permission to dispatch workflows for this repo
(`actions:write` on a fine-grained token). cron-job.org returning
`204 No Content` only means GitHub accepted the workflow dispatch; the actual
fetch result should be checked in GitHub Actions under the `Fetch Odds Cron`
workflow. The job currently has response-history saving off and only alerts when
cron-job.org is about to disable the job after repeated failures.

## 🔧 Technical Implementation

### Core Components

| File | Purpose | Frequency |
|------|---------|-----------|
| `fetch-odds.js` | Fetcher with retry logic and per-sport season/cadence/quota gating | Runs when dispatched |
| `.github/workflows/fetch-odds-cron.yml` | Manual GitHub Actions workflow called by cron-job.org | Dispatched every 15 minutes |
| `odds/nfl.json` | Current NFL odds (latest) | In season: every 15 min |
| `odds/ncaaf.json` | Current NCAA Football odds (latest) | In season: every 15 min |
| `odds/mlb.json` | Current MLB odds for the current America/New_York slate plus tomorrow's NY slate | In season: every 15 min |
| `odds/kbo.json` | Current KBO odds for the current Asia/Seoul slate plus tomorrow's Korea slate | In season: every 15 min |
| `odds/worldcup.json` | Current FIFA World Cup odds (latest, h2h + totals + to-qualify) | In tournament: every 15 min |
| `odds/summary.json` | Fetch metadata, quota headers & game counts | Each run that fetches |

### Git-Based Historical Tracking

The system leverages Git's native versioning for efficient historical data storage:

```bash
# Access historical data
git show HEAD~4:odds/nfl.json          # ~1 hour ago
git show HEAD~8:odds/nfl.json          # ~2 hours ago
git show HEAD~24:odds/nfl.json         # ~6 hours ago

# Compare line movements
git diff HEAD~4 HEAD -- odds/nfl.json     # Changes in last hour
git diff HEAD~8 HEAD~4 -- odds/nfl.json   # Changes between 1-2 hours ago

# Analyze commit frequency
git log --oneline --since="1 day ago"  # Recent activity
git log --oneline --since="1 week ago"  # Weekly patterns
```

### Storage Efficiency

- **Git Compression**: 90%+ efficiency for similar JSON data
- **Delta Storage**: Only stores changes between commits
- **Automatic Optimization**: Git handles garbage collection
- **No Cleanup Required**: Git manages storage lifecycle

## 🚀 Quick Start

### 1. Repository Setup
```bash
# Clone the repository
git clone https://github.com/kevbowl/odds-fetcher.git
cd odds-fetcher

# Install dependencies
npm install
```

### 2. API Configuration
1. Get API key from [The-Odds-API](https://the-odds-api.com/)
2. Add to GitHub repository secrets:
   - Go to **Settings** → **Secrets and variables** → **Actions**
   - Add secret: `ODDS_API_KEY` = `your_api_key_here`

### 3. Manual Testing
```bash
# Test the fetcher locally
ODDS_API_KEY=your_key_here node fetch-odds.js

# Manual workflow trigger
# Go to Actions → Fetch Odds Cron → Run workflow
```

## 📡 Data Access

### Current Data (Public URLs)
```bash
# Latest NFL odds
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/nfl.json

# Latest NCAA Football odds  
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/ncaaf.json

# Latest MLB odds
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/mlb.json

# Latest KBO odds
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/kbo.json

# Latest FIFA World Cup odds
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/worldcup.json

# Fetch summary
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/summary.json
```

### Historical Analysis (Git Clone)
```bash
# Clone for historical analysis
git clone https://github.com/kevbowl/odds-fetcher.git
cd odds-fetcher

# Analyze recent activity
git log --oneline --since="1 day ago"
git log --oneline --since="1 week ago"

# Extract specific time periods
git show HEAD~4:odds/nfl.json > nfl_1hour_ago.json
git show HEAD~8:odds/nfl.json > nfl_2hours_ago.json
```

## 📋 Data Schema

### NFL/NCAA Football/MLB/KBO JSON Structure

MLB and KBO use the same raw `/odds` response shape as football, but their
collection is event-windowed: the fetcher first calls `/events` for the current
league-local slate plus tomorrow's local slate, then calls `/odds` with those
`eventIds` and also calls direct `/odds` with the same time window. The two odds
responses are merged by event id. `odds/mlb.json` and `odds/kbo.json` remain
plain arrays of `/odds` game objects.

```json
[
  {
    "id": "game_id",
    "sport_key": "americanfootball_nfl",
    "sport_title": "NFL", 
    "commence_time": "2025-09-15T20:00:00Z",
    "home_team": "Kansas City Chiefs",
    "away_team": "Baltimore Ravens",
    "bookmakers": [
      {
        "key": "draftkings",
        "title": "DraftKings",
        "last_update": "2025-09-15T18:00:00Z",
        "markets": [
          {
            "key": "h2h",
            "last_update": "2025-09-15T18:00:00Z", 
            "outcomes": [
              {"name": "Kansas City Chiefs", "price": -110},
              {"name": "Baltimore Ravens", "price": -110}
            ]
          },
          {
            "key": "spreads",
            "outcomes": [
              {"name": "Kansas City Chiefs", "price": -110, "point": -3.5},
              {"name": "Baltimore Ravens", "price": -110, "point": 3.5}
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
      }
    ]
  }
]
```

### FIFA World Cup JSON Structure (`odds/worldcup.json`)

Identical top-level schema to the football files, with two soccer-specific differences:

- **No `spreads` market.** World Cup featured odds use `markets=h2h,totals` on
  the sport endpoint. For each returned knockout event, the event-odds endpoint
  is queried with `markets=to_qualify` and those bookmaker markets are merged
  into the same game object. This keeps team-to-advance prices separate from
  regulation-time `h2h`; NFL/NCAAF/MLB/KBO keep `h2h,spreads,totals`.
- **3-way moneyline.** The `h2h` market returns three outcomes — home team, away team, and the draw. The draw outcome's `name` is exactly `"Draw"` (The Odds API default, written through unchanged so downstream parsers can key off `name == "Draw"`).

```json
[
  {
    "id": "...",
    "sport_key": "soccer_fifa_world_cup",
    "sport_title": "FIFA World Cup",
    "commence_time": "2026-06-11T19:00:00Z",
    "home_team": "United States",
    "away_team": "Mexico",
    "bookmakers": [
      {
        "key": "draftkings",
        "title": "DraftKings",
        "markets": [
          {
            "key": "h2h",
            "last_update": "...",
            "outcomes": [
              {"name": "United States", "price": 150},
              {"name": "Mexico", "price": 180},
              {"name": "Draw", "price": 210}
            ]
          },
          {
            "key": "totals",
            "last_update": "...",
            "outcomes": [
              {"name": "Over", "price": -110, "point": 2.5},
              {"name": "Under", "price": -110, "point": 2.5}
            ]
          }
        ]
      }
    ]
  }
]
```

### Summary JSON Structure
```json
{
  "lastUpdated": "2026-06-19T14:30:00Z",
  "quota": {
    "remaining": 12800,
    "used": 7200,
    "lastRequestCost": 2,
    "reserveCredits": 20
  },
  "sports": [
    {
      "sport": "FIFA World Cup",
      "gameCount": 48,
      "fileName": "worldcup.json",
      "lastFetched": "2026-06-19T14:30:00Z"
    }
  ]
}
```

## 🔍 Steam Detection for Prophet

### Historical Data Access
```python
# Python example for Prophet integration
import subprocess
import json

def get_odds_at_time(commit_offset):
    """Get odds data from N commits ago"""
    result = subprocess.run([
        'git', 'show', f'HEAD~{commit_offset}:odds/nfl.json'
    ], capture_output=True, text=True)
    return json.loads(result.stdout)

def compare_odds_changes(hours_back=1):
    """Compare odds changes over time"""
    commits_back = hours_back * 4  # 4 commits per hour (15min intervals)
    
    current_odds = get_odds_at_time(0)
    historical_odds = get_odds_at_time(commits_back)
    
    # Analyze line movements
    for game in current_odds:
        game_id = game['id']
        # Find corresponding historical game
        # Compare line movements
        # Detect steam events
```

### Git-Based Analysis Commands
```bash
# Steam detection workflow
git log --oneline --since="1 day ago" | wc -l    # Commits in last 24h
git show HEAD~4:odds/nfl.json | jq '.[0].bookmakers[0].markets[0]'  # Sample data
git diff HEAD~8 HEAD~4 -- odds/nfl.json | grep -c "price"  # Price changes
```

## 🛠️ Development

### Local Development
```bash
# Install dependencies
npm install

# Run with environment variable
ODDS_API_KEY=your_key node fetch-odds.js

# Test specific sport
node -e "
const { fetchOdds } = require('./fetch-odds.js');
fetchOdds('NFL', 'americanfootball_nfl', 'nfl');
"
```

### Monitoring
- **GitHub Actions**: [View runs](https://github.com/kevbowl/odds-fetcher/actions)
- **API Usage**: Monitor in The-Odds-API dashboard
- **Storage**: Git repository size grows efficiently with compression

## License

MIT
