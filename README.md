# Odds Fetcher - Steam Detection System

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20Odds/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **High-frequency odds collection system with Git-based historical tracking for steam detection analysis**

## 🎯 Purpose

This system provides **real-time odds data** and **historical tracking** for detecting coordinated line movements (steam events) in NFL, NCAA Football, MLB, and FIFA World Cup betting markets. Built for the Prophet betting application's steam detection algorithms.

## 🏗️ Architecture

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
| GitHub Actions  │-─▶│ The-Odds-API    │-─▶│ GitHub          │
│ (Every 12min)   │   │ (Limit 20K/mo)  │   │ (Git Commits)   │
└─────────────────┘   └─────────────────┘   └─────────────────┘
                                                   ▲
                                                   │
                                            ┌─────────────────┐
                                            │ Analysis        │
                                            │ (Git History)   │
                                            └─────────────────┘
```

## 📊 Data Collection

| Metric | Value |
|--------|-------|
| **Workflow cadence** | Wakes every 12 minutes (24/7) |
| **Sports** | NFL + NCAA Football + MLB + FIFA World Cup |
| **Per-sport frequency** | NFL/NCAAF/MLB every run while in season; World Cup every run while active |
| **Historical Retention** | Unlimited (Git compression) |
| **Data Format** | JSON with full bookmaker details |

### Scheduling & quota (per-sport gating)

The GitHub Actions workflow wakes every 12 minutes, but `fetch-odds.js` decides
**per sport** whether to actually call the API on a given run. This keeps quota
usage tied to what's in season and how frequently each sport needs sampling.
The Odds API bills **1 credit per market, per region, per request**.

Before a paid `/odds` request, the script calls the no-cost `/sports` endpoint
to read the quota headers (`x-requests-remaining`, `x-requests-used`, and
`x-requests-last`). If the due fetches would dip into the configured reserve,
the script skips the paid request for that run.

| Sport | Season (gating) | Markets | Fetch frequency | Credits/request |
|-------|-----------------|---------|-----------------|-----------------|
| FIFA World Cup | Jun 7 – Jul 20, 2026 (fixed window) | `h2h,totals` | Every run (12 min, ~7,200 credits/mo) | 2 |
| NFL | September – February | `h2h,spreads,totals` | Every run (12 min) | 3 |
| NCAA Football | August – January | `h2h,spreads,totals` | Every run (12 min) | 3 |
| MLB | March – October | `h2h,spreads,totals` | Every run (12 min; current NY slate + next 2 NY dates) | 3 per odds batch |

- A sport is fetched only when it is **in season** *and* **due** this run.
- "Due" is based on **elapsed time since the last fetch** (tracked per sport via
  `lastFetched` in `summary.json`), not wall-clock slots — so it's robust to
  GitHub's cron jitter and skipped runs (a late/missed run just fetches on the
  next wake-up rather than waiting a full interval).
- **Manual runs bypass cadence, not quota.** Triggering the workflow via *Run
  workflow* (`workflow_dispatch`) fetches every in-season sport that still fits
  inside the quota reserve. Set `FORCE_FETCH=true` to do the same locally.
- On the 20,000-credit plan, World Cup can run every 12 minutes: `h2h,totals`
  in the `us` region costs 2 credits per fetch, which is about 7,200 credits in
  a 30-day month.
- The quota reserve defaults to 20 credits. Override it with
  `ODDS_API_QUOTA_RESERVE_CREDITS` if you need a larger safety buffer.
- Each `h2h,spreads,totals` sport costs 3 credits per fetch (~10,800
  credits/mo at 12-minute cadence), so overlapping seasons add quickly.
- Configure all of this in the `SPORTS` array in `fetch-odds.js`
  (`seasonMonths` / `window` for season, `fetchEveryMinutes` for cadence,
  `markets` / `regions` for quota cost).

## 🔧 Technical Implementation

### Core Components

| File | Purpose | Frequency |
|------|---------|-----------|
| `fetch-odds.js` | Fetcher with retry logic and per-sport season/cadence/quota gating | Runs every 12 minutes |
| `.github/workflows/fetch-odds.yml` | GitHub Actions scheduler | Wakes every 12 minutes |
| `odds/nfl.json` | Current NFL odds (latest) | In season: every 12 min |
| `odds/ncaaf.json` | Current NCAA Football odds (latest) | In season: every 12 min |
| `odds/mlb.json` | Current MLB odds for the current America/New_York slate plus the next 2 NY slate dates | In season: every 12 min |
| `odds/worldcup.json` | Current FIFA World Cup odds (latest, h2h + totals only) | In tournament: every 12 min |
| `odds/summary.json` | Fetch metadata, quota headers & game counts | Each run that fetches |

### Git-Based Historical Tracking

The system leverages Git's native versioning for efficient historical data storage:

```bash
# Access historical data
git show HEAD~7:odds/nfl.json          # 1 hour ago
git show HEAD~14:odds/nfl.json         # 2 hours ago
git show HEAD~50:odds/nfl.json         # 6+ hours ago

# Compare line movements
git diff HEAD~7 HEAD -- odds/nfl.json  # Changes in last hour
git diff HEAD~14 HEAD~7 -- odds/nfl.json  # Changes between 1-2 hours ago

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
# Go to Actions → Fetch Odds → Run workflow
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
git show HEAD~7:odds/nfl.json > nfl_1hour_ago.json
git show HEAD~14:odds/nfl.json > nfl_2hours_ago.json
```

## 📋 Data Schema

### NFL/NCAA Football/MLB JSON Structure

MLB uses the same raw `/odds` response shape as football, but its collection is
event-windowed: the fetcher first calls `/v4/sports/baseball_mlb/events` for
the current America/New_York slate plus the next 2 NY slate dates, then calls
`/odds` with those `eventIds`. `odds/mlb.json` remains a plain array of `/odds`
game objects.

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

- **No `spreads` market.** World Cup is fetched with `markets=h2h,totals` only — soccer has no point spread in our model. Only the World Cup file drops spreads; NFL/NCAAF/MLB keep `h2h,spreads,totals`.
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
    commits_back = hours_back * 7  # 7 commits per hour (8min intervals)
    
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
git show HEAD~7:odds/nfl.json | jq '.[0].bookmakers[0].markets[0]'  # Sample data
git diff HEAD~14 HEAD~7 -- odds/nfl.json | grep -c "price"  # Price changes
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
