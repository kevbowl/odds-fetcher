# Odds Fetcher - Steam Detection System

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20NFL%20Odds/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **High-frequency odds collection system with Git-based historical tracking for steam detection analysis**

## 🎯 Purpose

This system provides **real-time odds data** and **historical tracking** for detecting coordinated line movements (steam events) in NFL, NCAA Football, and FIFA World Cup betting markets. Built for the Prophet betting application's steam detection algorithms.

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
| **Sports** | NFL + NCAA Football + FIFA World Cup |
| **Per-sport frequency** | NFL/NCAAF every run (12 min); World Cup every 4h |
| **Historical Retention** | Unlimited (Git compression) |
| **Data Format** | JSON with full bookmaker details |

### Scheduling & quota (per-sport gating)

The GitHub Actions workflow wakes every 12 minutes, but `fetch-odds.js` decides
**per sport** whether to actually call the API on a given run. This keeps quota
usage tied to what's in season and how frequently each sport needs sampling.
The Odds API bills **1 credit per market, per region, per request**.

| Sport | Season (gating) | Markets | Fetch frequency | Credits/request |
|-------|-----------------|---------|-----------------|-----------------|
| FIFA World Cup | Jun 11 – Jul 20, 2026 (fixed window) | `h2h,totals` | Every 4h (~370 credits/mo) | 2 |
| NFL | September – February | `h2h,spreads,totals` | Every run (12 min) | 3 |
| NCAA Football | August – January | `h2h,spreads,totals` | Every run (12 min) | 3 |

- A sport is fetched only when it is **in season** *and* **due** this run.
- World Cup is throttled to 4h so it fits a 500-credit/month plan during the
  summer when it's the only sport active.
- NFL + NCAAF at 12-minute resolution is high-volume (~21,600 credits/mo when
  both are in season) — size the API plan accordingly for football season.
- Configure all of this in the `SPORTS` array in `fetch-odds.js`
  (`seasonMonths` / `window` for season, `fetchEveryMinutes` for cadence).

## 🔧 Technical Implementation

### Core Components

| File | Purpose | Frequency |
|------|---------|-----------|
| `fetch-odds.js` | Fetcher with retry logic, per-sport season/cadence gating & Git commits | Runs every 12 minutes |
| `.github/workflows/fetch-odds.yml` | GitHub Actions scheduler | Wakes every 12 minutes |
| `odds/nfl.json` | Current NFL odds (latest) | In season: every 12 min |
| `odds/ncaaf.json` | Current NCAA Football odds (latest) | In season: every 12 min |
| `odds/worldcup.json` | Current FIFA World Cup odds (latest, h2h + totals only) | In tournament: every 4h |
| `odds/summary.json` | Fetch metadata & game counts | Each run that fetches |

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
# Go to Actions → Fetch NFL Odds → Run workflow
```

## 📡 Data Access

### Current Data (Public URLs)
```bash
# Latest NFL odds
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/nfl.json

# Latest NCAA Football odds  
curl https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/ncaaf.json

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

### NFL/NCAA Football JSON Structure
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

- **No `spreads` market.** World Cup is fetched with `markets=h2h,totals` only — soccer has no point spread in our model. Only the World Cup file drops spreads; NFL/NCAAF keep `h2h,spreads,totals`.
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
  "lastUpdated": "2025-01-08T14:30:00Z",
  "sports": [
    {
      "sport": "NFL",
      "gameCount": 12,
      "fileName": "nfl.json"
    },
    {
      "sport": "NCAA Football", 
      "gameCount": 45,
      "fileName": "ncaaf.json"
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
