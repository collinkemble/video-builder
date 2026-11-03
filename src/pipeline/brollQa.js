/**
 * B-roll quality check — runs on every finished b-roll shot.
 *
 *   1. Rewind detector (local, free): finds moments where footage briefly plays backwards
 *      (e.g. a person "moonwalking"). At a turnaround point c, frame(c+k) ≈ frame(c-k) for several k,
 *      which never happens in normal forward motion. Tested: synthetic 2s backwards moments score
 *      ~0.2; normal Omni footage scores ≥1.1.
 *   2. Gemini review (cheap, ~6k tokens per 10s): crossfades/dissolves, two copies of the person,
 *      scene cuts, talking, and readable text/signage. (Gemini proved unreliable at judging reverse motion, so it is not asked.)
 *
 * The check never blocks a video: if it errors, the shot is accepted as-is.
 */
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

function findFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const candidates = ['/app/vendor/ffmpeg/ffmpeg', '/app/.heroku/vendor/ffmpeg/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which ffmpeg', { encoding: 'utf-8' }).trim(); } catch { /* not found */ }
  return 'ffmpeg';
}
const FFMPEG = findFfmpegPath();

function raceTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms); }),
  ]);
}

// ── 1. Rewind detector ──
const RW_W = 64, RW_H = 36, RW_FPS = 12;

function readGrayFrames(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', filePath, '-vf', 'fps=' + RW_FPS + ',scale=' + RW_W + ':' + RW_H + ',format=gray', '-f', 'rawvideo', '-']);
    const chunks = []; let err = '';
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error('frame read failed: ' + err.slice(-200)));
      const buf = Buffer.concat(chunks); const n = Math.floor(buf.length / (RW_W * RW_H));
      const frames = []; for (let i = 0; i < n; i++) frames.push(buf.subarray(i * RW_W * RW_H, (i + 1) * RW_W * RW_H));
      resolve(frames);
    });
  });
}

function frameDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

async function detectRewinds(filePath, { k = 6, minMotion = 1.2, threshold = 0.5 } = {}) {
  const frames = await readGrayFrames(filePath);
  const scores = [];
  for (let c = k; c < frames.length - k; c++) {
    let mirror = 0, motion = 0;
    for (let j = 2; j <= k; j++) {
      mirror += frameDiff(frames[c + j], frames[c - j]);
      motion += (frameDiff(frames[c + j], frames[c]) + frameDiff(frames[c - j], frames[c])) / 2;
    }
    mirror /= (k - 1); motion /= (k - 1);
    scores.push({ c, score: motion >= minMotion ? mirror / motion : Infinity });
  }
  const rewinds = [];
  scores.forEach((s, i) => {
    if (s.score > threshold) return;
    const prev = scores[i - 1], next = scores[i + 1];
    if ((prev && prev.score < s.score) || (next && next.score < s.score)) return;
    const sec = s.c / RW_FPS;
    if (rewinds.length && sec - rewinds[rewinds.length - 1].second < 1) return;
    rewinds.push({ second: +sec.toFixed(1), score: +s.score.toFixed(2) });
  });
  return rewinds;
}

// ── 2. Gemini review ──
const REVIEW_PROMPT = 'You are a strict video quality reviewer for silent b-roll footage. Watch the ENTIRE clip and report ONLY clear, visible defects from this list:\n' +
  '- "dissolve": a crossfade, dissolve, fade or blend between two different shots or locations, including moments where two images are overlaid at once.\n' +
  '- "duplicate_person": the same person appears twice at the same time (two copies, ghosting, a second version fading in while the first fades out).\n' +
  '- "scene_cut": a hard cut to a different shot, angle or location.\n' +
  '- "talking": a person is clearly speaking or moving their lips as if talking.\n' +
  '- "visible_text": any READABLE text, letters, words, numbers or logos anywhere in the frame — store signs and storefront names, awnings, window lettering, posters, product packaging or labels, clothing prints, vehicles, or screens. Report it even if it is only on screen briefly. Ignore marks that are too blurry to read as letters.\n' +
  'Return JSON only: {"ok": boolean, "problems": [{"type": one of the above, "second": approximate time in seconds, "detail": short description}]}. ' +
  '"ok" is true only if there are no problems. Do not report minor softness, lighting changes, or normal camera movement.';

