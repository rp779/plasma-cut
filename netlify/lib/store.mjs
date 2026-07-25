import { getStore } from '@netlify/blobs';
import { supabaseConfig, supabaseHeaders } from './shared.mjs';

const RATE_LIMIT_MS = 5000;

export async function listScores() {
  const cfg = supabaseConfig();
  if (cfg) return listSupabase(cfg);
  return listBlobs();
}

export async function upsertScore(nickname, score, level) {
  const cfg = supabaseConfig();
  if (cfg) return upsertSupabase(cfg, nickname, score, level);
  return upsertBlobs(nickname, score, level);
}

async function listSupabase(cfg) {
  const url = cfg.url + '/rest/v1/scores?select=nickname,score,level,updated_at&order=score.desc&limit=50';
  const res = await fetch(url, { headers: supabaseHeaders(cfg.key) });
  if (!res.ok) {
    const err = new Error('Failed to load leaderboard.');
    err.statusCode = 502;
    err.detail = await res.text();
    throw err;
  }
  return res.json();
}

async function upsertSupabase(cfg, nickname, score, level) {
  const getUrl = cfg.url + '/rest/v1/scores?nickname=eq.' + encodeURIComponent(nickname) +
    '&select=nickname,score,level,updated_at';
  const existingRes = await fetch(getUrl, { headers: supabaseHeaders(cfg.key) });
  if (!existingRes.ok) {
    const err = new Error('Failed to check existing score.');
    err.statusCode = 502;
    err.detail = await existingRes.text();
    throw err;
  }
  const existing = (await existingRes.json())[0];

  if (existing) {
    const updatedAt = Date.parse(existing.updated_at);
    if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < RATE_LIMIT_MS) {
      const rateErr = new Error('Slow down — try again in a few seconds.');
      rateErr.statusCode = 429;
      throw rateErr;
    }
    if (existing.score >= score) {
      return { updated: false, entry: existing };
    }
  }

  const payload = {
    nickname,
    score,
    level,
    updated_at: new Date().toISOString()
  };

  const writeRes = await fetch(cfg.url + '/rest/v1/scores', {
    method: 'POST',
    headers: supabaseHeaders(cfg.key, {
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify(payload)
  });

  if (!writeRes.ok) {
    const writeError = new Error('Failed to save score.');
    writeError.statusCode = 502;
    writeError.detail = await writeRes.text();
    throw writeError;
  }

  const saved = await writeRes.json();
  return { updated: true, entry: Array.isArray(saved) ? saved[0] : saved };
}

function nickKey(nickname) {
  return 'nick:' + nickname.toLowerCase();
}

async function listBlobs() {
  const store = getStore('plasma-cut-scores');
  const readOpts = { type: 'json', consistency: 'strong' };

  let index = await store.get('board', readOpts);
  if (!Array.isArray(index)) {
    index = [];
    // migrate legacy shapes
    const legacyAll = await store.get('all', { type: 'json' });
    if (legacyAll && legacyAll.scores) {
      index = Object.values(legacyAll.scores).filter((e) => e && typeof e.score === 'number');
    }
    const listed = await store.list();
    const blobs = listed?.blobs || [];
    for (const b of blobs) {
      if (!b.key.startsWith('nick:')) continue;
      const row = await store.get(b.key, { type: 'json' });
      if (row && typeof row.score === 'number' && !index.some((e) => e.nickname === row.nickname)) {
        index.push(row);
      }
    }
    if (index.length) await store.setJSON('board', index);
  }

  return index
    .slice()
    .sort((a, b) => b.score - a.score || String(a.nickname).localeCompare(String(b.nickname)))
    .slice(0, 50);
}

async function upsertBlobs(nickname, score, level) {
  const store = getStore('plasma-cut-scores');
  const readOpts = { type: 'json', consistency: 'strong' };
  let board = await store.get('board', readOpts);
  if (!Array.isArray(board)) board = await listBlobs();

  const existing = board.find((e) => e.nickname.toLowerCase() === nickname.toLowerCase());
  if (existing) {
    const updatedAt = Date.parse(existing.updated_at);
    if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < RATE_LIMIT_MS) {
      const rateErr = new Error('Slow down — try again in a few seconds.');
      rateErr.statusCode = 429;
      throw rateErr;
    }
    if (existing.score >= score) {
      return { updated: false, entry: existing };
    }
  }

  const entry = {
    nickname,
    score,
    level,
    updated_at: new Date().toISOString()
  };

  board = board.filter((e) => e.nickname.toLowerCase() !== nickname.toLowerCase());
  board.push(entry);
  await store.setJSON('board', board);
  await store.setJSON(nickKey(nickname), entry);
  return { updated: true, entry };
}
