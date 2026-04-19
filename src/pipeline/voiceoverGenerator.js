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
async function generateVoiceover({ segments, voiceId = 'pNInz6obpgDQGcFmaJgB', outputDir }) {
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
 * Get list of available voices from ElevenLabs
 * Pre-selected voices for the app
 */
function getAvailableVoices() {
  return [
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'Professional male narrator', style: 'deep' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', description: 'Professional female narrator', style: 'warm' },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'Warm conversational', style: 'conversational' },
    { id: 'jsCqWAovK2LkecY7zXl4', name: 'Freya', description: 'Energetic and upbeat', style: 'energetic' },
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'Calm and clear', style: 'calm' },
  ];
}

module.exports = { generateVoiceover, getAvailableVoices };
