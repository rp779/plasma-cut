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
    var err = new Error('Failed to load leaderboard.');
    err.statusCode = 502;
    err.detail = await res.text();
    throw err;
  }
  return res.json();
}

async function upsertSupabase(cfg, nickname, score, level) {
  var getUrl = cfg.url + '/rest/v1/scores?nickname=eq.' + encodeURIComponent(nickname) +
    '&select=nickname,score,level,updated_at';
  var existingRes = await fetch(getUrl, { headers: shared.supabaseHeaders(cfg.key) });
  if (!existingRes.ok) {
    var err = new Error('Failed to check existing score.');
    err.statusCode = 502;
    err.detail = await existingRes.text();
    throw err;
  }
  var existing = (await existingRes.json())[0];

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
    var writeError = new Error('Failed to save score.');
    writeError.statusCode = 502;
    writeError.detail = await writeRes.text();
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

async function loadBoard(store) {
  var byNick = {};

  var board = await store.get('board', { type: 'json' });
  if (Array.isArray(board)) {
    for (var i = 0; i < board.length; i++) {
      if (board[i] && board[i].nickname) byNick[board[i].nickname.toLowerCase()] = board[i];
    }
  }

  var listed = await store.list();
  var blobs = listed && listed.blobs ? listed.blobs : [];
  for (var j = 0; j < blobs.length; j++) {
    var key = blobs[j].key;
    if (key.indexOf('nick:') !== 0) continue;
    var row = await store.get(key, { type: 'json' });
    if (!row || typeof row.score !== 'number' || !row.nickname) continue;
    var nk = row.nickname.toLowerCase();
    if (!byNick[nk] || byNick[nk].score < row.score) byNick[nk] = row;
  }

  var legacy = await store.get('all', { type: 'json' });
  if (legacy && legacy.scores) {
    var legacyKeys = Object.keys(legacy.scores);
    for (var k = 0; k < legacyKeys.length; k++) {
      var entry = legacy.scores[legacyKeys[k]];
      if (!entry || typeof entry.score !== 'number' || !entry.nickname) continue;
      var ln = entry.nickname.toLowerCase();
      if (!byNick[ln] || byNick[ln].score < entry.score) byNick[ln] = entry;
    }
  }

  return Object.keys(byNick).map(function (n) { return byNick[n]; });
}

async function listBlobs(event) {
  var store = await getBlobStore(event);
  var rows = await loadBoard(store);
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

  var rows = await loadBoard(store);
  var replaced = false;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].nickname.toLowerCase() === nickname.toLowerCase()) {
      if (rows[i].score <= score) rows[i] = entry;
      replaced = true;
      break;
    }
  }
  if (!replaced) rows.push(entry);

  rows.sort(function (a, b) {
    return b.score - a.score || String(a.nickname).localeCompare(String(b.nickname));
  });
  await store.setJSON('board', rows.slice(0, 50));

  return { updated: true, entry: entry };
}

module.exports = {
  listScores: listScores,
  upsertScore: upsertScore
};
