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

function nickKey(nickname) {
  return 'nick:' + nickname.toLowerCase();
}

async function listBlobs(event) {
  var store = await getBlobStore(event);
  var listed = await store.list();
  var keys = (listed && listed.blobs ? listed.blobs : [])
    .map(function (b) { return b.key; })
    .filter(function (k) { return k.indexOf('nick:') === 0; });

  // Migrate legacy single-document store if present
  if (!keys.length) {
    var legacy = await store.get('all', { type: 'json' });
    if (legacy && legacy.scores) {
      var legacyKeys = Object.keys(legacy.scores);
      for (var i = 0; i < legacyKeys.length; i++) {
        var entry = legacy.scores[legacyKeys[i]];
        if (entry && entry.nickname) {
          await store.setJSON(nickKey(entry.nickname), entry);
          keys.push(nickKey(entry.nickname));
        }
      }
    }
  }

  var rows = [];
  for (var j = 0; j < keys.length; j++) {
    var row = await store.get(keys[j], { type: 'json' });
    if (row && typeof row.score === 'number') rows.push(row);
  }

  rows.sort(function (a, b) {
    return b.score - a.score || String(a.nickname).localeCompare(String(b.nickname));
  });
  return rows.slice(0, 50);
}

async function upsertBlobs(nickname, score, level, event) {
  var store = await getBlobStore(event);
  var key = nickKey(nickname);
  var existing = await store.get(key, { type: 'json' });

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
  await store.setJSON(key, entry);
  return { updated: true, entry: entry };
}

module.exports = {
  listScores: listScores,
  upsertScore: upsertScore
};
