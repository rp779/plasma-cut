'use strict';

var shared = require('./_shared');

var RATE_LIMIT_MS = 5000;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: shared.corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return shared.json(405, { error: 'Method not allowed' });
  }

  var cfg = shared.supabaseConfig();
  if (!cfg) {
    return shared.json(500, { error: 'Leaderboard is not configured.' });
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return shared.json(400, { error: 'Invalid JSON body.' });
  }

  var parsed = shared.validateScorePayload(body);
  if (parsed.error) {
    return shared.json(400, { error: parsed.error });
  }

  var nickname = parsed.nickname;
  var score = parsed.score;
  var level = parsed.level;

  try {
    var getUrl = cfg.url + '/rest/v1/scores?nickname=eq.' + encodeURIComponent(nickname) +
      '&select=nickname,score,level,updated_at';
    var existingRes = await fetch(getUrl, {
      headers: shared.supabaseHeaders(cfg.key)
    });
    if (!existingRes.ok) {
      var existingErr = await existingRes.text();
      return shared.json(502, { error: 'Failed to check existing score.', detail: existingErr });
    }
    var existingRows = await existingRes.json();
    var existing = existingRows[0];

    if (existing) {
      var updatedAt = Date.parse(existing.updated_at);
      if (!Number.isNaN(updatedAt) && Date.now() - updatedAt < RATE_LIMIT_MS) {
        return shared.json(429, { error: 'Slow down — try again in a few seconds.' });
      }
      if (existing.score >= score) {
        return shared.json(200, {
          ok: true,
          updated: false,
          message: 'Existing best is higher or equal.',
          entry: existing
        });
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
      return shared.json(502, { error: 'Failed to save score.', detail: writeErr });
    }

    var saved = await writeRes.json();
    return shared.json(200, {
      ok: true,
      updated: true,
      entry: Array.isArray(saved) ? saved[0] : saved
    });
  } catch (err) {
    return shared.json(500, { error: 'Failed to save score.' });
  }
};
