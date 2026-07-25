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

async function collectKeys(store) {
  var keySet = {};
  var index = await store.get('index', { type: 'json' });
  if (Array.isArray(index)) {
    for (var i = 0; i < index.length; i++) keySet[index[i]] = true;
  }

  var listed = await store.list();
  var blobs = listed && listed.blobs ? listed.blobs : [];
  for (var j = 0; j < blobs.length; j++) {
    if (blobs[j].key.indexOf('nick:') === 0) keySet[blobs[j].key] = true;
  }

  // Legacy single-document migration
  var legacy = await store.get('all', { type: 'json' });
  if (legacy && legacy.scores) {
    var legacyKeys = Object.keys(legacy.scores);
    for (var k = 0; k < legacyKeys.length; k++) {
      var entry = legacy.scores[legacyKeys[k]];
      if (entry && entry.nickname) {
        var lk = nickKey(entry.nickname);
        var existing = await store.get(lk, { type: 'json' });
        if (!existing) await store.setJSON(lk, entry);
        keySet[lk] = true;
      }
    }
  }

  return Object.keys(keySet);
}

async function writeIndex(store, keys) {
  var unique = keys.slice().sort();
  await store.setJSON('index', unique);
}

async function listBlobs(event) {
  var store = await getBlobStore(event);
  var keys = await collectKeys(store);
  if (keys.length) await writeIndex(store, keys);

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

  var keys = await collectKeys(store);
  if (keys.indexOf(key) === -1) keys.push(key);
  await writeIndex(store, keys);

  return { updated: true, entry: entry };
}

module.exports = {
  listScores: listScores,
  upsertScore: upsertScore
};
