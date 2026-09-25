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
4. Feature the person from the reference image as the MAIN character. Show them in lifestyle moments: walking, shopping, enjoying products, in beautiful environments. IMPORTANT: Dress the person in clothing appropriate for the scene — if they are exercising, put them in athletic wear; if at a formal event, put them in formal attire; if outdoors hiking, put them in outdoor gear. Do NOT keep them in whatever outfit they are wearing in the reference image if it does not match the activity. Their face and identity stay the same, but their wardrobe MUST fit the scene.
5. Every surface in the scene must be COMPLETELY CLEAN AND SMOOTH. This is the MOST IMPORTANT rule. All glasses must be perfectly plain, smooth, transparent glass — like simple kitchen tumblers or plain pint glasses you'd buy unprinted from a store. All bottles must be completely bare glass with zero printing or paper on them. All packaging must be plain solid single colors. All clothing must be solid colors. All storefronts and signs must be out of focus or show abstract shapes only. Think of this as a "stock footage" world where no brands exist — every object is a generic, unprinted, clean version of itself.
6. Slow cinematic motion only — no rapid movement.
7. ABSOLUTELY NO morphing between people — the person must remain the SAME throughout. Do NOT transition one person into a different person.
8. Show only ONE person (the reference person) per shot. Never add random other people.
9. NO delivery trucks, shipping vehicles, or logistics imagery.
10. The person must NOT be talking, speaking, mouthing words, or moving their lips unless the scene description explicitly calls for speaking or conversation. Show them in silent, contemplative, or active moments — smiling is fine, but their mouth must stay CLOSED or in a natural resting position.`;

// Rules for clips WITHOUT persona reference — NO PEOPLE to avoid random strangers
const VIDEO_PROMPT_RULES_NO_PERSONA = `Style: Cinematic b-roll footage. Smooth, slow camera movement. Warm natural lighting. Shallow depth of field. High production value.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO PEOPLE — do not show any human faces, bodies, hands, or silhouettes. This clip has no character reference, so any person shown will be a random stranger that breaks story continuity. Show ONLY environments, objects, products, architecture, nature, and atmospheric shots.
2. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display showing content.
3. ABSOLUTELY NO close-ups of devices.
4. INSTEAD focus on: beautiful environments, storefronts, product displays, nature scenes, cityscapes, architecture, atmospheric lighting, textures, objects related to the brand.
5. Every surface in the scene must be COMPLETELY CLEAN AND SMOOTH. This is the MOST IMPORTANT rule. All glasses must be perfectly plain, smooth, transparent glass — like simple kitchen tumblers or plain pint glasses you'd buy unprinted from a store. All bottles must be completely bare glass with zero printing or paper on them. All packaging must be plain solid single colors. All clothing must be solid colors. All storefronts and signs must be out of focus or show abstract shapes only. Think of this as a "stock footage" world where no brands exist — every object is a generic, unprinted, clean version of itself.
6. Slow cinematic motion only — no rapid movement.
7. NO delivery trucks, shipping vehicles, or logistics imagery.
8. Focus on MOOD and ATMOSPHERE — the visual should evoke the feeling of the brand without showing people.`;

/**
 * Sanitize a b-roll prompt to remove brand names and product-specific references
 * that cause AI models to generate fake logos/text. The visual model should focus
 * on the CATEGORY of product (e.g., "beer", "car") without knowing the specific
 * brand, so it can't invent branding.
 *
 * @param {string} text - Text to sanitize
 * @param {string} brandName - Brand name to strip
 * @returns {string} Sanitized text
 */
function sanitizeBrollPrompt(text, brandName) {
  if (!text) return text;
  let clean = text;

  // ═══ STEP 1: Remove entire negative-instruction sentences ═══
  // Sentences containing "no logo", "no text", "should be no", "without text" etc.
  // are counterproductive — telling AI "no logos" makes it think about logos.
  // The RULES section already handles these constraints — strip them from the description.
  clean = clean.replace(/[^.!?]*\b(no|without|don't|do not|should not|shouldn't|never|avoid)\b[^.!?]*(logo|text|brand|label|emblem|writing|lettering|generated|watermark)[^.!?]*[.!?]?\s*/gi, '');
  clean = clean.replace(/[^.!?]*\b(unlabeled|unbranded|unmarked|plain)\b[^.!?]*(glass|bottle|can|cup|mug|package)[^.!?]*[.!?]?\s*/gi, '');

  // ═══ STEP 2: Remove the brand name ═══
  if (brandName) {
    const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(`${escaped}(?:'s|'s|s)?\\s*`, 'gi'), '');
    clean = clean.replace(new RegExp(`(a|the|an)\\s+${escaped}`, 'gi'), '$1');
  }

  // ═══ STEP 3: Replace product terms with PURELY POSITIVE descriptions ═══
  // Key insight: NO negative language. Only describe what we WANT to see.

  // Beer / beverage industry — avoid the word "beer" entirely as it triggers branded imagery
  clean = clean.replace(/\bbeer\s+bottle(s)?\b/gi, 'elegant plain glass bottle$1 filled with amber liquid');
  clean = clean.replace(/\bbeer\s+can(s)?\b/gi, 'sleek solid-colored metallic can$1');
  clean = clean.replace(/\bbeer\s+glass(es)?\b/gi, 'simple smooth clear drinking glass$1 filled with golden liquid');
  clean = clean.replace(/\bglass(es)?\s+of\s+beer\b/gi, 'simple smooth clear drinking glass$1 of golden liquid');
  clean = clean.replace(/\bpint(s)?\s+of\s+beer\b/gi, 'simple smooth clear drinking glass$1 of golden liquid');
  clean = clean.replace(/\bbeer\s+tap(s)?\b/gi, 'polished metal draft tap$1');
  clean = clean.replace(/\bcraft\s+beer(s)?\b/gi, 'golden amber drink$1');
  clean = clean.replace(/\bbeer\s+garden\b/gi, 'outdoor dining patio');
  clean = clean.replace(/\bbeer\s+bar\b/gi, 'upscale bar counter');
  clean = clean.replace(/\bbeer(s)?\b/gi, 'golden amber drink$1');
  clean = clean.replace(/\bbrewer(y|ies)\b/gi, 'beverage venue');
  clean = clean.replace(/\bbrew(s|ed|ing)?\b/gi, 'artisan drink$1');
  clean = clean.replace(/\bale(s)?\b/gi, 'amber drink$1');
  clean = clean.replace(/\blager(s)?\b/gi, 'golden drink$1');
  clean = clean.replace(/\bstout(s)?\b/gi, 'dark beverage$1');
  clean = clean.replace(/\bIPA(s)?\b/g, 'craft drink$1');

  // Wine / spirits
  clean = clean.replace(/\bwine\s+bottle(s)?\b/gi, 'elegant dark glass bottle$1');
  clean = clean.replace(/\bwine\s+glass(es)?\b/gi, 'clear crystal stemmed glass$1');
  clean = clean.replace(/\bspirit\s+bottle(s)?\b/gi, 'premium glass bottle$1');
  clean = clean.replace(/\bliquor\s+bottle(s)?\b/gi, 'premium glass bottle$1');
  clean = clean.replace(/\bcocktail\s+glass(es)?\b/gi, 'elegant stemmed glass$1');

  // Soda / soft drinks
  clean = clean.replace(/\bsoda\s+(can|bottle)(s)?\b/gi, 'sleek solid-colored $1$2');
  clean = clean.replace(/\bsoft\s+drink(s)?\b/gi, 'refreshing carbonated beverage$1');

  // General product terms — strip words that prime branding
  clean = clean.replace(/\bbranded\b/gi, 'elegant');
  clean = clean.replace(/\blogo(s)?\b/gi, '');
  clean = clean.replace(/\bbrand(ed|ing)?\b/gi, '');
  clean = clean.replace(/\blabel(s|ed)?\b/gi, '');
  clean = clean.replace(/\bemblem(s)?\b/gi, '');
  clean = clean.replace(/\bcrest(s)?\b/gi, '');
  clean = clean.replace(/\bwatermark(s)?\b/gi, '');
  clean = clean.replace(/\bmonogram(s)?\b/gi, '');

  // Fashion / apparel
  clean = clean.replace(/\bbranded\s+(shirt|shoe|sneaker|jacket|bag|hat|cap)(s)?\b/gi, 'plain $1$2');

  // ═══ STEP 4: Clean up ═══
  clean = clean.replace(/\s{2,}/g, ' ');
  clean = clean.replace(/\s+([,.])/g, '$1');
  clean = clean.replace(/\.\s*\./g, '.'); // collapsed double periods
  clean = clean.replace(/,\s*,/g, ',');
  clean = clean.trim();

  return clean;
}

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
    personaPromptHint = 'IMPORTANT: You MUST feature the exact person from the provided reference image as the main character in this clip. Match their face, hair, skin tone, body type, and facial features precisely from the reference image. However, ADAPT their clothing and outfit to match the scene — if the scene involves exercise, dress them in athletic wear; if a formal event, dress them formally; if casual, dress them casually. The person\'s IDENTITY stays the same but their WARDROBE should fit the activity and setting described. ';
  }

  // Build brand/persona context — sanitized to avoid AI generating fake logos.
  // We tell the model what KIND of brand (industry) without naming it, so it
  // cannot invent branding.  The brand name is deliberately stripped.
  let brandContext = '';
  if (brandDescription) {
    brandContext += `Brand context: a premium brand — ${sanitizeBrollPrompt(brandDescription, brandName)}. `;
  }
  if (personaDescription) {
    brandContext += `The story follows: ${sanitizeBrollPrompt(personaDescription, brandName)}. `;
  }

  // Sanitize the visual description itself — strip brand name and branded product refs
  const cleanDescription = sanitizeBrollPrompt(description, brandName);

  // Use different rules depending on whether we have a persona reference image
  const rules = personaImageUrl ? VIDEO_PROMPT_RULES_WITH_PERSONA : VIDEO_PROMPT_RULES_NO_PERSONA;

  const prompt = `${contextHint}${personaPromptHint}${brandContext}Professional cinematic b-roll footage for a premium brand customer experience video: ${cleanDescription}.\n${rules}`;

  const modelName = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';

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
    // Return both file path and video reference (for extend API chaining)
    return { filePath: outputPath, videoRef: generatedVideo.video };

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
// B-Roll VIDEO EXTEND (Veo Extend API) — chain clips for continuity
// ════════════════════════════════════════════════════════════════

/**
 * Extend an existing Veo-generated video by ~7 seconds using the Veo Extend API.
 * Each extension adds approximately 7 seconds of continuous footage that maintains
 * visual coherence with the previous clip.
 *
 * Constraints:
 *   - Resolution locked to 720p (extend API requirement)
 *   - Max 20 extensions per chain (~148 seconds total)
 *   - Only works with Veo-generated MP4s
 *   - Each extension is sequential (depends on previous clip)
 *
 * @param {object} params
 * @param {object} params.videoRef - Video reference from previous generation (operation.response.generatedVideos[0].video)
 * @param {string} params.prompt - Continuation prompt for the extended footage
 * @param {string} params.outputDir - Directory to save the extended clip
 * @param {number} params.extensionNumber - Which extension this is (1-based, for logging)
 * @returns {Promise<{filePath: string, videoRef: object}|null>} Extended clip path + video ref for next extension, or null on failure
 */
async function extendBrollVideo({ videoRef, prompt, outputDir, extensionNumber = 1 }) {
  const ai = getGenAI();
  const modelName = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';

  try {
    console.log(`[B-Roll Extend] Extension #${extensionNumber} with ${modelName}: "${prompt.substring(0, 60)}..."`);

    let operation = await ai.models.generateVideos({
      model: modelName,
      prompt,
      video: videoRef,
      config: {
        numberOfVideos: 1,
        resolution: '720p',
      },
    });

    operation = await pollVeoOperation(ai, operation, `extend-${extensionNumber}`, 180000);

    if (!operation.done) {
      console.warn(`[B-Roll Extend] Extension #${extensionNumber} timed out.`);
      return null;
    }

    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo || !generatedVideo.video) {
      console.warn(`[B-Roll Extend] Extension #${extensionNumber} completed but no video in response.`);
      return null;
    }

    // Download the extended video
    const filename = `broll_extended_${extensionNumber}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir || os.tmpdir(), filename);

    await ai.files.download({
      file: generatedVideo.video,
      downloadPath: outputPath,
    });

    const stats = fs.statSync(outputPath);
    console.log(`[B-Roll Extend] Extension #${extensionNumber} done: ${outputPath} (${(stats.size / 1024).toFixed(1)}KB)`);
    return { filePath: outputPath, videoRef: generatedVideo.video };

  } catch (err) {
    const errMsg = err.message || String(err);
    console.warn(`[B-Roll Extend] Extension #${extensionNumber} failed: ${errMsg}`);
    if (err.status) console.warn(`[B-Roll Extend] HTTP status: ${err.status}`);
    return null;
  }
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

  // Sanitize to remove brand names and product references that cause fake logos
  const cleanDescription = sanitizeBrollPrompt(description, brandName);

  const prompt = `Professional, cinematic b-roll photograph for a premium brand customer experience video: ${cleanDescription}.
Style: Clean, modern, high-quality stock photography. Warm, inviting lighting. Shallow depth of field.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display.
2. ABSOLUTELY NO close-ups of devices showing screen content.
3. DO NOT show people looking at screens or using touchscreens in close-up.
4. INSTEAD focus on: people's faces, emotions, hands, shopping, outdoor scenes, storefronts, lifestyle moments, environments, nature, cityscapes.
5. Every surface in the scene must be COMPLETELY CLEAN AND SMOOTH. This is the MOST IMPORTANT rule. All glasses must be perfectly plain, smooth, transparent glass — like simple kitchen tumblers or plain pint glasses you'd buy unprinted from a store. All bottles must be completely bare glass with zero printing or paper on them. All packaging must be plain solid single colors. All clothing must be solid colors. Think of this as a "stock footage" world where no brands exist — every object is a generic, unprinted, clean version of itself.`;

  // Image generation models — ordered newest to oldest
  const modelNames = [
    process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
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
 * Returns { filePath, videoRef } for video clips (videoRef enables extend API chaining),
 * or { filePath, videoRef: null } for image fallbacks.
 *
 * @param {object} params
 * @param {string} params.description - What the clip should show
 * @param {string} params.brandName - Brand name for context
 * @param {string} params.outputDir - Directory to save the clip
 * @param {string} params.personaImageUrl - Optional persona image URL for character consistency
 * @returns {Promise<{filePath: string, videoRef: object|null}>} File path + video ref for chaining
 */
async function generateBroll({ description, brandName, brandDescription = '', personaDescription = '', outputDir, segmentType = '', segmentChannel = '', personaImageUrl = null }) {
  // Try video generation first (Veo) — generates 8s clips
  const videoResult = await generateBrollVideo({ description, brandName, brandDescription, personaDescription, outputDir, segmentType, segmentChannel, personaImageUrl });
  if (videoResult) return videoResult;  // { filePath, videoRef }

  // Wait before retrying to avoid rate-limit (429) cascading failures
  console.log(`[B-Roll] Retry 2: waiting 5s before simplified prompt (no persona)...`);
  await new Promise(r => setTimeout(r, 5000));
  const retryResult = await generateBrollVideo({
    description: `Cinematic lifestyle footage: ${description.substring(0, 100)}`,
    brandName, brandDescription, personaDescription, outputDir, segmentType, segmentChannel,
    personaImageUrl: null,  // Drop persona ref on retry — it can cause failures
  });
  if (retryResult) return retryResult;

  // Third attempt with longer delay — ultra-minimal prompt
  console.log(`[B-Roll] Retry 3: waiting 10s before minimal prompt...`);
  await new Promise(r => setTimeout(r, 10000));
  const minimalDesc = segmentType === 'intro'
    ? `Beautiful cinematic opening shot. Slow camera movement across a stunning ${brandName || 'modern'} environment. Warm golden lighting. No text. No screens.`
    : segmentType === 'outro'
    ? `Warm cinematic closing shot. Slow pull-back camera movement. Beautiful sunset or golden hour lighting. No text. No screens.`
    : `Smooth cinematic b-roll footage. Slow camera movement. Beautiful lighting. ${description.substring(0, 60)}. No text. No screens.`;
  const retry3Result = await generateBrollVideo({
    description: minimalDesc,
    brandName, outputDir, segmentType, segmentChannel,
    personaImageUrl: null,
  });
  if (retry3Result) return retry3Result;

  // Fallback to image generation (Gemini Imagen)
  console.warn(`[B-Roll] All 3 Veo attempts failed for ${segmentType || 'broll'} segment. Falling back to static image.`);
  const imagePath = await generateBrollImage({ description, brandName, outputDir });
  return { filePath: imagePath, videoRef: null };
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
 *
 * NEW APPROACH (Veo Extend API):
 *   For segments needing >8s of footage, instead of generating N independent clips
 *   and FFmpeg-concatenating them, we generate 1 initial 8s clip and then EXTEND it
 *   N-1 times using the Veo Extend API. Each extension adds ~7s of continuous footage
 *   that maintains visual coherence with the previous clip. The final extended clip
 *   is the SINGLE output for that segment — no FFmpeg concat needed.
 *
 *   Cross-segment parallelism is preserved (MAX_CONCURRENT=5 segments in parallel).
 *   Within a segment, extensions run sequentially (each depends on the previous clip).
 *
 *   FALLBACK: If an extend call fails mid-chain, we keep what we have (initial clip
 *   + successful extensions as one continuous clip) and fall back to independent clip
 *   generation for the missing footage. The compositor's FFmpeg concat handles mixing
 *   the extended clip with any independent fallback clips.
 *
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
  let extendCount = 0;
  let extendFailCount = 0;

  // Calculate total clips needed across all segments
  const segmentClipCounts = segments.map(seg => ({
    seg,
    clipsNeeded: calcClipsNeeded(seg, timestamps, allSegments),
  }));

  const totalSegments = segments.length;
  console.log(`[B-Roll] Generating b-roll for ${totalSegments} segments (extend API for multi-clip, max 5 concurrent)...${personaImageUrl ? ' (with persona reference image)' : ''}`);
  let completed = 0;

  /**
   * Generate b-roll for a single segment using extend API chaining.
   * Returns array of media file paths for this segment.
   */
  async function generateSegmentBroll(seg, clipsNeeded) {
    const desc = seg.brollDescription || 'Professional lifestyle image';
    const usePersona = !!personaImageUrl;

    // ── Step 1: Generate initial 8s clip ──
    const initialResult = await generateBroll({
      description: desc,
      brandName,
      brandDescription,
      personaDescription,
      outputDir,
      segmentType: seg.type || '',
      segmentChannel: seg.channel || '',
      personaImageUrl: usePersona ? personaImageUrl : null,
    });

    if (!initialResult || !initialResult.filePath) {
      console.warn(`[B-Roll] Segment ${seg.order}: initial clip generation failed completely`);
      return [];
    }

    const mediaPaths = [initialResult.filePath];
    if (initialResult.filePath.endsWith('.mp4')) {
      videoCount++;
    } else {
      imageCount++;
    }

    // Single clip needed — done
    if (clipsNeeded <= 1) {
      return mediaPaths;
    }

    // ── Step 2: Extend the clip for additional footage ──
    // Only extend if we got a video with a videoRef (not an image fallback)
    if (!initialResult.videoRef) {
      console.log(`[B-Roll] Segment ${seg.order}: no videoRef (image fallback), falling back to independent clips for remaining ${clipsNeeded - 1} clips`);
      // Fall back to independent clip generation for remaining clips
      const fallbackPaths = await generateFallbackClips(seg, clipsNeeded - 1, desc);
      mediaPaths.push(...fallbackPaths);
      return mediaPaths;
    }

    // Chain extensions sequentially
    let currentVideoRef = initialResult.videoRef;
    const MAX_EXTENSIONS = 20; // Veo limit
    const extensionsNeeded = Math.min(clipsNeeded - 1, MAX_EXTENSIONS);

    console.log(`[B-Roll] Segment ${seg.order}: extending initial clip ${extensionsNeeded} time(s) for continuous footage`);

    for (let ext = 0; ext < extensionsNeeded; ext++) {
      // Small delay between extensions to be gentle on the API
      if (ext > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }

      // Build continuation prompt — keep it coherent with the original
      const continuationPrompt = `Continue the same cinematic scene smoothly. Maintain the same visual style, lighting, color palette, and camera movement. ${sanitizeBrollPrompt(desc, brandName).substring(0, 120)}`;

      const extResult = await extendBrollVideo({
        videoRef: currentVideoRef,
        prompt: continuationPrompt,
        outputDir,
        extensionNumber: ext + 1,
      });

      if (!extResult) {
        console.warn(`[B-Roll] Segment ${seg.order}: extend #${ext + 1} failed — falling back to independent clips for remaining ${extensionsNeeded - ext} clips`);
        extendFailCount++;
        // Fall back to independent generation for remaining clips
        const fallbackPaths = await generateFallbackClips(seg, extensionsNeeded - ext, desc);
        mediaPaths.push(...fallbackPaths);
        break;
      }

      extendCount++;
      videoCount++;
      // Veo Extend returns the FULL combined video (original + extensions merged).
      // Replace mediaPaths[0] with each successive extension — the last one
      // contains the complete chain. Delete the now-superseded intermediate file.
      const prevPath = mediaPaths[0];
      mediaPaths[0] = extResult.filePath;
      try { if (prevPath && fs.existsSync(prevPath)) fs.unlinkSync(prevPath); } catch {}
      currentVideoRef = extResult.videoRef;
      console.log(`[B-Roll] Segment ${seg.order}: extend #${ext + 1}/${extensionsNeeded} done — full chain now in single file`);
    }

    return mediaPaths;
  }

  /**
   * Fallback: generate independent clips (old approach) when extend fails.
   */
  async function generateFallbackClips(seg, count, desc) {
    const variationStyles = [
      'Show a COMPLETELY DIFFERENT scene and setting — different location, different activity, different mood.',
      'Show an OUTDOOR establishing shot — wide angle, environmental, no close-ups of objects.',
      'Show a warm CLOSE-UP of hands or a facial expression — intimate, emotional moment.',
    ];

    const paths = [];
    for (let i = 0; i < count; i++) {
      // Small delay between independent clips
      if (i > 0) await new Promise(r => setTimeout(r, 3000));

      let fallbackDesc = desc;
      if (i < variationStyles.length) {
        fallbackDesc = `${variationStyles[i]} General theme: ${desc.substring(0, 80)}`;
      } else {
        fallbackDesc = `Cinematic environmental wide shot — cityscape, nature, or architecture. Theme: ${desc.substring(0, 60)}`;
      }

      try {
        const result = await generateBroll({
          description: fallbackDesc,
          brandName,
          brandDescription,
          personaDescription,
          outputDir,
          segmentType: seg.type || '',
          segmentChannel: seg.channel || '',
          personaImageUrl: null,  // No persona on fallback clips
        });
        if (result && result.filePath) {
          paths.push(result.filePath);
          if (result.filePath.endsWith('.mp4')) videoCount++;
          else imageCount++;
        }
      } catch (err) {
        console.warn(`[B-Roll] Fallback clip ${i + 1}/${count} for segment ${seg.order} failed: ${err.message}`);
      }
    }
    return paths;
  }

  // ── Run segments with controlled concurrency (max 5 segments in parallel) ──
  const MAX_CONCURRENT = 5;
  const STAGGER_MS = 2000;
  const segmentResults = new Array(segmentClipCounts.length);
  let nextIdx = 0;

  async function runNextSegment() {
    const idx = nextIdx++;
    if (idx >= segmentClipCounts.length) return;
    const { seg, clipsNeeded } = segmentClipCounts[idx];

    console.log(`[B-Roll] Segment order=${seg.order} (${seg.type || 'broll'}): ${clipsNeeded} clip(s) — "${seg.brollDescription?.substring(0, 50)}..."`);

    try {
      const mediaPaths = await generateSegmentBroll(seg, clipsNeeded);
      segmentResults[idx] = { order: seg.order, mediaPaths };
      completed++;
      console.log(`[B-Roll] Segment ${seg.order} complete: ${mediaPaths.length} clip(s) (${completed}/${totalSegments} segments done)`);
      if (onProgress) onProgress(Math.min(completed, totalSegments), totalSegments);
    } catch (err) {
      console.error(`[B-Roll] Segment ${seg.order} failed: ${err.message}`);
      segmentResults[idx] = null;
    }

    // Continue with next segment
    await runNextSegment();
  }

  // Launch initial batch with staggered starts
  const workers = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENT, segmentClipCounts.length); w++) {
    if (w > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
    workers.push(runNextSegment());
  }
  await Promise.all(workers);

  // Build results
  const results = segmentResults
    .filter(r => r !== null && r.mediaPaths.length > 0)
    .map(r => ({
      order: r.order,
      mediaPaths: r.mediaPaths,
      imagePath: r.mediaPaths[0],  // Backward compat — primary clip
    }));

  console.log(`[B-Roll] Complete: ${videoCount} video clips (${extendCount} via extend API, ${extendFailCount} extend failures), ${imageCount} still images for ${totalSegments} segments`);
  return results;
}

module.exports = { generateBrollImage, generateBrollVideo, extendBrollVideo, generateBroll, generateAllBroll, calcClipsNeeded };
