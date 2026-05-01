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

// Rules for clips WITH persona reference image — person is OK since Veo matches them
const VIDEO_PROMPT_RULES_WITH_PERSONA = `Style: Cinematic b-roll footage. Smooth, slow camera movement. Warm natural lighting. Shallow depth of field. High production value.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display showing content.
2. ABSOLUTELY NO close-ups of devices — do not show any device screen from an angle where you can see what is displayed.
3. DO NOT generate images of people looking at screens, typing on keyboards, or using touchscreens in close-up.
4. Feature the person from the reference image as the MAIN character. Show them in lifestyle moments: walking, shopping, enjoying products, in beautiful environments.
5. ABSOLUTELY NO text of any kind — no text overlays, no logos, no UI mockups, no signage with readable text, no writing on vehicles, no labels, no brand names visible, no letters or words anywhere in the scene.
6. Slow cinematic motion only — no rapid movement.
7. ABSOLUTELY NO morphing between people — the person must remain the SAME throughout. Do NOT transition one person into a different person.
8. Show only ONE person (the reference person) per shot. Never add random other people.
9. NO delivery trucks, shipping vehicles, or logistics imagery.`;

// Rules for clips WITHOUT persona reference — NO PEOPLE to avoid random strangers
const VIDEO_PROMPT_RULES_NO_PERSONA = `Style: Cinematic b-roll footage. Smooth, slow camera movement. Warm natural lighting. Shallow depth of field. High production value.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO PEOPLE — do not show any human faces, bodies, hands, or silhouettes. This clip has no character reference, so any person shown will be a random stranger that breaks story continuity. Show ONLY environments, objects, products, architecture, nature, and atmospheric shots.
2. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display showing content.
3. ABSOLUTELY NO close-ups of devices.
4. INSTEAD focus on: beautiful environments, storefronts, product displays, nature scenes, cityscapes, architecture, atmospheric lighting, textures, objects related to the brand.
5. ABSOLUTELY NO text of any kind — no text overlays, no logos, no UI mockups, no signage with readable text, no writing on vehicles, no labels, no brand names visible, no letters or words anywhere in the scene.
6. Slow cinematic motion only — no rapid movement.
7. NO delivery trucks, shipping vehicles, or logistics imagery.
8. Focus on MOOD and ATMOSPHERE — the visual should evoke the feeling of the brand without showing people.`;

/**
 * Poll a Veo video operation until done.
 * @returns {Promise<object>} The completed operation
 */
