'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// بصمة مقرونة بالمفتاح السري: لا يمكن عكسها ولا مقارنتها خارج الخادم
const hmac = (s, purpose = 'gen') => crypto.createHmac('sha256', config.secret).update(purpose + ':' + s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ———————— كلمات المرور (scrypt) ————————
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const k = Buffer.from(key, 'base64');
    const d = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), k.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(k, d);
  } catch { return false; }
}
function passwordProblems(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'كلمة المرور يجب ألا تقل عن 10 أحرف.';
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/\d/.test(pw)) return 'يجب أن تحتوي كلمة المرور على أحرف وأرقام.';
  return null;
}

// ———————— روابط موقّعة مؤقتة (لتشغيل الفيديو) ————————
function signPayload(payload, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${payload}.${exp}`;
  return `${exp}.${hmac(body, 'sig').slice(0, 32)}`;
}
function verifySigned(payload, token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(`${payload}.${exp}`, 'sig').slice(0, 32));
}

// ———————— تحديد معدّل الطلبات (في الذاكرة) ————————
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.reset - t) / 1000) };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* تجاهل */ }
  }
  return out;
}

function cookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (config.isProd) c += '; Secure';
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  return c;
}

module.exports = {
  randomToken, sha256, hmac, safeEqual, hashPassword, verifyPassword, passwordProblems,
  signPayload, verifySigned, rateLimit, clientIp, parseCookies, cookie,
};
