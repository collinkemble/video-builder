/**
 * Scene order for the narration and the video.
 *
 * PocketSIC stores a project's scenes newest-first, so the stored order is usually the REVERSE of the
 * customer journey. Order, in priority:
 *   1. The demo script's channel sections (Script Writer rows: "Channel - TikTok", "Channel - Website"…)
 *   2. The journey summary (cx_summary), by first mention of each channel
 *   3. Creation order (scene id ascending) — PocketSIC creates scenes from the script in journey order
 * Scenes that can't be matched keep their creation-order position relative to matched neighbours.
 *
 * Also attaches `scriptSection` (that channel's talk track from the demo script) to each scene, so the
 * narration can follow what the script actually says happens there.
 */

const EXCLUDED_CHANNELS = ['data360'];

// Words that identify each PocketSIC channel in free text. Order inside a list doesn't matter.
const CHANNEL_KEYWORDS = {
  site: ['website', 'web site', 'storefront', 'store front', 'digital boutique', 'digital flagship', 'digital salon', 'e-commerce', 'ecommerce', 'online store', 'online shop', 'commerce cloud', 'homepage', 'home page', 'landing page', 'web chat', 'webchat', 'site'],
  insta: ['instagram', 'insta'],
  tiktok: ['tiktok', 'tik tok'],
  facebook: ['facebook'],
  x: ['twitter', ' x ', 'x.com'],
  linkedin: ['linkedin'],
  email: ['email', 'e-mail', 'inbox', 'mail app'],
  imessage: ['imessage', 'i-message', 'text message', 'sms'],
  sms: ['sms', 'text message'],
  whatsapp: ['whatsapp', 'whats app'],
  slack: ['slack'],
  retailcloud: ['retail cloud', 'point of sale', 'pos', 'in-store', 'in store', 'store associate', 'clienteling', 'client advisor', 'store visit'],
  autocloud: ['auto cloud', 'autocloud', 'dealership', 'showroom'],
  loyalty: ['loyalty'],
  portal: ['portal', 'self-service', 'self service'],
  pos: ['point of sale', 'pos'],
};

function channelOf(scene) {
  return String(scene.channel || scene.channel_type || '').toLowerCase();
}

function keywordsFor(ch) {
  return CHANNEL_KEYWORDS[ch] || [ch];
}

function mentions(text, kw) {
  // Word-ish match so "pos" doesn't match "post"
  const re = new RegExp('(^|[^a-z0-9])' + kw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i');
  return re.test(text);
}

function sceneIdNum(s) {
  const n = Number(s.id ?? s.sceneId);
  return Number.isFinite(n) ? n : Infinity;
}

/** Demo-script rows → [{ title, text, talk: [lines] }] per channel section, in script order. */
function scriptSections(scriptWriterData) {
  if (!scriptWriterData) return [];
  let sd = scriptWriterData.script_data;
  if (typeof sd === 'string') { try { sd = JSON.parse(sd); } catch { sd = null; } }
  const rows = sd && Array.isArray(sd.rows) ? sd.rows : null;
  if (!rows) return [];
  const sections = [];
  let current = null;
  for (const r of rows) {
    if (!r) continue;
    if (r.type === 'channel') {
      current = { title: String(r.text || '').replace(/^channel\s*[-–—:]\s*/i, '').trim(), talk: [], visuals: [] };
      sections.push(current);
    } else if ((r.type === 'chapter' || r.type === 'section') && current && /wrap|outro|closing|summary/i.test(String(r.text || ''))) {
      current = null;
    } else if (r.type === 'script' && current) {
      if (/^\s*slide\b/i.test(String(r.visual || ''))) continue; // presenter slides (intro/wrap-up), not a channel moment
      if (r.talk) current.talk.push(String(r.talk).trim());
      if (r.visual) current.visuals.push(String(r.visual).trim());
    }
  }
  return sections.map(s => ({ ...s, text: (s.title + ' ' + s.visuals.join(' ')).toLowerCase() }));
}

/** Index of the section a scene belongs to (title first, then the section's visuals), or -1. */
function matchSection(scene, sections, used) {
  const kws = keywordsFor(channelOf(scene));
  const pick = (getText) => {
    for (let i = 0; i < sections.length; i++) {
      if (used.has(i)) continue;
      if (kws.some(kw => mentions(getText(sections[i]), kw))) return i;
    }
    return -1;
  };
  let i = pick(s => s.title.toLowerCase());
  if (i < 0) i = pick(s => s.text);
  return i;
}

/**
 * @param {Array} scenes            scene_data.scenes
 * @param {object} opts
 * @param {string} [opts.cxSummary]
 * @param {object} [opts.scriptWriterData]
 * @returns {{ scenes: Array, method: string }} scenes in journey order (excluded channels removed),
 *          each with `scriptSection` = { title, talk[] } when matched to the demo script
 */
function orderScenes(scenes, { cxSummary = '', scriptWriterData = null } = {}) {
  const list = (scenes || []).filter(s => !EXCLUDED_CHANNELS.includes(channelOf(s)));
  const byCreation = list.slice().sort((a, b) => sceneIdNum(a) - sceneIdNum(b));
  if (list.length <= 1) return { scenes: byCreation, method: 'single' };

  // Assign a position to every scene; unmatched scenes slot in after the matched scene created just before them
  const place = (posOf) => {
    let last = -1;
    const keyed = byCreation.map((s, idx) => {
      const p = posOf(s);
      if (p >= 0) last = p;
      return { s, key: p >= 0 ? p : last + 0.5, idx };
    });
    return keyed.sort((a, b) => a.key - b.key || a.idx - b.idx).map(k => k.s);
  };

  // 1. Demo script channel sections
  const sections = scriptSections(scriptWriterData);
  if (sections.length) {
    const used = new Set();
    const pos = new Map();
    for (const s of byCreation) {
      const i = matchSection(s, sections, used);
      if (i >= 0) { used.add(i); pos.set(s, i); }
    }
    if (pos.size >= Math.ceil(list.length / 2)) {
      const ordered = place(s => (pos.has(s) ? pos.get(s) : -1));
      ordered.forEach(s => { if (pos.has(s)) { const sec = sections[pos.get(s)]; s.scriptSection = { title: sec.title, talk: sec.talk }; } });
      return { scenes: ordered, method: 'demo script (' + pos.size + '/' + list.length + ' matched)' };
    }
  }

  // 2. Journey summary — first mention of each channel
  const cx = String(cxSummary || '').toLowerCase();
  if (cx) {
    const pos = new Map();
    for (const s of byCreation) {
      let best = Infinity;
      for (const kw of keywordsFor(channelOf(s))) {
        const re = new RegExp('(^|[^a-z0-9])' + kw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i');
        const m = re.exec(cx);
        if (m && m.index < best) best = m.index;
      }
      if (best !== Infinity) pos.set(s, best);
    }
    if (pos.size >= Math.ceil(list.length / 2)) {
      return { scenes: place(s => (pos.has(s) ? pos.get(s) : -1)), method: 'journey summary (' + pos.size + '/' + list.length + ' matched)' };
    }
  }

  // 3. Creation order
  return { scenes: byCreation, method: 'creation order' };
}

module.exports = { orderScenes, scriptSections, EXCLUDED_CHANNELS, CHANNEL_KEYWORDS };
