import { randomUUID } from 'node:crypto';
import { generate, ENGINE_VERSION } from './engine.mjs';
import { getRankings, RankingsError, RANKINGS_VERSION } from './fantasypros.mjs';
import { getStorage, leagueID, prefix, readVersioned } from './store.mjs';

async function read(path) {
  const response = await fetch(`https://api.sleeper.app/v1/${path}`, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status}`);
  return response.json();
}

export async function refreshLeague(store = getStorage()) {
  const modelKey = `${prefix}/model`;
  const current = await readVersioned(store, modelKey);
  if (current && fresh(current.data)) return current.data;
  // One refresh per league across instances; a crashed lease expires automatically.
  const leaseKey = `${prefix}/sync-lease`;
  const lease = await readVersioned(store, leaseKey);
  const token = randomUUID();
  let acquired = {modified: false};
  if (!lease || lease.data.until < Date.now()) {
    acquired = await store.setJSON(leaseKey, {token, until: Date.now() + 90000}, lease ? {onlyIfMatch: lease.etag} : {onlyIfNew: true});
    if (acquired.modified && !acquired.etag) throw new Error('Storage did not confirm the refresh lease.');
  }
  if (!acquired.modified) {
    if (current) return safePrevious(current.data);
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const model = await store.get(modelKey, {type: 'json'});
      if (model) return safePrevious(model);
    }
    const error = new Error('Your league is loading for the first time. Please refresh in a few seconds.');
    error.status = 503;
    error.public = true;
    throw error;
  }
  try {
    const league = await read(`league/${leagueID}`);
    if (!league?.league_id || league.sport !== 'nfl' || ![0, 1].includes(league.settings?.type)) throw new Error('An NFL redraft/keeper league is required.');
    const lastWeek = Math.min(Number(league.settings?.last_scored_leg || 0), 18);
    const playerKey = `${prefix}/players`;
    let cached = await store.get(playerKey, {type: 'json'});
    if (!cached || Date.now() - cached.saved_at > 86400000) {
      cached = {saved_at: Date.now(), players: await read('players/nfl')};
      await store.setJSON(playerKey, cached);
    }
    const data = await Promise.all([read(`league/${leagueID}/rosters`), read(`league/${leagueID}/users`)]);
    let rankings = null, reason = null, fields = [], counts = null;
    try { rankings = await getRankings(store, league, cached.players, data[0]); }
    catch (error) {
      if (!(error instanceof RankingsError)) throw error;
      reason = error.reason;
      fields = error.fields;
      counts = error.counts;
    }
    // Completed-week count is informational; past scores no longer price trades.
    const model = generate(league, data[0], data[1], cached.players, Array.from({length: lastWeek}, () => []), rankings);
    model.rankings_configured = Boolean(process.env.FANTASYPROS_API_KEY);
    model.rankings_version = RANKINGS_VERSION;
    if (reason) model.recommendations.reason = reason;
    if (fields.length) model.recommendations.fields = fields;
    if (counts) model.recommendations.counts = counts;
    const written = await store.setJSON(modelKey, model, current ? {onlyIfMatch: current.etag} : {onlyIfNew: true});
    if (written.modified && !written.etag) throw new Error('Storage did not confirm the league snapshot.');
    return written.modified ? model : await store.get(modelKey, {type: 'json'});
  } catch (error) {
    console.error('League refresh failed:', error.name);
    if (current) return safePrevious(current.data);
    const unavailable = new Error('Sleeper is unavailable. Please try again shortly.');
    unavailable.status = 503;
    unavailable.public = true;
    throw unavailable;
  } finally {
    await store.setJSON(leaseKey, {token, until: 0}, {onlyIfMatch: acquired.etag});
  }
}

export async function getModel(store = getStorage()) {
  const model = await store.get(`${prefix}/model`, {type: 'json'});
  if (!model || !fresh(model)) return refreshLeague(store);
  return model;
}

function fresh(model) {
  return model.engine_version === ENGINE_VERSION && model.teams?.every(t => Object.hasOwn(t, 'avatar')) && model.rankings_version === RANKINGS_VERSION && model.rankings_configured === Boolean(process.env.FANTASYPROS_API_KEY) && Date.now() - Date.parse(model.updated_at) < 900000;
}
function safePrevious(model) {
  // Never keep serving the retired scoring engine during a failed migration.
  return model.engine_version === ENGINE_VERSION ? model : {...model, proposals: [], recommendations: {source: null, status: 'unavailable', reason: 'awaiting_rankings'}};
}
