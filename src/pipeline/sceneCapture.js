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
const FRAME_RATE = 24; // capture frames per second — smooth video capture
const OUTPUT_FPS = 30; // final output video fps

/**
 * Channel-specific interaction patterns for PocketSIC scenes.
 * Each pattern defines how to progress the story during recording.
 *
 * The interaction scheduler clicks elements at timed intervals to simulate
 * a user naturally progressing through the demo.
 */
const INTERACTION_PATTERNS = {
  // Chat / agentic chat — click send or next-message buttons
  website: {
    // Selectors to try clicking (in priority order)
    selectors: [
      'button[class*="send"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="Send" i]',
      '[class*="chat"] button',
      '[class*="Chat"] button',
      'button[class*="next"]',
      'button[class*="reply"]',
      '.chat-input button',
      '.message-input button',
      // Generic clickable progression elements
      'button:not([disabled])',
    ],
    // How often to click (ms) — gives time for animations/responses
    intervalMs: 2500,
    // Initial delay before first click
    initialDelayMs: 2000,
  },

  // iMessage style — tap message bubbles or send buttons
  imessage: {
    selectors: [
      'button[class*="send"]',
      'button[aria-label*="send" i]',
      '[class*="message"] button',
      '[class*="iMessage"] button',
      '[class*="imessage"] button',
      'button[class*="next"]',
      'button:not([disabled])',
    ],
    intervalMs: 2000,
    initialDelayMs: 1500,
  },

  // SMS / text messages
  sms: {
    selectors: [
      'button[class*="send"]',
      'button[aria-label*="send" i]',
      '[class*="message"] button',
      'button[class*="next"]',
      'button:not([disabled])',
    ],
    intervalMs: 2000,
    initialDelayMs: 1500,
  },

  // Retail cloud / POS — tap through screens
  retail: {
    selectors: [
      'button[class*="next"]',
      'button[class*="continue"]',
      'button[class*="proceed"]',
      'button[class*="action"]',
      '[class*="retail"] button',
      '[class*="pos"] button',
      'button:not([disabled])',
    ],
    intervalMs: 3000,
    initialDelayMs: 2000,
  },

  // Email — mostly static, light interaction
  email: {
    selectors: [
      'button[class*="open"]',
      'button[class*="next"]',
      'a[class*="cta"]',
      'button:not([disabled])',
    ],
    intervalMs: 4000,
    initialDelayMs: 2000,
  },

  // Instagram / social — let video play, occasional taps
  instagram: {
    selectors: [],  // No clicks — let native video/animations play
    intervalMs: 0,
    initialDelayMs: 0,
  },

  // Default — gentle clicks on available buttons
  default: {
    selectors: [
      'button[class*="next"]',
      'button[class*="send"]',
      'button[class*="continue"]',
      'button[class*="action"]',
      'button:not([disabled])',
    ],
    intervalMs: 3000,
    initialDelayMs: 2000,
  },
};

/**
 * Get the interaction pattern for a channel type.
 */
function getInteractionPattern(channel) {
  const ch = (channel || '').toLowerCase().replace(/[^a-z]/g, '');

  if (ch.includes('instagram') || ch.includes('social') || ch.includes('facebook') || ch.includes('tiktok')) {
    return INTERACTION_PATTERNS.instagram;
  }
  if (ch.includes('imessage') || ch.includes('apple')) {
    return INTERACTION_PATTERNS.imessage;
  }
  if (ch.includes('sms') || ch.includes('text')) {
    return INTERACTION_PATTERNS.sms;
  }
  if (ch.includes('retail') || ch.includes('store') || ch.includes('pos') || ch.includes('instore')) {
    return INTERACTION_PATTERNS.retail;
  }
  if (ch.includes('email')) {
    return INTERACTION_PATTERNS.email;
  }
  if (ch.includes('web') || ch.includes('chat') || ch.includes('agent') || ch.includes('service')) {
    return INTERACTION_PATTERNS.website;
  }

  return INTERACTION_PATTERNS.default;
}

/**
 * Capture a single PocketSIC scene as a VIDEO CLIP with interactions.
 *
 * Uses Chrome DevTools Protocol (CDP) to take rapid screenshots while the
 * scene plays (with simulated clicks for interactive scenes), then stitches
 * them into an MP4 with FFmpeg.
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
    console.log(`[SceneCapture] Navigating to: ${sceneUrl} (recording ${captureDuration}s, channel: ${channel})`);
    const response = await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    console.log(`[SceneCapture] Page status: ${response ? response.status() : 'no response'}`);

    // Let the page fully render before starting capture
    await new Promise(r => setTimeout(r, 1500));

    // ── Set up interaction scheduler ──
    const pattern = getInteractionPattern(channel);
    let interactionTimer = null;
    let clickCount = 0;

    if (pattern.selectors.length > 0 && pattern.intervalMs > 0) {
      console.log(`[SceneCapture] Interactive mode for channel "${channel}" — clicking every ${pattern.intervalMs}ms`);

      // Schedule first click after initial delay
      const startInteractions = () => {
        interactionTimer = setInterval(async () => {
          try {
            await performInteraction(page, pattern.selectors, clickCount);
            clickCount++;
          } catch (e) {
            // Interaction errors are non-fatal — page may have changed
            console.log(`[SceneCapture] Interaction click ${clickCount} skipped: ${e.message}`);
          }
        }, pattern.intervalMs);
      };

      setTimeout(startInteractions, pattern.initialDelayMs);
    } else {
      console.log(`[SceneCapture] Passive mode for channel "${channel}" — no clicks, recording native animations`);
    }

    // ── Capture frames via rapid screenshots ──
    const totalFrames = Math.ceil(captureDuration * FRAME_RATE);
    const intervalMs = 1000 / FRAME_RATE;
    console.log(`[SceneCapture] Capturing ${totalFrames} frames at ${FRAME_RATE}fps...`);

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(frameDir, `frame_${String(i).padStart(5, '0')}.jpg`);
      await page.screenshot({
        path: framePath,
        type: 'jpeg',
        quality: 90,
        fullPage: false,
      });

      // Wait the frame interval (minus a small offset for screenshot overhead)
      if (i < totalFrames - 1) {
        await new Promise(r => setTimeout(r, intervalMs * 0.75));
      }
    }

    // Stop interactions
    if (interactionTimer) clearInterval(interactionTimer);

    console.log(`[SceneCapture] Captured ${totalFrames} frames (${clickCount} interactions performed)`);

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
 * Perform a single interaction click on the page.
 * Tries each selector in order until one succeeds.
 */
async function performInteraction(page, selectors, clickIndex) {
  for (const selector of selectors) {
    try {
      // Find all matching visible elements
      const elements = await page.$$(selector);

      for (const el of elements) {
        const isVisible = await el.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0';
        });

        if (isVisible) {
          // Scroll into view and click
          await el.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await new Promise(r => setTimeout(r, 200));
          await el.click();
          console.log(`[SceneCapture] Clicked: ${selector} (interaction #${clickIndex + 1})`);
          return; // One click per interval
        }
      }
    } catch {
      // Selector didn't match or element disappeared — try next
      continue;
    }
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
