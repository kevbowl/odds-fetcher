const assert = require('node:assert/strict');
const {
  DEFAULT_REGIONS,
  GAMMA_SERIES_BY_SPORT_KEY,
  POLYMARKET_BOOKMAKER_KEY,
  SPORTS,
  assertExpectedSportKey,
  buildApiRequestUrl,
  buildSummarySport,
  buildUsOddsParams,
  countNflGamesByFeed,
  estimateCredits,
  fetchJson,
  fetchNflOdds,
  fetchOdds,
  isPrimaryGammaGameEvent,
  isSportActive,
  isSportDue,
  isPreseasonActive,
  mergeGammaPolymarketBookmakers,
  mergeOddsGames,
  mergePolymarketBookmakers,
  needsBaseballDirectFallback,
  parseAvailableSportKeys,
  probabilityToAmerican,
  RUN_EVERY_MIN,
  selectSportsWithinQuota,
  teamMatches
} = require('./fetch-odds');

const sport = { sport: 'WNBA', fileName: 'wnba' };
const previous = {
  gameCount: 4,
  lastFetched: '2026-08-02T15:45:00.000Z',
  lastAttemptAt: '2026-08-02T15:45:00.000Z',
  lastAttemptStatus: 'success',
  lastError: null
};
const nowIso = '2026-08-02T16:00:00.000Z';

const success = buildSummarySport(sport, {
  sport: 'WNBA',
  gameCount: 7,
  debug: { warning: null }
}, previous, nowIso);
assert.equal(success.lastFetched, nowIso);
assert.equal(success.lastAttemptAt, nowIso);
assert.equal(success.lastAttemptStatus, 'success');
assert.equal(success.lastError, null);
assert.equal(success.gameCount, 7);
assert.deepEqual(success.debug, { warning: null });

const failure = buildSummarySport(sport, {
  sport: 'WNBA',
  error: { status: 503, message: 'Request failed with status code 503' }
}, previous, nowIso);
assert.equal(failure.lastFetched, previous.lastFetched);
assert.equal(failure.lastAttemptAt, nowIso);
assert.equal(failure.lastAttemptStatus, 'failed');
assert.deepEqual(failure.lastError, {
  status: 503,
  message: 'Request failed with status code 503'
});
assert.equal(failure.gameCount, previous.gameCount);
assert.equal(failure.debug, undefined);

const notDue = buildSummarySport(sport, undefined, previous, nowIso);
assert.equal(notDue.lastFetched, previous.lastFetched);
assert.equal(notDue.lastAttemptAt, previous.lastAttemptAt);
assert.equal(notDue.lastAttemptStatus, previous.lastAttemptStatus);
assert.equal(notDue.lastError, null);

const firstFailure = buildSummarySport(sport, {
  sport: 'WNBA',
  error: { status: null, message: 'network unavailable' }
}, undefined, nowIso);
assert.equal(firstFailure.gameCount, 0);
assert.equal(firstFailure.lastFetched, null);
assert.equal(firstFailure.lastAttemptStatus, 'failed');

