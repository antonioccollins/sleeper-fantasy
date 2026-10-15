import { getStorage, leagueID, prefix } from './store.mjs';

const VERSION = 1;
const MAX_AGE = 15 * 60 * 1000;
const amount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function avatar(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'sleepercdn.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

// Activity, not trade quality: one completed transaction counts once per team.
export function calculateRisk(league, rosters, users, transactions, now = Date.now()) {
  const owners = new Map(users.map(user => [user.user_id, user]));
  const budget = amount(league.settings?.waiver_budget);
  const usesFAAB = league.settings?.waiver_type === 2 && budget > 0;
  const weights = usesFAAB ? {trades: 40, faab: 35, moves: 25} : {trades: 60, faab: 0, moves: 40};
  const teams = rosters.map(roster => {
    const owner = owners.get(roster.owner_id) || {};
    return {id: roster.roster_id, name: owner.metadata?.team_name || owner.display_name || `Team ${roster.roster_id}`,
      manager: owner.display_name || 'Unclaimed', avatar: avatar(owner.metadata?.avatar),
      trades: 0, moves: 0, waivers: 0, free_agents: 0, adds: 0, drops: 0, faab_spent: 0, biggest_bid: 0};
  });
  const byID = new Map(teams.map(team => [team.id, team]));
  // Week boundaries can repeat a transaction; prefer its latest status.
  const unique = new Map();
  for (const transaction of transactions) {
    if (!transaction || typeof transaction.transaction_id !== 'string') throw new Error('Invalid transaction data');
    const previous = unique.get(transaction.transaction_id);
    if (!previous || amount(transaction.status_updated) >= amount(previous.status_updated)) unique.set(transaction.transaction_id, transaction);
  }
  for (const t of unique.values()) {
    if (t.status !== 'complete' || !['trade', 'waiver', 'free_agent'].includes(t.type)) continue;
    const adds = t.adds || {}, drops = t.drops || {};
    const participants = new Set([...(t.roster_ids || []), ...Object.values(adds), ...Object.values(drops)]);
    if (t.type === 'trade') {
      for (const pick of t.draft_picks || []) { participants.add(pick.owner_id); participants.add(pick.previous_owner_id); }
      for (const transfer of t.waiver_budget || []) { participants.add(transfer.sender); participants.add(transfer.receiver); }
    }
    for (const id of participants) {
      const team = byID.get(id);
      if (!team) continue;
      if (t.type === 'trade') { team.trades++; continue; }
      const added = Object.values(adds).filter(owner => owner === id).length;
      const dropped = Object.values(drops).filter(owner => owner === id).length;
      if (!added && !dropped) continue;
      team.moves++;
      team.adds += added;
      team.drops += dropped;
      if (t.type === 'waiver') {
        team.waivers++;
        // Spending means successful waiver bids, not traded FAAB or failed bids.
        const bid = added ? amount(t.settings?.waiver_bid) : 0;
        team.faab_spent += bid;
        team.biggest_bid = Math.max(team.biggest_bid, bid);
      } else team.free_agents++;
    }
  }
  const mostTrades = Math.max(1, ...teams.map(t => t.trades));
  const mostMoves = Math.max(1, ...teams.map(t => t.moves));
  for (const team of teams) {
    team.transactions = team.trades + team.moves;
    team.faab_percent = budget ? Math.round(team.faab_spent / budget * 100) : 0;
    team.points = {trades: weights.trades * team.trades / mostTrades,
      faab: usesFAAB ? weights.faab * Math.min(1, team.faab_spent / budget) : 0,
      moves: weights.moves * team.moves / mostMoves};
    team.score = Math.round(Object.values(team.points).reduce((a, b) => a + b, 0));
  }
  teams.sort((a, b) => b.score - a.score || a.id - b.id);
  teams.forEach((team, index) => { team.rank = index && team.score === teams[index - 1].score ? teams[index - 1].rank : index + 1; });
  return {version: VERSION, source: 'Sleeper', league: league.name, season: league.season,
    updated_at: new Date(now).toISOString(), stale: false, budget, uses_faab: usesFAAB, weights, teams};
}

async function readSleeper(path) {
  const response = await fetch(`https://api.sleeper.app/v1/${path}`, {
    headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status}`);
  return response.json();
}

export function createRiskLoader({read = readSleeper, now = Date.now} = {}) {
  let pending;
  return async (store = getStorage()) => {
    const key = `${prefix}/risk-index-v${VERSION}`;
    const cached = await store.get(key, {type: 'json'});
    if (cached?.version === VERSION && now() - Date.parse(cached.updated_at) < MAX_AGE) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        // Independent of FantasyPros, recommendation epochs, and the vote ledger.
        const [league, rosters, users, ...weeks] = await Promise.all([
          read(`league/${leagueID}`), read(`league/${leagueID}/rosters`), read(`league/${leagueID}/users`),
          ...Array.from({length: 19}, (_, week) => read(`league/${leagueID}/transactions/${week}`)),
        ]);
        if (league?.league_id !== leagueID || league.sport !== 'nfl' || !league.season ||
            !Array.isArray(rosters) || !rosters.length || !Array.isArray(users) || weeks.some(week => !Array.isArray(week))) {
          throw new Error('Incomplete Sleeper activity');
        }
        const result = calculateRisk(league, rosters, users, weeks.flat(), now());
        await store.setJSON(key, result);
        return result;
      } catch {
        // Never present partial history as a complete season or an outage as zeros.
        if (cached?.version === VERSION) return {...cached, stale: true};
        const error = new Error('Sleeper activity is unavailable. Try again shortly.');
        error.status = 503;
        error.public = true;
        throw error;
      } finally { pending = null; }
    })();
    return pending;
  };
}

export const getRiskIndex = createRiskLoader();
