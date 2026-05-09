/**
 * Smart Edit Parser — uses Gemini to interpret natural language editing instructions
 * and map them to specific segment changes for the regenerateSegments pipeline.
 *
 * Example inputs:
 *   "Change the intro b-roll to focus on the product"
 *   "Make the outro narration more energetic"
 *   "Update the first transition to show a cityscape"
 *   "Rewrite the narration for the email scene to be more conversational"
 */

const { GoogleGenAI } = require('@google/genai');

/**
 * Parse a natural-language editing instruction into concrete segment changes.
 *
 * @param {string} instruction - User's free-text edit instruction
 * @param {Array<object>} segments - Current script segments array
 * @param {string} brandName - Brand name for context
 * @returns {Promise<Array<object>>} Array of changes: [{ order, narration?, brollDescription?, regenerateVoiceover?, regenerateBroll? }]
 */
async function parseEditInstruction(instruction, segments, brandName = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const ai = new GoogleGenAI({ apiKey });

  // Build a compact summary of the current segments
  const segmentSummary = segments.map(seg => ({
    order: seg.order,
    type: seg.type,
    channel: seg.channel || null,
    narration: (seg.narration || '').substring(0, 150),
    brollDescription: (seg.brollDescription || '').substring(0, 100),
    visualType: seg.visualType || 'unknown',
    estimatedDuration: seg.estimatedDuration,
  }));

  const prompt = `You are a video editing assistant. A user wants to modify their video. Given their instruction and the current video script segments, determine which segments need changes and what those changes are.

CURRENT VIDEO SEGMENTS:
${JSON.stringify(segmentSummary, null, 2)}

BRAND: ${brandName || 'Unknown'}

USER INSTRUCTION: "${instruction}"

Respond with a JSON array of changes. Each change object should have:
- "order" (required): the segment order number to change
- "narration" (optional): new narration text if narration should change
- "brollDescription" (optional): new b-roll description if visuals should change
- "regenerateVoiceover" (boolean): true if narration/voice needs regeneration
- "regenerateBroll" (boolean): true if visuals need regeneration

RULES:
1. Only include segments that actually need changes based on the instruction
2. If the user mentions "intro", "beginning", "start" — that's typically order 1
3. If the user mentions "outro", "ending", "end", "closing" — that's the last segment
4. If the user mentions a specific channel (e.g., "email scene", "website section"), match by channel name
5. If the user wants to change narration text, set regenerateVoiceover: true and provide new narration
6. If the user wants to change visuals/b-roll, set regenerateBroll: true and provide new brollDescription
7. If the user says "make more X" about narration, rewrite the narration with that quality
8. For b-roll description changes, write a cinematic description suitable for AI video generation
9. Scene capture segments (visualType: "scene_capture") CANNOT have their visuals regenerated — only narration
10. Keep existing narration style and length when rewriting — just apply the requested change

Respond with ONLY the JSON array, no markdown formatting or explanation.`;

  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const result = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    });
    const text = (result.text || '').trim();

    // Parse the JSON — handle potential markdown wrapping
    let jsonStr = text;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const changes = JSON.parse(jsonStr);

    if (!Array.isArray(changes)) {
      throw new Error('LLM returned non-array response');
    }

    // Validate each change
    const validChanges = changes.filter(c => {
      if (!c.order || typeof c.order !== 'number') return false;
      // Ensure the order exists in segments
      const seg = segments.find(s => s.order === c.order);
      if (!seg) return false;
      // Don't allow b-roll regeneration on scene captures
      if (seg.visualType === 'scene_capture' && c.regenerateBroll) {
        c.regenerateBroll = false;
      }
      // Must have at least one action
      return c.narration || c.brollDescription || c.regenerateVoiceover || c.regenerateBroll;
    });

    console.log(`[SmartEdit] Instruction: "${instruction}" → ${validChanges.length} change(s)`);
    return validChanges;

  } catch (err) {
    console.error(`[SmartEdit] Parse failed: ${err.message}`);
    throw new Error(`Failed to interpret edit instruction: ${err.message}`);
  }
}

module.exports = { parseEditInstruction };
