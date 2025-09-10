# Odds Fetcher

Automated odds fetching for NFL and NCAA Football games using The-Odds-API and GitHub Actions.

## Overview

This repository automatically fetches NFL and NCAA Football betting odds every 4 hours and makes them publicly available as JSON files. The Prophet betting application consumes these odds for generating recommendations.

## Files

- `.github/workflows/fetch-odds.yml` - GitHub Actions workflow that runs every 4 hours
- `fetch-odds.js` - Node.js script that fetches odds from The-Odds-API
- `package.json` - Node.js dependencies
- `odds/nfl.json` - Generated NFL odds data (updated every 4 hours)
- `odds/ncaaf.json` - Generated NCAA Football odds data (updated every 4 hours)
- `odds/summary.json` - Summary of the latest odds fetch for all sports

## Setup

1. **Repository Secrets**: Add your The-Odds-API key as a repository secret named `ODDS_API_KEY`

2. **Manual Trigger**: You can manually trigger the workflow by going to Actions → Fetch NFL Odds → Run workflow

3. **API Usage**: The generated odds files are publicly accessible at:
   ```
   https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/nfl.json
   https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/ncaaf.json
   https://raw.githubusercontent.com/kevbowl/odds-fetcher/main/odds/summary.json
   ```

## Data Format

The `nfl.json` file contains an array of game objects with the following structure:

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
              {
                "name": "Kansas City Chiefs",
                "price": -110
              },
              {
                "name": "Baltimore Ravens", 
                "price": -110
              }
            ]
          }
        ]
      }
    ]
  }
]
```

## Integration

The Prophet application consumes this data by fetching from the public URL, bypassing corporate firewall restrictions and API rate limits.

## License

MIT
