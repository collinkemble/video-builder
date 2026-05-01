const { GoogleGenAI } = require('@google/genai');

let genai = null;

function getGenAI() {
  if (genai) return genai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  genai = new GoogleGenAI({ apiKey });
  return genai;
}

/**
 * Generate a narration script from PocketSIC scene data
 * @param {object} params
 * @param {string} params.brandName - Brand name
 * @param {string} params.brandDescription - Brand description/tone
 * @param {string} params.personaName - Demo persona name
 * @param {string} params.personaDescription - Persona backstory
 * @param {string} params.synopsis - Demo story synopsis
 * @param {Array} params.scenes - Array of scene objects with { id, channel, content_summary }
 * @param {number} params.durationTarget - Target duration in seconds (default 180)
 * @returns {Promise<object>} Structured narration timeline
 */
async function generateScript({ brandName, brandDescription, personaName, personaDescription, synopsis, scenes, durationTarget = 180, scriptWriterData = null }) {
  const ai = getGenAI();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const sceneList = scenes.map((s, i) =>
    `  ${i + 1}. Scene ID ${s.id} — Channel: ${s.channel}${s.content_summary ? ` — ${s.content_summary}` : ''}`
  ).join('\n');

  // Build Script Writer reference section if we have data from the Script Writer app
  let scriptWriterSection = '';
  if (scriptWriterData) {
    const swParts = [];
    if (scriptWriterData.title) swParts.push(`SCRIPT TITLE: ${scriptWriterData.title}`);
    if (scriptWriterData.script_data) {
      const sd = typeof scriptWriterData.script_data === 'string'
        ? JSON.parse(scriptWriterData.script_data)
        : scriptWriterData.script_data;
      // Extract key narrative elements from the Script Writer output
      if (sd.opening) swParts.push(`OPENING: ${sd.opening}`);
      if (sd.narrative_arc) swParts.push(`NARRATIVE ARC: ${sd.narrative_arc}`);
      if (sd.closing) swParts.push(`CLOSING: ${sd.closing}`);
      if (sd.key_messages && Array.isArray(sd.key_messages)) {
        swParts.push(`KEY MESSAGES:\n${sd.key_messages.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`);
      }
      if (sd.tone) swParts.push(`TONE: ${sd.tone}`);
      if (sd.full_script) swParts.push(`REFERENCE SCRIPT:\n${sd.full_script}`);
      // Fallback: if script_data is a simple string or has a body/content field
      if (typeof sd === 'string') swParts.push(`REFERENCE SCRIPT:\n${sd}`);
      if (sd.body) swParts.push(`REFERENCE SCRIPT:\n${sd.body}`);
      if (sd.content) swParts.push(`REFERENCE SCRIPT:\n${sd.content}`);
    }
    if (swParts.length > 0) {
      scriptWriterSection = `\n\nDEMO SCRIPT (from Script Writer — use this as the primary narrative basis):\n${swParts.join('\n')}`;
    }
  }

  const scriptWriterInstruction = scriptWriterData
    ? `\n- IMPORTANT: A demo script has been provided from Script Writer. Use it as the primary narrative basis — adapt its language, tone, key messages, and story arc to fit the video timeline. Do NOT ignore it.`
    : '';

  const prompt = `You are a CX story narrator writing a script for a short video (~${Math.round(durationTarget / 60)} minutes).

BRAND: ${brandName}
${brandDescription ? `BRAND DESCRIPTION: ${brandDescription}` : ''}
${personaName ? `PERSONA: ${personaName}` : ''}
${personaDescription ? `PERSONA BACKGROUND: ${personaDescription}` : ''}
${synopsis ? `DEMO STORY SYNOPSIS: ${synopsis}` : ''}${scriptWriterSection}

SCENES (in order):
${sceneList}

Write a narration script that tells a connected customer experience story. The narration should:
- Start with a SHORT, punchy intro (2-3 sentences) that sets up the BRAND and mentions the Salesforce partnership. The intro MUST include a line like "${brandName}, together with Salesforce, is transforming [the customer experience / the industry / how customers connect]" or similar. Do NOT mention or introduce the persona/character by name in the intro. The intro should mention the brand, Salesforce, and what they're doing together.
- The persona should be introduced ONLY ONCE, in the narration for the FIRST scene segment (e.g., "Meet [name], who…"). Never introduce or mention the persona by name in the intro segment. If the persona is introduced in the intro, the script is WRONG.
- NEVER mention the persona's name more than once across the ENTIRE script. After introducing them in the first scene, refer to them as "she", "he", "they", "our customer", etc. — NEVER repeat their name.
- Walk through each scene as part of a cohesive customer journey
- Include transition moments between major channel shifts
- End with a wrap-up outro that ties the experience together AND reinforces the Salesforce partnership. The outro MUST include a closing line like "This is how ${brandName} and Salesforce are transforming [the customer experience / their industry]" or "Together with Salesforce, ${brandName} is redefining what's possible" or similar. Make it feel like a natural, inspiring conclusion.
- Be conversational and compelling, NOT a feature walkthrough
- Each segment's narration should be 2-4 sentences
- Target ~${durationTarget} seconds total (about ${Math.round(durationTarget / 15)} segments at ~15 seconds each)${scriptWriterInstruction}

Return ONLY valid JSON in this exact format:
{
  "title": "Brand's Connected Customer Experience",
  "totalSegments": <number>,
  "segments": [
    {
      "order": 1,
      "type": "intro",
      "sceneId": null,
      "channel": null,
      "visualType": "broll",
      "brollDescription": "Description of a lifestyle/brand image for the intro",
      "narration": "Short punchy intro about the BRAND and Salesforce partnership — 2-3 sentences, absolutely NO persona name here",
      "estimatedDuration": 10
    },
    {
      "order": 2,
      "type": "scene",
      "sceneId": <scene_id_number>,
      "channel": "<channel_name>",
      "visualType": "scene_capture",
      "brollDescription": null,
      "narration": "Narration for this scene...",
      "estimatedDuration": 15
    },
    {
      "order": 3,
      "type": "transition",
      "sceneId": null,
      "channel": null,
      "visualType": "broll",
      "brollDescription": "Description of a transition image",
      "narration": "Brief transition narration...",
      "estimatedDuration": 10
    }
  ]
}

Segment types:
- "intro" — Opening (2-3 sentences, ~10 seconds), always first, uses b-roll visual. Sets up the BRAND and mentions the Salesforce partnership (e.g., "[Brand], together with Salesforce, is transforming..."). Do NOT introduce or name the persona here. Must be long enough for the logo animation overlay.
- "scene" — Maps to a PocketSIC scene, uses scene_capture visual. The FIRST scene segment is where the persona should be introduced by name.
- "transition" — Brief bridge between scenes, uses b-roll
- "outro" — Closing (3-4 sentences, ~12-15 seconds), always last, uses b-roll. Must reinforce the Salesforce partnership with a closing line like "This is how [Brand] and Salesforce are transforming..." or "Together with Salesforce, [Brand] is redefining..."

B-ROLL / TRANSITION PLACEMENT RULES (CRITICAL):
- Do NOT put a transition/b-roll between scenes that happen immediately after each other in the customer journey. For example: customer sees an Instagram ad and clicks through to the website — these happen back-to-back with no time gap, so NO transition between them.
- DO put a transition/b-roll between scenes where time passes. For example: customer purchases on the website, and LATER goes to a physical retail store — there is a passage of time here, so include a b-roll transition.
- The b-roll should visually represent the passage of time or change in context (e.g., "Customer leaving home and heading to the store", "Time passes as the order is being prepared").
- When in doubt, if two scenes are part of the same immediate interaction flow (same session, same moment), do NOT add b-roll between them.
- Typically a 3-minute video should have at most 2-3 b-roll transitions (intro, maybe 1-2 time-passage moments, outro).

B-ROLL RELEVANCE RULES (CRITICAL — b-roll MUST match the story):
- Every brollDescription MUST be directly relevant to the BRAND and the STORY being told. Generic city footage or random activities are WRONG.
- Think about what the brand actually does. If it's a makeup brand, show beauty/cosmetics environments and products. If it's a sports brand, show athletic environments and gear. ALWAYS match the brand's industry.
- IMPORTANT: Describe ENVIRONMENTS, PRODUCTS, and ATMOSPHERIC SCENES — not people. The video system handles character consistency separately. Your descriptions should focus on settings, objects, textures, and moods.
- The intro b-roll should describe a wide establishing shot of an ENVIRONMENT relevant to the brand (e.g., for a beauty brand: "Sunlit boutique beauty store interior with elegant cosmetics displays and warm golden lighting", for a sports brand: "Misty morning running trail through a forest with dappled sunlight").
- Transition b-roll should describe the specific ENVIRONMENT or PRODUCT context change (e.g., for a makeup buyer: "Close-up of beautifully arranged luxury cosmetics and brushes on a marble vanity with soft warm light" NOT "person running through Manhattan").
- The outro b-roll should describe a warm concluding ENVIRONMENT or MOOD relevant to the brand (e.g., for a beauty brand: "Golden hour light streaming through a chic boutique window with fresh flowers and beauty products" NOT "generic sunset over a city").
- NEVER describe random people or generic activities. Focus on the brand's WORLD — its products, stores, environments, and atmosphere.

B-ROLL UNIQUENESS RULES (CRITICAL):
- Every brollDescription MUST be completely unique and visually distinct from every other brollDescription.
- Do NOT repeat or closely paraphrase the same description. Each b-roll clip is generated as a separate video — if descriptions are similar, the clips look identical and the video appears to repeat itself.
- NEVER repeat the same action or prop across different b-roll clips. Each clip must show a FUNDAMENTALLY DIFFERENT activity.
- NEVER include delivery trucks, shipping vehicles, or logistics imagery — these create ugly shots with fake text on them.
- NEVER use generic descriptions — be hyper-specific about the exact visual scene, camera angle, and mood. Each description must paint a distinct cinematic picture that is relevant to this brand's industry and persona.

DURATION RULES:
- Intro segments should be 8-12 seconds with 2-3 sentences that set up the brand. The intro has an animated logo overlay that needs time to play, so aim for 10 seconds of narration. Do NOT make the intro shorter than 8 seconds. No persona introduction here.
- Transition segments should be at least 8-10 seconds with meaningful narration (2-3 sentences).
- Outro segments should be at least 10-15 seconds with a proper wrap-up (3-4 sentences).
- Scene segments should be 12-20 seconds each.
- NEVER make any segment shorter than 5 seconds. Short segments create jarring visual cuts.

IMPORTANT: Every PocketSIC scene MUST appear exactly once as a "scene" type segment. Include the scene's sceneId and channel.

CRITICAL ORDERING RULE: Scene segments MUST appear in the EXACT same order as the SCENES list above. Do NOT reorder scenes. The scenes are already in the correct customer journey sequence — scene 1 happens first, scene 2 happens second, etc. You may insert b-roll transitions BETWEEN scenes, but never swap or rearrange the scenes themselves.`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.7,
    },
  });

  let text = response.text.trim();

  // Strip markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  const script = JSON.parse(text);

  // Validate: every scene should appear
  const scriptSceneIds = script.segments
    .filter(s => s.type === 'scene')
    .map(s => s.sceneId);

  const missingScenes = scenes.filter(s => !scriptSceneIds.includes(s.id));
  if (missingScenes.length > 0) {
    console.warn(`Warning: ${missingScenes.length} scene(s) missing from script: ${missingScenes.map(s => s.id).join(', ')}`);
  }

  // ── Validate: persona name must NOT appear in intro ──
  // The LLM sometimes ignores the instruction and introduces the persona in the intro.
  // Detect this and warn — we can't easily rewrite the narration, but at least flag it.
  if (personaName) {
    const introSeg = script.segments.find(s => s.type === 'intro');
    if (introSeg && introSeg.narration) {
      const namePattern = new RegExp(personaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (namePattern.test(introSeg.narration)) {
        console.warn(`[ScriptGenerator] ⚠ Persona name "${personaName}" found in intro narration — removing it.`);
        // Attempt to remove the persona introduction from the intro
        // Common patterns: "Meet X, ...", "X is ...", "Enter X, ..."
        introSeg.narration = introSeg.narration
          .replace(new RegExp(`\\bMeet\\s+${personaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]*\\.\\s*`, 'gi'), '')
          .replace(new RegExp(`\\bEnter\\s+${personaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]*\\.\\s*`, 'gi'), '')
          .replace(new RegExp(`\\b${personaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'a customer')
          .trim();
        console.log(`[ScriptGenerator] Cleaned intro narration: "${introSeg.narration.substring(0, 100)}..."`);
      }
    }
  }

  // ── Enforce minimum intro duration for logo overlay animation ──
  const introSegment = script.segments.find(s => s.type === 'intro');
  if (introSegment && introSegment.estimatedDuration < 10) {
    console.log(`[ScriptGenerator] Intro estimatedDuration ${introSegment.estimatedDuration}s → bumped to 10s for logo overlay`);
    introSegment.estimatedDuration = 10;
  }

  // ── Enforce scene ordering matches input order ──
  // Gemini sometimes reorders scenes despite being told not to.
  // Re-sort: keep non-scene segments in their relative positions around scenes,
  // but ensure scene segments follow the original input order.
  const inputSceneOrder = scenes.map(s => s.id);
  const sceneSegments = script.segments.filter(s => s.type === 'scene');
  const sceneOrderInScript = sceneSegments.map(s => s.sceneId);

  const isCorrectOrder = inputSceneOrder.every((id, idx) => {
    const scriptIdx = sceneOrderInScript.indexOf(id);
    if (scriptIdx === -1) return true; // missing scene, already warned
    if (idx === 0) return true;
    const prevId = inputSceneOrder[idx - 1];
    const prevScriptIdx = sceneOrderInScript.indexOf(prevId);
    return prevScriptIdx === -1 || prevScriptIdx < scriptIdx;
  });

  if (!isCorrectOrder) {
    console.warn('[ScriptGenerator] Scene order does not match input. Re-sorting to enforce correct sequence.');
    // Rebuild segments: extract scenes and non-scenes, then interleave correctly
    const nonSceneSegments = script.segments.filter(s => s.type !== 'scene');
    const sceneMap = {};
    sceneSegments.forEach(s => { sceneMap[s.sceneId] = s; });

    const reordered = [];
    let nonSceneIdx = 0;

    // Add intro/transition segments that appear before the first scene
    const firstScenePos = script.segments.findIndex(s => s.type === 'scene');
    for (let i = 0; i < firstScenePos && i < script.segments.length; i++) {
      if (script.segments[i].type !== 'scene') reordered.push(script.segments[i]);
    }

    // Interleave scenes in correct order with transitions between them
    const scenesInScript = inputSceneOrder.filter(id => sceneMap[id]);
    for (let i = 0; i < scenesInScript.length; i++) {
      reordered.push(sceneMap[scenesInScript[i]]);

      // Find transition/broll that was between this scene and the next in the original script
      if (i < scenesInScript.length - 1) {
        const curSceneOrigIdx = script.segments.findIndex(s => s.sceneId === scenesInScript[i]);
        const nextSceneOrigIdx = script.segments.findIndex(s => s.sceneId === scenesInScript[i + 1]);
        if (curSceneOrigIdx !== -1 && nextSceneOrigIdx !== -1) {
          for (let j = curSceneOrigIdx + 1; j < nextSceneOrigIdx; j++) {
            if (script.segments[j].type !== 'scene') reordered.push(script.segments[j]);
          }
        }
      }
    }

    // Add outro/trailing segments after the last scene
    const lastScenePos = script.segments.length - 1 - [...script.segments].reverse().findIndex(s => s.type === 'scene');
    for (let i = lastScenePos + 1; i < script.segments.length; i++) {
      if (script.segments[i].type !== 'scene') reordered.push(script.segments[i]);
    }

    // Re-number orders
    reordered.forEach((seg, idx) => { seg.order = idx + 1; });
    script.segments = reordered;
    script.totalSegments = reordered.length;
    console.log(`[ScriptGenerator] Re-sorted ${reordered.length} segments. Scene order now: ${reordered.filter(s => s.type === 'scene').map(s => s.sceneId).join(', ')}`);
  }

  return script;
}

module.exports = { generateScript };
