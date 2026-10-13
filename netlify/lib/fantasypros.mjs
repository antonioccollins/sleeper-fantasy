// FantasyPros Public API v2. Credentials never enter stored/public data.
const base = 'https://api.fantasypros.com/public/v2/json';
const positions = new Set(['QB', 'RB', 'WR', 'TE']);
export const RANK_CACHE_MS = 6 * 3600000;
export const RANK_MAX_AGE_MS = 36 * 3600000;
const MAX_PUBLICATION_AGE_MS = 7 * 86400000;
export class RankingsError extends Error {
  constructor(reason) { super('FantasyPros rankings unavailable.'); this.reason = reason; }
}
export function rankingFormat(league) {
  const rec = Number(league.scoring_settings?.rec || 0);
  if (![0, .5, 1].includes(rec) || league.roster_positions.includes('SUPER_FLEX') || league.roster_positions.filter(p => p === 'QB').length !== 1 || league.scoring_settings?.bonus_rec_te) {
    throw new RankingsError('unsupported_format');
  }
  return rec === .5 ? 'HALF' : rec === 1 ? 'PPR' : 'STD';
}
function publicationTime(data) {
  const ts = Number(data.last_updated_ts);
  return ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(data.last_updated);
}
export function parseRankings(data, season, scoring, position = 'ALL', now = Date.now()) {
  if (data?.sport?.toUpperCase() !== 'NFL' || String(data.year) !== String(season) || data.type?.toUpperCase() !== 'ROS' || data.scoring?.toUpperCase() !== scoring || data.position_id !== position || !Array.isArray(data.players)) {
    throw new RankingsError('incompatible_response');
  }
  const published = publicationTime(data);
  if (!Number.isFinite(published) || now - published > MAX_PUBLICATION_AGE_MS || published - now > 86400000) throw new RankingsError('outdated_rankings');
  const rows = data.players.filter(p => positions.has(p.player_position_id)).map(p => ({
    id: String(p.player_id), name: p.player_name, position: p.player_position_id,
    team: p.player_team_id, yahoo_id: String(p.player_yahoo_id || ''),
    rank: Number(p.rank_ecr), position_rank: Number(String(p.pos_rank || '').replace(/^[A-Z]+/, '')) || null,
  })).filter(p => p.name && /^\d+$/.test(p.id) && Number.isFinite(p.rank) && p.rank > 0);
  if (rows.length < (position === 'ALL' ? 50 : 12) || new Set(rows.map(p => p.id)).size !== rows.length) throw new RankingsError('incomplete_rankings');
  // Position ranks, when absent, are derived from the full list, never league rosters.
  for (const pos of positions) rows.filter(p => p.position === pos).sort((a, b) => a.rank - b.rank).forEach((p, i) => { p.position_rank ||= i + 1; });
  return {rows, published_at: new Date(published).toISOString()};
}
const normalized = name => String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]/g, '');
export function mapRankings(rows, players, rosters) {
  const index = (key) => {
    const map = new Map();
    for (const row of rows) { const value = key(row); if (value) map.set(value, [...(map.get(value) || []), row]); }
    return map;
  };
  const yahoo = index(p => p.yahoo_id), names = index(p => `${p.position}:${normalized(p.name)}`);
  const bySleeper = {};
  const ids = new Set(rosters.flatMap(r => r.players || []));
  for (const id of ids) {
    const p = players[id];
    if (!positions.has(p?.position)) continue;
    const linked = p.yahoo_id ? yahoo.get(String(p.yahoo_id)) : undefined;
    const candidates = linked || names.get(`${p.position}:${normalized(p.full_name || `${p.first_name} ${p.last_name}`)}`) || [];
    if (candidates.length === 1 && candidates[0].position === p.position) bySleeper[id] = candidates[0];
  }
  // An ambiguous provider identity must not be assigned to two Sleeper players.
  const counts = new Map();
  for (const row of Object.values(bySleeper)) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  for (const [id, row] of Object.entries(bySleeper)) if (counts.get(row.id) > 1) delete bySleeper[id];
  const eligible = [...ids].filter(id => positions.has(players[id]?.position));
  const coverage = eligible.length ? Object.keys(bySleeper).length / eligible.length : 0;
  if (coverage < .7 || [...positions].some(pos => eligible.some(id => players[id].position === pos) && !Object.values(bySleeper).some(p => p.position === pos))) throw new RankingsError('low_player_coverage');
  return {bySleeper, coverage: Math.round(coverage * 100)};
}
export async function getRankings(store, league, players, rosters, {apiKey = process.env.FANTASYPROS_API_KEY, fetcher = fetch, now = Date.now()} = {}) {
  if (!apiKey) throw new RankingsError('missing_key');
  const scoring = rankingFormat(league);
  const cacheKey = `fantasypros/v1/nfl/${league.season}/ROS/${scoring}`;
  const cached = await store.get(cacheKey, {type: 'json'});
  const valid = value => value?.season === String(league.season) && value?.scoring === scoring && Number.isFinite(value.fetched_at) && now - value.fetched_at <= RANK_MAX_AGE_MS && Number.isFinite(Date.parse(value.published_at)) && now - Date.parse(value.published_at) <= MAX_PUBLICATION_AGE_MS && Array.isArray(value.rows);
  let ranks = valid(cached) ? cached : null;
  if (!ranks || now - ranks.fetched_at > RANK_CACHE_MS) {
    // Persist a short cooldown: a denied/rate-limited account is not hit on every visit.
    const failureKey = `${cacheKey}/retry`;
    const failure = await store.get(failureKey, {type: 'json'});
    if (failure?.until > now) { if (!ranks) throw new RankingsError(failure.reason); }
    else try {
      const read = async position => {
        const url = new URL(`${base}/nfl/${league.season}/consensus-rankings`);
        url.search = new URLSearchParams({type: 'ROS', scoring, position}).toString();
        const response = await fetcher(url, {headers: {Accept: 'application/json', 'x-api-key': apiKey}, redirect: 'error', signal: AbortSignal.timeout(15000)});
        if (!response.ok) {
          const reason = response.status === 401 ? 'invalid_key' : response.status === 403 ? 'access_denied' : response.status === 429 ? 'rate_limited' : 'provider_unavailable';
          throw new RankingsError(reason);
        }
        return parseRankings(await response.json(), league.season, scoring, position, now);
      };
      const all = await read('ALL');
      if (all.rows.filter(p => p.position === 'QB').length < 12) {
        const qb = await read('QB');
        // Positional QB rankings supplement fit; ALL alone establishes market values.
        for (const row of all.rows.filter(p => p.position === 'QB')) row.position_rank = qb.rows.find(p => p.id === row.id)?.rank || row.position_rank;
        if (!all.rows.some(p => p.position === 'QB')) throw new RankingsError('incomplete_rankings');
      }
      mapRankings(all.rows, players, rosters);
      const next = {...all, season: String(league.season), scoring, fetched_at: now};
      await store.setJSON(cacheKey, next);
      ranks = next;
      await store.setJSON(failureKey, {until: 0});
    } catch (error) {
      const reason = error instanceof RankingsError ? error.reason : 'provider_unavailable';
      await store.setJSON(failureKey, {until: now + 15 * 60000, reason});
      if (!ranks) throw new RankingsError(reason);
    }
  }
  return {...mapRankings(ranks.rows, players, rosters), source: 'FantasyPros', type: 'ROS', scoring,
    fetched_at: new Date(ranks.fetched_at).toISOString(), published_at: ranks.published_at};
}
