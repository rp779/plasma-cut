'use strict';

var MAX_LEVEL = 12;
var MAX_SCORE = 500000;
var NICK_RE = /^[A-Za-z0-9 _]{2,16}$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function json(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: corsHeaders(),
    body: statusCode === 204 ? '' : JSON.stringify(body)
  };
}

function supabaseConfig() {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key: key };
}

function supabaseHeaders(key, extra) {
  var headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'
  };
  if (extra) {
    for (var k in extra) headers[k] = extra[k];
  }
  return headers;
}

function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  var nick = raw.trim().replace(/\s+/g, ' ');
  if (!NICK_RE.test(nick)) return null;
  return nick;
}

function validateScorePayload(body) {
  var nickname = normalizeNickname(body && body.nickname);
  var score = body && body.score;
  var level = body && body.level;

  if (!nickname) {
    return { error: 'Nickname must be 2–16 characters (letters, numbers, spaces, underscores).' };
  }
  if (typeof score !== 'number' || !Number.isFinite(score) || score !== Math.floor(score)) {
    return { error: 'Score must be an integer.' };
  }
  if (score < 0 || score > MAX_SCORE) {
    return { error: 'Score out of range.' };
  }
  if (typeof level !== 'number' || !Number.isFinite(level) || level !== Math.floor(level)) {
    return { error: 'Level must be an integer.' };
  }
  if (level < 1 || level > MAX_LEVEL) {
    return { error: 'Level out of range.' };
  }
  return { nickname: nickname, score: score, level: level };
}

module.exports = {
  corsHeaders: corsHeaders,
  json: json,
  supabaseConfig: supabaseConfig,
  supabaseHeaders: supabaseHeaders,
  normalizeNickname: normalizeNickname,
  validateScorePayload: validateScorePayload
};
