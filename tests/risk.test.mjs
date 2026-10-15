import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRisk, createRiskLoader } from '../netlify/lib/risk.mjs';
import { createHandler } from '../netlify/lib/api.mjs';
import { leagueID } from '../netlify/lib/store.mjs';

const league = {league_id: leagueID, sport: 'nfl', season: '2026', name: 'Risk league', settings: {waiver_type: 2, waiver_budget: 100}};
const rosters = [1, 2, 3].map(id => ({roster_id: id, owner_id: String(id)}));
const users = rosters.map(r => ({user_id: r.owner_id, display_name: `Team ${r.roster_id}`}));
const transaction = (id, type, fields = {}) => ({transaction_id: id, type, status: 'complete', status_updated: 100, roster_ids: [1], ...fields});
const waiver = (id, bid, fields = {}) => transaction(id, 'waiver', {adds: {p: 1}, drops: {q: 1}, settings: {waiver_bid: bid}, ...fields});
const team = (data, id) => data.teams.find(t => t.id === id);
class Store {
  value = null;
  writes = 0;
  async get() { return structuredClone(this.value); }
  async setJSON(key, value) { this.value = structuredClone(value); this.writes++; }
}
function reader(overrides = {}) {
  const paths = [];
  return {paths, read: async path => {
    paths.push(path);
    if (overrides[path]) return overrides[path]();
    if (path.endsWith('/rosters')) return rosters;
    if (path.endsWith('/users')) return users;
    if (path.includes('/transactions/')) return [];
    return league;
  }};
}

test('successful bids and completed moves only; add+drop and repeated IDs count once', () => {
  const win = waiver('win', 30);
  const result = calculateRisk(league, rosters, users, [win, win,
    waiver('failed', 99, {status: 'failed'}), waiver('pending', 80, {status: 'pending'}),
    waiver('zero', 0), transaction('drop', 'free_agent', {drops: {z: 1}}),
    transaction('noop', 'free_agent'), transaction('commissioner', 'commissioner', {adds: {z: 1}})]);
  const a = team(result, 1);
  assert.equal(a.moves, 3); assert.equal(a.waivers, 2); assert.equal(a.free_agents, 1);
  assert.equal(a.adds, 2); assert.equal(a.drops, 3); assert.equal(a.faab_spent, 30);
  assert.equal(a.biggest_bid, 30); assert.equal(a.score, 36);
  assert.equal(team(result, 2).score, 0);
  assert.equal(team(result, 2).rank, team(result, 3).rank);
});

test('trades credit all participants once, including pick-only and FAAB-only trades', () => {
  const result = calculateRisk(league, rosters, users, [
    transaction('trade', 'trade', {roster_ids: [1, 1, 2], adds: {a: 1, b: 2}, drops: {a: 2, b: 1}, waiver_budget: [{sender: 1, receiver: 2, amount: 20}]}),
    transaction('picks', 'trade', {roster_ids: [2, 3], draft_picks: [{owner_id: 3, previous_owner_id: 2}]}),
    transaction('cash', 'trade', {roster_ids: [1, 3], waiver_budget: [{sender: 1, receiver: 3, amount: 15}]}),
    transaction('pending', 'trade', {roster_ids: [1, 2], status: 'pending'}),
  ]);
  for (const t of result.teams) {
    assert.equal(t.trades, 2); assert.equal(t.moves, 0); assert.equal(t.faab_spent, 0);
    assert.equal(t.transactions, 2); assert.equal(t.score, 40); assert.equal(t.rank, 1);
  }
});

test('score is bounded, empty leagues score zero, non-FAAB leagues use adjusted weights', () => {
  const result = calculateRisk(league, rosters, users, [waiver('large', 200), transaction('trade', 'trade', {roster_ids: [1, 2]})]);
  assert.equal(team(result, 1).score, 100); assert.equal(team(result, 1).faab_spent, 200);
  assert.equal(team(result, 1).faab_percent, 200);
  assert.ok(calculateRisk(league, rosters, users, []).teams.every(t => t.score === 0 && t.rank === 1));
  const nonFAAB = calculateRisk({...league, settings: {waiver_type: 0}}, rosters, users, [waiver('move', 0), transaction('trade', 'trade', {roster_ids: [1, 2]})]);
  assert.deepEqual(nonFAAB.weights, {trades: 60, faab: 0, moves: 40});
  assert.equal(team(nonFAAB, 1).score, 100); assert.equal(team(nonFAAB, 2).score, 60);
});

test('later transaction status wins and teams without owners remain visible', () => {
  const result = calculateRisk(league, rosters, [], [waiver('same', 10), waiver('same', 10, {status: 'failed', status_updated: 200})]);
  assert.equal(team(result, 1).moves, 0); assert.equal(team(result, 1).name, 'Team 1');
  assert.throws(() => calculateRisk(league, rosters, users, [null]));
});

test('fetches the whole season, caches, and coalesces concurrent requests', async () => {
  const store = new Store(), source = reader();
  let now = Date.UTC(2026, 9, 15);
  const load = createRiskLoader({...source, now: () => now});
  const [first, second] = await Promise.all([load(store), load(store)]);
  assert.deepEqual(first, second); assert.equal(source.paths.length, 22); assert.equal(store.writes, 1);
  assert.equal(source.paths.filter(p => p.includes('/transactions/')).length, 19);
  assert.ok(source.paths.some(p => p.endsWith('/transactions/0')));
  assert.ok(source.paths.some(p => p.endsWith('/transactions/18')));
  await load(store); assert.equal(source.paths.length, 22);
  now += 900001;
  await load(store); assert.equal(source.paths.length, 44);
});

test('a missing week preserves old data with original time; no cache yields unavailable, never zeros', async () => {
  const now = Date.UTC(2026, 9, 15), store = new Store();
  store.value = calculateRisk(league, rosters, users, [waiver('win', 25)], now - 900001);
  const original = structuredClone(store.value);
  const source = reader({[`league/${leagueID}/transactions/3`]: () => { throw new Error('offline'); }});
  const load = createRiskLoader({...source, now: () => now});
  const old = await load(store);
  assert.equal(old.stale, true); assert.equal(old.updated_at, original.updated_at);
  assert.equal(team(old, 1).faab_spent, 25); assert.equal(store.writes, 0);
  store.value = null;
  await assert.rejects(load(store), error => error.status === 503 && error.public);
  const invalid = createRiskLoader({...reader({[`league/${leagueID}/transactions/2`]: () => ({error: 'bad data'})})});
  await assert.rejects(invalid(store), error => error.status === 503);
});

test('risk API works independently of rankings, sessions, and trade ledger', async () => {
  const store = new Store();
  const payload = calculateRisk(league, rosters, users, []);
  const handler = createHandler({storage: () => store,
    loadModel: () => { throw new Error('Rankings unavailable'); }, loadRisk: async () => payload});
  const result = await handler(new Request('https://test.local/api/risk'));
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), payload);
  assert.equal(store.writes, 0);
  const unavailable = createHandler({storage: () => store, loadRisk: createRiskLoader({read: () => { throw new Error('offline'); }})});
  const failure = await unavailable(new Request('https://test.local/api/risk'));
  assert.equal(failure.status, 503); assert.match((await failure.json()).error, /Sleeper activity/);
});