assert.equal(RUN_EVERY_MIN, 5);
assert.equal(DEFAULT_REGIONS, 'us');
assert.equal(POLYMARKET_BOOKMAKER_KEY, 'polymarket');
assert.equal(GAMMA_SERIES_BY_SPORT_KEY.soccer_epl, '10188');
assert.equal(GAMMA_SERIES_BY_SPORT_KEY.americanfootball_ncaaf, '12756');
assert.equal(GAMMA_SERIES_BY_SPORT_KEY.baseball_kbo, '10370');
assert.equal(GAMMA_SERIES_BY_SPORT_KEY.americanfootball_nfl, '12185');
assert.equal(probabilityToAmerican(0.5), -100);
assert.equal(probabilityToAmerican(0.355), 182);
assert.equal(probabilityToAmerican(0), null);
SPORTS.forEach(candidate => {
  assert.equal(candidate.regions, 'us', `${candidate.sport} must keep regions=us`);
});
const epl = SPORTS.find(candidate => candidate.sportKey === 'soccer_epl');
assert.ok(epl, 'EPL configuration should exist');
assert.equal(epl.sport, 'epl');
assert.equal(epl.fileName, 'epl');
assert.equal(epl.markets, 'h2h,totals');
assert.equal(epl.regions, 'us');
assert.equal(epl.fetchEveryMinutes, 5);
assert.equal(epl.preseasonSportKey, undefined);
assert.equal(estimateCredits(epl), 2);
assert.equal(isSportActive(epl, new Date('2026-08-20T00:00:00Z')), true);
assert.equal(isSportActive(epl, new Date('2026-05-31T23:59:59Z')), true);
assert.equal(isSportActive(epl, new Date('2026-06-01T00:00:00Z')), false);
assert.equal(isSportActive(epl, new Date('2026-07-19T00:00:00Z')), false);
assert.doesNotThrow(() => assertExpectedSportKey([
  { id: 'epl-1', sport_key: 'soccer_epl' }
], 'soccer_epl'));
assert.doesNotThrow(() => assertExpectedSportKey([], 'soccer_epl'));
assert.throws(
  () => assertExpectedSportKey([
    { id: 'epl-1', sport_key: 'soccer_epl' },
    { id: 'wcup-1', sport_key: 'soccer_fifa_world_cup' }
  ], 'soccer_epl'),
  /soccer_fifa_world_cup/
);
assert.throws(
  () => assertExpectedSportKey([
    { id: 'mls-1', sport_key: 'soccer_usa_mls' }
  ], 'soccer_epl'),
  /soccer_usa_mls/
);
const worldcup = SPORTS.find(candidate => candidate.sportKey === 'soccer_fifa_world_cup');
assert.ok(worldcup, 'World Cup configuration should remain separate');
assert.equal(worldcup.fileName, 'worldcup');
assert.notEqual(epl.fileName, worldcup.fileName);
assert.notEqual(epl.sportKey, worldcup.sportKey);
const eplSummary = buildSummarySport(epl, {
  sport: 'epl',
  gameCount: 10
}, undefined, nowIso);
assert.equal(eplSummary.fileName, 'epl.json');
assert.equal(eplSummary.sport, 'epl');
assert.equal(eplSummary.gameCount, 10);
assert.equal(eplSummary.lastFetched, nowIso);
assert.equal(eplSummary.lastAttemptAt, nowIso);
assert.equal(eplSummary.lastAttemptStatus, 'success');
const failedEplSummary = buildSummarySport(epl, {
  sport: 'epl',
  error: { status: 503, message: 'provider failure' }
}, undefined, nowIso);
assert.equal(failedEplSummary.lastFetched, null);
assert.equal(failedEplSummary.gameCount, 0);
assert.equal(failedEplSummary.lastAttemptStatus, 'failed');
assert.notEqual(failedEplSummary.lastAttemptStatus, 'success');
const nfl = SPORTS.find(candidate => candidate.sportKey === 'americanfootball_nfl');
assert.ok(nfl, 'NFL configuration should exist');
assert.equal(isSportActive(nfl, new Date('2026-08-01T00:00:00Z')), true);
assert.equal(isSportActive(nfl, new Date('2026-07-31T23:59:59Z')), false);
assert.equal(nfl.preseasonSportKey, 'americanfootball_nfl_preseason');

const providerSports = parseAvailableSportKeys([
  { key: 'americanfootball_nfl', active: true },
  { key: 'americanfootball_nfl_preseason', active: true },
  { key: 'baseball_mlb', active: false }
]);
assert.deepEqual(
  [...providerSports].sort(),
  ['americanfootball_nfl', 'americanfootball_nfl_preseason']
);
assert.equal(isPreseasonActive(nfl, providerSports, new Date('2026-10-01T00:00:00Z')), true);
assert.equal(isPreseasonActive(nfl, new Set(), new Date('2026-08-15T00:00:00Z')), false);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-08-01T00:00:00Z')), true);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-09-09T23:59:59Z')), true);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-09-10T00:00:00Z')), false);
assert.equal(isPreseasonActive(nfl, null, new Date('2026-07-31T23:59:59Z')), false);
assert.equal(estimateCredits({ ...nfl, includePreseason: false }), 3);
assert.equal(estimateCredits({ ...nfl, includePreseason: true }), 6);
const mlb = SPORTS.find(candidate => candidate.sportKey === 'baseball_mlb');
assert.ok(mlb, 'MLB configuration should exist');
assert.equal(mlb.regions, 'us');
assert.equal(estimateCredits(mlb), 6);
const wnba = SPORTS.find(candidate => candidate.sportKey === 'basketball_wnba');
assert.equal(estimateCredits(wnba), 3);

