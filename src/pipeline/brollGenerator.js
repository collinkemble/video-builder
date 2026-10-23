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
// B-Roll VIDEO generation (Gemini Omni Flash) — primary path
// ════════════════════════════════════════════════════════════════

// Rules for clips WITH persona reference image — person is OK since the model matches them
const VIDEO_PROMPT_RULES_WITH_PERSONA = `Style: Cinematic b-roll footage. Smooth, slow camera movement. Warm natural lighting. Shallow depth of field. High production value.
CRITICAL RULES YOU MUST FOLLOW:
1. ABSOLUTELY NO screens of any kind — no phone screens, laptop screens, tablet screens, computer monitors, TV screens, smartwatch screens, or any digital display showing content.
2. ABSOLUTELY NO close-ups of devices — do not show any device screen from an angle where you can see what is displayed.
3. DO NOT generate images of people looking at screens, typing on keyboards, or using touchscreens in close-up.
4. ABSOLUTELY NO TALKING — the person must NEVER be speaking, talking to camera, mouthing words, lip-syncing, or moving their lips at any point. Their mouth must stay CLOSED or in a natural resting smile. Show them in SILENT lifestyle moments only — walking, looking, enjoying, contemplating. This is b-roll footage with a voiceover, NOT a talking-head video. If you show moving lips the clip is unusable.
5. Feature the person from the reference image as the MAIN character. Show them in lifestyle moments: walking, shopping, enjoying products, in beautiful environments. IMPORTANT: Dress the person in clothing appropriate for the scene — if they are exercising, put them in athletic wear; if at a formal event, put them in formal attire; if outdoors hiking, put them in outdoor gear. Do NOT keep them in whatever outfit they are wearing in the reference image if it does not match the activity. Their face and identity stay the same, but their wardrobe MUST fit the scene.
6. Every surface in the scene must be COMPLETELY CLEAN AND SMOOTH. This is the MOST IMPORTANT rule. All glasses must be perfectly plain, smooth, transparent glass — like simple kitchen tumblers or plain pint glasses you'd buy unprinted from a store. All bottles must be completely bare glass with zero printing or paper on them. All packaging must be plain solid single colors. All clothing must be solid colors. All storefronts and signs must be out of focus or show abstract shapes only. Think of this as a "stock footage" world where no brands exist — every object is a generic, unprinted, clean version of itself.
7. Slow cinematic motion only — no rapid movement.
8. ABSOLUTELY NO morphing between people — the person must remain the SAME throughout. Do NOT transition one person into a different person.
9. Show only ONE person (the reference person) per shot. Never add random other people.
10. NO delivery trucks, shipping vehicles, or logistics imagery.
11. ONE single continuous shot — no scene cuts, no edits, no jumps to a different location or angle.`;

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
8. Focus on MOOD and ATMOSPHERE — the visual should evoke the feeling of the brand without showing people.
9. ONE single continuous shot — no scene cuts, no edits, no jumps to a different location or angle.`;

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

// ════════════════════════════════════════════════════════════════
// Gemini Omni Flash client (replaces Veo 3.1, which Google shut down 2026-10-22)
//   • One synchronous Interactions API call returns a ~10s 720p clip.
//   • Extensions use previous_interaction_id and return the FULL combined video.
//   • Tested: a single continuous shot reliably reaches 30s (10s + 2 extensions).
//     A 3rd extension replaced the last 10s instead of adding to it, so chains are capped at 30s.
//   • No AbortController (unreliable on Heroku Fir) — timeouts use Promise.race.
// ════════════════════════════════════════════════════════════════
const OMNI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OMNI_CLIP_SECONDS = 10;
const OMNI_MAX_CHAIN_SECONDS = 30;
const OMNI_MAX_CLIPS_PER_CHAIN = OMNI_MAX_CHAIN_SECONDS / OMNI_CLIP_SECONDS; // 3 → initial + 2 extensions
const OMNI_CALL_TIMEOUT_MS = 4 * 60 * 1000;
const OMNI_RESPONSE_FORMAT = { type: 'video', aspect_ratio: '16:9', resolution: '720p' };

function omniModel() {
  const m = (process.env.VEO_MODEL || '').trim();
  // Ignore stale Veo model names — those endpoints no longer exist
  return m && !/^veo-/i.test(m) ? m : 'gemini-omni-1.1-flash';
}

function raceTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

function omniHeaders() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
}

/** Find the generated video anywhere in an Interactions API response. */
function findVideoPart(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if ((node.type === 'video' || /^video\//.test(node.mime_type || node.mimeType || '')) && (node.data || node.uri)) return node;
  for (const v of Object.values(node)) {
    const found = findVideoPart(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Download a `files/<id>` video once it is ACTIVE. */
async function downloadOmniFile(uri) {
  const headers = omniHeaders();
  const fileId = uri.replace(/^.*?(files\/[^:/?]+).*$/, '$1');
  for (let i = 0; i < 60; i++) {
    const meta = await raceTimeout(fetch(`${OMNI_BASE}/${fileId}`, { headers }).then(r => r.json()), 30000, 'Omni file status');
    if (meta.state === 'ACTIVE') break;
    if (meta.state === 'FAILED') throw new Error(`Omni file ${fileId} failed to process`);
    await new Promise(r => setTimeout(r, 3000));
  }
  const resp = await raceTimeout(fetch(`${OMNI_BASE}/${fileId}:download?alt=media`, { headers }), 120000, 'Omni file download');
  if (!resp.ok) throw new Error(`Omni file download HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * One Omni generation. Returns { buffer, interactionId }.
 * @param {string|Array} input - prompt text, or [image part, text part] for a persona reference
 * @param {string} [previousInteractionId] - set to extend an earlier clip
 */
