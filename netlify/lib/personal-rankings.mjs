import { createHash, randomUUID } from 'node:crypto';
import { prefix, mutate } from './store.mjs';

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const RANKING_LIMIT = 40;
const keyFor = model => `${prefix}/personal-rankings/v1/${model.league.season}`;
const fail = (status, message) => Object.assign(new Error(message), {status, public: true});
const own = (data, team) => data.teams?.[team.id]?.owner_id === team.owner_id ? data.teams[team.id] : {owner_id: team.owner_id, positions: {}, seen: {}};
const read = async (store, model) => await store.get(keyFor(model), {type: 'json'}) || {teams: {}};
const rosterStale = model => !Number.isFinite(Date.parse(model.updated_at)) || Date.now() - Date.parse(model.updated_at) > 3600000;

export async function playerCatalog(store, model) {
  const raw = (await store.get(`${prefix}/players`, {type: 'json'}))?.players || {};
  const ids = new Set([...Object.keys(raw), ...Object.keys(model.players)]);
  return [...ids].flatMap(id => {
    const source = raw[id] || {}, rated = model.players[id];
    const position = rated?.position || source.position;
    if (!POSITIONS.includes(position) || (!rated && (!source.team || source.active === false))) return [];
    const name = rated?.name || source.full_name || [source.first_name, source.last_name].filter(Boolean).join(' ') || id;
    return [{id, name, position, nfl_team: rated?.nfl_team || source.team || 'FA', injury: rated?.injury || source.injury_status || null,
      suggested_order: rated?.position_rank || (Number(source.search_rank) > 0 ? 1000 + Number(source.search_rank) : 100000)}];
  }).sort((a, b) => a.suggested_order - b.suggested_order || a.name.localeCompare(b.name));
}

export async function getPersonalRankings(store, model, team) {
  const [data, players] = await Promise.all([read(store, model), playerCatalog(store, model)]);
  return {season: model.league.season, positions: POSITIONS, limit: RANKING_LIMIT, players, lists: own(data, team).positions};
}

export async function savePersonalRankings(store, model, team, input) {
  if (!POSITIONS.includes(input.position) || !Array.isArray(input.ids) || input.ids.length > RANKING_LIMIT ||
      input.ids.some(id => typeof id !== 'string') || new Set(input.ids).size !== input.ids.length ||
      !(input.revision === null || typeof input.revision === 'string')) throw fail(400, `Choose up to ${RANKING_LIMIT} different players at one position.`);
  const players = new Map((await playerCatalog(store, model)).map(p => [p.id, p]));
  if (input.ids.some(id => players.get(id)?.position !== input.position)) throw fail(400, 'Every player must belong to the selected position.');
  return mutate(store, keyFor(model), () => ({teams: {}}), data => {
    const selected = own(data, team);
    const current = selected.positions[input.position];
    if ((current?.revision || null) !== input.revision) throw fail(409, 'These rankings changed in another session. Reload saved rankings before saving again.');
    const saved = {ids: [...input.ids], revision: randomUUID(), updated_at: new Date().toISOString()};
    selected.positions[input.position] = saved;
    data.teams[team.id] = selected;
    return {position: input.position, list: saved};
  });
}

export function findOpportunities(data, model, team) {
  if (rosterStale(model)) return {items: [], stale: true};
  const mine = own(data, team), players = model.players;
  const owners = new Map();
  for (const t of model.teams) for (const id of t.players) owners.set(id, owners.has(id) ? null : t.id);
  const items = [];
  for (const other of model.teams) {
    if (other.id === team.id || !other.owner_id) continue;
    const theirs = own(data, other);
    for (const position of POSITIONS) {
      const myIDs = mine.positions[position]?.ids || [], theirIDs = theirs.positions[position]?.ids || [];
      const myRanks = new Map(myIDs.map((id, i) => [id, i + 1]));
      const theirRanks = new Map(theirIDs.map((id, i) => [id, i + 1]));
      const eligible = id => players[id]?.position === position && myRanks.has(id) && theirRanks.has(id);
      for (const give of team.players.filter(id => owners.get(id) === team.id && eligible(id))) {
        for (const receive of other.players.filter(id => owners.get(id) === other.id && eligible(id))) {
          if (myRanks.get(receive) >= myRanks.get(give) || theirRanks.get(give) >= theirRanks.get(receive)) continue;
          const sides = [[team.id, team.owner_id, give], [other.id, other.owner_id, receive]].sort((a, b) => a[0] - b[0]);
          const id = createHash('sha256').update(JSON.stringify([model.league.season, position, sides])).digest('hex').slice(0, 24);
          items.push({id, position, partner: {id: other.id, name: other.name, avatar: other.avatar}, give: players[give], receive: players[receive],
            your_ranks: {give: myRanks.get(give), receive: myRanks.get(receive)},
            partner_ranks: {give: theirRanks.get(give), receive: theirRanks.get(receive)}, unread: !mine.seen[id]});
        }
      }
    }
  }
  items.sort((a, b) => (b.your_ranks.give - b.your_ranks.receive + b.partner_ranks.receive - b.partner_ranks.give) -
    (a.your_ranks.give - a.your_ranks.receive + a.partner_ranks.receive - a.partner_ranks.give) || a.id.localeCompare(b.id));
  return {items, stale: false};
}

export async function getOpportunities(store, model, team) {
  return findOpportunities(await read(store, model), model, team);
}

export async function seeOpportunities(store, model, team, input) {
  if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string')) throw fail(400, 'Invalid opportunities.');
  return mutate(store, keyFor(model), () => ({teams: {}}), data => {
    const selected = own(data, team);
    const current = new Set(findOpportunities(data, model, team).items.map(item => item.id));
    for (const id of input.ids) if (current.has(id)) selected.seen[id] = Date.now();
    selected.seen = Object.fromEntries(Object.entries(selected.seen).sort((a, b) => b[1] - a[1]).slice(0, 500));
    data.teams[team.id] = selected;
    return {ok: true};
  });
}
