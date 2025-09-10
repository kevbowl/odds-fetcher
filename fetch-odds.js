const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';

// Ensure odds directory exists
if (!fs.existsSync(ODDS_DIR)) {
  fs.mkdirSync(ODDS_DIR, { recursive: true });
}

async function fetchNFLOdds() {
  try {
    console.log('Fetching NFL odds...');
    
    const response = await axios.get('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/', {
      params: {
        apiKey: ODDS_API_KEY,
        regions: 'us',
        markets: 'h2h,spreads,totals',
        oddsFormat: 'american',
        dateFormat: 'iso'
      }
    });

    const oddsData = response.data;
    console.log(`Fetched ${oddsData.length} games with odds`);

    // Save to nfl.json
    const filePath = path.join(ODDS_DIR, 'nfl.json');
    fs.writeFileSync(filePath, JSON.stringify(oddsData, null, 2));
    
    console.log(`Odds saved to ${filePath}`);
    
    // Also create a summary for debugging
    const summary = {
      lastUpdated: new Date().toISOString(),
      gameCount: oddsData.length,
      games: oddsData.map(game => ({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        bookmakers: game.bookmakers?.length || 0
      }))
    };
    
    const summaryPath = path.join(ODDS_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`Summary saved to ${summaryPath}`);
    
  } catch (error) {
    console.error('Error fetching odds:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Run the fetch
fetchNFLOdds();
