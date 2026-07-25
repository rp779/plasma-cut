'use strict';

var shared = require('./_shared');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: shared.corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return shared.json(405, { error: 'Method not allowed' });
  }

  var cfg = shared.supabaseConfig();
  if (!cfg) {
    return shared.json(500, { error: 'Leaderboard is not configured.' });
  }

  try {
    var url = cfg.url + '/rest/v1/scores?select=nickname,score,level,updated_at&order=score.desc&limit=50';
    var res = await fetch(url, {
      headers: shared.supabaseHeaders(cfg.key)
    });
    if (!res.ok) {
      var text = await res.text();
      return shared.json(502, { error: 'Failed to load leaderboard.', detail: text });
    }
    var rows = await res.json();
    return shared.json(200, { scores: rows });
  } catch (err) {
    return shared.json(500, { error: 'Failed to load leaderboard.' });
  }
};
