'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const media = config.storage.driver === 's3' && config.storage.s3.endpoint ? ' ' + new URL(config.storage.s3.endpoint).origin + ' https:' : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:" + media,
    "media-src 'self' blob:" + media,
    "connect-src 'self'" + media,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'حجم الطلب أكبر من المسموح.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new HttpError(415, 'نوع المحتوى غير مدعوم.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); if (v && typeof v === 'object') return v; } catch {}
  throw new HttpError(400, 'بيانات غير صالحة.');
}

// ———————— موجّه مسارات بسيط ————————
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); } post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); } patch(p, h) { this.add('PATCH', p, h); } delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

// ———————— الملفات الثابتة ————————
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const staticCache = new Map();
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html'; // روابط نظيفة: /register → register.html
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let entry = staticCache.get(file);
  if (!entry || !config.isProd) {
    let stat; try { stat = fs.statSync(file); } catch { return false; }
    if (!stat.isFile()) return false;
    let raw = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    // ربط ملفات JS/CSS بإصدارها (بصمة المحتوى) كي يصل أي تحديث فورًا رغم التخزين المؤقت
    if (ext === '.html') {
      raw = Buffer.from(raw.toString('utf8').replace(/((?:src|href)="\/(?:js|css)\/[^"?]+\.(?:js|css))"/g, (m, url) => {
        try {
          const asset = fs.readFileSync(path.join(PUBLIC_DIR, url.slice(url.indexOf('"') + 2)));
          return `${url}?v=${crypto.createHash('sha1').update(asset).digest('hex').slice(0, 10)}"`;
        } catch { return m; }
      }));
    }
    const type = MIME[ext] || 'application/octet-stream';
    const compressible = /text|json|svg|javascript|manifest/.test(type);
    entry = {
      raw, type, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 20) + '"',
      gz: compressible && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null, ext,
    };
    staticCache.set(file, entry);
  }
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304); res.end(); return true; }
  const headers = {
    'Content-Type': entry.type, ETag: entry.etag,
    'Cache-Control': entry.ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    Vary: 'Accept-Encoding',
  };
  let body = entry.raw;
  if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

module.exports = { HttpError, Router, sendJson, readJson, readBody, securityHeaders, serveStatic, PUBLIC_DIR, MIME };