async function omniGenerate({ input, previousInteractionId = null, label = 'Omni' }) {
  const body = { model: omniModel(), input, response_format: OMNI_RESPONSE_FORMAT };
  if (previousInteractionId) body.previous_interaction_id = previousInteractionId;
  const started = Date.now();
  const resp = await raceTimeout(
    fetch(`${OMNI_BASE}/interactions`, { method: 'POST', headers: omniHeaders(), body: JSON.stringify(body) }),
    OMNI_CALL_TIMEOUT_MS, label
  );
  const json = await raceTimeout(resp.json(), 120000, `${label} response`).catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 300);
    const err = new Error(`${label} HTTP ${resp.status}: ${msg}`);
    err.status = resp.status;
    throw err;
  }
  const part = findVideoPart(json);
  if (!part) throw new Error(`${label}: response contained no video (${JSON.stringify(json).slice(0, 200)})`);
  const buffer = part.data ? Buffer.from(part.data, 'base64') : await downloadOmniFile(part.uri);
  const outTokens = json?.usage?.total_output_tokens;
  console.log(`[B-Roll Omni] ${label}: ok in ${Math.round((Date.now() - started) / 1000)}s (${(buffer.length / 1024 / 1024).toFixed(1)}MB${outTokens ? `, ${outTokens} output tokens` : ''})`);
  return { buffer, interactionId: json.id || null };
}

/** Download the persona photo (public URL, then presigned-URL fallback). Returns { base64, mimeType } or null. */
async function loadPersonaImage(personaImageUrl) {
  try {
    let imgResp = await raceTimeout(fetch(personaImageUrl), 30000, 'Persona image download');
    const _st = require('../utils/storage');
    if (!imgResp.ok && _st.isStorageUrl(personaImageUrl) && _st.isOwnKey(_st.urlToKey(personaImageUrl))) {
      console.log(`[B-Roll Omni] Persona image returned ${imgResp.status}, trying presigned URL...`);
      try {
        const presignedUrl = await _st.getPresignedUrl(_st.urlToKey(personaImageUrl), 300);
        imgResp = await raceTimeout(fetch(presignedUrl), 30000, 'Persona image presigned download');
      } catch (e) { console.warn(`[B-Roll Omni] Presigned fallback failed: ${e.message}`); }
    }
    if (!imgResp.ok) { console.warn(`[B-Roll Omni] Persona image download failed (HTTP ${imgResp.status})`); return null; }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const ct = (imgResp.headers.get('content-type') || '').toLowerCase();
    const mimeType = ct.includes('png') || /\.png(\?|$)/i.test(personaImageUrl) ? 'image/png'
      : ct.includes('webp') || /\.webp(\?|$)/i.test(personaImageUrl) ? 'image/webp'
      : 'image/jpeg';
    return { base64: buf.toString('base64'), mimeType };
  } catch (err) {
    console.warn(`[B-Roll Omni] Persona image error: ${err.message}`);
    return null;
  }
}

