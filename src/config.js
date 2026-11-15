'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// تحميل ملف .env إن وُجد (بدون أي مكتبة خارجية)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// مفتاح سري ثابت: من المتغيرات، وإلا يُنشأ مرة واحدة ويُحفظ داخل مجلد البيانات
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  isProd: env.NODE_ENV === 'production',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'qari.db'),
  uploadTmpDir: path.join(DATA_DIR, 'tmp'),
  localMediaDir: path.join(DATA_DIR, 'media'),
  secret: loadSecret(),
  storage: {
    driver: (env.STORAGE_DRIVER || 'local').toLowerCase(), // local | s3
    s3: {
      endpoint: env.S3_ENDPOINT || '',          // مثال: https://<account>.r2.cloudflarestorage.com
      region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      prefix: (env.S3_PREFIX || 'qari/').replace(/^\/+/, ''),
    },
  },
  chunkSize: 4 * 1024 * 1024, // 4MB لكل جزء
  bootstrapAdmin: { username: env.ADMIN_USERNAME || '', password: env.ADMIN_PASSWORD || '' },
};

fs.mkdirSync(config.uploadTmpDir, { recursive: true });
fs.mkdirSync(config.localMediaDir, { recursive: true });

module.exports = config;
