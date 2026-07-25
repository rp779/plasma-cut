'use strict';

var shared = require('../lib/shared');
var store = require('../lib/store');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: shared.corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return shared.json(405, { error: 'Method not allowed' });
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

  try {
    var result = await store.upsertScore(parsed.nickname, parsed.score, parsed.level);
    return shared.json(200, {
      ok: true,
      updated: result.updated,
      message: result.updated ? undefined : 'Existing best is higher or equal.',
      entry: result.entry
    });
  } catch (err) {
    return shared.json(err.statusCode || 500, {
      error: err.message || 'Failed to save score.',
      detail: err.detail
    });
  }
};
