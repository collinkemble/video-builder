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

// ════════════════════════════════════════════════════════════════
// B-Roll VIDEO generation (Veo) — primary path
// ════════════════════════════════════════════════════════════════

const VIDEO_PROMPT_RULES = `Style: Cinematic b-roll footage. Smooth, slow camera movement. Warm natural lighting. Shallow depth of field. High production value.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display showing content.
2. ABSOLUTELY NO close-ups of devices — do not show any device screen from an angle where you can see what is displayed.
3. DO NOT generate images of people looking at screens, typing on keyboards, or using touchscreens in close-up.
4. INSTEAD focus on: people's faces and emotions, hands gesturing, walking, shopping in stores, outdoor environments, coffee shops, cityscapes, nature, product packaging, storefronts, lifestyle moments.
5. No text overlays, no logos, no UI mockups.
6. Slow cinematic motion only — no rapid movement.`;

/**
 * Poll a Veo video operation until done.
 * @returns {Promise<object>} The completed operation
 */
async function pollVeoOperation(ai, operation, label, maxWait = 300000) {
  const pollInterval = 10000;
  const startTime = Date.now();

  console.log(`[B-Roll Video] ${label}: Polling every ${pollInterval / 1000}s (max ${maxWait / 1000}s)...`);

  while (!operation.done) {
    if (Date.now() - startTime > maxWait) {
      console.warn(`[B-Roll Video] ${label}: Timeout (${(maxWait / 1000)}s).`);
      return operation;
    }
    await new Promise(r => setTimeout(r, pollInterval));
    operation = await ai.operations.getVideosOperation({ operation });
    console.log(`[B-Roll Video] ${label}: Polling... (${Math.round((Date.now() - startTime) / 1000)}s) done=${operation.done}`);
  }

  return operation;
}

/**
 * Generate a b-roll VIDEO clip from a description using Google Veo.
 * Generates a single 8-second clip (Veo maximum per generation).
 * The compositor handles looping if the segment needs to be longer.
 *
 * @param {object} params
 * @param {string} params.description - What the clip should show
 * @param {string} params.brandName - Brand name for context
 * @param {string} params.outputDir - Directory to save the clip
 * @param {string} params.segmentType - Segment type (intro/transition/outro) for prompt context
 * @param {string} params.segmentChannel - Channel name for prompt context
 * @returns {Promise<string|null>} Path to MP4 clip, or null if video gen failed
 */
async function generateBrollVideo({ description, brandName, outputDir, segmentType = '', segmentChannel = '' }) {
  const ai = getGenAI();

  // Add context about the segment role for more fitting footage
  let contextHint = '';
  if (segmentType === 'intro') {
    contextHint = 'This is the OPENING shot of the video — use a wide, establishing cinematic shot that sets the mood. ';
  } else if (segmentType === 'outro') {
    contextHint = 'This is the CLOSING shot of the video — use a warm, conclusive cinematic shot that feels like a satisfying ending. ';
  } else if (segmentType === 'transition') {
    contextHint = `This is a TRANSITION shot bridging two scenes${segmentChannel ? ` (coming from: ${segmentChannel})` : ''} — show movement, travel, or passage of time. `;
  }

  const prompt = `${contextHint}Professional cinematic b-roll footage for a ${brandName || 'brand'} customer experience video: ${description}.\n${VIDEO_PROMPT_RULES}`;

  const modelName = 'veo-3.1-generate-preview';

  try {
    console.log(`[B-Roll Video] Generating 8s clip with ${modelName}: "${description.substring(0, 60)}..."`);

    // Generate a single 8-second clip (max for one Veo generation)
    // The compositor uses -stream_loop to seamlessly loop it if the segment is longer
    let operation = await ai.models.generateVideos({
      model: modelName,
      prompt,
      config: {
        aspectRatio: '16:9',
        resolution: '720p',
        durationSeconds: 8,
        numberOfVideos: 1,
        personGeneration: 'allow_all',
      },
    });

    operation = await pollVeoOperation(ai, operation, 'generation');

    if (!operation.done) return null;

    // Extract video
    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo || !generatedVideo.video) {
      console.warn(`[B-Roll Video] ${modelName} completed but no video in response.`);
      return null;
    }

    // Download the video file
    const filename = `broll_video_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir || os.tmpdir(), filename);

    await ai.files.download({
      file: generatedVideo.video,
      downloadPath: outputPath,
    });

    const stats = fs.statSync(outputPath);
    console.log(`[B-Roll Video] Generated: ${outputPath} (8s, ${(stats.size / 1024).toFixed(1)}KB)`);
    return outputPath;

  } catch (err) {
    const errMsg = err.message || String(err);
    console.warn(`[B-Roll Video] ${modelName} failed: ${errMsg}`);
    if (err.status) console.warn(`[B-Roll Video] HTTP status: ${err.status}`);
    if (err.statusText) console.warn(`[B-Roll Video] Status text: ${err.statusText}`);
    if (err.errorDetails) console.warn(`[B-Roll Video] Error details: ${JSON.stringify(err.errorDetails).substring(0, 500)}`);
    if (errMsg.includes('billing') || errMsg.includes('quota') || errMsg.includes('permission') || errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED')) {
      console.warn('[B-Roll Video] Veo requires a paid-tier Gemini API key with billing enabled.');
    }
  }

  console.warn('[B-Roll Video] Veo failed. Falling back to image generation.');
  return null;
}


// ════════════════════════════════════════════════════════════════
// B-Roll IMAGE generation (Gemini Imagen) — fallback path
// ════════════════════════════════════════════════════════════════

/**
 * Generate a b-roll image from a description using Gemini Imagen.
 * Used as fallback when video generation is unavailable.
 * @returns {Promise<string>} Path to generated PNG image
 */
async function generateBrollImage({ description, brandName, outputDir }) {
  const ai = getGenAI();

  const prompt = `Professional, cinematic b-roll photograph for a ${brandName || 'brand'} customer experience video: ${description}.
Style: Clean, modern, high-quality stock photography. Warm, inviting lighting. Shallow depth of field.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display.
2. ABSOLUTELY NO close-ups of devices showing screen content.
3. DO NOT show people looking at screens or using touchscreens in close-up.
4. INSTEAD focus on: people's faces, emotions, hands, shopping, outdoor scenes, storefronts, lifestyle moments, environments, nature, cityscapes.
5. No text, no logos, no UI mockups.`;

  // Image generation models — ordered newest to oldest
  // gemini-2.0-flash models sunset June 1 2026
  const modelNames = [
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-exp-image-generation',
  ];

  for (const modelName of modelNames) {
    try {
      console.log(`[B-Roll Image] Generating with ${modelName}: "${description.substring(0, 60)}..."`);
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData);

      if (imagePart && imagePart.inlineData) {
        const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        const filename = `broll_${Date.now()}.png`;
        const outputPath = path.join(outputDir || os.tmpdir(), filename);
        fs.writeFileSync(outputPath, imageBuffer);
        console.log(`[B-Roll Image] Generated with ${modelName}: ${outputPath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
        return outputPath;
      }

      console.warn(`[B-Roll Image] No image from ${modelName}.`);
      continue;
    } catch (err) {
      console.warn(`[B-Roll Image] ${modelName} failed: ${err.message}`);
      continue;
    }
  }

  console.warn('[B-Roll] All image models also failed. Using placeholder.');
  return await generatePlaceholderImage({ description, brandName, outputDir });
}


