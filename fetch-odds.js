const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_DIR = 'odds';

// Ensure odds directory exists
if (!fs.existsSync(ODDS_DIR)) {
  fs.mkdirSync(ODDS_DIR, { recursive: true });
}

async function fetchOdds(sport, sportKey, fileName) {
  try {
    console.log(`Fetching ${sport} odds...`);
    
    const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: 'us',
        markets: 'h2h,spreads,totals',
        oddsFormat: 'american',
        dateFormat: 'iso'
      }
    });

    const oddsData = response.data;
    console.log(`Fetched ${oddsData.length} ${sport} games with odds`);

    // Save to sport-specific JSON file
    const filePath = path.join(ODDS_DIR, `${fileName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(oddsData, null, 2));
    
    console.log(`${sport} odds saved to ${filePath}`);
    
    return {
      sport,
      gameCount: oddsData.length,
      games: oddsData.map(game => ({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        bookmakers: game.bookmakers?.length || 0
      }))
    };
    
  } catch (error) {
    console.error(`Error fetching ${sport} odds:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return null;
  }
}

async function fetchAllOdds() {
  try {
    console.log('Starting odds fetching for all sports...');
    
    // Fetch both NFL and NCAA football odds
    const [nflResult, ncaafResult] = await Promise.all([
      fetchOdds('NFL', 'americanfootball_nfl', 'nfl'),
      fetchOdds('NCAA Football', 'americanfootball_ncaaf', 'ncaaf')
    ]);
    
    // Create combined summary
    const summary = {
      lastUpdated: new Date().toISOString(),
      sports: []
    };
    
    if (nflResult) {
      summary.sports.push({
        sport: nflResult.sport,
        gameCount: nflResult.gameCount,
        fileName: 'nfl.json'
      });
    }
    
    if (ncaafResult) {
      summary.sports.push({
        sport: ncaafResult.sport,
        gameCount: ncaafResult.gameCount,
        fileName: 'ncaaf.json'
      });
    }
    
    // Save combined summary
    const summaryPath = path.join(ODDS_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`Summary saved to ${summaryPath}`);
    console.log('Odds fetching completed successfully!');
    
  } catch (error) {
    console.error('Error in fetchAllOdds:', error.message);
    process.exit(1);
  }
}

// Run the fetch
fetchAllOdds();