const regularGame = {
  id: 'regular-later',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-10T00:15:00Z'
};
const preseasonGame = {
  id: 'preseason-earlier',
  sport_key: 'americanfootball_nfl_preseason',
  commence_time: '2026-08-13T23:00:00Z'
};
const duplicateRegular = {
  id: 'duplicate',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-01T00:00:00Z'
};
const duplicatePreseason = {
  id: 'duplicate',
  sport_key: 'americanfootball_nfl_preseason',
  commence_time: '2026-09-01T00:00:00Z'
};
const mergedNfl = mergeOddsGames(
  [regularGame, duplicateRegular],
  [duplicatePreseason, preseasonGame]
);
assert.deepEqual(
  mergedNfl.map(game => game.id),
  ['preseason-earlier', 'duplicate', 'regular-later']
);
assert.equal(mergedNfl.length, 3);
assert.equal(mergedNfl[0].sport_key, 'americanfootball_nfl_preseason');
assert.equal(mergedNfl[1].sport_key, 'americanfootball_nfl_preseason');
assert.deepEqual(countNflGamesByFeed(mergedNfl), {
  regularSeasonGameCount: 1,
  preseasonGameCount: 2
});

const usDraftKings = { key: 'draftkings', title: 'DraftKings', last_update: '2026-09-01T00:00:00Z' };
const usFanDuel = { key: 'fanduel', title: 'FanDuel', last_update: '2026-09-01T00:00:00Z' };
const stalePolymarket = { key: 'polymarket', title: 'Polymarket', last_update: '2026-08-31T00:00:00Z' };
const livePolymarket = {
  key: 'polymarket',
  title: 'Polymarket',
  last_update: '2026-09-01T01:00:00Z',
  markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -105, sid: 'pm-1' }] }]
};
const sharedUsGame = {
  id: 'shared',
  sport_key: 'soccer_epl',
  commence_time: '2026-09-12T14:00:00Z',
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  bookmakers: [usDraftKings]
};
const usOnlyGame = {
  id: 'us-only',
  sport_key: 'soccer_epl',
  commence_time: '2026-09-13T14:00:00Z',
  home_team: 'Liverpool',
  away_team: 'Everton',
  bookmakers: [usFanDuel]
};
const polymarketSharedGame = {
  id: 'shared',
  sport_key: 'soccer_epl',
  commence_time: '2099-01-01T00:00:00Z',
  home_team: 'Wrong Home',
  away_team: 'Wrong Away',
  bookmakers: [livePolymarket]
};
const polymarketOnlyGame = {
  id: 'poly-only',
  sport_key: 'soccer_epl',
  commence_time: '2026-09-14T14:00:00Z',
  bookmakers: [livePolymarket]
};
const mergedBooks = mergePolymarketBookmakers(
  [sharedUsGame, usOnlyGame],
  [polymarketSharedGame, polymarketOnlyGame]
);
assert.equal(mergedBooks.length, 2);
assert.equal(mergedBooks[0].id, 'shared');
assert.equal(mergedBooks[0].commence_time, sharedUsGame.commence_time);
assert.equal(mergedBooks[0].home_team, 'Arsenal');
assert.equal(mergedBooks[0].sport_key, 'soccer_epl');
assert.deepEqual(mergedBooks[0].bookmakers.map(book => book.key), ['draftkings', 'polymarket']);
assert.equal(mergedBooks[0].bookmakers[1].markets[0].outcomes[0].sid, 'pm-1');
assert.equal(mergedBooks[1].id, 'us-only');
assert.deepEqual(mergedBooks[1].bookmakers, [usFanDuel]);
assert.equal(mergedBooks.some(game => game.id === 'poly-only'), false);

