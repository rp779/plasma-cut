'use strict';

var shared = require('../lib/shared');
var store = require('../lib/store');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: shared.corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return shared.json(405, { error: 'Method not allowed' });
  }

  try {
    var rows = await store.listScores(event);
    return shared.json(200, { scores: rows });
  } catch (err) {
    return shared.json(err.statusCode || 500, {
      error: err.message || 'Failed to load leaderboard.',
      detail: err.detail
    });
  }
};
