import { refreshLeague } from '../lib/league.mjs';

export default async () => {
  const model = await refreshLeague();
  return new Response(JSON.stringify({updated_at: model.updated_at, proposals: model.proposals.length}), {headers: {'Content-Type': 'application/json'}});
};
export const config = {schedule: '*/15 * * * *'};
