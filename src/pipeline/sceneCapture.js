const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const POCKETSIC_BASE = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';

/**
 * Capture a single PocketSIC scene as a screenshot
 * @param {object} params
 * @param {number} params.sceneId - PocketSIC scene ID
 * @param {string} params.channel - Channel type (e.g. "insta", "email")
 * @param {string} params.outputDir - Directory to save captures
 * @param {object} params.browser - Puppeteer browser instance (reuse for batch)
 * @returns {Promise<string>} Path to captured image
 */
async function captureScene({ sceneId, channel, outputDir, browser }) {
  const ownBrowser = !browser;
  if (ownBrowser) {
    browser = await launchBrowser();
  }

  const page = await browser.newPage();

  try {
    // Set viewport to phone portrait (PocketSIC scenes are phone-sized)
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

    // Navigate to scene
    const sceneUrl = `${POCKETSIC_BASE}/scene/${sceneId}`;
    console.log(`[SceneCapture] Navigating to: ${sceneUrl}`);
    const response = await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    console.log(`[SceneCapture] Page status: ${response ? response.status() : 'no response'}`);

    // Wait for content to render
    await new Promise(r => setTimeout(r, 2000));

    // Take screenshot
    const filename = `scene_${sceneId}_${channel}.png`;
    const outputPath = path.join(outputDir || os.tmpdir(), filename);

    await page.screenshot({
      path: outputPath,
      type: 'png',
      fullPage: false,
    });

    // Verify file was created
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Screenshot not saved at ${outputPath}`);
    }
    const stats = fs.statSync(outputPath);
    console.log(`[SceneCapture] Captured: ${outputPath} (${(stats.size / 1024).toFixed(1)}KB)`);

    return outputPath;
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

/**
 * Capture all scenes for a video (batch)
 * @param {Array} scenes - Array of { sceneId, channel }
 * @param {string} outputDir - Directory for captures
 * @param {function} onProgress - Progress callback (completed, total)
 * @returns {Promise<Array>} Array of { sceneId, channel, imagePath }
 */
async function captureAllScenes(scenes, outputDir, onProgress) {
  const browser = await launchBrowser();
  const results = [];

  try {
    // Capture serially to avoid memory issues on Heroku
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`Capturing scene ${i + 1}/${scenes.length}: ${scene.sceneId} (${scene.channel})`);

      const imagePath = await captureScene({
        sceneId: scene.sceneId,
        channel: scene.channel,
        outputDir,
        browser,
      });

      results.push({
        sceneId: scene.sceneId,
        channel: scene.channel,
        imagePath,
      });

      if (onProgress) onProgress(i + 1, scenes.length);
    }
  } finally {
    await browser.close();
  }

  return results;
}

/**
 * Find the system-installed Chrome/Chromium executable.
 * On Heroku, the google-chrome buildpack puts it at /app/.apt/usr/bin/google-chrome
 * or it may be on PATH as google-chrome-stable / google-chrome / chromium-browser.
 */
function findChromePath() {
  // Check GOOGLE_CHROME_BIN env var (set by Heroku buildpack)
  if (process.env.GOOGLE_CHROME_BIN) return process.env.GOOGLE_CHROME_BIN;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  // Check common Heroku paths (chrome-for-testing buildpack, apt-based buildpacks)
  const candidates = [
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/app/.apt/usr/bin/google-chrome',
    '/app/.apt/usr/bin/google-chrome-stable',
    '/app/.apt/usr/bin/chromium-browser',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Try which
  try {
    const result = execSync('which google-chrome-stable || which google-chrome || which chromium-browser', { encoding: 'utf-8' }).trim();
    if (result) return result;
  } catch { /* not found via which */ }

  throw new Error('Chrome not found. Ensure the Google Chrome buildpack is installed on Heroku.');
}

/**
 * Launch a headless Chrome browser configured for Heroku
 */
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

module.exports = { captureScene, captureAllScenes };
