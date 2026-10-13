import { randomUUID } from 'node:crypto';
import { generate } from './engine.mjs';
import { getStorage, leagueID, prefix, readVersioned } from './store.mjs';

async function read(path) {
  const response = await fetch(`https://api.sleeper.app/v1/${path}`, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status}`);
  return response.json();
}

export async function refreshLeague(store = getStorage()) {
  const modelKey = `${prefix}/model`;
  const current = await readVersioned(store, modelKey);
  if (current && Date.now() - Date.parse(current.data.updated_at) < 900000) return current.data;
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
    if (current) return current.data;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const model = await store.get(modelKey, {type: 'json'});
      if (model) return model;
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
    const paths = [`league/${leagueID}/rosters`, `league/${leagueID}/users`, ...Array.from({length: lastWeek}, (_, i) => `league/${leagueID}/matchups/${i + 1}`)];
    const data = [];
    for (let i = 0; i < paths.length; i += 4) data.push(...await Promise.all(paths.slice(i, i + 4).map(read)));
    const model = generate(league, data[0], data[1], cached.players, data.slice(2));
    const written = await store.setJSON(modelKey, model, current ? {onlyIfMatch: current.etag} : {onlyIfNew: true});
    if (written.modified && !written.etag) throw new Error('Storage did not confirm the league snapshot.');
    return written.modified ? model : await store.get(modelKey, {type: 'json'});
  } catch (error) {
    console.error('Sleeper refresh failed:', error.name);
    if (current) return current.data;
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
  if (!model || Date.now() - Date.parse(model.updated_at) > 900000) return refreshLeague(store);
  return model;
}