const replacedPolymarket = mergePolymarketBookmakers(
  [{ ...sharedUsGame, bookmakers: [usDraftKings, stalePolymarket] }],
  [polymarketSharedGame]
);
assert.deepEqual(replacedPolymarket[0].bookmakers.map(book => book.key), ['draftkings', 'polymarket']);
assert.equal(replacedPolymarket[0].bookmakers[1].last_update, livePolymarket.last_update);

const emptyPolymarketMerge = mergePolymarketBookmakers([sharedUsGame, usOnlyGame], []);
assert.equal(emptyPolymarketMerge[0], sharedUsGame);
assert.equal(emptyPolymarketMerge[1], usOnlyGame);

const usParams = buildUsOddsParams({ markets: 'h2h,spreads,totals', regions: DEFAULT_REGIONS });
assert.equal(usParams.regions, 'us');
assert.equal(usParams.oddsFormat, 'american');
assert.equal(usParams.dateFormat, 'iso');
assert.equal(usParams.bookmakers, undefined);
assert.equal(Object.hasOwn(usParams, 'bookmakers'), false);

const arsenalTeam = { name: 'Arsenal FC', alias: 'Arsenal', abbreviation: 'ars' };
const chelseaTeam = { name: 'Chelsea FC', alias: 'Chelsea', abbreviation: 'che' };
assert.equal(teamMatches('Arsenal', arsenalTeam), true);
assert.equal(teamMatches('Brighton and Hove Albion', {
  name: 'Brighton & Hove Albion FC',
  alias: 'Brighton',
  abbreviation: 'bha'
}), true);
assert.equal(teamMatches('Iowa State Cyclones', {
  name: 'Cyclones',
  alias: 'Iowa State',
  abbreviation: 'iowast'
}), true);
assert.equal(teamMatches('Iowa State Cyclones', {
  name: 'Bobcats',
  alias: 'Texas State',
  abbreviation: 'txst'
}), false);
assert.equal(teamMatches('Miami Hurricanes', {
  name: 'Hurricanes',
  alias: 'Miami (FL)',
  abbreviation: 'mia'
}), true);
assert.equal(teamMatches('Miami Hurricanes', {
  name: 'RedHawks',
  alias: 'Miami (OH)',
  abbreviation: 'miaoh'
}), false);
assert.equal(isPrimaryGammaGameEvent({
  slug: 'epl-ars-che-2026-09-12',
  teams: [arsenalTeam, chelseaTeam]
}), true);
assert.equal(isPrimaryGammaGameEvent({
  slug: 'epl-ars-che-2026-09-12-halftime-result',
  teams: [arsenalTeam, chelseaTeam]
}), false);

const gammaEplEvent = {
  id: 'gamma-epl-1',
  slug: 'epl-ars-che-2026-09-12',
  startTime: sharedUsGame.commence_time,
  teams: [arsenalTeam, chelseaTeam],
  markets: [
    {
      sportsMarketType: 'moneyline',
      groupItemTitle: 'Arsenal FC',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.4","0.6"]',
      clobTokenIds: '["tok-ars","tok-ars-no"]',
      bestBid: 0.39,
      bestAsk: 0.41
    },
    {
      sportsMarketType: 'moneyline',
      groupItemTitle: 'Draw (Arsenal FC vs. Chelsea FC)',
      question: 'Will Arsenal FC vs. Chelsea FC end in a draw?',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.3","0.7"]',
      clobTokenIds: '["tok-draw","tok-draw-no"]'
    },
    {
      sportsMarketType: 'moneyline',
      groupItemTitle: 'Chelsea FC',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.3","0.7"]',
      clobTokenIds: '["tok-che","tok-che-no"]'
    },
    {
      sportsMarketType: 'totals',
      groupItemTitle: 'O/U 2.5',
      line: 2.5,
      outcomes: '["Over","Under"]',
      outcomePrices: '["0.52","0.48"]',
      clobTokenIds: '["tok-ov","tok-un"]'
    }
  ]
};
const gammaHalftimeEvent = {
  ...gammaEplEvent,
  id: 'gamma-epl-ht',
  slug: 'epl-ars-che-2026-09-12-halftime-result'
};
const gammaMerged = mergeGammaPolymarketBookmakers(
  [sharedUsGame, usOnlyGame],
  [gammaEplEvent, gammaHalftimeEvent],
  'h2h,totals'
);
assert.equal(gammaMerged.length, 2);
assert.equal(gammaMerged[0].id, 'shared');
assert.equal(gammaMerged[0].home_team, 'Arsenal');
assert.deepEqual(gammaMerged[0].bookmakers.map(book => book.key), ['draftkings', 'polymarket']);
const gammaBook = gammaMerged[0].bookmakers[1];
assert.equal(gammaBook.sid, 'gamma-epl-1');
assert.deepEqual(gammaBook.markets.map(market => market.key), ['h2h', 'totals']);
assert.deepEqual(gammaBook.markets[0].outcomes.map(outcome => outcome.name), [
  'Arsenal',
  'Draw',
  'Chelsea'
]);
assert.equal(gammaBook.markets[0].outcomes[0].sid, 'tok-ars');
assert.equal(gammaBook.markets[0].outcomes[1].sid, 'tok-draw');
assert.equal(gammaBook.markets[1].outcomes[0].point, 2.5);
assert.deepEqual(gammaMerged[1].bookmakers, [usFanDuel]);

