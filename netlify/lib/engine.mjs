import { createHash } from 'node:crypto';

const positions = new Set(['QB', 'RB', 'WR', 'TE']);
const eligibility = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: [...positions], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'],
};
const round = (value, digits = 1) => Number(value.toFixed(digits));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const combinations = (items) => items.flatMap((a, i) => items.slice(i + 1).map(b => [a, b]));

export const ENGINE_VERSION = 'fantasypros-ros-v1';

// Rankings are ordinal, not FantasyPros trade prices or point projections.
// A convex curve protects elite assets from stacks of replaceable players.
export function tradeValue(rank) { return round(100 * Math.exp(-(rank - 1) / 48)); }
function playerRatings(players, rosters, rankings) {
  const ratings = {};
  for (const id of new Set(rosters.flatMap(r => r.players || []))) {
    const p = players[id] || {}, row = rankings?.bySleeper?.[id];
    const position = p.position || (/^[A-Za-z]+$/.test(id) ? 'DEF' : '?');
    const replacement = {QB: 24, RB: 60, WR: 75, TE: 30}[position] || 0;
    // Positional rank measures lineup fit independently of cross-position price.
    const fit = row ? Math.max(0, 12 * Math.log((replacement + 8) / (row.position_rank + 8))) : 0;
    ratings[id] = {id, name: p.full_name || id, position, nfl_team: p.team || 'FA', injury: p.injury_status || null,
      value: row ? tradeValue(row.rank) : 0, fit: round(fit, 3), ros_rank: row?.rank || null, position_rank: row?.position_rank || null};
  }
  return ratings;
}

function strength(ids, ratings, slots) {
  const remaining = new Set(ids);
  let starters = 0;
  for (const slot of slots.filter(s => eligibility[s]).sort((a, b) => eligibility[a].length - eligibility[b].length)) {
    const eligible = [...remaining].filter(id => eligibility[slot].includes(ratings[id].position));
    eligible.sort((a, b) => ratings[b].fit - ratings[a].fit || a.localeCompare(b));
    if (eligible.length) { starters += ratings[eligible[0]].fit; remaining.delete(eligible[0]); }
  }
  // Value only the best backups; hoarding extra QBs/TEs is not a roster need.
  let bench = 0;
  for (const position of positions) {
    const backups = [...remaining].filter(id => ratings[id].position === position).sort((a, b) => ratings[b].fit - ratings[a].fit);
    bench += backups.slice(0, ['QB', 'TE'].includes(position) ? 1 : 2).reduce((sum, id) => sum + ratings[id].fit * .04, 0);
  }
  return [starters, starters + bench];
}