let _ai = null;
async function geminiReview(filePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  if (!_ai) _ai = new GoogleGenAI({ apiKey });
  const size = fs.statSync(filePath).size;
  if (size > 18 * 1024 * 1024) return []; // too large to send inline — skip rather than block
  const data = fs.readFileSync(filePath).toString('base64');
  const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'])];
  for (const model of models) {
    try {
      const resp = await raceTimeout(_ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'video/mp4', data }, videoMetadata: { fps: 8 } }, { text: REVIEW_PROMPT }] }],
        config: { responseMimeType: 'application/json', temperature: 0, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' },
      }), 90000, 'B-roll review');
      const parsed = JSON.parse((resp.text || '').trim());
      const allowed = ['dissolve', 'duplicate_person', 'scene_cut', 'talking', 'visible_text'];
      return (Array.isArray(parsed.problems) ? parsed.problems : []).filter(p => p && allowed.includes(p.type));
    } catch (err) {
      console.warn('[B-Roll QA] Gemini review with ' + model + ' failed: ' + err.message);
    }
  }
  return [];
}

const PROBLEM_LABELS = {
  reverse_motion: 'brief backwards motion',
  dissolve: 'a crossfade between scenes',
  duplicate_person: 'two copies of the person',
  scene_cut: 'a scene cut',
  talking: 'the person talking',
  visible_text: 'readable text or signage',
};

/**
 * Review one finished shot.
 * @returns {Promise<{ ok: boolean, problems: Array<{type, second, detail}>, error?: string }>}
 */
async function reviewShot(filePath) {
  if (process.env.BROLL_QA === 'off') return { ok: true, problems: [] };
  const started = Date.now();
  const problems = [];
  let error = null;
  const [rw, gm] = await Promise.allSettled([detectRewinds(filePath), geminiReview(filePath)]);
  if (rw.status === 'fulfilled') rw.value.forEach(r => problems.push({ type: 'reverse_motion', second: r.second, detail: 'footage briefly plays backwards (score ' + r.score + ')' }));
  else error = 'rewind check: ' + rw.reason.message;
  if (gm.status === 'fulfilled') gm.value.forEach(p => problems.push({ type: p.type, second: p.second, detail: p.detail }));
  else error = (error ? error + '; ' : '') + 'review: ' + gm.reason.message;
  console.log('[B-Roll QA] ' + require('path').basename(filePath) + ': ' + (problems.length ? problems.map(p => p.type + '@' + p.second + 's').join(', ') : 'clean') + ' (' + Math.round((Date.now() - started) / 1000) + 's)');
  return { ok: problems.length === 0, problems, ...(error ? { error } : {}) };
}

// ── 3. Salvage: keep the longest clean stretch of a shot ──
function probeDuration(filePath) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', filePath]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
    });
  });
}

/**
 * Cut the problem moments out of a shot and keep the longest clean stretch (≥ minSeconds).
 * Each problem removes a window of ±pad seconds around its time. Problems without a time
 * can't be located, so the shot can't be salvaged. Returns { filePath, seconds } or null.
 * The caller must re-check the result (problem times are approximate).
 */
async function trimToCleanSpan(filePath, problems, outputDir, { pad = 1.5, minSeconds = 4 } = {}) {
  if (!problems || !problems.length) return null;
  if (problems.some(p => !Number.isFinite(Number(p.second)))) return null;
  const dur = await probeDuration(filePath);
  if (!dur) return null;
  const bad = problems.map(p => [Math.max(0, Number(p.second) - pad), Math.min(dur, Number(p.second) + pad)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  bad.forEach(w => { const last = merged[merged.length - 1]; if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else merged.push(w.slice()); });
  let best = null, cursor = 0.2;
  for (const w of [...merged, [dur - 0.2, dur]]) {
    const len = w[0] - cursor;
    if (len > 0 && (!best || len > best.len)) best = { start: cursor, len };
    cursor = Math.max(cursor, w[1]);
  }
  if (!best || best.len < minSeconds) return null;
  const out = require('path').join(outputDir || require('os').tmpdir(), 'broll_trim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.mp4');
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-v', 'error', '-ss', best.start.toFixed(2), '-i', filePath, '-t', best.len.toFixed(2), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    let e = ''; p.stderr.on('data', d => { e += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('trim failed: ' + e.slice(-200))));
  });
  return { filePath: out, seconds: +best.len.toFixed(2), start: +best.start.toFixed(2) };
}

module.exports = { reviewShot, detectRewinds, geminiReview, trimToCleanSpan, probeDuration, PROBLEM_LABELS };
