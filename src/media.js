'use strict';
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');

function has(bin) { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasProbe = has(FFPROBE);
const hasMpeg = has(FFMPEG);

// فحص "التوقيع الثنائي" للملف بدل الاعتماد على الامتداد فقط
function sniffVideo(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  fs.closeSync(fd);
  if (b.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'webm', mime: 'video/webm' };
  // MPEG-1/2 (Program Stream أو Elementary Stream)
  if (b.readUInt32BE(0) === 0x000001ba || b.readUInt32BE(0) === 0x000001b3) return { kind: 'mpeg', mime: 'video/mpeg' };
  // MP3: وسم ID3 أو إطار MPEG Audio Layer III مباشرة
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return { kind: 'mp3', mime: 'audio/mpeg' };
  const box = b.toString('latin1', 4, 8);
  if (box === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'qt  ') return { kind: 'mov', mime: 'video/quicktime' };
    if (/^(isom|iso\d|mp4\d|avc1|dash|M4V |M4VH|M4VP|mmp4|MSNV|3gp\d|3g2\w|f4v )/.test(brand)) return { kind: 'mp4', mime: 'video/mp4' };
    return { kind: 'mp4', mime: 'video/mp4' };
  }
  if (['moov', 'mdat', 'wide', 'free', 'pnot', 'skip'].includes(box)) return { kind: 'mov', mime: 'video/quicktime' };
  return null;
}

function probe(file) {
  return new Promise((resolve) => {
    if (!hasProbe) return resolve(null);
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000 }, (err, out) => {
      if (err) return resolve({ error: true });
      try {
        const j = JSON.parse(out);
        const video = (j.streams || []).find((s) => s.codec_type === 'video');
        const audio = (j.streams || []).find((s) => s.codec_type === 'audio');
        resolve({ duration: Number(j.format && j.format.duration) || null, hasVideo: !!video, hasAudio: !!audio, vcodec: video && video.codec_name });
      } catch { resolve({ error: true }); }
    });
  });
}

// إنشاء صورة مصغّرة (غلاف) من منتصف المقطع تقريبًا
function poster(file, out, at = 3) {
  return new Promise((resolve) => {
    if (!hasMpeg) return resolve(false);
    execFile(FFMPEG, ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out], { timeout: 60000 }, (err) => {
      resolve(!err && fs.existsSync(out) && fs.statSync(out).size > 0);
    });
  });
}

// إعادة تغليف المقطع دون إعادة ترميز: تُحذف البيانات الوصفية (ومنها موقع التصوير GPS واسم الجهاز)
// ويُنقل فهرس MP4 لبداية الملف لتشغيل أسرع. MOV يُحوَّل إلى حاوية MP4 لتوافق أوسع مع المتصفحات.
function sanitize(file, kind) {
  return new Promise((resolve) => {
    if (!hasMpeg) return resolve(null);
    if (kind === 'mp3') return sanitizeAudio(file, resolve);
    if (kind === 'mpeg') return transcodeMpeg(file, resolve);
    const webm = kind === 'webm';
    const out = file + (webm ? '.clean.webm' : '.clean.mp4');
    const args = ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1',
      '-metadata', 'title=', '-metadata', 'location=', '-metadata', 'creation_time='];
    if (!webm) args.push('-movflags', '+faststart', '-f', 'mp4'); else args.push('-f', 'webm');
    args.push(out);
    execFile(FFMPEG, args, { timeout: 5 * 60000 }, (err) => {
      if (err || !fs.existsSync(out) || fs.statSync(out).size < 1024) { try { fs.unlinkSync(out); } catch {} return resolve(null); }
      resolve({ file: out, mime: webm ? 'video/webm' : 'video/mp4', ext: webm ? 'webm' : 'mp4' });
    });
  });
}

// MP3: حذف الوسوم (ID3) وصورة الغلاف دون إعادة ترميز
function sanitizeAudio(file, resolve) {
  const out = file + '.clean.mp3';
  execFile(FFMPEG, ['-y', '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', '-f', 'mp3', out], { timeout: 5 * 60000 }, (err) => {
    if (err || !fs.existsSync(out) || fs.statSync(out).size < 1024) { try { fs.unlinkSync(out); } catch {} return resolve(null); }
    resolve({ file: out, mime: 'audio/mpeg', ext: 'mp3' });
  });
}

// MPEG-1/2: لا تشغّله المتصفحات، فيُعاد ترميزه إلى H.264 + AAC داخل MP4
function transcodeMpeg(file, resolve) {
  const out = file + '.clean.mp4';
  execFile(FFMPEG, ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-f', 'mp4', out], { timeout: 20 * 60000 }, (err) => {
    if (err || !fs.existsSync(out) || fs.statSync(out).size < 1024) { try { fs.unlinkSync(out); } catch {} return resolve(null); }
    resolve({ file: out, mime: 'video/mp4', ext: 'mp4' });
  });
}

module.exports = { sniffVideo, probe, poster, sanitize, hasProbe, hasMpeg };
