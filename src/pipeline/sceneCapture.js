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

// ════════════════════════════════════════════════════════════════
// Channel detection helpers
// ════════════════════════════════════════════════════════════════

function normalizeChannel(channel) {
  return (channel || '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Determine if a channel type should have click interactions.
 */
function shouldInteract(channel) {
  const ch = normalizeChannel(channel);
  // These channels have video/animation that plays on its own
  if (ch.includes('instagram') || ch.includes('social') || ch.includes('facebook') || ch.includes('tiktok')) return false;
  // Email is mostly static
  if (ch.includes('email')) return false;
  // Everything else (website, chat, imessage, sms, whatsapp, retail, etc.) needs clicks
  return true;
}

/**
 * Classify the scene interaction model from the channel string.
 * Returns: 'messaging' | 'website' | 'retail' | 'generic'
 */
function getSceneType(channel) {
  const ch = normalizeChannel(channel);
  if (ch.includes('imessage') || ch.includes('sms') || ch.includes('text') || ch.includes('whatsapp')) return 'messaging';
  if (ch.includes('web') || ch.includes('chat') || ch.includes('agent')) return 'website';
  if (ch.includes('retail') || ch.includes('store') || ch.includes('pos')) return 'retail';
  return 'generic';
}

// ════════════════════════════════════════════════════════════════
// Channel-specific interaction strategies
// ════════════════════════════════════════════════════════════════

/**
 * MESSAGING scenes (iMessage, WhatsApp, SMS):
 *   - Messages are #msg1..#msgN, first is already visible
 *   - Click anywhere on document.body to advance
 *   - N messages → N-1 clicks (one more click resets!)
 *   - Typing indicator shows for ~1s before received messages
 */
async function setupMessagingInteraction(page) {
  // Dismiss the "tap to continue" hint if present
  await page.evaluate(() => {
    const hint = document.querySelector('.tap-hint');
    if (hint) hint.remove();
  });

  // Count total messages
  const totalMessages = await page.evaluate(() => {
    let count = 0;
    while (document.getElementById(`msg${count + 1}`)) count++;
    return count;
  });

  const clickLimit = Math.max(totalMessages - 1, 1);
  const clickInterval = 2200; // 2.2s between clicks — enough for typing indicator animation
  console.log(`[SceneCapture] Messaging: ${totalMessages} messages, will click ${clickLimit} times`);

  return { clickLimit, clickInterval, clickFn: 'messaging' };
}

/**
 * WEBSITE scenes (web chat, Agentforce):
 *   - First: click #chatFab or #agentBanner to open the chat panel
 *   - Then: click #chatInputArea to advance messages
 *   - Customer messages need 2 clicks (1 to start typing animation, 1 to "send")
 *   - Agent messages auto-advance after a customer message is sent (no clicks needed)
 *   - So total clicks = 1 (open) + 2 per customer message
 */
async function setupWebsiteInteraction(page) {
  const chatInfo = await page.evaluate(() => {
    const chatContent = document.getElementById('chatContent');
    if (!chatContent) return { totalMsgs: 0, customerMsgs: 0, hasChat: false };

    const msgs = chatContent.querySelectorAll('.msg');
    let customerMsgs = 0;
    msgs.forEach(m => {
      if (m.classList.contains('msg-customer')) customerMsgs++;
    });

    const hasChatFab = !!document.getElementById('chatFab');
    const hasAgentBanner = !!document.getElementById('agentBanner');

    return {
      totalMsgs: msgs.length,
      customerMsgs,
      hasChat: hasChatFab || hasAgentBanner,
    };
  });

  // Click budget:
  //   1 click to open the chat panel
  //   2 clicks per customer message (click 1 = type animation, click 2 = send)
  //   Agent messages auto-advance after each customer send — no clicks needed
  let clickLimit;
  if (chatInfo.hasChat && chatInfo.customerMsgs > 0) {
    clickLimit = 1 + (chatInfo.customerMsgs * 2);
  } else if (chatInfo.hasChat) {
    clickLimit = 3; // fallback if no customer msgs found
  } else {
    clickLimit = 3;
  }

  // Use a longer interval — agent auto-advance needs time for typing indicators
  const clickInterval = 3000;
  console.log(`[SceneCapture] Website: ${chatInfo.totalMsgs} msgs (${chatInfo.customerMsgs} customer), clickLimit=${clickLimit}, interval=${clickInterval}ms`);

  return { clickLimit, clickInterval, clickFn: 'website', chatInfo };
}

/**
 * RETAIL scenes (POS, store):
 *   - Similar click-to-advance pattern with product cards
 *   - Generic smart click approach works here
 */
async function setupRetailInteraction(page) {
  const interactiveCount = await page.evaluate(() => {
    let count = 0;
    document.querySelectorAll('button, [role="button"], [onclick]').forEach(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden') count++;
    });
    return count;
  });

  const clickLimit = Math.max(interactiveCount - 1, 2);
  const clickInterval = 3000;
  console.log(`[SceneCapture] Retail: ${interactiveCount} interactive elements, ${clickLimit} clicks`);

  return { clickLimit, clickInterval, clickFn: 'generic' };
}


// ════════════════════════════════════════════════════════════════
// Click execution functions
// ════════════════════════════════════════════════════════════════

/**
 * Messaging click: just click the body. PocketSIC messaging scenes
 * use document.body click handler to advance the conversation.
 */
async function performMessagingClick(page, clickIndex) {
  await page.evaluate(() => {
    document.body.click();
  });
  console.log(`[SceneCapture] Messaging click #${clickIndex + 1} (body)`);
}

/**
 * Website click: first click opens chat, subsequent clicks advance the conversation.
 *
 * Pattern:
 *   Click 0: Open chat panel via #chatFab or #agentBanner
 *   Click 1: Start customer typing animation (click #chatInputArea)
 *   Click 2: Send customer message + agent auto-replies (click #chatInputArea)
 *   Click 3: Start next customer typing... (click #chatInputArea)
 *   Click 4: Send next customer message + agent auto-replies... etc.
 */
async function performWebsiteClick(page, clickIndex, chatInfo) {
  if (clickIndex === 0) {
    // First click: open the chat panel
    const opened = await page.evaluate(() => {
      const chatFab = document.getElementById('chatFab');
      if (chatFab) { chatFab.click(); return 'chatFab'; }
      const agentBanner = document.getElementById('agentBanner');
      if (agentBanner) { agentBanner.click(); return 'agentBanner'; }
      // Fallback: look for anything chat/agent related
      const els = document.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const el of els) {
        const text = (el.textContent || '').toLowerCase();
        if (text.includes('chat') || text.includes('agent') || text.includes('ask')) {
          el.click();
          return `element: "${text.substring(0, 30)}"`;
        }
      }
      return null;
    });
    console.log(`[SceneCapture] Website click #1: opened chat via ${opened}`);
  } else {
    // Subsequent clicks: advance the chat by clicking the input area (send button area)
    // This triggers advanceChat() which handles both customer typing and sending
    const clicked = await page.evaluate(() => {
      // Prefer #chatInputArea — it's the bottom bar with the send button
      const chatInput = document.getElementById('chatInputArea');
      if (chatInput) { chatInput.click(); return 'chatInputArea'; }
      // Fallback to #chatContent
      const chatContent = document.getElementById('chatContent');
      if (chatContent) { chatContent.click(); return 'chatContent'; }
      return null;
    });
    console.log(`[SceneCapture] Website click #${clickIndex + 1}: advance via ${clicked}`);
  }
}