const nextDaySameTeams = mergeGammaPolymarketBookmakers(
  [sharedUsGame],
  [{ ...gammaEplEvent, startTime: '2026-09-13T14:00:00Z' }],
  'h2h'
);
assert.deepEqual(nextDaySameTeams[0].bookmakers, [usDraftKings]);

const ambiguousGamma = mergeGammaPolymarketBookmakers(
  [sharedUsGame],
  [
    gammaEplEvent,
    { ...gammaEplEvent, id: 'gamma-epl-2', slug: 'epl-ars-che-2026-09-12' }
  ],
  'h2h'
);
assert.deepEqual(ambiguousGamma[0].bookmakers, [usDraftKings]);

const nflUsGameForGamma = {
  id: 'nfl-1',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-20T17:00:00Z',
  home_team: 'Chicago Bears',
  away_team: 'Minnesota Vikings',
  bookmakers: [usDraftKings]
};
const gammaNflEvent = {
  id: 'gamma-nfl-1',
  slug: 'nfl-min-chi-2026-09-20',
  startTime: '2026-09-20T17:00:00Z',
  teams: [
    { name: 'Minnesota Vikings', alias: 'Vikings', abbreviation: 'min', ordering: 'away' },
    { name: 'Chicago Bears', alias: 'Bears', abbreviation: 'chi', ordering: 'home' }
  ],
  markets: [
    {
      sportsMarketType: 'moneyline',
      outcomes: '["Vikings","Bears"]',
      outcomePrices: '["0.34","0.66"]',
      clobTokenIds: '["tok-min","tok-chi"]'
    },
    {
      sportsMarketType: 'spreads',
      groupItemTitle: 'Spread -3.5',
      line: -3.5,
      outcomes: '["Bears","Vikings"]',
      outcomePrices: '["0.51","0.49"]',
      clobTokenIds: '["tok-chi-spread","tok-min-spread"]'
    }
  ]
};
const nflGammaMerged = mergeGammaPolymarketBookmakers(
  [nflUsGameForGamma],
  [gammaNflEvent],
  'h2h,spreads,totals'
);
const nflGammaBook = nflGammaMerged[0].bookmakers[1];
assert.equal(nflGammaBook.key, 'polymarket');
assert.deepEqual(
  nflGammaBook.markets.find(market => market.key === 'h2h').outcomes.map(outcome => (
    { name: outcome.name, sid: outcome.sid }
  )),
  [
    { name: 'Minnesota Vikings', sid: 'tok-min' },
    { name: 'Chicago Bears', sid: 'tok-chi' }
  ]
);
const nflSpread = nflGammaBook.markets.find(market => market.key === 'spreads');
assert.equal(nflSpread.outcomes.find(outcome => outcome.name === 'Chicago Bears').point, -3.5);
assert.equal(nflSpread.outcomes.find(outcome => outcome.name === 'Minnesota Vikings').point, 3.5);

