'use strict';
/**
 * تسجيل دخول المصوّت بحساب المدرسة (OpenID Connect) — يعمل مع Google Workspace و Microsoft Entra ID (Office 365)
 * وأي مزوّد متوافق. يُتحقق من توقيع id_token محليًا عبر مفاتيح JWKS، دون أي مكتبة خارجية.
 */
const crypto = require('node:crypto');

const env = process.env;
const cfg = {
  issuer: (env.OIDC_ISSUER || '').replace(/\/$/, ''),          // https://accounts.google.com  أو  https://login.microsoftonline.com/<tenant>/v2.0
  clientId: env.OIDC_CLIENT_ID || '',
  clientSecret: env.OIDC_CLIENT_SECRET || '',
  allowedDomain: (env.OIDC_ALLOWED_DOMAIN || '').toLowerCase(),  // مثال: school.edu.qa
  label: env.OIDC_BUTTON_LABEL || 'الدخول بحساب المدرسة',
};
const enabled = () => !!(cfg.issuer && cfg.clientId && cfg.clientSecret);

let discovery = null, jwks = null, jwksAt = 0;
async function getDiscovery() {
  if (discovery) return discovery;
  const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error('OIDC discovery failed: ' + r.status);
  discovery = await r.json();
  return discovery;
}
async function getKeys(force) {
  if (jwks && !force && Date.now() - jwksAt < 3600000) return jwks;
  const d = await getDiscovery();
  const r = await fetch(d.jwks_uri);
  if (!r.ok) throw new Error('JWKS fetch failed');
  jwks = (await r.json()).keys || []; jwksAt = Date.now();
  return jwks;
}

const b64url = (b) => Buffer.from(b).toString('base64url');

async function authUrl(redirectUri) {
  const d = await getDiscovery();
  const state = b64url(crypto.randomBytes(18));
  const nonce = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  if (cfg.allowedDomain && /google/.test(cfg.issuer)) q.set('hd', cfg.allowedDomain);
  return { url: `${d.authorization_endpoint}?${q}`, state, nonce, verifier };
}

async function verifyIdToken(idToken, nonce) {
  const [h, p, sig] = String(idToken).split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('unsupported alg');
  let key = (await getKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await getKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new Error('unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const d = await getDiscovery();
  const now = Date.now() / 1000;
  // Microsoft متعدد المستأجرين يضع tenantid في المصدر؛ نقارن مع مصدر الاكتشاف
  const iss = String(d.issuer || '').replace('{tenantid}', payload.tid || '');
  if (payload.iss !== iss && payload.iss !== cfg.issuer) throw new Error('bad issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.clientId)) throw new Error('bad audience');
  if (payload.exp < now - 60 || (payload.iat && payload.iat > now + 300)) throw new Error('expired');
  if (payload.nonce !== nonce) throw new Error('bad nonce');
  const email = String(payload.email || payload.preferred_username || payload.upn || '').toLowerCase();
  if (!email) throw new Error('no email');
  if (payload.email_verified === false) throw new Error('email not verified');
  if (cfg.allowedDomain && !email.endsWith('@' + cfg.allowedDomain)) throw new Error('domain');
  return { email, name: payload.name || '' };
}

async function exchange(code, redirectUri, verifier, nonce) {
  const d = await getDiscovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: verifier }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw new Error('token exchange failed');
  return verifyIdToken(j.id_token, nonce);
}

module.exports = { enabled, authUrl, exchange, label: () => cfg.label, domain: () => cfg.allowedDomain };