// ════════════════════════════════════════════════════════════════
// Placeholder fallback (gradient card)
// ════════════════════════════════════════════════════════════════

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


// ════════════════════════════════════════════════════════════════
// Main entry point — tries video first, falls back to image
// ════════════════════════════════════════════════════════════════

/**
 * Generate a b-roll asset (video clip preferred, image fallback).
 * @param {object} params
 * @param {string} params.description - What the clip should show
 * @param {string} params.brandName - Brand name for context
 * @param {string} params.outputDir - Directory to save the clip
 * @param {number} params.targetDuration - Desired clip length in seconds (default 8)
 * @returns {Promise<string>} Path to MP4 video or PNG image
 */
async function generateBroll({ description, brandName, outputDir, segmentType = '', segmentChannel = '' }) {
  // Try video generation first (Veo) — generates 8s clips
  const videoPath = await generateBrollVideo({ description, brandName, outputDir, segmentType, segmentChannel });
  if (videoPath) return videoPath;

  // Fallback to image generation (Gemini Imagen)
  return await generateBrollImage({ description, brandName, outputDir });
}

/**
 * Generate all b-roll assets for a video.
 * @param {Array} segments - B-roll segments from script
 * @param {string} brandName
 * @param {string} outputDir
 * @param {function} onProgress
 * @returns {Promise<Array>} Array of { order, imagePath }
 */
async function generateAllBroll(segments, brandName, outputDir, onProgress) {
  const results = [];
  let videoCount = 0;
  let imageCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    console.log(`[B-Roll] Generating ${i + 1}/${segments.length} (${seg.type || 'broll'}): ${seg.brollDescription?.substring(0, 50)}...`);

    const mediaPath = await generateBroll({
      description: seg.brollDescription || 'Professional lifestyle image',
      brandName,
      outputDir,
      segmentType: seg.type || '',
      segmentChannel: seg.channel || '',
    });

    if (mediaPath.endsWith('.mp4')) {
      videoCount++;
      console.log(`[B-Roll] ${i + 1}/${segments.length}: Got VIDEO clip → ${path.basename(mediaPath)}`);
    } else {
      imageCount++;
      console.log(`[B-Roll] ${i + 1}/${segments.length}: Got still IMAGE → ${path.basename(mediaPath)}`);
    }

    results.push({
      order: seg.order,
      imagePath: mediaPath,  // kept as 'imagePath' for backward compat with compositor
    });

    if (onProgress) onProgress(i + 1, segments.length);
  }

  console.log(`[B-Roll] Complete: ${videoCount} video clips, ${imageCount} still images out of ${segments.length} segments`);
  return results;
}

module.exports = { generateBrollImage, generateBrollVideo, generateBroll, generateAllBroll };
