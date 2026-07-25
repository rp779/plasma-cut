'use strict';

var shared = require('./shared');
var RATE_LIMIT_MS = 5000;

async function listScores(event) {
  var cfg = shared.supabaseConfig();
  if (cfg) return listSupabase(cfg);
  return listBlobs(event);
}

async function upsertScore(nickname, score, level, event) {
  var cfg = shared.supabaseConfig();
  if (cfg) return upsertSupabase(cfg, nickname, score, level);
  return upsertBlobs(nickname, score, level, event);
}

async function listSupabase(cfg) {
  var url = cfg.url + '/rest/v1/scores?select=nickname,score,level,updated_at&order=score.desc&limit=50';
  var res = await fetch(url, { headers: shared.supabaseHeaders(cfg.key) });
  if (!res.ok) {
    var text = await res.text();
    var err = new Error('Failed to load leaderboard.');
    err.statusCode = 502;
    err.detail = text;
    throw err;
  }
  return res.json();
}

async function upsertSupabase(cfg, nickname, score, level) {
  var getUrl = cfg.url + '/rest/v1/scores?nickname=eq.' + encodeURIComponent(nickname) +
    '&select=nickname,score,level,updated_at';
  var existingRes = await fetch(getUrl, { headers: shared.supabaseHeaders(cfg.key) });
  if (!existingRes.ok) {
    var existingErr = await existingRes.text();
    var err = new Error('Failed to check existing score.');
    err.statusCode = 502;
    err.detail = existingErr;
    throw err;
  }
  var existingRows = await existingRes.json();
  var existing = existingRows[0];

  if (existing) {
    var updatedAt = Date.parse(existing.updated_at);
    if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < RATE_LIMIT_MS) {
      var rateErr = new Error('Slow down — try again in a few seconds.');
      rateErr.statusCode = 429;
      throw rateErr;
    }
    if (existing.score >= score) {
      return { updated: false, entry: existing };
    }
  }

  var payload = {
    nickname: nickname,
    score: score,
    level: level,
    updated_at: new Date().toISOString()
  };

  var writeRes = await fetch(cfg.url + '/rest/v1/scores', {
    method: 'POST',
    headers: shared.supabaseHeaders(cfg.key, {
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify(payload)
  });

  if (!writeRes.ok) {
    var writeErr = await writeRes.text();
    var writeError = new Error('Failed to save score.');
    writeError.statusCode = 502;
    writeError.detail = writeErr;
    throw writeError;
  }

  var saved = await writeRes.json();
  return { updated: true, entry: Array.isArray(saved) ? saved[0] : saved };
}

async function getBlobStore(event) {
  var blobs = await import('@netlify/blobs');
  if (typeof blobs.connectLambda === 'function' && event) {
    blobs.connectLambda(event);
  }
  return blobs.getStore('plasma-cut-scores');
}

async function readBlobMap(store) {
  var data = await store.get('all', { type: 'json', consistency: 'strong' });
  return data && data.scores ? data.scores : {};
}

async function listBlobs(event) {
  var store = await getBlobStore(event);
  var map = await readBlobMap(store);
  return Object.keys(map)
    .map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.score - a.score || a.nickname.localeCompare(b.nickname); })
    .slice(0, 50);
}

async function upsertBlobs(nickname, score, level, event) {
  var store = await getBlobStore(event);
  var map = await readBlobMap(store);
  var key = nickname.toLowerCase();
  var existing = map[key];

  if (existing) {
    var updatedAt = Date.parse(existing.updated_at);
    if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < RATE_LIMIT_MS) {
      var rateErr = new Error('Slow down — try again in a few seconds.');
      rateErr.statusCode = 429;
      throw rateErr;
    }
    if (existing.score >= score) {
      return { updated: false, entry: existing };
    }
  }

  var entry = {
    nickname: nickname,
    score: score,
    level: level,
    updated_at: new Date().toISOString()
  };
  map[key] = entry;
  await store.setJSON('all', { scores: map });
  return { updated: true, entry: entry };
}

module.exports = {
  listScores: listScores,
  upsertScore: upsertScore
};