const unknownQuota = selectSportsWithinQuota([epl], null);
assert.equal(unknownQuota.selected.length, 1);
assert.equal(unknownQuota.skipped.length, 0);
const fullQuota = selectSportsWithinQuota([epl], { remaining: 24 });
assert.equal(fullQuota.selected.length, 1);
assert.equal(fullQuota.skipped.length, 0);
const tightQuota = selectSportsWithinQuota([epl], { remaining: 22 });
assert.equal(tightQuota.selected.length, 1);
assert.equal(tightQuota.skipped.length, 0);
const noQuota = selectSportsWithinQuota([epl], { remaining: 21 });
assert.equal(noQuota.selected.length, 0);
assert.equal(noQuota.skipped.length, 1);
const bothLeaguesFit = selectSportsWithinQuota(
  [epl, { ...nfl, includePreseason: false }],
  { remaining: 26 }
);
assert.equal(bothLeaguesFit.selected.length, 2);
assert.equal(bothLeaguesFit.skipped.length, 0);

assert.equal(
  needsBaseballDirectFallback(
    [{ id: 'game-1' }, { id: 'game-2' }],
    [{ id: 'game-1' }, { id: 'game-2' }]
  ),
  false,
  'complete event-ID odds should not spend credits on the direct fallback'
);
assert.equal(
  needsBaseballDirectFallback(
    [{ id: 'game-1' }, { id: 'game-2' }],
    [{ id: 'game-1' }]
  ),
  true,
  'an incomplete event-ID response should use the direct fallback'
);
assert.equal(
  needsBaseballDirectFallback([], []),
  true,
  'an empty events response should retain the direct fallback'
);

const nflSummary = buildSummarySport(nfl, {
  sport: 'NFL',
  gameCount: 3,
  regularSeasonGameCount: 1,
  preseasonGameCount: 2
}, undefined, nowIso);
assert.equal(nflSummary.gameCount, 3);
assert.equal(nflSummary.regularSeasonGameCount, 1);
assert.equal(nflSummary.preseasonGameCount, 2);
const failedNflSummary = buildSummarySport(nfl, {
  sport: 'NFL',
  error: { status: 503, message: 'preseason unavailable' }
}, {
  gameCount: 285,
  regularSeasonGameCount: 272,
  preseasonGameCount: 13,
  lastFetched: previous.lastFetched
}, nowIso);
assert.equal(failedNflSummary.gameCount, 285);
assert.equal(failedNflSummary.regularSeasonGameCount, 272);
assert.equal(failedNflSummary.preseasonGameCount, 13);
assert.equal(failedNflSummary.lastAttemptStatus, 'failed');
const fiveMinuteSport = { fetchEveryMinutes: 5 };
const cadenceNow = new Date('2026-08-02T16:05:00.000Z');
assert.equal(
  isSportDue(fiveMinuteSport, '2026-08-02T16:03:00.000Z', cadenceNow),
  false
);
assert.equal(
  isSportDue(fiveMinuteSport, '2026-08-02T16:02:00.000Z', cadenceNow),
  true
);

async function testNflPublication() {
  const writes = [];
  const result = await fetchNflOdds(
    { ...nfl, includePreseason: true },
    {
      fetchRequest: async url => ({
        data: url.includes('nfl_preseason') ? [] : [regularGame],
        headers: {}
      }),
      writeFile: (filePath, contents) => writes.push({ filePath, contents })
    }
  );
  assert.equal(result.gameCount, 1);
  assert.equal(result.regularSeasonGameCount, 1);
  assert.equal(result.preseasonGameCount, 0);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].contents), [regularGame]);

  let partialFailureWrites = 0;
  await assert.rejects(
    fetchNflOdds(
      { ...nfl, includePreseason: true },
      {
        fetchRequest: async url => {
          if (url.includes('nfl_preseason')) {
            throw new Error('preseason provider failure');
          }
          return { data: [regularGame], headers: {} };
        },
        writeFile: () => { partialFailureWrites += 1; }
      }
    ),
    /preseason provider failure/
  );
  assert.equal(partialFailureWrites, 0);
}

