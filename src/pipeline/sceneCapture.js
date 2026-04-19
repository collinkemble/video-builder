const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    await page.goto(sceneUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for content to render
    await page.waitForTimeout(2000);

    // Take screenshot
    const filename = `scene_${sceneId}_${channel}.png`;
    const outputPath = path.join(outputDir || os.tmpdir(), filename);

    await page.screenshot({
      path: outputPath,
      type: 'png',
      fullPage: false,
    });

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
 * Launch a headless Chrome browser configured for Heroku
 */
async function launchBrowser() {
  return puppeteer.launch({
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