async function pollVeoOperation(ai, operation, label, maxWait = 120000) {
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
 * @param {string} params.brandDescription - Brand description/industry for context
 * @param {string} params.personaDescription - Persona description for context
 * @param {string} params.outputDir - Directory to save the clip
 * @param {string} params.segmentType - Segment type (intro/transition/outro) for prompt context
 * @param {string} params.segmentChannel - Channel name for prompt context
 * @param {string} params.personaImageUrl - Optional persona image URL for character consistency
 * @returns {Promise<string|null>} Path to MP4 clip, or null if video gen failed
 */
async function generateBrollVideo({ description, brandName, brandDescription = '', personaDescription = '', outputDir, segmentType = '', segmentChannel = '', personaImageUrl = null }) {
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

  // If persona image is provided, enhance the prompt to explicitly mention the person
  let personaPromptHint = '';
  if (personaImageUrl) {
    personaPromptHint = 'IMPORTANT: You MUST feature the exact person from the provided reference image as the main character in this clip. Match their face, hair, skin tone, body type, and all physical features precisely from the reference image. Do not change their appearance in any way. ';
  }

  // Build brand/persona context to ground the visual in the right world
  let brandContext = '';
  if (brandDescription) {
    brandContext += `Brand context: ${brandName || 'brand'} — ${brandDescription}. `;
  }
  if (personaDescription) {
    brandContext += `The story follows: ${personaDescription}. `;
  }

  // Use different rules depending on whether we have a persona reference image
  const rules = personaImageUrl ? VIDEO_PROMPT_RULES_WITH_PERSONA : VIDEO_PROMPT_RULES_NO_PERSONA;

  const prompt = `${contextHint}${personaPromptHint}${brandContext}Professional cinematic b-roll footage for a ${brandName || 'brand'} customer experience video: ${description}.\n${rules}`;

  const modelName = 'veo-3.1-generate-preview';

  try {
    console.log(`[B-Roll Video] Generating 8s clip with ${modelName}: "${description.substring(0, 60)}..."${personaImageUrl ? ' (with persona reference image)' : ''}`);

    // Build Veo config
    const veoConfig = {
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 8,
      numberOfVideos: 1,
      personGeneration: 'allow_all',
    };

    // If persona image is provided, download and pass as reference image for character consistency.
    // Uses referenceType: "ASSET" (uppercase per SDK enum) to preserve the subject's appearance.
    // referenceImages goes INSIDE config per the Gemini API spec.
    if (personaImageUrl) {
      try {
        console.log(`[B-Roll Video] Downloading persona image for Veo reference: ${personaImageUrl.substring(0, 80)}...`);
        let imgResp = await fetch(personaImageUrl);

        // If public URL fails, try presigned URL from R2 as fallback
        if (!imgResp.ok && personaImageUrl.includes('r2.dev/')) {
          console.log(`[B-Roll Video] Public URL returned ${imgResp.status}, trying presigned URL fallback...`);
          try {
            const { getPresignedUrl } = require('../utils/r2');
            // Extract the R2 key from the public URL (everything after the domain/)
            const urlObj = new URL(personaImageUrl);
            const r2Key = urlObj.pathname.replace(/^\//, '');
            const presignedUrl = await getPresignedUrl(r2Key, 300);
            imgResp = await fetch(presignedUrl);
            if (imgResp.ok) {
              console.log(`[B-Roll Video] ✅ Presigned URL fallback worked for persona image`);
            }
          } catch (presignErr) {
            console.warn(`[B-Roll Video] Presigned URL fallback failed: ${presignErr.message}`);
          }
        }

        if (imgResp.ok) {
          let imgBuffer = Buffer.from(await imgResp.arrayBuffer());
          console.log(`[B-Roll Video] Downloaded persona image: ${(imgBuffer.length / 1024).toFixed(0)}KB`);

          // If image is very large (>2MB), resize to avoid API limits
          if (imgBuffer.length > 2 * 1024 * 1024) {
            console.log(`[B-Roll Video] Image too large (${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB), will proceed but may hit size limits`);
          }

          const base64Data = imgBuffer.toString('base64');
          // Detect mime type from content-type header or URL
          const contentType = imgResp.headers.get('content-type') || '';
          const mimeType = contentType.includes('jpeg') || contentType.includes('jpg') || personaImageUrl.match(/\.jpe?g/i)
            ? 'image/jpeg'
            : 'image/png';

          veoConfig.referenceImages = [{
            image: {
              imageBytes: base64Data,
              mimeType,
            },
            referenceType: 'ASSET',
          }];
          // Veo does not allow personGeneration: 'allow_all' when referenceImages are present
          delete veoConfig.personGeneration;
          console.log(`[B-Roll Video] ✅ Persona reference image attached (${(imgBuffer.length / 1024).toFixed(0)}KB, type=${mimeType}, referenceType=ASSET, base64Length=${base64Data.length})`);
        } else {
          console.warn(`[B-Roll Video] ❌ Persona image download failed (HTTP ${imgResp.status}). Proceeding without reference.`);
        }
      } catch (err) {
        console.warn(`[B-Roll Video] ❌ Persona image download error: ${err.message}. Proceeding without reference.`);
      }
    }

    // Generate a single 8-second clip (max for one Veo generation)
    const hasRefImages = veoConfig.referenceImages && veoConfig.referenceImages.length > 0;
    console.log(`[B-Roll Video] Calling ${modelName}.generateVideos (hasReferenceImages=${hasRefImages}, configKeys=${Object.keys(veoConfig).join(',')})...`);
    let operation = await ai.models.generateVideos({
      model: modelName,
      prompt,
      config: veoConfig,
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
5. ABSOLUTELY NO text of any kind — no text, no logos, no UI mockups, no signage with readable text, no writing on vehicles, no labels, no brand names visible. All surfaces must be clean and text-free.`;

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
 * @param {string} params.personaImageUrl - Optional persona image URL for character consistency
 * @returns {Promise<string>} Path to MP4 video or PNG image
 */
async function generateBroll({ description, brandName, brandDescription = '', personaDescription = '', outputDir, segmentType = '', segmentChannel = '', personaImageUrl = null }) {
  // Try video generation first (Veo) — generates 8s clips
  const videoPath = await generateBrollVideo({ description, brandName, brandDescription, personaDescription, outputDir, segmentType, segmentChannel, personaImageUrl });
  if (videoPath) return videoPath;

  // Retry Veo once with a simplified prompt before falling back to still images
  console.log(`[B-Roll] Retrying Veo with simplified prompt...`);
  const retryPath = await generateBrollVideo({
    description: `Cinematic lifestyle footage: ${description.substring(0, 100)}`,
    brandName, brandDescription, personaDescription, outputDir, segmentType, segmentChannel,
    personaImageUrl: null,  // Drop persona ref on retry — it can cause failures
  });
  if (retryPath) return retryPath;

  // Fallback to image generation (Gemini Imagen)
  return await generateBrollImage({ description, brandName, outputDir });
}

/**
 * Calculate how many 8s Veo clips a b-roll segment needs based on voiceover timestamps.
 * Uses the same logic as the compositor: duration = next segment's startTime - this segment's startTime.
 *
 * @param {object} seg - The b-roll segment
 * @param {object} timestamps - Voiceover timestamps { segments: [{order, startTime, endTime}] }
 * @param {Array} allSegments - All script segments (for next-segment lookup)
 * @returns {number} Number of 8s clips needed (minimum 1)
 */
function calcClipsNeeded(seg, timestamps, allSegments) {
  const VEO_CLIP_DURATION = 8;

  if (!timestamps || !timestamps.segments || !allSegments) return 1;

  const tsMap = {};
  timestamps.segments.forEach(ts => { tsMap[ts.order] = ts; });

  const orderedTs = timestamps.segments.slice().sort((a, b) => a.order - b.order);
  const tsIndexMap = {};
  orderedTs.forEach((ts, idx) => { tsIndexMap[ts.order] = idx; });

  const ts = tsMap[seg.order];
  if (!ts) return 1;

  const tsIdx = tsIndexMap[seg.order];
  const nextTs = (tsIdx !== undefined && tsIdx < orderedTs.length - 1)
    ? orderedTs[tsIdx + 1]
    : null;

  let duration;
  if (nextTs) {
    duration = nextTs.startTime - ts.startTime;
  } else {
    duration = ts.endTime - ts.startTime;
  }

  if (duration <= VEO_CLIP_DURATION) return 1;

  const clipsNeeded = Math.ceil(duration / VEO_CLIP_DURATION);
  console.log(`[B-Roll] Segment ${seg.order} needs ${duration.toFixed(1)}s → ${clipsNeeded} clips (${clipsNeeded * VEO_CLIP_DURATION}s of footage)`);
  return clipsNeeded;
}

/**
 * Generate all b-roll assets for a video.
 * @param {Array} segments - B-roll segments from script
 * @param {string} brandName
 * @param {string} outputDir
 * @param {function} onProgress
 * @param {string} personaImageUrl - Optional persona image for character consistency across clips
 * @param {object} timestamps - Voiceover timestamps for duration calculation
 * @param {Array} allSegments - All script segments for next-segment lookup
 * @param {string} brandDescription - Brand description/industry for contextual b-roll
 * @param {string} personaDescription - Persona description for contextual b-roll
 * @returns {Promise<Array>} Array of { order, mediaPaths, imagePath }
 */
async function generateAllBroll(segments, brandName, outputDir, onProgress, personaImageUrl = null, timestamps = null, allSegments = null, brandDescription = '', personaDescription = '') {
  let videoCount = 0;
  let imageCount = 0;

  // Calculate total clips needed across all segments
  const segmentClipCounts = segments.map(seg => ({
    seg,
    clipsNeeded: calcClipsNeeded(seg, timestamps, allSegments),
  }));

  const totalClips = segmentClipCounts.reduce((sum, s) => sum + s.clipsNeeded, 0);

  console.log(`[B-Roll] Launching ${totalClips} clip generations for ${segments.length} segments in parallel...${personaImageUrl ? ' (with persona reference image)' : ''}`);
  let completed = 0;

  // Launch ALL clip generations in parallel
  const promises = segmentClipCounts.map(({ seg, clipsNeeded }, i) => {
    console.log(`[B-Roll] Segment ${i + 1}/${segments.length} (${seg.type || 'broll'}): ${clipsNeeded} clip(s) — "${seg.brollDescription?.substring(0, 50)}..."`);

    // Generate clipsNeeded clips for this segment, all in parallel.
    // Each clip gets a DISTINCT visual description to avoid repetitive themes.
    const clipPromises = [];
    const variationStyles = [
      null,  // First clip uses the original description unchanged
      'Show a COMPLETELY DIFFERENT scene and setting — different location, different activity, different mood. Do NOT repeat any action or prop from the previous shot.',
      'Show an OUTDOOR establishing shot — wide angle, environmental, no close-ups of objects. Completely different from previous clips.',
      'Show a warm CLOSE-UP of hands or a facial expression — intimate, emotional moment. No props, no objects, no packages.',
    ];

    for (let c = 0; c < clipsNeeded; c++) {
      let desc = seg.brollDescription || 'Professional lifestyle image';
      if (c > 0 && c < variationStyles.length) {
        // Replace the original description with a distinctly different visual direction
        desc = `${variationStyles[c]} General theme: ${desc.substring(0, 80)}`;
      } else if (c >= variationStyles.length) {
        desc = `Cinematic environmental wide shot — cityscape, nature, or architecture. Unrelated to previous clips. Theme context: ${desc.substring(0, 60)}`;
      }

      // Pass persona reference for the FIRST clip of each b-roll segment to maintain character consistency.
      // Only the first clip gets the reference to avoid Veo generating inconsistent variations.
      // Without persona reference, the prompt rules will tell Veo to show NO PEOPLE (environments only).
      const usePersona = personaImageUrl && c === 0;

      clipPromises.push(
        generateBroll({
          description: desc,
          brandName,
          brandDescription,
          personaDescription,
          outputDir,
          segmentType: seg.type || '',
          segmentChannel: seg.channel || '',
          personaImageUrl: usePersona ? personaImageUrl : null,
        }).then(mediaPath => {
          completed++;
          if (mediaPath.endsWith('.mp4')) {
            videoCount++;
          } else {
            imageCount++;
          }
          console.log(`[B-Roll] ${completed}/${totalClips} done: ${mediaPath.endsWith('.mp4') ? 'VIDEO' : 'IMAGE'} → ${path.basename(mediaPath)}`);
          if (onProgress) onProgress(Math.min(completed, totalClips), totalClips);
          return mediaPath;
        })
      );
    }

    return Promise.all(clipPromises).then(mediaPaths => ({
      order: seg.order,
      mediaPaths,  // Array of all clip paths for this segment
      imagePath: mediaPaths[0],  // Backward compat — primary clip
    })).catch(err => {
      console.error(`[B-Roll] Segment ${seg.order} (${seg.type || 'broll'}) failed entirely: ${err.message}`);
      return null; // Return null so other segments still complete
    });
  });

  const allResults = await Promise.all(promises);
  const results = allResults.filter(r => r !== null); // Remove failed segments

  console.log(`[B-Roll] Complete: ${videoCount} video clips, ${imageCount} still images out of ${totalClips} total clips for ${segments.length} segments`);
  return results;
}

module.exports = { generateBrollImage, generateBrollVideo, generateBroll, generateAllBroll };