async function testPolymarketFetchAndMerge() {
  const nflRequests = [];
  const nflWrites = [];
  const nflUsGame = {
    ...nflUsGameForGamma,
    bookmakers: [usDraftKings]
  };
  const nflResult = await fetchNflOdds(
    { ...nfl, includePreseason: false },
    {
      fetchRequest: async (url, params) => {
        nflRequests.push({ url, params });
        if (String(url).includes('gamma-api.polymarket.com')) {
          return { data: [gammaNflEvent], headers: {} };
        }
        return { data: [nflUsGame], headers: { 'x-requests-remaining': '90' } };
      },
      writeFile: (filePath, contents) => nflWrites.push({ filePath, contents })
    }
  );
  assert.equal(nflRequests.length, 2);
  assert.equal(nflRequests[0].params.regions, 'us');
  assert.equal(Object.hasOwn(nflRequests[0].params, 'bookmakers'), false);
  assert.equal(nflRequests[1].url.includes('gamma-api.polymarket.com/events'), true);
  assert.equal(nflRequests[1].params.series_id, '12185');
  assert.equal(Object.hasOwn(nflRequests[1].params, 'bookmakers'), false);
  assert.equal(nflResult.gameCount, 1);
  const nflPublished = JSON.parse(nflWrites[0].contents);
  assert.equal(nflPublished[0].commence_time, nflUsGame.commence_time);
  assert.deepEqual(nflPublished[0].bookmakers.map(book => book.key), ['draftkings', 'polymarket']);
  assert.equal(
    nflPublished[0].bookmakers[1].markets[0].outcomes[0].sid,
    'tok-min'
  );

  const eplRequests = [];
  const eplWrites = [];
  const eplResult = await fetchOdds(
    { ...epl },
    {
      fetchRequest: async (url, params) => {
        eplRequests.push({ url, params });
        if (String(url).includes('gamma-api.polymarket.com')) {
          return { data: [gammaEplEvent, gammaHalftimeEvent], headers: {} };
        }
        return { data: [sharedUsGame, usOnlyGame], headers: {} };
      },
      writeFile: (filePath, contents) => eplWrites.push({ filePath, contents })
    }
  );
  assert.equal(eplResult.error, undefined);
  assert.equal(eplResult.gameCount, 2);
  assert.equal(eplRequests[0].params.regions, 'us');
  assert.equal(Object.hasOwn(eplRequests[0].params, 'bookmakers'), false);
  assert.equal(eplRequests[1].params.series_id, '10188');
  const eplPublished = JSON.parse(eplWrites[0].contents);
  assert.equal(eplPublished.length, 2);
  assert.equal(eplPublished[0].home_team, 'Arsenal');
  assert.equal(eplPublished[0].bookmakers[1].key, 'polymarket');
  assert.equal(eplPublished[1].bookmakers.length, 1);
  assert.equal(eplPublished.some(game => game.id === 'poly-only'), false);

  const emptyPolyWrites = [];
  await fetchOdds(
    { ...epl },
    {
      fetchRequest: async (url) => {
        if (String(url).includes('gamma-api.polymarket.com')) return { data: [], headers: {} };
        return { data: [sharedUsGame, usOnlyGame], headers: {} };
      },
      writeFile: (_filePath, contents) => emptyPolyWrites.push(contents)
    }
  );
  const emptyPublished = JSON.parse(emptyPolyWrites[0]);
  assert.equal(emptyPublished.length, 2);
  assert.deepEqual(emptyPublished[1].bookmakers, [usFanDuel]);

  const failedPolyWrites = [];
  const failedPolyResult = await fetchOdds(
    { ...epl },
    {
      fetchRequest: async (url) => {
        if (String(url).includes('gamma-api.polymarket.com')) {
          const error = new Error('Request failed with status code 503');
          error.response = { status: 503, data: { message: 'unavailable' } };
          throw error;
        }
        return { data: [sharedUsGame], headers: {} };
      },
      writeFile: (_filePath, contents) => failedPolyWrites.push(contents)
    }
  );
  assert.equal(failedPolyResult.error, undefined);
  assert.equal(failedPolyResult.gameCount, 1);
  assert.deepEqual(JSON.parse(failedPolyWrites[0])[0].bookmakers, [usDraftKings]);

  const mlbRequests = [];
  const mlbWrites = [];
  const commenceTime = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mlbUsGame = {
    id: 'mlb-1',
    sport_key: 'baseball_mlb',
    commence_time: commenceTime,
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    bookmakers: [usDraftKings]
  };
  const mlbGammaEvent = {
    id: 'gamma-mlb-1',
    slug: 'mlb-bos-nyy-2026-09-19',
    startTime: commenceTime,
    teams: [
      { name: 'Boston Red Sox', alias: 'Red Sox', abbreviation: 'bos' },
      { name: 'New York Yankees', alias: 'Yankees', abbreviation: 'nyy' }
    ],
    markets: [
      {
        sportsMarketType: 'moneyline',
        outcomes: '["Boston Red Sox","New York Yankees"]',
        outcomePrices: '["0.42","0.58"]',
        clobTokenIds: '["tok-bos","tok-nyy"]'
      }
    ]
  };
  const mlbResult = await fetchOdds(
    { ...mlb },
    {
      fetchRequest: async (url, params) => {
        mlbRequests.push({ url, params });
        if (String(url).includes('gamma-api.polymarket.com')) {
          return { data: [mlbGammaEvent], headers: {} };
        }
        if (url.includes('/events')) {
          return { data: [{ id: 'mlb-1', commence_time: commenceTime }], headers: {} };
        }
        return { data: [mlbUsGame], headers: {} };
      },
      writeFile: (_filePath, contents) => mlbWrites.push(contents)
    }
  );
  assert.equal(mlbResult.error, undefined);
  const mlbUsOdds = mlbRequests.find(item => (
    String(item.url).includes('/odds/') && item.params.regions === 'us'
  ));
  const mlbGamma = mlbRequests.find(item => String(item.url).includes('gamma-api.polymarket.com'));
  assert.ok(mlbUsOdds, 'MLB US odds request should use regions=us');
  assert.equal(Object.hasOwn(mlbUsOdds.params, 'bookmakers'), false);
  assert.equal(mlbUsOdds.params.eventIds, 'mlb-1');
  assert.ok(mlbGamma, 'MLB Polymarket should come from Gamma, not Odds API');
  assert.equal(mlbGamma.params.series_id, '3');
  assert.equal(Object.hasOwn(mlbGamma.params, 'bookmakers'), false);
  assert.equal(mlbResult.debug.mlbDirectFallbackUsed, false);
  assert.equal(JSON.parse(mlbWrites[0])[0].bookmakers[1].key, 'polymarket');
}