// Cache persona photo per URL for the life of the process (same photo used for every clip)
const _personaCache = new Map();
async function getPersonaImage(url) {
  if (!url) return null;
  if (!_personaCache.has(url)) _personaCache.set(url, loadPersonaImage(url));
  const img = await _personaCache.get(url);
  if (!img) _personaCache.delete(url); // retry download next time
  return img;
}

// Persona photos that Google's safety filter has blocked ("Input blocked"). Once blocked, we stop
// sending that photo and describe the person in words instead, so no attempts are wasted.
const _blockedPersonaPhotos = new Set();
function isPersonaPhotoBlocked(url) { return !!url && _blockedPersonaPhotos.has(url); }
function markPersonaPhotoBlocked(url) { if (url) _blockedPersonaPhotos.add(url); }

// Written description of the persona's look, made once per photo with Gemini (vision).
const _personaLookCache = new Map();
async function describePersona(url, fallbackText = '') {
  if (!url) return fallbackText || '';
  if (!_personaLookCache.has(url)) {
    _personaLookCache.set(url, (async () => {
      const img = await getPersonaImage(url);
      if (!img) return '';
      const ai = getGenAI();
      const models = [process.env.GEMINI_MODEL || 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
      for (const model of [...new Set(models)]) {
        try {
          const resp = await raceTimeout(ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType: img.mimeType, data: img.base64 } },
              { text: 'Write a short casting description of this fictional character\'s visible appearance for a video shoot: apparent age range, gender presentation, hair color and style, skin tone, build, and any distinctive features. Do not name or identify anyone and do not describe clothing. One or two sentences, no preamble.' },
            ] }],
          }), 45000, 'Persona description');
          const text = (resp.text || '').trim().replace(/\s+/g, ' ');
          if (text) { console.log('[B-Roll Omni] Persona described in words: ' + text.substring(0, 160)); return text; }
        } catch (err) {
          console.warn('[B-Roll Omni] Persona description with ' + model + ' failed: ' + err.message);
        }
      }
      return '';
    })());
  }
  const look = await _personaLookCache.get(url);
  if (!look) _personaLookCache.delete(url); // try again next time
  return look || fallbackText || '';
}

/** Classify an Omni error so retries can react to the real cause. */
function classifyOmniError(err) {
  const msg = (err && err.message) || '';
  const status = err && err.status;
  if (status === 429 || status >= 500 || /timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(msg)) return 'transient';
  if (/Input blocked|could not be processed|safety|blocked|prohibited|not supported.*(person|people|image)/i.test(msg)) return 'blocked';
  return 'other';
}

/**
 * Generate a b-roll VIDEO clip (~10s, 720p) with Gemini Omni Flash.
 * personaMode:
 *   'photo'     — send the persona photo as <IMAGE_REF_0> (strongest likeness)
 *   'described' — the photo is blocked by Google, so the same person is described in words (personaLook)
 *   'none'      — no people at all (last resort)
 * @returns {Promise<{filePath: string, videoRef: string|null}|{error: Error}>} videoRef = Omni interaction id (for extensions)
 */
