const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const POCKETSIC_BASE = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';

// How long to record each scene (seconds). Each segment's narration duration
// is the ideal, but we enforce a min/max to keep captures reasonable.
const MIN_CAPTURE_SECS = 5;
const MAX_CAPTURE_SECS = 30;
const FRAME_RATE = 10; // capture frames per second (low to save CPU/memory on Heroku)
const OUTPUT_FPS = 30; // final output video fps

/**
 * Capture a single PocketSIC scene as a VIDEO CLIP.
 *
 * Uses Chrome DevTools Protocol (CDP) to take rapid screenshots while the
 * scene plays, then stitches them into an MP4 with FFmpeg.
 *
 * @param {object} params
 * @param {number} params.sceneId - PocketSIC scene ID
 * @param {string} params.channel - Channel type
 * @param {number} params.duration - Target capture duration in seconds
 * @param {string} params.outputDir - Directory to save captures
 * @param {object} params.browser - Puppeteer browser instance (reuse for batch)
 * @returns {Promise<string>} Path to captured MP4 clip
 */
async function captureScene({ sceneId, channel, duration, outputDir, browser }) {
  const ownBrowser = !browser;
  if (ownBrowser) {
    browser = await launchBrowser();
  }

  const captureDuration = Math.min(Math.max(duration || 10, MIN_CAPTURE_SECS), MAX_CAPTURE_SECS);
  const frameDir = path.join(outputDir || os.tmpdir(), `frames_${sceneId}_${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });

  const page = await browser.newPage();

  try {
    // Set viewport — phone portrait for PocketSIC scenes
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

    // Navigate to scene
    const sceneUrl = `${POCKETSIC_BASE}/scene/${sceneId}`;
    console.log(`[SceneCapture] Navigating to: ${sceneUrl} (recording ${captureDuration}s)`);
    const response = await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    console.log(`[SceneCapture] Page status: ${response ? response.status() : 'no response'}`);

    // Let the page fully render before starting capture
    await new Promise(r => setTimeout(r, 1500));

    // ── Capture frames via rapid screenshots ──
    const totalFrames = Math.ceil(captureDuration * FRAME_RATE);
    const intervalMs = 1000 / FRAME_RATE;
    console.log(`[SceneCapture] Capturing ${totalFrames} frames at ${FRAME_RATE}fps...`);

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(frameDir, `frame_${String(i).padStart(5, '0')}.jpg`);
      await page.screenshot({
        path: framePath,
        type: 'jpeg',
        quality: 85,
        fullPage: false,
      });

      // Wait the frame interval (minus a small offset for screenshot time)
      if (i < totalFrames - 1) {
        await new Promise(r => setTimeout(r, intervalMs * 0.8));
      }
    }

    console.log(`[SceneCapture] Captured ${totalFrames} frames in ${frameDir}`);

    // ── Stitch frames into MP4 with FFmpeg ──
    const outputPath = path.join(outputDir || os.tmpdir(), `scene_${sceneId}_${channel}.mp4`);
    await stitchFramesToVideo(frameDir, outputPath, captureDuration);

    // Cleanup frame directory
    try {
      const files = fs.readdirSync(frameDir);
      for (const f of files) fs.unlinkSync(path.join(frameDir, f));
      fs.rmdirSync(frameDir);
    } catch { /* cleanup is best-effort */ }

    return outputPath;
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

/**
 * Stitch a directory of JPEG frames into an MP4 video.
 */
function stitchFramesToVideo(frameDir, outputPath, duration) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = findFfmpegPath();
    const args = [
      '-y',
      '-framerate', String(FRAME_RATE),
      '-i', path.join(frameDir, 'frame_%05d.jpg'),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-r', String(OUTPUT_FPS),
      '-t', String(duration),
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log(`[SceneCapture] FFmpeg stitching: ${ffmpegPath} ${args.slice(0, 8).join(' ')}...`);
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        const stats = fs.statSync(outputPath);
        console.log(`[SceneCapture] Video clip: ${outputPath} (${(stats.size / 1024).toFixed(1)}KB)`);
        resolve();
      } else {
        console.error(`[SceneCapture] FFmpeg failed (code ${code}): ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg frame stitching failed (exit ${code})`));
      }
    });

    proc.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));

    // 2-minute timeout
    setTimeout(() => { proc.kill('SIGKILL'); }, 2 * 60 * 1000);
  });
}

/**
 * Also export a static capture for fallback / thumbnail
 */
async function captureSceneStatic({ sceneId, channel, outputDir, browser }) {
  const ownBrowser = !browser;
  if (ownBrowser) browser = await launchBrowser();

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });
    const sceneUrl = `${POCKETSIC_BASE}/scene/${sceneId}`;
    await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const outputPath = path.join(outputDir || os.tmpdir(), `scene_${sceneId}_${channel}.png`);
    await page.screenshot({ path: outputPath, type: 'png', fullPage: false });
    return outputPath;
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

/**
 * Capture all scenes for a video (batch)
 * @param {Array} scenes - Array of { sceneId, channel, duration }
 * @param {string} outputDir - Directory for captures
 * @param {function} onProgress - Progress callback (completed, total)
 * @returns {Promise<Array>} Array of { sceneId, channel, clipPath }
 */
async function captureAllScenes(scenes, outputDir, onProgress) {
  const browser = await launchBrowser();
  const results = [];

  try {
    // Capture serially to avoid memory issues on Heroku
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`Capturing scene ${i + 1}/${scenes.length}: ${scene.sceneId} (${scene.channel})`);

      const clipPath = await captureScene({
        sceneId: scene.sceneId,
        channel: scene.channel,
        duration: scene.duration || 10,
        outputDir,
        browser,
      });

      results.push({
        sceneId: scene.sceneId,
        channel: scene.channel,
        clipPath,
        // Keep backward compat — imagePath points to clip for compositor
        imagePath: clipPath,
      });

      if (onProgress) onProgress(i + 1, scenes.length);
    }
  } finally {
    await browser.close();
  }

  return results;
}

// ── FFmpeg path discovery ──
function findFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const candidates = ['/app/vendor/ffmpeg/ffmpeg', '/app/.heroku/vendor/ffmpeg/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which ffmpeg', { encoding: 'utf-8' }).trim(); } catch {}
  return 'ffmpeg';
}

// ── Chrome path discovery ──
function findChromePath() {
  if (process.env.GOOGLE_CHROME_BIN) return process.env.GOOGLE_CHROME_BIN;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const candidates = [
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/app/.apt/usr/bin/google-chrome',
    '/app/.apt/usr/bin/google-chrome-stable',
    '/app/.apt/usr/bin/chromium-browser',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const result = execSync('which google-chrome-stable || which google-chrome || which chromium-browser', { encoding: 'utf-8' }).trim();
    if (result) return result;
  } catch { /* not found */ }

  throw new Error('Chrome not found. Ensure the Google Chrome buildpack is installed on Heroku.');
}

async function launchBrowser() {
  const executablePath = findChromePath();
  console.log(`Launching Chrome from: ${executablePath}`);

  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
    ],
    defaultViewport: null,
  });
}

module.exports = { captureScene, captureSceneStatic, captureAllScenes };