async function testNativeHttpClient() {
  const requestUrl = buildApiRequestUrl('https://example.test/odds', {
    markets: 'h2h,spreads',
    regions: 'us',
    omitted: null
  });
  assert.equal(requestUrl.searchParams.get('markets'), 'h2h,spreads');
  assert.equal(requestUrl.searchParams.get('regions'), 'us');
  assert.equal(requestUrl.searchParams.has('omitted'), false);

  const response = await fetchJson('https://example.test/odds', { regions: 'us' }, {
    fetchImpl: async url => {
      assert.equal(url.searchParams.get('regions'), 'us');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 'game-1' }]),
        headers: { entries: () => [['x-requests-remaining', '42']] }
      };
    },
    timeoutMs: 1000
  });
  assert.deepEqual(response.data, [{ id: 'game-1' }]);
  assert.equal(response.headers['x-requests-remaining'], '42');

  await assert.rejects(
    fetchJson('https://example.test/odds', {}, {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'unavailable' }),
        headers: { entries: () => [] }
      }),
      timeoutMs: 1000
    }),
    error => error.response?.status === 503
      && error.response?.data?.message === 'unavailable'
  );

  await assert.rejects(
    fetchJson('https://example.test/odds', {}, {
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
      timeoutMs: 10
    }),
    error => error.code === 'ETIMEDOUT'
  );
}

Promise.all([testNflPublication(), testNativeHttpClient(), testPolymarketFetchAndMerge()])
  .then(() => console.log('odds-fetcher fetch and receipt tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