async function generateBrollVideo({ description, brandName, brandDescription = '', personaDescription = '', outputDir, segmentType = '', segmentChannel = '', personaImageUrl = null, personaMode = null, personaLook = '' }) {
  let contextHint = '';
  if (segmentType === 'intro') {
    contextHint = 'This is the OPENING shot of the video — use a wide, establishing cinematic shot that sets the mood. ';
  } else if (segmentType === 'outro') {
    contextHint = 'This is the CLOSING shot of the video — use a warm, conclusive cinematic shot that feels like a satisfying ending. ';
  } else if (segmentType === 'transition') {
    contextHint = 'This is a TRANSITION shot bridging two scenes' + (segmentChannel ? ' (coming from: ' + segmentChannel + ')' : '') + ' — show movement, travel, or passage of time. ';
  }

  const mode = personaMode || (personaImageUrl ? 'photo' : 'none');
  const persona = mode === 'photo' && personaImageUrl ? await getPersonaImage(personaImageUrl) : null;
  const usePhoto = !!persona;
  const useDescribed = !usePhoto && (mode === 'described' || (mode === 'photo' && !!personaLook)) && !!personaLook;

  let personaPromptHint = '';
  const noTalking = 'CRITICAL: The person must NOT be talking or moving their lips at any point — this is silent b-roll with a voiceover, not a talking-head shot. ';
  const wardrobe = 'ADAPT their clothing to the scene — athletic wear for exercise, formal wear for formal events, casual for casual. Their IDENTITY stays the same; their WARDROBE fits the activity. ';
  if (usePhoto) {
    personaPromptHint = 'IMPORTANT: The main character is the person shown in <IMAGE_REF_0>. Match their face, hair, skin tone, body type, and facial features exactly. ' + wardrobe + noTalking;
  } else if (useDescribed) {
    personaPromptHint = 'IMPORTANT: The main character is a fictional person with this exact look, kept identical in every shot: ' + personaLook + ' ' + wardrobe + noTalking;
  }

  let brandContext = '';
  if (brandDescription) brandContext += 'Brand context: a premium brand — ' + sanitizeBrollPrompt(brandDescription, brandName) + '. ';
  if (personaDescription) brandContext += 'The story follows: ' + sanitizeBrollPrompt(personaDescription, brandName) + '. ';

  const cleanDescription = sanitizeBrollPrompt(description, brandName);
  let rules = VIDEO_PROMPT_RULES_NO_PERSONA;
  if (usePhoto) rules = VIDEO_PROMPT_RULES_WITH_PERSONA;
  else if (useDescribed) rules = VIDEO_PROMPT_RULES_WITH_PERSONA
    .replace(/the person from the reference image/gi, 'the described main character')
    .replace(/\(the reference person\)/gi, '(the described main character)')
    .replace(/in the reference image/gi, 'in the description');

  const promptText = contextHint + personaPromptHint + brandContext +
    'Professional cinematic b-roll footage for a premium brand customer experience video, filmed as ONE single continuous shot with no scene cuts: ' +
    cleanDescription + '.\n' + rules;

  const input = usePhoto
    ? [{ type: 'image', mime_type: persona.mimeType, data: persona.base64 }, { type: 'text', text: promptText }]
    : promptText;

  const how = usePhoto ? 'persona photo' : useDescribed ? 'persona described in words' : 'no people';
  try {
    console.log('[B-Roll Video] Generating ~' + OMNI_CLIP_SECONDS + 's clip with ' + omniModel() + ' (' + how + '): "' + description.substring(0, 60) + '..."');
    const res = await omniGenerate({ input, label: 'clip (' + (segmentType || 'broll') + ', ' + how + ')' });
    const outputPath = path.join(outputDir || os.tmpdir(), 'broll_video_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.mp4');
    fs.writeFileSync(outputPath, res.buffer);
    return { filePath: outputPath, videoRef: res.interactionId };
  } catch (err) {
    console.warn('[B-Roll Video] ' + omniModel() + ' failed (' + how + '): ' + err.message);
    err.usedPhoto = usePhoto;
    return { error: err };
  }
}

/**
 * Extend an Omni clip by ~10s. Omni returns the FULL combined video (earlier footage + new),
 * so the caller should REPLACE its file with the returned one.
 * @param {string} params.videoRef - interaction id of the clip being extended
 * @returns {Promise<{filePath: string, videoRef: string|null}|null>}
 */
