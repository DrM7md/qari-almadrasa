'use strict';
/**
 * طبقة التخزين: محلي (قرص الخادم) أو سحابي متوافق مع S3
 * (Amazon S3 / Cloudflare R2 / Backblaze B2 / Wasabi / DigitalOcean Spaces / MinIO)
 * التوقيع AWS Signature V4 منفّذ يدويًا دون أي مكتبة خارجية.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmacRaw = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// ———————————— التخزين المحلي ————————————
const local = {
  name: 'local',
  resolve(key) {
    const p = path.normalize(path.join(config.localMediaDir, key));
    if (!p.startsWith(config.localMediaDir + path.sep)) throw new Error('bad key');
    return p;
  },
  async putFile(src, key) {
    const dst = this.resolve(key);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.renameSync(src, dst); } catch { fs.copyFileSync(src, dst); fs.unlinkSync(src); }
  },
  async remove(key) { if (key) try { fs.unlinkSync(this.resolve(key)); } catch {} },
  stat(key) { try { return fs.statSync(this.resolve(key)); } catch { return null; } },
};

// ———————————— S3 المتوافق ————————————
function s3() {
  const c = config.storage.s3;
  const ep = new URL(c.endpoint || `https://s3.${c.region}.amazonaws.com`);
  function target(key) {
    const k = (c.prefix + key).split('/').map(enc).join('/');
    if (c.forcePathStyle) return { host: ep.host, pathname: `/${c.bucket}/${k}` };
    return { host: `${c.bucket}.${ep.host}`, pathname: `/${k}` };
  }
  function scope(date) { return `${date.slice(0, 8)}/${c.region}/s3/aws4_request`; }
  function signingKey(date) {
    let k = hmacRaw('AWS4' + c.secretAccessKey, date.slice(0, 8));
    k = hmacRaw(k, c.region); k = hmacRaw(k, 's3'); return hmacRaw(k, 'aws4_request');
  }
  const amzDate = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  function request(method, key, { body, headers = {}, length } = {}) {
    const { host, pathname } = target(key);
    const date = amzDate();
    const h = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': date, ...headers };
    if (length != null) h['content-length'] = String(length);
    const names = Object.keys(h).map((x) => x.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonical = [method, pathname, '', names.map((n) => `${n}:${lower[n]}`).join('\n') + '\n', names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const sts = ['AWS4-HMAC-SHA256', date, scope(date), sha256hex(canonical)].join('\n');
    const sig = crypto.createHmac('sha256', signingKey(date)).update(sts).digest('hex');
    lower.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope(date)}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
    const mod = ep.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request({ method, host, port: ep.port || undefined, path: pathname, headers: lower }, (res) => {
        const chunks = []; res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 300 && !(method === 'DELETE' && res.statusCode === 404)) reject(new Error(`S3 ${method} ${res.statusCode}: ${text.slice(0, 300)}`));
          else resolve(text);
        });
      });
      req.on('error', reject);
      if (body && typeof body.pipe === 'function') body.pipe(req); else req.end(body);
    });
  }

  return {
    name: 's3',
    async putFile(src, key, contentType) {
      const size = fs.statSync(src).size;
      await request('PUT', key, { body: fs.createReadStream(src), length: size, headers: { 'content-type': contentType || 'application/octet-stream', 'cache-control': 'private, max-age=3600' } });
      fs.unlinkSync(src);
    },
    async remove(key) { if (key) await request('DELETE', key).catch((e) => console.error('[storage]', e.message)); },
    // رابط مؤقت موقّع للتشغيل المباشر من التخزين السحابي
    presign(key, ttl = 900, responseType) {
      const { host, pathname } = target(key);
      const date = amzDate();
      const q = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${c.accessKeyId}/${scope(date)}`,
        'X-Amz-Date': date, 'X-Amz-Expires': String(ttl), 'X-Amz-SignedHeaders': 'host',
      };
      if (responseType) q['response-content-type'] = responseType;
      q['response-content-disposition'] = 'inline';
      const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
      const canonical = ['GET', pathname, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
      const sts = ['AWS4-HMAC-SHA256', date, scope(date), sha256hex(canonical)].join('\n');
      const sig = crypto.createHmac('sha256', signingKey(date)).update(sts).digest('hex');
      return `${ep.protocol}//${host}${pathname}?${qs}&X-Amz-Signature=${sig}`;
    },
  };
}

let driver = local;
if (config.storage.driver === 's3') {
  const c = config.storage.s3;
  if (!c.bucket || !c.accessKeyId || !c.secretAccessKey) {
    console.error('[storage] STORAGE_DRIVER=s3 لكن إعدادات S3 ناقصة — سيُستخدم التخزين المحلي.');
  } else driver = s3();
}

module.exports = driver;
