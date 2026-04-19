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
const FRAME_RATE = 15; // capture fps — balanced between smoothness and Heroku memory
const OUTPUT_FPS = 30; // final output video fps (FFmpeg interpolates)

/**
 * Determine if a channel type should have click interactions.
 * Instagram/social scenes have native video/animation — no clicks needed.
 * Email scenes are mostly static — no clicks needed.
 */
function shouldInteract(channel) {
  const ch = (channel || '').toLowerCase().replace(/[^a-z]/g, '');
  // These channels have video/animation that plays on its own
  if (ch.includes('instagram') || ch.includes('social') || ch.includes('facebook') || ch.includes('tiktok')) {
    return false;
  }
  // Email is mostly static
  if (ch.includes('email')) {
    return false;
  }
  // Everything else (website, chat, imessage, sms, retail, etc.) needs clicks
  return true;
}

/**
 * Get the click interval for a channel type (ms between clicks).
 */
function getClickInterval(channel) {
  const ch = (channel || '').toLowerCase().replace(/[^a-z]/g, '');
  if (ch.includes('imessage') || ch.includes('sms') || ch.includes('text')) return 2000;
  if (ch.includes('web') || ch.includes('chat') || ch.includes('agent')) return 2500;
  if (ch.includes('retail') || ch.includes('store') || ch.includes('pos')) return 3000;
  return 2500;
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
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });

    // Navigate to scene
    const sceneUrl = `${POCKETSIC_BASE}/scene/${sceneId}`;
    console.log(`[SceneCapture] Navigating to: ${sceneUrl} (recording ${captureDuration}s, channel: ${channel})`);
    const response = await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    console.log(`[SceneCapture] Page status: ${response ? response.status() : 'no response'}`);

    // Let the page fully render before starting capture
    await new Promise(r => setTimeout(r, 1500));

    // ── Block external navigation (PocketSIC CTAs link to real websites) ──
    await page.evaluate(() => {
      // Prevent all link clicks from navigating away
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link && link.href && !link.href.startsWith(window.location.origin)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      // Also block window.open and form submissions
      window.open = () => null;
    });

    // ── Dismiss PWA install banner if present ──
    try {
      const dismissBtn = await page.$('.pwa-dismiss-btn, button[class*="dismiss"], button[class*="Dismiss"]');
      if (dismissBtn) {
        await dismissBtn.click();
        console.log(`[SceneCapture] Dismissed PWA banner`);
        await new Promise(r => setTimeout(r, 500));
      }
    } catch { /* no banner */ }

    // ── Set up interaction scheduler ──
    const interactive = shouldInteract(channel);
    let interactionTimer = null;
    let clickCount = 0;

    if (interactive) {
      const intervalMs = getClickInterval(channel);
      console.log(`[SceneCapture] Interactive mode for channel "${channel}" — clicking every ${intervalMs}ms`);

      // Schedule first click after initial delay
      const startInteractions = () => {
        interactionTimer = setInterval(async () => {
          try {
            await performSmartClick(page, clickCount);
            clickCount++;
          } catch (e) {
            // Interaction errors are non-fatal — page may have changed
          }
        }, intervalMs);
      };

      setTimeout(startInteractions, 2000);
    } else {
      console.log(`[SceneCapture] Passive mode for channel "${channel}" — no clicks, recording native animations`);
    }

    // ── Capture frames via rapid screenshots ──
    const totalFrames = Math.ceil(captureDuration * FRAME_RATE);
    const intervalMs = 1000 / FRAME_RATE;
    console.log(`[SceneCapture] Capturing ${totalFrames} frames at ${FRAME_RATE}fps...`);

    let capturedFrames = 0;
    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(frameDir, `frame_${String(i).padStart(5, '0')}.jpg`);
      try {
        await page.screenshot({
          path: framePath,
          type: 'jpeg',
          quality: 85,
          fullPage: false,
        });
        capturedFrames++;
      } catch (screenshotErr) {
        // Page may have crashed — stop capturing but use whatever frames we have
        console.warn(`[SceneCapture] Screenshot failed at frame ${i}: ${screenshotErr.message}. Using ${capturedFrames} captured frames.`);
        break;
      }

      // Wait the frame interval (minus a small offset for screenshot overhead)
      if (i < totalFrames - 1) {
        await new Promise(r => setTimeout(r, intervalMs * 0.8));
      }
    }

    // Stop interactions
    if (interactionTimer) clearInterval(interactionTimer);

    console.log(`[SceneCapture] Captured ${capturedFrames}/${totalFrames} frames (${clickCount} interactions performed)`);

    if (capturedFrames < 3) {
      throw new Error(`Only captured ${capturedFrames} frames — not enough for video`);
    }

    // ── Stitch frames into MP4 with FFmpeg ──
    // Use actual captured duration if we got fewer frames than planned
    const actualDuration = capturedFrames / FRAME_RATE;
    const outputPath = path.join(outputDir || os.tmpdir(), `scene_${sceneId}_${channel}.mp4`);
    await stitchFramesToVideo(frameDir, outputPath, actualDuration);

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
 * Smart click — find the best interactive element on the page and click it.
 *
 * PocketSIC scenes are custom HTML pages without standardized selectors.
 * This function scans the DOM for visible, clickable elements and picks the
 * best one to click based on:
 *   1. Buttons and links that look like progression controls (send, next, reply, etc.)
 *   2. Elements with click handlers or cursor:pointer styling
 *   3. Skip PWA buttons, navigation chrome, and external links
 */
