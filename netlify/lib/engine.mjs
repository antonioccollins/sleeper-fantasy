import { createHash } from 'node:crypto';

const positions = new Set(['QB', 'RB', 'WR', 'TE']);
const eligibility = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: [...positions], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'],
};
const round = (value, digits = 1) => Number(value.toFixed(digits));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const combinations = (items) => items.flatMap((a, i) => items.slice(i + 1).map(b => [a, b]));

function playerRatings(players, rosters, weeks) {
  const samples = {};
  weeks.forEach((matchups, week) => matchups.forEach(matchup => {
    for (const [id, points] of Object.entries(matchup.players_points || {})) {
      if (points !== 0) (samples[id] ||= {})[week] = Number(points);
    }
  }));
  const ranks = {};
  for (const position of positions) {
    Object.values(players).filter(p => p.position === position && p.team)
      .sort((a, b) => (a.search_rank || 99999) - (b.search_rank || 99999))
      .forEach((p, i) => { ranks[p.player_id] = i + 1; });
  }
  const ratings = {};
  for (const id of new Set(rosters.flatMap(r => r.players || []))) {
    const p = players[id] || {};
    const position = p.position || (/^[A-Za-z]+$/.test(id) ? 'DEF' : '?');
    const rank = ranks[id] || 100;
    const prior = {QB: Math.max(8, 24 - .5 * (rank - 1)), RB: 18 / (1 + .030 * (rank - 1)), WR: 18 / (1 + .023 * (rank - 1)), TE: 15 / (1 + .060 * (rank - 1))}[position] || 0;
    const history = Object.values(samples[id] || {});
    const average = history.length ? history.reduce((a, b) => a + b, 0) / history.length : prior;
    const weight = history.length / (history.length + 6);
    const injury = p.injury_status || null;
    const estimate = (weight * average + (1 - weight) * prior) * ({Questionable: .95, Doubtful: .70, Out: .65, IR: .45}[injury] || 1);
    const replacement = {QB: 14, RB: 7, WR: 7, TE: 5}[position] || 0;
    ratings[id] = {id, name: p.full_name || id, position, nfl_team: p.team || 'FA', injury,
      value: round(Math.max(2, estimate * 1.6 + Math.max(0, estimate - replacement) * 3)),
      estimate: round(estimate), average: round(average), sample_weeks: history.length};
  }
  return ratings;
}

function strength(ids, ratings, slots) {
  const remaining = new Set(ids);
  let starters = 0;
  for (const slot of slots.filter(s => eligibility[s]).sort((a, b) => eligibility[a].length - eligibility[b].length)) {
    const eligible = [...remaining].filter(id => eligibility[slot].includes(ratings[id].position));
    eligible.sort((a, b) => ratings[b].estimate - ratings[a].estimate || a.localeCompare(b));
    if (eligible.length) { starters += ratings[eligible[0]].estimate; remaining.delete(eligible[0]); }
  }
  const bench = [...remaining].filter(id => positions.has(ratings[id].position)).reduce((sum, id) => sum + ratings[id].estimate, 0);
  return [starters, starters + .08 * bench];
}