async function extendBrollVideo({ videoRef, prompt, outputDir, extensionNumber = 1 }) {
  if (!videoRef) return null;
  try {
    console.log('[B-Roll Extend] Extension #' + extensionNumber + ' with ' + omniModel() + ': "' + prompt.substring(0, 60) + '..."');
    const res = await omniGenerate({ input: prompt, previousInteractionId: videoRef, label: 'extension #' + extensionNumber });
    const outputPath = path.join(outputDir || os.tmpdir(), 'broll_extended_' + extensionNumber + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.mp4');
    fs.writeFileSync(outputPath, res.buffer);
    return { filePath: outputPath, videoRef: res.interactionId };
  } catch (err) {
    console.warn('[B-Roll Extend] Extension #' + extensionNumber + ' failed: ' + err.message);
    return null;
  }
}

/** Continuation prompt that keeps the same person, outfit and setting. */
function buildContinuationPrompt(desc, brandName, hasPersona) {
  return 'Continue the SAME single continuous shot smoothly — no scene cuts. Keep the same ' +
    (hasPersona ? 'person, the same outfit, ' : '') +
    'setting, lighting, color palette, and camera style. ' +
    (hasPersona ? 'The person must NOT be talking, speaking, or moving their lips — mouth stays closed. ' : 'No people. ') +
    'No text, no screens. Story continues: ' + sanitizeBrollPrompt(desc, brandName).substring(0, 160);
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
 * Generate one b-roll VIDEO clip, reacting to Google's actual error. NEVER returns a still image —
 * throws if every attempt fails (the caller then reuses b-roll from another section).
 *   • Persona photo blocked ("Input blocked") → remember it for this photo, describe the person in
 *     words instead (same look in every section) — the person stays in the shot.
 *   • Prompt blocked without a photo → simplify the prompt in steps, keeping the person:
 *       full description + brand/persona context → full description only → minimal description.
 *   • Rate limit / server error / timeout → retry the SAME prompt after a backoff.
 *   • Only the very last resort drops the person entirely.
 */
async function generateBroll({ description, brandName, brandDescription = '', personaDescription = '', outputDir, segmentType = '', segmentChannel = '', personaImageUrl = null, stats = null }) {
  const MAX_ATTEMPTS = 6;
  const TRANSIENT_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

  let mode = !personaImageUrl ? 'none' : (isPersonaPhotoBlocked(personaImageUrl) ? 'described' : 'photo');
  let promptLevel = 0; // 0 = full + context, 1 = full description only, 2 = minimal
  let transientCount = 0;

  const minimal = segmentType === 'intro'
    ? 'Beautiful cinematic opening shot. Slow camera movement across a stunning modern environment. Warm golden lighting.'
    : segmentType === 'outro'
    ? 'Warm cinematic closing shot. Slow pull-back camera movement. Beautiful golden hour lighting.'
    : 'Smooth cinematic lifestyle footage. Slow camera movement. Beautiful lighting. ' + description.substring(0, 80) + '.';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const personaLook = mode === 'described' ? await describePersona(personaImageUrl, '') : '';
    if (mode === 'described' && !personaLook) mode = 'none'; // couldn't describe them — fall through to no-people

    const desc = promptLevel >= 2 ? minimal : description;
    const passBrandDesc = promptLevel === 0 ? brandDescription : '';
    const passPersonaDesc = promptLevel === 0 ? personaDescription : '';

    const result = await generateBrollVideo({
      description: desc, brandName, brandDescription: passBrandDesc, personaDescription: passPersonaDesc,
      outputDir, segmentType, segmentChannel, personaImageUrl, personaMode: mode, personaLook,
    });

    if (result && result.filePath) {
      if (stats) {
        if (attempt > 1) stats.retried++;
        if (promptLevel > 0) stats.simplified++;
        if (mode === 'described') stats.described++;
        if (personaImageUrl && mode === 'none') stats.withoutPersona++;
      }
      return result;
    }

    const err = (result && result.error) || new Error('unknown error');
    const kind = classifyOmniError(err);
    if (stats) stats.errors.push({ kind, message: (err.message || '').replace(/^.*?HTTP \d+:\s*/, '').substring(0, 200), photo: !!err.usedPhoto });
    console.warn('[B-Roll] Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' for ' + (segmentType || 'broll') + ' failed (' + kind + ', ' + mode + ', level ' + promptLevel + ')');
    if (attempt === MAX_ATTEMPTS) break;

    if (kind === 'transient') {
      const delay = TRANSIENT_DELAYS_MS[Math.min(transientCount++, TRANSIENT_DELAYS_MS.length - 1)];
      console.log('[B-Roll] Google is busy — retrying the same prompt in ' + (delay / 1000) + 's');
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // Blocked or other content problem
    if (mode === 'photo' && err.usedPhoto && kind === 'blocked') {
      markPersonaPhotoBlocked(personaImageUrl);
      if (stats) stats.photoBlocked = true;
      mode = 'described';
      console.warn('[B-Roll] Google blocked the persona photo — describing the person in words instead');
    } else if (promptLevel < 2) {
      promptLevel++;
    } else if (mode !== 'none') {
      mode = 'none';
    } else {
      break; // nothing left to simplify
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('B-roll video generation failed for ' + (segmentType || 'broll') + ' segment. Description: "' + description.substring(0, 80) + '"');
}

/**
 * How many ~10s Omni clips a b-roll segment needs, from the voiceover timeline
 * (duration = next segment's startTime - this segment's startTime).
 */
function calcClipsNeeded(seg, timestamps, allSegments) {
  if (!timestamps || !timestamps.segments || !allSegments) return 1;
  const orderedTs = timestamps.segments.slice().sort((a, b) => a.order - b.order);
  const idx = orderedTs.findIndex(t => t.order === seg.order);
  if (idx < 0) return 1;
  const ts = orderedTs[idx];
  const nextTs = idx < orderedTs.length - 1 ? orderedTs[idx + 1] : null;
  const duration = nextTs ? (nextTs.startTime - ts.startTime) : (ts.endTime - ts.startTime);
  if (duration <= OMNI_CLIP_SECONDS) return 1;
  const clipsNeeded = Math.ceil(duration / OMNI_CLIP_SECONDS);
  console.log('[B-Roll] Segment ' + seg.order + ' needs ' + duration.toFixed(1) + 's → ' + clipsNeeded + ' × ' + OMNI_CLIP_SECONDS + 's clips');
  return clipsNeeded;
}

/**
 * Make all footage for ONE b-roll section as continuous shots of up to 30s each.
 *   Chain = 10s clip (with persona photo) + up to 2 extensions → one file of up to 30s.
 *   Sections longer than 30s start a new chain from the persona photo (one cut every 30s).
 *   If an extension fails, the shorter chain is kept and the next chain picks up the rest;
 *   the compositor loops/trims footage to the exact section length.
 * Returns an array of mp4 paths ([] if not even one clip could be made).
 */
async function generateSectionFootage({ seg, clipsNeeded, brandName, brandDescription = '', personaDescription = '', outputDir, personaImageUrl = null, stats = null, logPrefix = '[B-Roll]' }) {
  const desc = seg.brollDescription || 'Professional lifestyle footage';
  const mediaPaths = [];
  let remaining = Math.max(1, clipsNeeded);
  let chain = 0;

  while (remaining > 0 && chain < Math.max(1, clipsNeeded)) {
    const chainDesc = chain === 0
      ? desc
      : 'The story continues in the same world as before, a new angle of the same moment: ' + desc;
    let initial;
    try {
      initial = await generateBroll({
        description: chainDesc, brandName, brandDescription, personaDescription, outputDir,
        segmentType: seg.type || '', segmentChannel: seg.channel || '', personaImageUrl, stats,
      });
    } catch (err) {
      console.warn(logPrefix + ' Segment ' + seg.order + ': shot ' + (chain + 1) + ' could not start — ' + err.message);
      break;
    }

    let filePath = initial.filePath;
    let videoRef = initial.videoRef;
    let clipsInChain = 1;
    const target = Math.min(remaining, OMNI_MAX_CLIPS_PER_CHAIN);

    while (clipsInChain < target && videoRef) {
      const ext = await extendBrollVideo({
        videoRef,
        prompt: buildContinuationPrompt(desc, brandName, !!personaImageUrl),
        outputDir,
        extensionNumber: clipsInChain,
      });
      if (!ext) {
        if (stats) stats.extensionFailures++;
        console.warn(logPrefix + ' Segment ' + seg.order + ': extension ' + clipsInChain + ' failed — keeping ' + (clipsInChain * OMNI_CLIP_SECONDS) + 's shot');
        break;
      }
      // Omni returns the FULL combined video — replace, and delete the superseded file
      try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      filePath = ext.filePath;
      videoRef = ext.videoRef;
      clipsInChain++;
      if (stats) stats.extensions++;
    }

    mediaPaths.push(filePath);
    if (stats) stats.clips++;
    remaining -= clipsInChain;
    chain++;
    console.log(logPrefix + ' Segment ' + seg.order + ': shot ' + chain + ' = ' + (clipsInChain * OMNI_CLIP_SECONDS) + 's continuous' + (remaining > 0 ? ' (' + (remaining * OMNI_CLIP_SECONDS) + 's still needed)' : ''));
  }

  return mediaPaths;
}

function newBrollStats() {
  return { clips: 0, extensions: 0, extensionFailures: 0, retried: 0, simplified: 0, described: 0, withoutPersona: 0, photoBlocked: false, errors: [], reused: [], notes: [] };
}

/** Human-readable notes for the progress view — explain what happened and why. */
function summarizeBrollStats(stats) {
  const notes = [];
  if (stats.photoBlocked) {
    notes.push("Google's safety filter blocks this persona photo, so the person was described in words instead (same look in every section)" + (stats.described ? ' — ' + stats.described + ' clip' + (stats.described === 1 ? '' : 's') + ' made this way' : '') + '.');
  }
  if (stats.reused.length) {
    const list = stats.reused.map(r => 'section ' + r.order + ' used ' + r.from).join(', ');
    notes.push(stats.reused.length + ' section' + (stats.reused.length === 1 ? '' : 's') + ' reused b-roll after the video model failed (' + list + ').');
  }
  if (stats.simplified) {
    notes.push(stats.simplified + ' clip' + (stats.simplified === 1 ? '' : 's') + ' needed a simpler prompt after Google rejected the full one.');
  }
  if (stats.withoutPersona) {
    notes.push(stats.withoutPersona + ' clip' + (stats.withoutPersona === 1 ? '' : 's') + ' had to be made without the person.');
  }
  const transient = stats.errors.filter(e => e.kind === 'transient').length;
  if (transient) notes.push('Google was busy ' + transient + ' time' + (transient === 1 ? '' : 's') + '; those clips were retried with the same prompt.');
  if (stats.extensionFailures) {
    notes.push(stats.extensionFailures + ' extension' + (stats.extensionFailures === 1 ? '' : 's') + ' failed, so some shots are shorter and loop to fill their section.');
  }
  // Google's own words, most common first (excluding the photo block already explained)
  const counts = {};
  stats.errors.filter(e => e.kind !== 'transient' && !(e.photo && e.kind === 'blocked')).forEach(e => { counts[e.message] = (counts[e.message] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2);
  top.forEach(([m, n]) => notes.push('Google said' + (n > 1 ? ' (' + n + '×)' : '') + ': "' + m + '"'));
  return notes;
}

/**
 * Generate all b-roll for a video (max 5 sections in parallel).
 * Sections that still fail after every retry REUSE b-roll from the nearest successful section —
 * never a still image. If no section succeeds at all, this throws so the video fails visibly.
 * @returns {Promise<Array>} [{ order, mediaPaths, imagePath, reusedFrom }] with a non-enumerable `.stats`
 */
async function generateAllBroll(segments, brandName, outputDir, onProgress, personaImageUrl = null, timestamps = null, allSegments = null, brandDescription = '', personaDescription = '') {
  const stats = newBrollStats();
  const plan = segments.map(seg => ({ seg, clipsNeeded: calcClipsNeeded(seg, timestamps, allSegments) }));
  const totalSegments = segments.length;
  console.log('[B-Roll] Generating b-roll for ' + totalSegments + ' section(s) with ' + omniModel() + ' (≤30s continuous shots, max 5 in parallel)' + (personaImageUrl ? ' with persona photo' : '') + '...');

  const results = new Array(plan.length).fill(null);
  let completed = 0;
  let nextIdx = 0;
  let lastError = null;

  async function worker() {
    while (nextIdx < plan.length) {
      const idx = nextIdx++;
      const { seg, clipsNeeded } = plan[idx];
      console.log('[B-Roll] Section ' + seg.order + ' (' + (seg.type || 'broll') + '): ' + (clipsNeeded * OMNI_CLIP_SECONDS) + 's — "' + (seg.brollDescription || '').substring(0, 50) + '..."');
      try {
        const mediaPaths = await generateSectionFootage({ seg, clipsNeeded, brandName, brandDescription, personaDescription, outputDir, personaImageUrl, stats });
        results[idx] = { order: seg.order, mediaPaths };
      } catch (err) {
        lastError = err;
        console.error('[B-Roll] Section ' + seg.order + ' failed: ' + err.message);
        results[idx] = { order: seg.order, mediaPaths: [] };
      }
      completed++;
      if (onProgress) onProgress(Math.min(completed, totalSegments), totalSegments);
    }
  }

  const BROLL_STAGE_TIMEOUT_MS = 25 * 60 * 1000;
  let timedOut = false;
  const workers = [];
  for (let w = 0; w < Math.min(5, plan.length); w++) {
    if (w > 0) await new Promise(r => setTimeout(r, 2000));
    workers.push(worker());
  }
  let stageTimer;
  await Promise.race([
    Promise.all(workers),
    new Promise(resolve => { stageTimer = setTimeout(() => { timedOut = true; resolve(); }, BROLL_STAGE_TIMEOUT_MS); }),
  ]);
  clearTimeout(stageTimer);
  if (timedOut) console.warn('[B-Roll] Stage hit ' + (BROLL_STAGE_TIMEOUT_MS / 60000) + '-minute limit — using the sections finished so far');

  // Reuse b-roll for sections that got nothing (nearest successful section by order)
  const done = results.filter(r => r && r.mediaPaths.length > 0);
  if (done.length === 0) {
    throw new Error('B-roll video generation failed for every section' + (lastError ? ' (' + lastError.message + ')' : '') + '. No still images were used. Try regenerating in a few minutes.');
  }
  plan.forEach(({ seg }, idx) => {
    const r = results[idx];
    if (r && r.mediaPaths.length > 0) return;
    const donor = done.slice().sort((a, b) => Math.abs(a.order - seg.order) - Math.abs(b.order - seg.order))[0];
    results[idx] = { order: seg.order, mediaPaths: donor.mediaPaths.slice(), reusedFrom: donor.order };
    stats.reused.push({ order: seg.order, from: 'section ' + donor.order });
    console.warn('[B-Roll] Section ' + seg.order + ': no footage — reusing b-roll from section ' + donor.order);
  });

  stats.notes = summarizeBrollStats(stats);
  const out = results.filter(Boolean).map(r => ({ order: r.order, mediaPaths: r.mediaPaths, imagePath: r.mediaPaths[0], reusedFrom: r.reusedFrom }));
  Object.defineProperty(out, 'stats', { value: stats, enumerable: false });
  console.log('[B-Roll] Complete: ' + stats.clips + ' shot(s), ' + stats.extensions + ' extension(s), ' + stats.retried + ' retried, ' + stats.reused.length + ' section(s) reused — 0 still images');
  return out;
}

module.exports = {
  generateBrollImage, generateBrollVideo, extendBrollVideo, generateBroll, generateAllBroll, calcClipsNeeded,
  generateSectionFootage, newBrollStats, summarizeBrollStats, omniModel, omniGenerate,
  OMNI_CLIP_SECONDS, OMNI_MAX_CHAIN_SECONDS, describePersona, classifyOmniError, isPersonaPhotoBlocked,
};