/**
 * Generic smart click: find the best clickable element and click it.
 * Used for retail and unknown scene types.
 */
async function performGenericClick(page, clickIndex) {
  const clicked = await page.evaluate((idx) => {
    const skipTexts = ['install', 'dismiss', '✕', 'sign out', 'sign in', 'login', 'log in'];
    const skipClasses = ['pwa-install', 'pwa-dismiss', 'pwa-banner'];

    function shouldSkip(el) {
      const text = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      if (skipTexts.some(s => text === s)) return true;
      if (skipClasses.some(s => cls.includes(s))) return true;
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

    const candidates = [];
    document.querySelectorAll('button, a, [onclick], [role="button"], [tabindex="0"]').forEach(el => {
      if (!isVisible(el) || shouldSkip(el) || el.disabled) return;
      const text = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const rect = el.getBoundingClientRect();

      let score = 0;
      if (/send|reply|next|continue|submit|tap|click|start|begin|go|proceed|confirm|accept|ok|yes|add|open/i.test(text)) score += 10;
      if (/send|reply|next|continue|submit|action|cta|primary|chat|message/i.test(cls)) score += 8;
      if (el.tagName === 'BUTTON') score += 3;
      if (rect.top > window.innerHeight * 0.5) score += 2;
      if (rect.width > 100 && rect.height > 30) score += 2;
      if (!el.dataset._vbClicked) score += 5;

      candidates.push({ el, score, text: text.substring(0, 30), tag: el.tagName });
    });

    // Also check cursor:pointer divs/spans
    document.querySelectorAll('div, span, img, svg').forEach(el => {
      if (!isVisible(el) || shouldSkip(el)) return;
      const style = window.getComputedStyle(el);
      if (style.cursor !== 'pointer') return;
      if (el.closest('button, a, [role="button"]')) return;
      const text = (el.textContent || '').trim().toLowerCase();
      let score = 0;
      if (/send|reply|next|continue|tap|click/i.test(text)) score += 8;
      if (!el.dataset._vbClicked) score += 5;
      candidates.push({ el, score, text: text.substring(0, 30), tag: el.tagName });
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    let target = candidates.find(c => !c.el.dataset._vbClicked) || candidates[idx % candidates.length];
    if (target) {
      target.el.dataset._vbClicked = 'true';
      target.el.click();
      return { text: target.text, tag: target.tag, score: target.score };
    }
    return null;
  }, clickIndex);

  if (clicked) {
    console.log(`[SceneCapture] Generic click #${clickIndex + 1}: <${clicked.tag}> "${clicked.text}" (score: ${clicked.score})`);
  }
}


// ════════════════════════════════════════════════════════════════
// Main scene capture
// ════════════════════════════════════════════════════════════════

/**
 * Capture a single PocketSIC scene as a VIDEO CLIP with interactions.
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
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link && link.href && !link.href.startsWith(window.location.origin)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      window.open = () => null;
    });

    // ── Dismiss PWA install banner if present ──
    try {
      await page.evaluate(() => {
        const pwa = document.querySelector('.pwa-install-banner, .pwa-banner, [class*="pwa-install"], [class*="pwa-dismiss"]');
        if (pwa) pwa.remove();
        // Also try the dismiss button
        const dismissBtn = document.querySelector('.pwa-dismiss-btn, button[class*="dismiss"], button[class*="Dismiss"]');
        if (dismissBtn) dismissBtn.click();
      });
      await new Promise(r => setTimeout(r, 300));
    } catch { /* no banner */ }

    // ── Set up channel-specific interaction strategy ──
    const interactive = shouldInteract(channel);
    let interactionTimer = null;
    let clickCount = 0;

    if (interactive) {
      const sceneType = getSceneType(channel);
      let strategy;

      switch (sceneType) {
        case 'messaging':
          strategy = await setupMessagingInteraction(page);
          break;
        case 'website':
          strategy = await setupWebsiteInteraction(page);
          break;
        case 'retail':
          strategy = await setupRetailInteraction(page);
          break;
        default:
          strategy = { clickLimit: 4, clickInterval: 2500, clickFn: 'generic' };
      }

      const { clickLimit, clickInterval, clickFn, chatInfo } = strategy;

      // Schedule clicks after initial delay (let the initial state render + record a bit)
      const startInteractions = () => {
        interactionTimer = setInterval(async () => {
          if (clickCount >= clickLimit) {
            clearInterval(interactionTimer);
            interactionTimer = null;
            console.log(`[SceneCapture] Reached click limit (${clickLimit}). Stopping.`);
            return;
          }
          try {
            switch (clickFn) {
              case 'messaging':
                await performMessagingClick(page, clickCount);
                break;
              case 'website':
                await performWebsiteClick(page, clickCount, chatInfo);
                break;
              default:
                await performGenericClick(page, clickCount);
            }
            clickCount++;
          } catch (e) {
            // Interaction errors are non-fatal — page may have navigated or element gone
          }
        }, clickInterval);
      };

      // Start interactions after 2 seconds (so the initial state is captured first)
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
        console.warn(`[SceneCapture] Screenshot failed at frame ${i}: ${screenshotErr.message}. Using ${capturedFrames} captured frames.`);
        break;
      }

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


// ════════════════════════════════════════════════════════════════
// FFmpeg stitching & utilities
// ════════════════════════════════════════════════════════════════

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
 * Static capture for fallback / thumbnail
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
 */
async function captureAllScenes(scenes, outputDir, onProgress) {
  let browser = await launchBrowser();
  const results = [];

  try {
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
        // If Chrome crashed, relaunch and retry once
        if (err.message.includes('Connection closed') || err.message.includes('Target closed') || err.message.includes('Session closed')) {
          console.warn(`[SceneCapture] Browser crashed on scene ${scene.sceneId}. Relaunching and retrying...`);
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
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--js-flags=--max-old-space-size=256',
    ],
    defaultViewport: null,
  });
}

module.exports = { captureScene, captureSceneStatic, captureAllScenes };
