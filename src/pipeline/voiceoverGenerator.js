const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Generate voiceover audio with word-level timestamps from ElevenLabs
 * @param {object} params
 * @param {Array} params.segments - Script segments with narration text
 * @param {string} params.voiceId - ElevenLabs voice ID
 * @param {string} params.outputDir - Directory to save audio file
 * @returns {Promise<object>} { audioPath, timestamps, totalDuration }
 */
async function generateVoiceover({ segments, voiceId = 'XrExE9yKIg1WjnnlVkGX', outputDir }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');

  // Concatenate narration segments with pause markers
  // Track character positions for segment mapping
  const segmentMeta = [];
  let fullText = '';

  for (const segment of segments) {
    const startChar = fullText.length;
    fullText += segment.narration;
    const endChar = fullText.length;
    segmentMeta.push({
      order: segment.order,
      startChar,
      endChar,
    });
    fullText += '\n\n'; // Natural pause between segments
  }

  fullText = fullText.trim();

  // Call ElevenLabs TTS with timestamps
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: fullText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errText}`);
  }

  const data = await response.json();

  // Decode base64 audio
  const audioBuffer = Buffer.from(data.audio_base64, 'base64');
  const audioPath = path.join(outputDir || os.tmpdir(), `voiceover_${Date.now()}.mp3`);
  fs.writeFileSync(audioPath, audioBuffer);

  // Map character-level alignments back to segments
  const alignment = data.alignment || {};
  const characters = alignment.characters || [];
  const charStartTimes = alignment.character_start_times_seconds || [];
  const charEndTimes = alignment.character_end_times_seconds || [];

  const segmentTimestamps = segmentMeta.map(meta => {
    // Find first and last character within this segment's range
    let startTime = null;
    let endTime = null;

    for (let i = 0; i < characters.length; i++) {
      const charPos = alignment.character_positions
        ? alignment.character_positions[i]
        : i;

      if (charPos >= meta.startChar && charPos < meta.endChar) {
        if (startTime === null) startTime = charStartTimes[i];
        endTime = charEndTimes[i];
      }
    }

    // Fallback: estimate from segment order
    if (startTime === null) {
      const totalDur = charEndTimes.length > 0
        ? charEndTimes[charEndTimes.length - 1]
        : segments.length * 15;
      const avgDur = totalDur / segments.length;
      startTime = (meta.order - 1) * avgDur;
      endTime = meta.order * avgDur;
    }

    return {
      order: meta.order,
      startTime: Math.round(startTime * 100) / 100,
      endTime: Math.round(endTime * 100) / 100,
    };
  });

  const totalDuration = segmentTimestamps.length > 0
    ? segmentTimestamps[segmentTimestamps.length - 1].endTime
    : 0;

  return {
    audioPath,
    timestamps: {
      segments: segmentTimestamps,
      totalDuration: Math.round(totalDuration * 100) / 100,
    },
    totalDuration,
  };
}

/**
 * Curated voice list — IDs and metadata.
 * preview_url is fetched on-demand from ElevenLabs.
 *
 * All voices support all 29 Multilingual v2 languages — the language is determined
 * by the text, not the voice. However, some voices have accents that pair better
 * with specific languages, so we add bonus voices per language.
 */
// Core voices — available for every language (verified April 2026).
const CORE_VOICES = [
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'Dominant, firm male narrator', style: 'deep' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Mature, reassuring, confident', style: 'warm' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'Steady broadcaster', style: 'conversational' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', description: 'Playful, bright, warm', style: 'energetic' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Knowledgeable, professional', style: 'calm' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'Deep, resonant, comforting', style: 'deep' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', description: 'Velvety actress', style: 'warm' },
];

// Bonus voices for specific languages — these have accents that pair well
// with the target language, producing more natural-sounding results.
// They are PREPENDED to the voice list so they appear first as recommended options.
const LANGUAGE_BONUS_VOICES = {
  Italian:  [{ id: 'zcAOhNBS3c14rBihAFp1', name: 'Giovanni', description: 'Italian-accented, young male', style: 'warm', recommended: true }],
  Swedish:  [{ id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', description: 'Swedish-accented, sophisticated female', style: 'warm', recommended: true }],
  French:   [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Raspy British, strong in French', style: 'deep', recommended: true }],
  German:   [{ id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', description: 'Pleasant, clear female — great for German', style: 'warm', recommended: true }],
  Spanish:  [{ id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy', description: 'Pleasant British female — strong in Spanish', style: 'warm', recommended: true }],
  Portuguese: [{ id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy', description: 'Pleasant British female — strong in Portuguese', style: 'warm', recommended: true }],
  Japanese: [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Chinese:  [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Korean:   [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Hindi:    [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Arabic:   [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Dutch:    [{ id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', description: 'Swedish-accented, close to Dutch', style: 'warm', recommended: true }],
  Polish:   [{ id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', description: 'Casual Australian — strong in Polish', style: 'conversational', recommended: true }],
  Russian:  [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
  Turkish:  [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Versatile multilingual male', style: 'deep', recommended: true }],
};

/**
 * Get the curated voice list for a given language.
 * Returns bonus voices (if any) prepended to the core list.
 */
function getVoicesForLanguage(language = 'English') {
  const bonus = LANGUAGE_BONUS_VOICES[language] || [];
  // Deduplicate: if a bonus voice ID is already in CORE_VOICES, skip it
  const coreIds = new Set(CORE_VOICES.map(v => v.id));
  const uniqueBonus = bonus.filter(v => !coreIds.has(v.id));
  return [...uniqueBonus, ...CORE_VOICES];
}

// Cache for preview URLs (populated on first request, lives for process lifetime)
// We cache the full ElevenLabs voice map (all voices) and build per-language lists on demand.
let cachedElevenLabsVoiceMap = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the full ElevenLabs voice map (id → voice object) with preview URLs.
 * Cached for 1 hour.
 */
async function fetchVoiceMap() {
  if (cachedElevenLabsVoiceMap && (Date.now() - cacheTimestamp < CACHE_TTL)) {
    return cachedElevenLabsVoiceMap;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn('[Voices] No ELEVENLABS_API_KEY — returning voices without previews');
    return {};
  }

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs voices API returned ${response.status}`);
    }

    const data = await response.json();
    const voiceMap = {};
    for (const v of (data.voices || [])) {
      voiceMap[v.voice_id] = v;
    }

    cachedElevenLabsVoiceMap = voiceMap;
    cacheTimestamp = Date.now();
    console.log(`[Voices] Cached ${Object.keys(voiceMap).length} voices from ElevenLabs`);
    return voiceMap;
  } catch (err) {
    console.warn(`[Voices] Failed to fetch voice map: ${err.message}`);
    return cachedElevenLabsVoiceMap || {};
  }
}

/**
 * Get list of available voices for a language, enriched with preview_url from ElevenLabs.
 * Falls back to voices without preview URLs if the API call fails.
 * @param {string} [language='English'] - Language to get voices for
 */
async function getAvailableVoices(language = 'English') {
  const voiceMap = await fetchVoiceMap();
  const voices = getVoicesForLanguage(language);

  // Enrich with preview URLs
  const enriched = voices.map(cv => {
    const elVoice = voiceMap[cv.id];
    return {
      ...cv,
      preview_url: elVoice?.preview_url || null,
    };
  });

  return enriched;
}

module.exports = { generateVoiceover, getAvailableVoices };
