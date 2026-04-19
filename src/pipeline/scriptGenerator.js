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
async function generateScript({ brandName, brandDescription, personaName, personaDescription, synopsis, scenes, durationTarget = 180 }) {
  const ai = getGenAI();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const sceneList = scenes.map((s, i) =>
    `  ${i + 1}. Scene ID ${s.id} — Channel: ${s.channel}${s.content_summary ? ` — ${s.content_summary}` : ''}`
  ).join('\n');

  const prompt = `You are a CX story narrator writing a script for a short video (~${Math.round(durationTarget / 60)} minutes).

BRAND: ${brandName}
${brandDescription ? `BRAND DESCRIPTION: ${brandDescription}` : ''}
${personaName ? `PERSONA: ${personaName}` : ''}
${personaDescription ? `PERSONA BACKGROUND: ${personaDescription}` : ''}
${synopsis ? `DEMO STORY SYNOPSIS: ${synopsis}` : ''}

SCENES (in order):
${sceneList}

Write a narration script that tells a connected customer experience story. The narration should:
- Start with an engaging intro that sets up the brand's vision
- Walk through each scene as part of a cohesive customer journey
- Include transition moments between major channel shifts
- End with a wrap-up that ties the experience together
- Be conversational and compelling, NOT a feature walkthrough
- Each segment's narration should be 2-4 sentences
- Target ~${durationTarget} seconds total (about ${Math.round(durationTarget / 15)} segments at ~15 seconds each)

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
      "narration": "The opening narration text...",
      "estimatedDuration": 12
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
      "estimatedDuration": 6
    }
  ]
}

Segment types:
- "intro" — Opening, always first, uses b-roll visual
- "scene" — Maps to a PocketSIC scene, uses scene_capture visual
- "transition" — Brief bridge between scenes, uses b-roll
- "outro" — Closing, always last, uses b-roll

IMPORTANT: Every PocketSIC scene MUST appear exactly once as a "scene" type segment. Include the scene's sceneId and channel.`;

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

  return script;
}

module.exports = { generateScript };
