import { json } from '../lib/shared.mjs';
import { listScores } from '../lib/store.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return json(204, {});
  }
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const scores = await listScores();
    return json(200, { scores });
  } catch (err) {
    return json(err.statusCode || 500, {
      error: err.message || 'Failed to load leaderboard.',
      detail: err.detail
    });
  }
};
