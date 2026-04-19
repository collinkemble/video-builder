/**
 * Curated royalty-free background music tracks.
 * Pixabay license — free for commercial use, no attribution required.
 */
const MUSIC_TRACKS = [
  {
    id: 'inspiring-cinematic',
    name: 'Inspiring Cinematic',
    mood: 'Uplifting, motivational',
    url: 'https://cdn.pixabay.com/audio/2024/11/28/audio_3eca3db467.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/11/28/audio_3eca3db467.mp3',
    duration: 132,
  },
  {
    id: 'corporate-technology',
    name: 'Corporate Technology',
    mood: 'Modern, professional',
    url: 'https://cdn.pixabay.com/audio/2024/09/10/audio_6e6a40e982.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/09/10/audio_6e6a40e982.mp3',
    duration: 162,
  },
  {
    id: 'ambient-piano',
    name: 'Ambient Piano',
    mood: 'Calm, elegant',
    url: 'https://cdn.pixabay.com/audio/2024/02/14/audio_08d0da7dfd.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/02/14/audio_08d0da7dfd.mp3',
    duration: 138,
  },
  {
    id: 'documentary-background',
    name: 'Documentary',
    mood: 'Storytelling, cinematic',
    url: 'https://cdn.pixabay.com/audio/2024/06/11/audio_4abfd0ff1d.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/06/11/audio_4abfd0ff1d.mp3',
    duration: 188,
  },
  {
    id: 'soft-corporate',
    name: 'Soft Corporate',
    mood: 'Gentle, warm',
    url: 'https://cdn.pixabay.com/audio/2024/03/22/audio_2a847ee815.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/03/22/audio_2a847ee815.mp3',
    duration: 132,
  },
  {
    id: 'future-tech',
    name: 'Future Tech',
    mood: 'Innovation, futuristic',
    url: 'https://cdn.pixabay.com/audio/2024/10/01/audio_6b50ce9f05.mp3',
    preview_url: 'https://cdn.pixabay.com/audio/2024/10/01/audio_6b50ce9f05.mp3',
    duration: 145,
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
