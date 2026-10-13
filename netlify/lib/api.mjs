import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStorage, leagueID, prefix, mutate } from './store.mjs';
import { getModel } from './league.mjs';

class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const stale = model => !Number.isFinite(Date.parse(model.updated_at)) || Date.now() - Date.parse(model.updated_at) > 3600000;
const emptyLedger = model => ({epoch: model.epoch, model_updated_at: model.updated_at, votes: {}, matches: {}});
const ledgerKey = `${prefix}/ledger`;
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
}});

async function secret(store) {
  const key = `${prefix}/session-secret`;
  let value = await store.get(key, {type: 'json'});
  if (!value) {
    await store.setJSON(key, randomBytes(32).toString('hex'), {onlyIfNew: true});
    value = await store.get(key, {type: 'json'});
  }
  return value;
}
function sign(team, key) {
  const payload = Buffer.from(JSON.stringify({team, league: leagueID, expires: Date.now() + 2592000000})).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
}
async function session(request, model, store) {
  const cookie = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('trade_session='));
  if (!cookie) return null;
  try {
    const [payload, signature] = cookie.slice('trade_session='.length).split('.');
    if (!payload || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
    const expected = createHmac('sha256', await secret(store)).update(payload).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (decoded.league !== leagueID || !Number.isFinite(decoded.expires) || decoded.expires < Date.now()) return null;
    return model.teams.find(t => t.id === decoded.team && t.owner_id) || null;
  } catch { return null; }
}
async function body(request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 4096) throw new APIError(413, 'Request is too large.');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new APIError(400, 'Invalid request.'); }
}
function decorate(p, team, model) {
  const isA = p.a === team.id;
  const partnerID = isA ? p.b : p.a;
  const partner = model.teams.find(t => t.id === partnerID) || p._teams.find(t => t.id === partnerID);
  const players = {...p._players, ...model.players};
  return {id: p.id, partner: {id: partner.id, name: partner.name, manager: partner.manager},
    give: (isA ? p.give_a : p.give_b).map(id => players[id]), receive: (isA ? p.give_b : p.give_a).map(id => players[id]),
    give_value: isA ? p.value_a : p.value_b, receive_value: isA ? p.value_b : p.value_a,
    gap: p.gap, kind: p.kind, starter_gain: p.starter_gain[team.id], partner_starter_gain: p.starter_gain[partnerID],
    drops: p.drops[team.id].map(id => players[id]), partner_drops: p.drops[partnerID].map(id => players[id])};
}
function snapshot(proposal, model) {
  const ids = new Set([...proposal.give_a, ...proposal.give_b, ...Object.values(proposal.drops).flat()]);
  return {...proposal, _players: Object.fromEntries([...ids].map(id => [id, model.players[id]])),
    _teams: model.teams.filter(t => [proposal.a, proposal.b].includes(t.id)).map(t => ({id: t.id, name: t.name, manager: t.manager}))};
}

