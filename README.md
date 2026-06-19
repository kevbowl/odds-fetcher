# Odds Fetcher - Steam Detection System

[![GitHub Actions](https://github.com/kevbowl/odds-fetcher/workflows/Fetch%20Odds/badge.svg)](https://github.com/kevbowl/odds-fetcher/actions)
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
| **Per-sport frequency** | NFL/NCAAF every run while in season; World Cup every run while active |
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
- NFL + NCAAF at 12-minute resolution is high-volume (~21,600 credits/mo when
  both are in season) — size the API plan accordingly for football season.
- Configure all of this in the `SPORTS` array in `fetch-odds.js`
  (`seasonMonths` / `window` for season, `fetchEveryMinutes` for cadence,
  `markets` / `regions` for quota cost).

## 🔧 Technical Implementation

### Core Components

| File | Purpose | Frequency |
|------|---------|-----------|
| `fetch-odds.js` | Fetcher with retry logic, per-sport season/cadence gating & Git commits | Runs every 12 minutes |
| `.github/workflows/fetch-odds.yml` | GitHub Actions scheduler | Wakes every 12 minutes |
| `odds/nfl.json` | Current NFL odds (latest) | In season: every 12 min |
| `odds/ncaaf.json` | Current NCAA Football odds (latest) | In season: every 12 min |
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
