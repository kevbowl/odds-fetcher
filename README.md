# Odds Fetcher - Steam Detection System

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20NFL%20Odds/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **High-frequency odds collection system with Git-based historical tracking for steam detection analysis**

## 🎯 Purpose

This system provides **real-time odds data** and **historical tracking** for detecting coordinated line movements (steam events) in NFL and NCAA Football betting markets. Built for the Prophet betting application's steam detection algorithms.

## 🏗️ Architecture

```
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│   GitHub Actions  │─▶│  The-Odds-API     │─▶│  Git Repository   │
│   (8min)         │  │   (20K/mo)        │  │ (Historical)     │
└───────────────────┘  └───────────────────┘  └───────────────────┘
         │                                        │
         ▼                                        ▼
┌─────────────────┐                        ┌─────────────────┐
│  Current Data   │                        │ Prophet Analysis│
│  (JSON Files)   │                        │ (Git History)   │
└─────────────────┘                        └─────────────────┘
```

## 📊 Data Collection

| Metric | Value |
|--------|-------|
| **Frequency** | Every 8 minutes (24/7) |
| **Sports** | NFL + NCAA Football |
| **API Calls/Month** | ~1,800 (within free tier) |
| **Historical Retention** | Unlimited (Git compression) |
| **Data Format** | JSON with full bookmaker details |

## 🔧 Technical Implementation

### Core Components

| File | Purpose | Frequency |
|------|---------|-----------|
| `fetch-odds.js` | Enhanced fetcher with retry logic & Git commits | Every 8 minutes |
| `.github/workflows/fetch-odds.yml` | GitHub Actions scheduler | Every 8 minutes |
| `odds/nfl.json` | Current NFL odds (latest) | Updated every 8 minutes |
| `odds/ncaaf.json` | Current NCAA Football odds (latest) | Updated every 8 minutes |
| `odds/summary.json` | Fetch metadata & game counts | Updated every 8 minutes |

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
