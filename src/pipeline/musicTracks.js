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
  { id: 'jazz-brunch', name: 'Jazz Brunch', category: 'Jazz & Lounge', mood: 'Easy, upscale café — electric piano & guitar', duration: 323 },
  { id: 'apero-hour', name: 'Apero Hour', category: 'Jazz & Lounge', mood: 'Cool, relaxed — guitar & organ', duration: 283 },
  { id: 'samba-isobel', name: 'Samba Isobel', category: 'Jazz & Lounge', mood: 'Bright samba-jazz — piano trio', duration: 250 },
  { id: 'in-your-arms', name: 'In Your Arms', category: 'Jazz & Lounge', mood: 'Elegant 1940s big band — horns', duration: 169 },
  { id: 'george-street-shuffle', name: 'George Street Shuffle', category: 'Jazz & Lounge', mood: 'Light, friendly — vibraphone & piano', duration: 268 },
  // Pop
  { id: 'sunshine', name: 'Sunshine', category: 'Pop', mood: 'Bright, feel-good — piano & guitar', duration: 202 },
  { id: 'glitter-blast', name: 'Glitter Blast', category: 'Pop', mood: 'Playful, sparkly — ukulele, flute & glockenspiel', duration: 178 },
  { id: 'funky-chunk', name: 'Funky Chunk', category: 'Pop', mood: 'Upbeat funk-pop — bass, keys & horns', duration: 239 },
  { id: 'shaving-mirror', name: 'Shaving Mirror', category: 'Pop', mood: 'Bouncy, confident — guitar, organ & horns', duration: 206 },
  { id: 'celebration', name: 'Celebration', category: 'Pop', mood: 'Warm, celebratory — saxes & trombones', duration: 278 },
  // Classical (Kevin MacLeod performances, CC BY 4.0). title = name used in the credit line
  { id: 'gymnopedie-no-1', name: 'Gymnopedie No. 1', category: 'Classical', mood: 'Serene, refined — solo piano (Satie)', duration: 187 },
  { id: 'canon-in-d', name: 'Canon in D Major', category: 'Classical', mood: 'Timeless, graceful — violin, harp & bass (Pachelbel)', duration: 356 },
  { id: 'prelude-in-c', name: 'Prelude in C', title: 'Prelude in C - BWV 846', category: 'Classical', mood: 'Flowing, poised — solo piano (Bach)', duration: 179 },
  { id: 'brandenburg-no-4', name: 'Brandenburg Concerto No. 4', title: 'Brandenburg Concerto No. 4 in G, Movement I (Allegro), BWV 1049', category: 'Classical', mood: 'Bright, stately — flute, strings & harpsichord (Bach)', duration: 438 },
  { id: 'there-is-romance', name: 'There is Romance', category: 'Classical', mood: 'Tender, intimate — solo piano', duration: 198 },
  { id: 'aquarium', name: 'Aquarium', category: 'Classical', mood: 'Polished, a little mysterious — flute, piano & strings', duration: 144 },
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
    return { ...t, url, preview_url: url, credit: LIBRARY_CREDIT(t.title || t.name), legacy: false };
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

/**
 * Make sure every library track is in THIS app's storage (videos/_music/). Missing tracks are
 * copied once from the seed copy (staging's public storage by default). Safe to run on every boot.
 */
async function ensureMusicLibrary() {
  const storage = require('../utils/storage');
  if (!storage.isConfigured || !storage.isConfigured()) return;
  const seedBase = (process.env.MUSIC_SEED_BASE_URL || 'https://d1vf0mzqz17dz6.cloudfront.net').replace(/\/$/, '');
  const own = storage.getPublicUrl ? (storage.getPublicUrl() || '').replace(/\/$/, '') : '';
  let copied = 0, failed = 0;
  for (const t of LIBRARY) {
    const key = 'videos/_music/' + t.id + '.mp3';
    try {
      if (await storage.headObject(key)) continue;
      if (own && own === seedBase) { failed++; console.warn('[Music] ' + key + ' missing and this app is the seed source'); continue; }
      const resp = await fetch(seedBase + '/' + key);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = Buffer.from(await resp.arrayBuffer());
      await storage.putObject(key, buf, 'audio/mpeg', { contentLength: buf.length, cacheControl: 'public, max-age=31536000, immutable' });
      copied++;
    } catch (err) {
      failed++;
      console.warn('[Music] Could not add ' + key + ': ' + err.message);
    }
  }
  console.log('[Music] Library check: ' + (LIBRARY.length - failed) + '/' + LIBRARY.length + ' tracks available' + (copied ? ' (' + copied + ' copied in)' : ''));
}

module.exports = {
  ensureMusicLibrary,
  getMusicTracks, getTrack, getMusicTrackUrl, creditFor, musicGainDb, musicFilterChain,
  DEFAULT_TRACK_ID, DEFAULT_MUSIC_VOLUME,
};