export function createHandler({storage = getStorage, loadModel = getModel} = {}) {
  return async request => {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (!['GET', 'POST', 'DELETE'].includes(method)) throw new APIError(405, 'Method not allowed.');
      if (method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) throw new APIError(403, 'Requests must come from this website.');
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new APIError(415, 'Use a JSON request.');
      }
      const store = storage();
      const model = await loadModel(store);
      if (path === '/health' && method === 'GET') return response({status: 'ok', league: model.league.name, updated_at: model.updated_at, stale: stale(model)});
      const team = await session(request, model, store);
      if (path === '/api/bootstrap' && method === 'GET') return response({league: model.league, scoring: model.scoring, teams: model.teams,
        players: model.players, team, updated_at: model.updated_at, stale: stale(model), completed_weeks: model.completed_weeks, epoch: model.epoch});
      if (path === '/api/session' && method === 'POST') {
        const data = await body(request);
        const selected = Number.isInteger(data.team_id) && model.teams.find(t => t.id === data.team_id && t.owner_id);
        if (!selected) throw new APIError(400, 'Choose a team in this league.');
        return response({team: selected}, 200, {'Set-Cookie': `trade_session=${sign(selected.id, await secret(store))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${url.protocol === 'https:' ? '; Secure' : ''}`});
      }
      if (path === '/api/session' && method === 'DELETE') return response({ok: true}, 200, {'Set-Cookie': 'trade_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});
      if (!team) throw new APIError(401, 'Choose your team to continue.');
      const ledger = await store.get(ledgerKey, {type: 'json'}) || emptyLedger(model);
      const votes = ledger.epoch === model.epoch ? ledger.votes : {};
      if (path === '/api/deck' && method === 'GET') {
        const kind = url.searchParams.get('kind') || 'all';
        const buckets = new Map();
        for (const p of [...model.proposals].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
          if (![p.a, p.b].includes(team.id) || votes[p.id]?.[team.id] || ledger.matches[p.id] || (kind !== 'all' && p.kind !== kind)) continue;
          const partner = p.a === team.id ? p.b : p.a;
          if (!buckets.has(partner)) buckets.set(partner, []);
          buckets.get(partner).push(p);
        }
        const ordered = [], keys = [...buckets.keys()].sort((a, b) => a - b);
        while ([...buckets.values()].some(bucket => bucket.length)) {
          for (const key of keys) if (buckets.get(key).length) ordered.push(buckets.get(key).shift());
        }
        return response({proposals: ordered.map(p => decorate(p, team, model)), stale: stale(model)});
      }
      const modify = change => mutate(store, ledgerKey, () => emptyLedger(model), value => {
        if (value.epoch !== model.epoch && Date.parse(value.model_updated_at || 0) > Date.parse(model.updated_at)) {
          throw new APIError(409, 'League data changed. Refresh your deck before voting.');
        }
        if (value.epoch !== model.epoch) {value.epoch = model.epoch; value.votes = {};}
        if (!value.model_updated_at || Date.parse(value.model_updated_at) < Date.parse(model.updated_at)) value.model_updated_at = model.updated_at;
        return change(value);
      });
      if (path === '/api/votes' && method === 'POST') {
        if (stale(model)) throw new APIError(503, 'Roster updates are delayed. Voting is paused until Sleeper reconnects.');
        const data = await body(request);
        if (!['like', 'pass'].includes(data.decision)) throw new APIError(400, 'Choose like or pass.');
        const p = model.proposals.find(p => p.id === data.proposal_id && [p.a, p.b].includes(team.id));
        if (!p) throw new APIError(409, 'This trade is no longer available. Refresh your deck.');
        const result = await modify(value => {
          if (value.matches[p.id]) throw new APIError(409, 'This trade is already a match. Find it in your matches.');
          const now = new Date().toISOString();
          (value.votes[p.id] ||= {})[team.id] = {decision: data.decision, updated_at: now};
          const matched = [p.a, p.b].every(id => value.votes[p.id][id]?.decision === 'like');
          if (matched) value.matches[p.id] = {epoch: model.epoch, created_at: now, proposal: snapshot(p, model), seen: {}};
          return {ok: true, matched, ...(matched ? {match: {...decorate(p, team, model), created_at: now, available: true, unread: true}} : {})};
        });
        return response(result);
      }
      if (path.startsWith('/api/votes/') && method === 'DELETE') {
        const id = path.slice('/api/votes/'.length);
        const p = model.proposals.find(p => p.id === id && [p.a, p.b].includes(team.id));
        const previous = ledger.matches[id]?.proposal;
        if (!p && (!previous || ![previous.a, previous.b].includes(team.id))) throw new APIError(404, 'Trade not found.');
        await modify(value => {
          if (value.matches[id]) throw new APIError(409, 'Both managers liked this trade, so it is already a match.');
          if (value.votes[id]) delete value.votes[id][team.id];
        });
        return response({ok: true});
      }
      if (path === '/api/matches' && method === 'GET') {
        const items = Object.values(ledger.matches).filter(m => [m.proposal.a, m.proposal.b].includes(team.id)).map(m => ({
          ...decorate(m.proposal, team, model), created_at: m.created_at, unread: !m.seen[team.id],
          available: m.epoch === model.epoch && model.proposals.some(p => p.id === m.proposal.id),
        })).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return response({items});
      }
      if (path === '/api/likes' && method === 'GET') {
        const items = model.proposals.filter(p => votes[p.id]?.[team.id]?.decision === 'like' && !ledger.matches[p.id])
          .map(p => ({...decorate(p, team, model), created_at: votes[p.id][team.id].updated_at, available: true, unread: false}))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return response({items});
      }
      if (path.startsWith('/api/matches/') && method === 'POST') {
        await body(request);
        const id = path.slice('/api/matches/'.length);
        await modify(value => {
          const match = value.matches[id];
          if (!match || ![match.proposal.a, match.proposal.b].includes(team.id)) throw new APIError(404, 'Match not found.');
          match.seen[team.id] = true;
        });
        return response({ok: true});
      }
      throw new APIError(404, 'Not found.');
    } catch (error) {
      const publicError = error instanceof APIError || error.public === true;
      if (!publicError) console.error('Trade Match request failed:', error.name);
      return response({error: publicError ? error.message : 'Could not connect to league storage. Please try again.'}, publicError ? error.status : 503);
    }
  };
}