export function generate(league, rosters, users, players, weeks = [], rankings = null) {
  const ratings = playerRatings(players, rosters, rankings);
  const owners = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teams = rosters.map(r => {
    const owner = owners[r.owner_id] || {};
    return {id: r.roster_id, owner_id: r.owner_id || null, name: owner.metadata?.team_name || owner.display_name || `Team ${r.roster_id}`,
      manager: owner.display_name || 'Unclaimed', wins: r.settings?.wins || 0, losses: r.settings?.losses || 0, ties: r.settings?.ties || 0,
      players: [...(r.players || [])].sort(), reserve: r.reserve || []};
  }).sort((a, b) => a.id - b.id);
  const epoch = digest([ENGINE_VERSION, teams.map(t => [t.id, t.owner_id, t.players, t.reserve])]).slice(0, 16);
  const proposals = [];
  const tradable = t => t.players.filter(id => positions.has(ratings[id].position) && !t.reserve.includes(id) && ratings[id].ros_rank && ratings[id].value >= 5)
    .sort((a, b) => ratings[b].value - ratings[a].value || a.localeCompare(b)).slice(0, 12);
  for (const [a, b] of rankings ? combinations(teams) : []) {
    if (!a.owner_id || !b.owner_id) continue;
    const pa = tradable(a), pb = tradable(b);
    const ba = {1: pa.map(p => [p]), 2: combinations(pa)}, bb = {1: pb.map(p => [p]), 2: combinations(pb)};
    const beforeA = strength(a.players.filter(p => !a.reserve.includes(p)), ratings, league.roster_positions);
    const beforeB = strength(b.players.filter(p => !b.reserve.includes(p)), ratings, league.roster_positions);
    for (const [countA, countB] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      const accepted = [];
      for (const giveA of ba[countA]) for (const giveB of bb[countB]) {
        // Same-position shuffles have no modeled mutual roster benefit.
        if (giveA.map(p => ratings[p].position).sort().join() === giveB.map(p => ratings[p].position).sort().join()) continue;
        const sum = ids => ids.reduce((s, p) => s + ratings[p].value, 0);
        const rawA = sum(giveA), rawB = sum(giveB);
        // A manager consolidating two assets pays a premium for the single asset.
        const valueA = rawA / (countA > countB ? 1.12 : 1), valueB = rawB / (countB > countA ? 1.12 : 1);
        let gap = Math.abs(valueA - valueB) / Math.max(valueA, valueB);
        if (gap > .12) continue;
        if (countA !== countB) {
          const pack = countA === 2 ? giveA : giveB, single = countA === 2 ? giveB : giveA;
          if (Math.min(...pack.map(p => ratings[p].value)) < ratings[single[0]].value * .35 || Math.max(...pack.map(p => ratings[p].value)) < ratings[single[0]].value * .55) continue;
        }
        const idsA = new Set([...a.players.filter(p => !giveA.includes(p)), ...giveB]);
        const idsB = new Set([...b.players.filter(p => !giveB.includes(p)), ...giveA]);
        const drops = {[a.id]: [], [b.id]: []};
        let valid = true;
        for (const [team, ids, received] of [[a, idsA, giveB], [b, idsB, giveA]]) {
          const extra = Math.max(0, ids.size - team.players.length);
          const pool = [...ids].filter(p => !received.includes(p) && !team.reserve.includes(p) && ratings[p].ros_rank && positions.has(ratings[p].position))
            .sort((x, y) => ratings[x].value - ratings[y].value || x.localeCompare(y));
          if (pool.length < extra) { valid = false; break; }
          for (const p of pool.slice(0, extra)) { ids.delete(p); drops[team.id].push(p); }
        }
        if (!valid) continue;
        // Include the cost of opening a spot, rather than treating a drop as free.
        gap = Math.max(gap, Math.abs(valueB - valueA - sum(drops[a.id])) / Math.max(valueA, valueB), Math.abs(valueA - valueB - sum(drops[b.id])) / Math.max(valueA, valueB));
        if (gap > .12) continue;
        const afterA = strength([...idsA].filter(p => !a.reserve.includes(p)), ratings, league.roster_positions);
        const afterB = strength([...idsB].filter(p => !b.reserve.includes(p)), ratings, league.roster_positions);
        const gainA = afterA[1] - beforeA[1], gainB = afterB[1] - beforeB[1];
        // Both rosters must improve, with no loss to either starting lineup.
        if (Math.min(gainA, gainB) < .15 || Math.min(afterA[0] - beforeA[0], afterB[0] - beforeB[0]) < -.01 || gainA + gainB < 1) continue;
        if (countA !== countB) {
          const recipient = countA === 2 ? b : a, pack = countA === 2 ? giveA : giveB;
          const after = countA === 2 ? idsB : idsA;
          const total = strength([...after].filter(p => !recipient.reserve.includes(p)), ratings, league.roster_positions)[0];
          // Each package piece must contribute to the recipient's best lineup.
          if (pack.some(p => total - strength([...after].filter(id => id !== p && !recipient.reserve.includes(id)), ratings, league.roster_positions)[0] < .3)) continue;
        }
        const id = digest([league.league_id, league.season, epoch, a.id, b.id, [...giveA].sort(), [...giveB].sort()]).slice(0, 24);
        accepted.push({id, a: a.id, b: b.id, give_a: [...giveA].sort(), give_b: [...giveB].sort(), value_a: round(valueA), value_b: round(valueB),
          gap: Math.round(gap * 100), kind: `${Math.min(countA, countB)}-for-${Math.max(countA, countB)}`, drops,
          score: round((1 - gap) * 6 + Math.min(gainA, gainB) * 2 + gainA + gainB, 2),
          starter_gain: {[a.id]: round(afterA[0] - beforeA[0]), [b.id]: round(afterB[0] - beforeB[0])}, fit_gain: {[a.id]: round(gainA), [b.id]: round(gainB)}});
      }
      const used = {}, selected = [];
      for (const p of accepted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
        if ([...p.give_a, ...p.give_b].some(id => (used[id] || 0) >= 2)) continue;
        selected.push(p);
        for (const id of [...p.give_a, ...p.give_b]) used[id] = (used[id] || 0) + 1;
        if (selected.length === 4) break;
      }
      proposals.push(...selected);
    }
  }
  return {league: Object.fromEntries(['league_id', 'name', 'season', 'total_rosters'].map(k => [k, league[k]])),
    scoring: league.scoring_settings?.rec === .5 ? 'Half PPR' : `${league.scoring_settings?.rec || 0} PPR`,
    teams, players: ratings, proposals, epoch, engine_version: ENGINE_VERSION,
    recommendations: rankings ? {source: rankings.source, type: rankings.type, scoring: rankings.scoring, fetched_at: rankings.fetched_at, published_at: rankings.published_at, coverage: rankings.coverage, status: 'ready'} : {source: null, status: 'unavailable'},
    completed_weeks: weeks.length, updated_at: new Date().toISOString()};
}
