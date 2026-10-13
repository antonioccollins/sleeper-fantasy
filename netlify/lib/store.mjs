import { getStore } from '@netlify/blobs';

export const leagueID = process.env.SLEEPER_LEAGUE_ID || '1314338659381575680';
export const prefix = `league/${leagueID}`;
export const getStorage = () => getStore({name: process.env.TRADE_MATCH_STORE || 'trade-match-v1', consistency: 'strong'});

export async function readVersioned(store, key) {
  const current = await store.getWithMetadata(key, {type: 'json'});
  if (!current || current.etag) return current;
  // The SDK's local emulator omits ETags on GET/HEAD but includes them in lists.
  // Read between matching listed versions; never attach a newer ETag to old data.
  const version = async () => (await store.list({prefix: key})).blobs.find(blob => blob.key === key)?.etag;
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await version();
    const data = await store.get(key, {type: 'json'});
    const after = await version();
    if (!before && !after && data === null) return null;
    if (before && before === after) return {data, etag: after};
  }
  throw new Error('Storage could not provide a stable version for an atomic update.');
}

// CAS makes a read/modify/write indivisible across concurrent function instances.
// SDK returns modified:false for a stale ETag, so retry with the latest object.
export async function mutate(store, key, initial, change) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await readVersioned(store, key);
    if (current && !current.etag) throw new Error('Storage did not provide an ETag for an atomic update.');
    const value = structuredClone(current?.data ?? initial());
    const result = await change(value);
    const written = await store.setJSON(key, value, current ? {onlyIfMatch: current.etag} : {onlyIfNew: true});
    if (written.modified) {
      if (!written.etag) throw new Error('Storage did not confirm the atomic write.');
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 150)));
  }
  const error = new Error('The league is busy. Please try your swipe again.');
  error.status = 409;
  error.public = true;
  throw error;
}