async function performSmartClick(page, clickIndex) {
  const clicked = await page.evaluate((idx) => {
    // Skip list — elements we should never click
    const skipTexts = ['install', 'dismiss', '✕', 'sign out', 'sign in', 'login', 'log in'];
    const skipClasses = ['pwa-install', 'pwa-dismiss', 'pwa-banner'];

    function shouldSkip(el) {
      const text = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      if (skipTexts.some(s => text === s)) return true;
      if (skipClasses.some(s => cls.includes(s))) return true;
      // Skip external links
      if (el.tagName === 'A' && el.href && !el.href.startsWith(window.location.origin)) return true;
      return false;
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 10 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        parseFloat(style.opacity) > 0.1 &&
        rect.top >= 0 && rect.top < window.innerHeight;
    }

    // Gather all clickable candidates
    const candidates = [];
    const allElements = document.querySelectorAll('button, a, [onclick], [role="button"], [tabindex="0"]');

    allElements.forEach(el => {
      if (!isVisible(el) || shouldSkip(el)) return;
      if (el.disabled) return;

      const text = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const rect = el.getBoundingClientRect();

      // Score — higher = more likely to be the right thing to click
      let score = 0;

      // Progression keywords get high scores
      if (/send|reply|next|continue|submit|type|tap|click|start|begin|go|proceed|confirm|accept|ok|yes|add|open/i.test(text)) score += 10;
      if (/send|reply|next|continue|submit|action|cta|primary|chat|message/i.test(cls)) score += 8;

      // Buttons get preference over links
      if (el.tagName === 'BUTTON') score += 3;

      // Elements in the lower half of the screen are more likely CTAs
      if (rect.top > window.innerHeight * 0.5) score += 2;

      // Larger elements are more likely primary CTAs
      if (rect.width > 100 && rect.height > 30) score += 2;

      // Elements that haven't been clicked before (use data attribute to track)
      if (!el.dataset._vbClicked) score += 5;

      candidates.push({ el, score, text: text.substring(0, 30), tag: el.tagName });
    });

    // Also look for elements with cursor:pointer that aren't buttons/links
    // (PocketSIC might use divs/spans as clickable elements)
    document.querySelectorAll('div, span, img, svg').forEach(el => {
      if (!isVisible(el) || shouldSkip(el)) return;
      const style = window.getComputedStyle(el);
      if (style.cursor !== 'pointer') return;
      // Skip if it's inside an already-found button/link
      if (el.closest('button, a, [role="button"]')) return;

      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim().toLowerCase();

      let score = 0;
      if (/send|reply|next|continue|tap|click/i.test(text)) score += 8;
      if (rect.width > 30 && rect.height > 30) score += 2;
      if (!el.dataset._vbClicked) score += 5;

      candidates.push({ el, score, text: text.substring(0, 30), tag: el.tagName });
    });

    if (candidates.length === 0) return null;

    // Sort by score (highest first), then click the best one
    candidates.sort((a, b) => b.score - a.score);

    // Pick the best unclicked candidate, or cycle through if all clicked
    let target = candidates.find(c => !c.el.dataset._vbClicked) || candidates[idx % candidates.length];

    if (target) {
      target.el.dataset._vbClicked = 'true';
      target.el.click();
      return { text: target.text, tag: target.tag, score: target.score };
    }

    return null;
  }, clickIndex);

  if (clicked) {
    console.log(`[SceneCapture] Smart click #${clickIndex + 1}: <${clicked.tag}> "${clicked.text}" (score: ${clicked.score})`);
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
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
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
  let browser = await launchBrowser();
  const results = [];

  try {
    // Capture serially to avoid memory issues on Heroku
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`Capturing scene ${i + 1}/${scenes.length}: ${scene.sceneId} (${scene.channel})`);

      try {
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
          imagePath: clipPath,
        });
      } catch (err) {
        // If Chrome crashed ("Connection closed"), relaunch and retry this scene once
        if (err.message.includes('Connection closed') || err.message.includes('Target closed') || err.message.includes('Session closed')) {
          console.warn(`[SceneCapture] Browser crashed on scene ${scene.sceneId}. Relaunching Chrome and retrying...`);
          try { await browser.close(); } catch { /* already dead */ }
          browser = await launchBrowser();

          try {
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
              imagePath: clipPath,
            });
          } catch (retryErr) {
            console.error(`[SceneCapture] Retry also failed for scene ${scene.sceneId}: ${retryErr.message}. Skipping.`);
          }
        } else {
          console.error(`[SceneCapture] Failed to capture scene ${scene.sceneId}: ${err.message}. Skipping.`);
        }
      }

      if (onProgress) onProgress(i + 1, scenes.length);
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
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
      // Note: removed --single-process — it causes entire browser to die on OOM
      // instead of just the renderer tab. Multi-process is more resilient on Heroku.
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--js-flags=--max-old-space-size=256',
    ],
    defaultViewport: null,
  });
}

module.exports = { captureScene, captureSceneStatic, captureAllScenes };
