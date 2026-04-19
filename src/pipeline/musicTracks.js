/**
 * Curated royalty-free background music tracks.
 * SoundHelix — free for use, public domain.
 */
const MUSIC_TRACKS = [
  {
    id: 'inspiring-cinematic',
    name: 'Inspiring Cinematic',
    mood: 'Uplifting, motivational',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    duration: 372,
  },
  {
    id: 'corporate-technology',
    name: 'Corporate Technology',
    mood: 'Modern, professional',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    duration: 318,
  },
  {
    id: 'ambient-piano',
    name: 'Ambient Piano',
    mood: 'Calm, elegant',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    duration: 291,
  },
  {
    id: 'documentary-background',
    name: 'Documentary',
    mood: 'Storytelling, cinematic',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
    duration: 370,
  },
  {
    id: 'soft-corporate',
    name: 'Soft Corporate',
    mood: 'Gentle, warm',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
    duration: 337,
  },
  {
    id: 'future-tech',
    name: 'Future Tech',
    mood: 'Innovation, futuristic',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
    preview_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
    duration: 295,
  },
];

function getMusicTrackUrl(trackId) {
  const track = MUSIC_TRACKS.find(t => t.id === trackId);
  return track ? track.url : null;
}

function getMusicTracks() {
  return MUSIC_TRACKS;
}

module.exports = { getMusicTrackUrl, getMusicTracks, MUSIC_TRACKS };
