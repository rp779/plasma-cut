'use strict';

var shared = require('./shared');
var RATE_LIMIT_MS = 5000;
var SCORES_PATH = 'data/scores.json';

async function listScores() {
  var cfg = shared.supabaseConfig();
  if (cfg) return listSupabase(cfg);
  return listGithub();
}

async function upsertScore(nickname, score, level) {
  var cfg = shared.supabaseConfig();
  if (cfg) return upsertSupabase(cfg, nickname, score, level);
  return upsertGithub(nickname, score, level);
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

function githubConfig() {
  var token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  var repo = process.env.GITHUB_REPO || 'rp779/plasma-cut';
  if (!token) return null;
  return { token: token, repo: repo };
}

function githubHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'plasma-cut-leaderboard'
  };
}

async function readGithubFile(cfg) {
  var url = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + SCORES_PATH;
  var res = await fetch(url, { headers: githubHeaders(cfg.token) });
  if (res.status === 404) {
    return { scores: [], sha: null };
  }
  if (!res.ok) {
    var err = new Error('Failed to load leaderboard.');
    err.statusCode = 502;
    err.detail = await res.text();
    throw err;
  }
  var data = await res.json();
  var decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  var parsed = JSON.parse(decoded);
  var scores = Array.isArray(parsed.scores) ? parsed.scores : [];
  return { scores: scores, sha: data.sha };
}

async function writeGithubFile(cfg, scores, sha) {
  var url = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + SCORES_PATH;
  var body = {
    message: 'Update public high scores',
    content: Buffer.from(JSON.stringify({ scores: scores }, null, 2) + '\n', 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;

  var res = await fetch(url, {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders(cfg.token)),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    var err = new Error('Failed to save score.');
    err.statusCode = res.status === 409 ? 409 : 502;
    err.detail = await res.text();
    throw err;
  }
}

function sortScores(scores) {
  return scores.slice().sort(function (a, b) {
    return b.score - a.score || String(a.nickname).localeCompare(String(b.nickname));
  }).slice(0, 50);
}

async function listGithub() {
  var cfg = githubConfig();
  if (!cfg) {
    var err = new Error('Leaderboard is not configured.');
    err.statusCode = 500;
    throw err;
  }
  var file = await readGithubFile(cfg);
  return sortScores(file.scores);
}

async function upsertGithub(nickname, score, level) {
  var cfg = githubConfig();
  if (!cfg) {
    var err = new Error('Leaderboard is not configured.');
    err.statusCode = 500;
    throw err;
  }

  var attempts = 0;
  while (attempts < 3) {
    attempts++;
    var file = await readGithubFile(cfg);
    var scores = file.scores.slice();
    var idx = -1;
    for (var i = 0; i < scores.length; i++) {
      if (scores[i].nickname.toLowerCase() === nickname.toLowerCase()) {
        idx = i;
        break;
      }
    }

    var existing = idx >= 0 ? scores[idx] : null;
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

    if (idx >= 0) scores[idx] = entry;
    else scores.push(entry);
    scores = sortScores(scores);

    try {
      await writeGithubFile(cfg, scores, file.sha);
      return { updated: true, entry: entry };
    } catch (writeErr) {
      if (writeErr.statusCode === 409 && attempts < 3) continue;
      throw writeErr;
    }
  }

  var fail = new Error('Failed to save score.');
  fail.statusCode = 502;
  throw fail;
}

module.exports = {
  listScores: listScores,
  upsertScore: upsertScore
};
