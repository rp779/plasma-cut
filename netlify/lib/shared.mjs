const MAX_LEVEL = 12;
const MAX_SCORE = 500000;
const NICK_RE = /^[A-Za-z0-9 _]{2,16}$/;

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

export function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: corsHeaders()
  });
}

export function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

export function supabaseHeaders(key, extra) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    ...(extra || {})
  };
}

export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const nick = raw.trim().replace(/\s+/g, ' ');
  if (!NICK_RE.test(nick)) return null;
  return nick;
}

export function validateScorePayload(body) {
  const nickname = normalizeNickname(body && body.nickname);
  const score = body && body.score;
  const level = body && body.level;

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
  return { nickname, score, level };
}
