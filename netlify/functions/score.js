import { json, validateScorePayload } from '../lib/shared.mjs';
import { upsertScore } from '../lib/store.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return json(204, {});
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const parsed = validateScorePayload(body);
  if (parsed.error) {
    return json(400, { error: parsed.error });
  }

  try {
    const result = await upsertScore(parsed.nickname, parsed.score, parsed.level);
    return json(200, {
      ok: true,
      updated: result.updated,
      message: result.updated ? undefined : 'Existing best is higher or equal.',
      entry: result.entry
    });
  } catch (err) {
    return json(err.statusCode || 500, {
      error: err.message || 'Failed to save score.',
      detail: err.detail
    });
  }
};
