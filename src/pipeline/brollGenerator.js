const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const os = require('os');

let genai = null;

function getGenAI() {
  if (genai) return genai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  genai = new GoogleGenAI({ apiKey });
  return genai;
}

/**
 * Generate a b-roll image from a description using Gemini Imagen
 * @param {object} params
 * @param {string} params.description - Description of the image to generate
 * @param {string} params.brandName - Brand name for context
 * @param {string} params.outputDir - Directory to save image
 * @returns {Promise<string>} Path to generated image
 */
async function generateBrollImage({ description, brandName, outputDir }) {
  const ai = getGenAI();

  const prompt = `Professional, cinematic b-roll image for a ${brandName || 'brand'} customer experience video: ${description}.
Style: Clean, modern, high-quality stock photography look. Warm, inviting lighting. No text or logos.`;

  try {
    console.log(`[B-Roll] Generating image: "${description.substring(0, 60)}..."`);
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-exp-image-generation',
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    // Check if image was generated
    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (imagePart && imagePart.inlineData) {
      const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const filename = `broll_${Date.now()}.png`;
      const outputPath = path.join(outputDir || os.tmpdir(), filename);
      fs.writeFileSync(outputPath, imageBuffer);
      console.log(`[B-Roll] AI image generated: ${outputPath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
      return outputPath;
    }

    console.warn('[B-Roll] No image in response. Parts:', parts.map(p => p.text ? 'text' : p.inlineData ? 'image' : 'unknown'));
    // Fallback: generate a simple gradient placeholder
    return await generatePlaceholderImage({ description, brandName, outputDir });
  } catch (err) {
    console.warn(`[B-Roll] Generation failed: ${err.message}. Using placeholder.`);
    return await generatePlaceholderImage({ description, brandName, outputDir });
  }
}

/**
 * Generate a placeholder image when AI image generation fails.
 * Renders an SVG as a PNG using Puppeteer (headless Chrome) since FFmpeg
 * doesn't have an SVG decoder.
 */
async function generatePlaceholderImage({ description, brandName, outputDir }) {
  const puppeteer = require('puppeteer-core');
  const { execSync } = require('child_process');

  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#032D60;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#0176D3;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#bg)"/>
    <text x="960" y="500" text-anchor="middle" fill="white" font-family="Arial" font-size="48" font-weight="bold">${escapeXml(brandName || 'Video Builder')}</text>
    <text x="960" y="580" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-family="Arial" font-size="24">${escapeXml(truncate(description || '', 80))}</text>
  </svg>`;

  const filename = `broll_placeholder_${Date.now()}.png`;
  const outputPath = path.join(outputDir || os.tmpdir(), filename);

  // Find Chrome (same logic as sceneCapture)
  function findChrome() {
    if (process.env.GOOGLE_CHROME_BIN) return process.env.GOOGLE_CHROME_BIN;
    if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
    const candidates = ['/app/.chrome-for-testing/chrome-linux64/chrome', '/app/.apt/usr/bin/google-chrome'];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    try { return execSync('which google-chrome-stable || which google-chrome || which chromium-browser', { encoding: 'utf-8' }).trim(); } catch {}
    throw new Error('Chrome not found for placeholder generation');
  }

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">${svg}</body></html>`, { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
    await page.close();
  } finally {
    await browser.close();
  }

  return outputPath;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

/**
 * Generate all b-roll images for a video
 * @param {Array} segments - B-roll segments from script
 * @param {string} brandName
 * @param {string} outputDir
 * @param {function} onProgress
 * @returns {Promise<Array>} Array of { order, imagePath }
 */
async function generateAllBroll(segments, brandName, outputDir, onProgress) {
  const results = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    console.log(`Generating b-roll ${i + 1}/${segments.length}: ${seg.brollDescription?.substring(0, 50)}...`);

    const imagePath = await generateBrollImage({
      description: seg.brollDescription || 'Professional lifestyle image',
      brandName,
      outputDir,
    });

    results.push({
      order: seg.order,
      imagePath,
    });

    if (onProgress) onProgress(i + 1, segments.length);
  }

  return results;
}

module.exports = { generateBrollImage, generateAllBroll };