export function generate(league, rosters, users, players, weeks) {
  const ratings = playerRatings(players, rosters, weeks);
  const owners = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teams = rosters.map(r => {
    const owner = owners[r.owner_id] || {};
    return {id: r.roster_id, owner_id: r.owner_id || null, name: owner.metadata?.team_name || owner.display_name || `Team ${r.roster_id}`,
      manager: owner.display_name || 'Unclaimed', wins: r.settings?.wins || 0, losses: r.settings?.losses || 0, ties: r.settings?.ties || 0,
      players: [...(r.players || [])].sort(), reserve: r.reserve || []};
  }).sort((a, b) => a.id - b.id);
  const epoch = digest(teams.map(t => [t.id, t.owner_id, t.players])).slice(0, 16);
  const proposals = [];
  const tradable = t => t.players.filter(id => positions.has(ratings[id].position) && !t.reserve.includes(id) && ratings[id].value >= 10)
    .sort((a, b) => ratings[b].value - ratings[a].value || a.localeCompare(b)).slice(0, 12);
  for (const [a, b] of combinations(teams)) {
    if (!a.owner_id || !b.owner_id) continue;
    const pa = tradable(a), pb = tradable(b);
    const ba = {1: pa.map(p => [p]), 2: combinations(pa)}, bb = {1: pb.map(p => [p]), 2: combinations(pb)};
    const beforeA = strength(a.players.filter(p => !a.reserve.includes(p)), ratings, league.roster_positions);
    const beforeB = strength(b.players.filter(p => !b.reserve.includes(p)), ratings, league.roster_positions);
    for (const [countA, countB] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      const accepted = [];
      for (const giveA of ba[countA]) for (const giveB of bb[countB]) {
        const valueA = giveA.reduce((s, p) => s + ratings[p].value, 0), valueB = giveB.reduce((s, p) => s + ratings[p].value, 0);
        const gap = Math.abs(valueA - valueB) / Math.max(valueA, valueB);
        if (gap > .18) continue;
        if (countA !== countB) {
          const pack = countA === 2 ? giveA : giveB, single = countA === 2 ? giveB : giveA;
          if (Math.min(...pack.map(p => ratings[p].value)) < ratings[single[0]].value * .28) continue;
        }
        const idsA = new Set([...a.players.filter(p => !giveA.includes(p)), ...giveB]);
        const idsB = new Set([...b.players.filter(p => !giveB.includes(p)), ...giveA]);
        const drops = {[a.id]: [], [b.id]: []};
        let valid = true;
        for (const [team, ids, received] of [[a, idsA, giveB], [b, idsB, giveA]]) {
          const extra = Math.max(0, ids.size - team.players.length);
          const pool = [...ids].filter(p => !received.includes(p) && !team.reserve.includes(p) && positions.has(ratings[p].position))
            .sort((x, y) => ratings[x].value - ratings[y].value || x.localeCompare(y));
          if (pool.length < extra) { valid = false; break; }
          for (const p of pool.slice(0, extra)) { ids.delete(p); drops[team.id].push(p); }
        }
        if (!valid) continue;
        const afterA = strength([...idsA].filter(p => !a.reserve.includes(p)), ratings, league.roster_positions);
        const afterB = strength([...idsB].filter(p => !b.reserve.includes(p)), ratings, league.roster_positions);
        const gainA = afterA[1] - beforeA[1], gainB = afterB[1] - beforeB[1];
        if (Math.min(gainA, gainB) < -1.5) continue;
        const id = digest([league.league_id, league.season, epoch, a.id, b.id, [...giveA].sort(), [...giveB].sort()]).slice(0, 24);
        accepted.push({id, a: a.id, b: b.id, give_a: [...giveA].sort(), give_b: [...giveB].sort(), value_a: round(valueA), value_b: round(valueB),
          gap: Math.round(gap * 100), kind: `${Math.min(countA, countB)}-for-${Math.max(countA, countB)}`, drops,
          score: round((1 - gap) * 6 + Math.min(gainA, gainB) * 2 + gainA + gainB, 2),
          starter_gain: {[a.id]: round(afterA[0] - beforeA[0]), [b.id]: round(afterB[0] - beforeB[0])}, fit_gain: {[a.id]: round(gainA), [b.id]: round(gainB)}});
      }
      const used = {}, selected = [];
      for (const p of accepted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
        if ([...p.give_a, ...p.give_b].some(id => (used[id] || 0) >= 3)) continue;
        selected.push(p);
        for (const id of [...p.give_a, ...p.give_b]) used[id] = (used[id] || 0) + 1;
        if (selected.length === 6) break;
      }
      proposals.push(...selected);
    }
  }
  return {league: Object.fromEntries(['league_id', 'name', 'season', 'total_rosters'].map(k => [k, league[k]])),
    scoring: league.scoring_settings?.rec === .5 ? 'Half PPR' : `${league.scoring_settings?.rec || 0} PPR`,
    teams, players: ratings, proposals, epoch, completed_weeks: weeks.length, updated_at: new Date().toISOString()};
}
