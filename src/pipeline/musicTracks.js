/**
 * Background music tracks.
 *
 * Library tracks: Kevin MacLeod (incompetech.com), licensed under Creative Commons Attribution 4.0.
 * The licence allows commercial use but REQUIRES a credit line (see creditFor()). The files are
 * loudness-normalized to -16 LUFS and hosted in this app's own storage under videos/_music/.
 *
 * Legacy tracks (SoundHelix, computer-generated electronic music) are kept so existing videos
 * still render; they are listed under "Electronic".
 */

const LIBRARY_CREDIT = (title) =>
  `"${title}" Kevin MacLeod (incompetech.com) — Licensed under Creative Commons: By Attribution 4.0 License (http://creativecommons.org/licenses/by/4.0/)`;

// key: file name in videos/_music/ (hosted copy)
const LIBRARY = [
  // Uplifting
  { id: 'life-of-riley', name: 'Life of Riley', category: 'Uplifting', mood: 'Bright, optimistic — ukulele & glockenspiel', duration: 235 },
  { id: 'carefree', name: 'Carefree', category: 'Uplifting', mood: 'Cheerful, light — ukulele & marimba', duration: 205 },
  { id: 'fretless', name: 'Fretless', category: 'Uplifting', mood: 'Warm, hopeful — guitar & ukulele', duration: 336 },
  // Acoustic & warm
  { id: 'almost-bliss', name: 'Almost Bliss', category: 'Acoustic & Warm', mood: 'Easygoing, sunny — acoustic guitars', duration: 317 },
  { id: 'clear-air', name: 'Clear Air', category: 'Acoustic & Warm', mood: 'Fresh, relaxed — guitar & piano', duration: 184 },
  { id: 'morning', name: 'Morning', category: 'Acoustic & Warm', mood: 'Gentle, peaceful — classical guitar, harp & flute', duration: 153 },
  { id: 'evening', name: 'Evening', category: 'Acoustic & Warm', mood: 'Calm, thoughtful — guitar, cello & oboe', duration: 186 },
  // Piano & elegant
  { id: 'fresh-air', name: 'Fresh Air', category: 'Piano & Elegant', mood: 'Calm, reflective — solo piano', duration: 294 },
  { id: 'crinoline-dreams', name: 'Crinoline Dreams', category: 'Piano & Elegant', mood: 'Elegant, graceful — piano & strings', duration: 246 },
  { id: 'dreamer', name: 'Dreamer', category: 'Piano & Elegant', mood: 'Soft, inspiring — piano', duration: 204 },
  // Jazz & lounge
  { id: 'backbay-lounge', name: 'Backbay Lounge', category: 'Jazz & Lounge', mood: 'Smooth, upscale — piano & guitar', duration: 267 },
  { id: 'bossa-antigua', name: 'Bossa Antigua', category: 'Jazz & Lounge', mood: 'Relaxed bossa nova — guitar', duration: 283 },
  { id: 'lobby-time', name: 'Lobby Time', category: 'Jazz & Lounge', mood: 'Light, polished — vibraphone & piano', duration: 193 },
];

const LEGACY = [
  { id: 'inspiring-cinematic', name: 'Electronic Pulse', mood: 'Electronic, upbeat', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', duration: 372 , gainOffsetDb: -7.03 },
  { id: 'corporate-technology', name: 'Electronic Drive', mood: 'Electronic, modern', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', duration: 318 , gainOffsetDb: -3.93 },
  { id: 'ambient-piano', name: 'Electronic Glow', mood: 'Electronic, mellow', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', duration: 291 , gainOffsetDb: -6.69 },
  { id: 'documentary-background', name: 'Electronic Story', mood: 'Electronic, steady', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', duration: 370 , gainOffsetDb: -3.58 },
  { id: 'soft-corporate', name: 'Electronic Soft', mood: 'Electronic, gentle', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', duration: 337 , gainOffsetDb: -4.1 },
  { id: 'future-tech', name: 'Electronic Future', mood: 'Electronic, futuristic', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', duration: 295 , gainOffsetDb: -3.25 },
];

const DEFAULT_TRACK_ID = 'life-of-riley';
// 0–100 for new videos. The level curve is unchanged: 50 = the level videos had before the volume control existed,
// 30 ≈ 3 dB quieter (music sits further under the narration).
const DEFAULT_MUSIC_VOLUME = 30;

function libraryUrl(id) {
  let base = '';
  try { base = require('../utils/storage').keyToUrl('videos/_music/' + id + '.mp3'); } catch { /* storage not configured */ }
  return base;
}

/** All tracks with resolved URLs, library first. */
function getMusicTracks() {
  const lib = LIBRARY.map(t => {
    const url = libraryUrl(t.id);
    return { ...t, url, preview_url: url, credit: LIBRARY_CREDIT(t.name), legacy: false };
  });
  const legacy = LEGACY.map(t => ({ ...t, category: 'Electronic', preview_url: t.url, credit: null, legacy: true }));
  return [...lib, ...legacy];
}

function getTrack(trackId) {
  return getMusicTracks().find(t => t.id === trackId) || null;
}

function getMusicTrackUrl(trackId) {
  const t = getTrack(trackId);
  return t ? t.url : null;
}

/** Credit line required by the track's licence, or null if none is needed. */
function creditFor(trackId) {
  const t = getTrack(trackId);
  return t ? t.credit : null;
}

/**
 * Music level for the mixer, as dB applied after normalizing the music to -16 LUFS.
 * 0 → no music. 50 → -14.4 dB (same level as before this setting existed). 100 → -6.4 dB.
 */
function musicGainDb(volume) {
  const v = Math.max(0, Math.min(100, Number.isFinite(Number(volume)) ? Number(volume) : DEFAULT_MUSIC_VOLUME));
  if (v === 0) return null;
  return +(-22.4 + v * 0.16).toFixed(2);
}

/**
 * FFmpeg filter chain for the music input: a fixed per-track level adjustment so every track
 * sits at about -16 LUFS (library files are already normalized; legacy tracks get a measured
 * offset), then the user's volume. Linear gain only — keeps the music's natural dynamics.
 * Returns null when the volume is 0 (no music).
 */
function musicFilterChain(volume, trackId) {
  const db = musicGainDb(volume);
  if (db === null) return null;
  const t = trackId ? getTrack(trackId) : null;
  const total = +(db + ((t && t.gainOffsetDb) || 0)).toFixed(2);
  return 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=' + total + 'dB';
}

module.exports = {
  getMusicTracks, getTrack, getMusicTrackUrl, creditFor, musicGainDb, musicFilterChain,
  DEFAULT_TRACK_ID, DEFAULT_MUSIC_VOLUME,
};
