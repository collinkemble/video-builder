require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { runPipeline, getPipelineStatus, regenerateSegments } = require('./src/pipeline/orchestrator');
const { generateScript } = require('./src/pipeline/scriptGenerator');
const { getAvailableVoices } = require('./src/pipeline/voiceoverGenerator');
const { deleteVideoAssets } = require('./src/utils/r2');
const { parseEditInstruction } = require('./src/pipeline/smartEditParser');

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = 'v174-no-talking-in-broll';

// Health/version endpoint — verify which code is deployed
app.get('/api/version', (req, res) => {
  res.json({ version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

console.log(`[VideoBuilder] Starting server — build: ${BUILD_VERSION}`);

// ─── Diagnostic log ring buffer ───
// Captures recent [Compositor] and [SceneCapture] logs for debugging
const DIAG_LOG_MAX = 200;
const diagLogs = [];
const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
console.log = function(...args) {
  origConsoleLog.apply(console, args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[Compositor]') || msg.includes('[SceneCapture]') || msg.includes('[Regen]')) {
    diagLogs.push({ t: Date.now(), msg });
    if (diagLogs.length > DIAG_LOG_MAX) diagLogs.shift();
  }
};
console.warn = function(...args) {
  origConsoleWarn.apply(console, args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[Compositor]') || msg.includes('[SceneCapture]') || msg.includes('[Regen]')) {
    diagLogs.push({ t: Date.now(), msg: `WARN: ${msg}` });
    if (diagLogs.length > DIAG_LOG_MAX) diagLogs.shift();
  }
};

app.get('/api/diag-logs', (req, res) => {
  res.json({ version: BUILD_VERSION, count: diagLogs.length, logs: diagLogs.map(l => ({ ts: new Date(l.t).toISOString(), msg: l.msg })) });
});

// ─── JWT Session Tokens ───
const JWT_SECRET = process.env.JWT_SECRET || (process.env.MAGIC_LINK_SECRET
  ? crypto.createHash('sha256').update('video-builder-session:' + process.env.MAGIC_LINK_SECRET).digest('hex')
  : 'dev-jwt-secret');
const JWT_EXPIRY = '30d';

// Cross-app SSO: try JWT secrets from other aubreydemo apps when validating session cookies.
// Each app derives its JWT secret from the shared MAGIC_LINK_SECRET with a unique prefix.
const CROSS_APP_SECRETS = (() => {
  const secrets = [JWT_SECRET];
  const magicSecret = process.env.MAGIC_LINK_SECRET || process.env.MAGIC_SECRET_KEY;
  if (magicSecret) {
    const prefixes = ['demoforge-session:', 'pocketsic-session:', 'saleo-session:', 'brandkit-session:', 'orgbuilder-session:', 'scriptwriter-session:', 'installer-session:'];
    for (const prefix of prefixes) {
      const derived = crypto.createHash('sha256').update(prefix + magicSecret).digest('hex');
      if (derived !== JWT_SECRET) secrets.push(derived);
    }
  }
  return secrets;
})();

function issueSessionToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifySessionToken(token) {
  for (const secret of CROSS_APP_SECRETS) {
    try { return jwt.verify(token, secret); } catch { /* try next */ }
  }
  return null;
}

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve static files — no cache on HTML so deploys are picked up immediately
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('CDN-Cache-Control', 'no-store');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    }
  },
}));

// ═══════════════════════════════════════════════
// SHARED HELPERS (do not modify)
// ═══════════════════════════════════════════════

// Check admin status from ADMIN_EMAILS env var
function isAdmin(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((email || '').toLowerCase());
}

// Get or create user — upserts, stamps last_login_at, syncs admin flag
async function getOrCreateUser(email) {
  let users = await query('SELECT * FROM users WHERE email = ?', [email]);
  if (users.length === 0) {
    const result = await query(
      'INSERT INTO users (email, is_admin) VALUES (?, ?)',
      [email, isAdmin(email)]
    );
    return { id: result.insertId, email, is_admin: isAdmin(email) };
  }
  // Sync admin status and update last_login_at on each login
  const user = users[0];
  const shouldBeAdmin = isAdmin(email);
  if (user.is_admin !== shouldBeAdmin) {
    await query('UPDATE users SET is_admin = ?, last_login_at = NOW() WHERE id = ?', [shouldBeAdmin, user.id]);
    user.is_admin = shouldBeAdmin;
  } else {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  }
  return user;
}

// ═══════════════════════════════════════════════
// SHARED ROUTES — Auth Config
// ═══════════════════════════════════════════════

// Returns public app configuration for the frontend (Magic key, cookie domain).
// No auth required — the frontend fetches this on load.
app.get('/api/auth/config', (req, res) => {
  res.json({
    magicPublishableKey: process.env.MAGIC_PUBLISHABLE_KEY || process.env.VITE_MAGIC_LINK_KEY || null,
    cookieDomain: process.env.COOKIE_DOMAIN || null,
  });
});

// Check if current user is admin
app.get('/api/is-admin', (req, res) => {
  const email = req.query.email;
  res.json({ isAdmin: isAdmin(email) });
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Session Auth
// ═══════════════════════════════════════════════

// POST /api/auth/login — exchange email for a long-lived JWT session token
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const ALLOWED_EMAILS = ['aubreykemble@gmail.com'];
    if (!email.endsWith('@salesforce.com') && !ALLOWED_EMAILS.includes(email.toLowerCase())) return res.status(403).json({ error: 'Access restricted to @salesforce.com email addresses' });
    const user = await getOrCreateUser(email);
    const sessionToken = issueSessionToken(user.id, email);
    res.json({ success: true, token: sessionToken, email: user.email });
  } catch (err) {
    console.error('Session login error:', err.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// POST /api/auth/validate — check if a JWT session token is still valid
app.post('/api/auth/validate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    const payload = verifySessionToken(token);
    if (!payload || !payload.email) return res.status(401).json({ error: 'Invalid or expired session' });
    const users = await query('SELECT id, email FROM users WHERE id = ? AND email = ?', [payload.userId, payload.email]);
    if (users.length === 0) return res.status(401).json({ error: 'User not found' });
    res.json({ valid: true, email: payload.email });
  } catch (err) {
    console.error('Session validate error:', err.message);
    res.status(401).json({ error: 'Invalid session' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Feedback
// ═══════════════════════════════════════════════

// POST /api/feedback — submit feedback (any user)
app.post('/api/feedback', async (req, res) => {
  try {
    const { name, email, subject, body } = req.body;
    if (!name || !email || !subject || !body) {
      return res.status(400).json({ error: 'All fields are required: name, email, subject, body' });
    }

    const user = await getOrCreateUser(email);

    const result = await query(
      'INSERT INTO feedback (user_id, name, email, subject, body) VALUES (?, ?, ?, ?, ?)',
      [user.id, name.trim(), email.trim(), subject.trim(), body.trim()]
    );

    res.status(201).json({
      feedback: {
        id: result.insertId,
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        body: body.trim(),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// GET /api/feedback — list all feedback (admin only)
app.get('/api/feedback', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json({ feedback: rows });
  } catch (err) {
    console.error('Failed to fetch feedback:', err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// DELETE /api/feedback/:id — delete feedback (admin only)
app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query('DELETE FROM feedback WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete feedback:', err);
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — API Keys
// ═══════════════════════════════════════════════

const API_KEY_PREFIX = 'vbld';

function generateApiKeyToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `${API_KEY_PREFIX}${raw}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// GET /api/api-keys — list keys for a user
app.get('/api/api-keys', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const keys = await query(
      'SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );
    res.json({ apiKeys: keys });
  } catch (err) {
    console.error('Failed to list API keys:', err);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// POST /api/api-keys — create a new API key
app.post('/api/api-keys', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name || !name.trim()) {
      return res.status(400).json({ error: 'Email and key name are required' });
    }

    const user = await getOrCreateUser(email);
    const rawKey = generateApiKeyToken();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, API_KEY_PREFIX.length + 4);

    await query(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
      [user.id, name.trim(), keyPrefix, keyHash]
    );

    res.status(201).json({
      success: true,
      apiKey: rawKey,
      name: name.trim(),
      keyPrefix,
      message: 'Save this key — it will not be shown again.'
    });
  } catch (err) {
    console.error('Failed to create API key:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// DELETE /api/api-keys/:id — revoke an API key
app.delete('/api/api-keys/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const result = await query(
      'DELETE FROM api_keys WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke API key:', err);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Users (admin only)
// ═══════════════════════════════════════════════

app.get('/api/users', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
             COUNT(v.id) AS item_count
      FROM users u
      LEFT JOIN videos v ON v.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Gemini Streaming Proxy
// ═══════════════════════════════════════════════

app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const { contents, generationConfig } = req.body;
  if (!contents) {
    return res.status(400).json({ error: 'Missing "contents" in request body' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': keepalive\n\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 270000);

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!geminiResp.ok) {
      const errData = await geminiResp.json().catch(() => ({}));
      const errMsg = errData.error?.message || `Gemini API returned ${geminiResp.status}`;
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let allText = '';
    const reader = geminiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);
            const textPart = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (textPart) {
              allText += textPart;
              res.write(`: chunk received\n\n`);
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    const finalResponse = {
      candidates: [{
        content: {
          parts: [{ text: allText }],
          role: 'model'
        },
        finishReason: 'STOP'
      }]
    };

    res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Gemini Proxy] Request timed out');
      res.write(`data: ${JSON.stringify({ error: 'Request timed out. Try a shorter prompt.' })}\n\n`);
    } else {
      console.error('[Gemini Proxy] Error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to reach Gemini API' })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — Videos CRUD
// ═══════════════════════════════════════════════

// GET /api/videos — list videos for a user
app.get('/api/videos', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const videos = await query(
      `SELECT id, name, brand_name, pocketsic_project_name, status,
              video_url, thumbnail_url, duration_actual, error,
              shared_by, shared_at, created_at, updated_at
       FROM videos WHERE user_id = ? ORDER BY updated_at DESC`,
      [user.id]
    );
    res.json({ videos });
  } catch (err) {
    console.error('Failed to list videos:', err);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

// GET /api/videos/:id — get single video with full data
app.get('/api/videos/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = rows[0];
    // Parse JSON fields
    ['scene_data', 'scene_ids', 'narration_script', 'voiceover_timestamps', 'scriptwriter_data', 'segment_assets'].forEach(field => {
      if (typeof video[field] === 'string') {
        try { video[field] = JSON.parse(video[field]); } catch (e) { /* keep as string */ }
      }
    });

    // Auto-resolve brand logo from PocketSIC if missing
    const _psApiKey = process.env.POCKETSIC_API_KEY;
    const _psBaseUrl = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';
    if (!video.brand_logo_url && video.pocketsic_project_id && _psApiKey) {
      try {
        const pResp = await fetch(
          `${_psBaseUrl}/api/projects/${video.pocketsic_project_id}?email=${encodeURIComponent(email)}`,
          { headers: { 'X-API-Key': _psApiKey } }
        );
        if (pResp.ok) {
          const pData = await pResp.json();
          const proj = pData.project || pData;
          const bp = proj.brand_profile || {};
          const logoUrl = bp.logoUrl || bp.logo_url || bp.logo || proj.brand_logo_url || proj.logo_url || null;
          if (logoUrl) {
            console.log(`[API] Auto-resolved brand logo from PocketSIC for video ${video.id}: ${logoUrl}`);
            video.brand_logo_url = logoUrl;
            // Persist so it doesn't need to be fetched again
            await query('UPDATE videos SET brand_logo_url = ? WHERE id = ?', [logoUrl, video.id]);
          }
        }
      } catch (e) {
        console.warn(`[API] Brand logo auto-fetch failed (non-fatal): ${e.message}`);
      }
    }

    // Auto-resolve persona image from PocketSIC if missing
    if (!video.persona_image_url && video.pocketsic_project_id && _psApiKey) {
      try {
        // Reuse PocketSIC data if already fetched above, otherwise make a new call
        let projData = null;
        const pResp2 = await fetch(
          `${_psBaseUrl}/api/projects/${video.pocketsic_project_id}?email=${encodeURIComponent(email)}`,
          { headers: { 'X-API-Key': _psApiKey } }
        );
        if (pResp2.ok) {
          const pData2 = await pResp2.json();
          projData = pData2.project || pData2;
        }
        if (projData) {
          const persona = projData.persona || {};
          const personaImgUrl = persona.imageUrl || persona.image_url || persona.image || projData.persona_image_url || null;
          if (personaImgUrl) {
            console.log(`[API] Auto-resolved persona image from PocketSIC for video ${video.id}: ${personaImgUrl}`);
            video.persona_image_url = personaImgUrl;
            await query('UPDATE videos SET persona_image_url = ? WHERE id = ?', [personaImgUrl, video.id]);
          }
        }
      } catch (e) {
        console.warn(`[API] Persona image auto-fetch failed (non-fatal): ${e.message}`);
      }
    }

    // If persona image URL exists, verify it's accessible; if not, try presigned URL fallback
    if (video.persona_image_url && video.persona_image_url.includes('r2.dev/')) {
      try {
        const headResp = await fetch(video.persona_image_url, { method: 'HEAD' });
        if (!headResp.ok) {
          console.log(`[API] Persona image 404 at public URL, trying presigned fallback...`);
          const { getPresignedUrl } = require('./src/utils/r2');
          const urlObj = new URL(video.persona_image_url);
          const r2Key = urlObj.pathname.replace(/^\//, '');
          video.persona_image_url = await getPresignedUrl(r2Key, 3600);
          console.log(`[API] Persona image presigned URL generated`);
        }
      } catch (e) {
        // If verification fails, just pass through the original URL
        console.warn(`[API] Persona image verification failed: ${e.message}`);
      }
    }

    // Never expose password hash to client — expose hasPassword boolean instead
    video.hasPassword = !!video.public_password;
    delete video.public_password;

    res.json({ video });
  } catch (err) {
    console.error('Failed to get video:', err);
    res.status(500).json({ error: 'Failed to get video' });
  }
});

// POST /api/videos — create a new video
app.post('/api/videos', async (req, res) => {
  try {
    const { email, name, brandName, pocketsicProjectId, pocketsicProjectName, sceneData, voiceId, durationTarget, scriptWriterScriptId, scriptWriterScriptName, scriptWriterData } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Missing required fields: email, name' });
    }

    const user = await getOrCreateUser(email);

    // Extract brand logo URL from sceneData if available
    const parsedSceneData = sceneData ? (typeof sceneData === 'string' ? JSON.parse(sceneData) : sceneData) : null;
    const brandLogoUrl = parsedSceneData?.brand_logo_url || null;

    const result = await query(
      `INSERT INTO videos (user_id, name, brand_name, brand_logo_url, pocketsic_project_id, pocketsic_project_name,
        scene_data, voice_id, duration_target, music_track_id, scriptwriter_script_id, scriptwriter_script_name, scriptwriter_data, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        user.id,
        name.trim(),
        brandName || null,
        brandLogoUrl,
        pocketsicProjectId || null,
        pocketsicProjectName || null,
        sceneData ? JSON.stringify(sceneData) : null,
        voiceId || 'default',
        durationTarget || 180,
        'corporate-technology',
        scriptWriterScriptId || null,
        scriptWriterScriptName || null,
        scriptWriterData ? JSON.stringify(scriptWriterData) : null,
      ]
    );

    res.status(201).json({
      video: {
        id: result.insertId,
        name: name.trim(),
        brand_name: brandName || null,
        status: 'draft',
        created_at: new Date().toISOString(),
      }
    });
  } catch (err) {
    console.error('Failed to create video:', err);
    res.status(500).json({ error: 'Failed to create video' });
  }
});

// PUT /api/videos/:id — update video settings
app.put('/api/videos/:id', async (req, res) => {
  try {
    const { email, name, brandName, voiceId, durationTarget, sceneData, narrationScript, musicTrackId, customInstructions } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Verify ownership
    const existing = await query('SELECT id FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Build dynamic update — three-state race condition guard:
    // truthy → use value, empty string → set null, null/undefined → keep existing
    const sets = [];
    const params = [];

    if (name !== undefined && name !== null) {
      sets.push('name = ?');
      params.push(name === '' ? null : name.trim());
    }
    if (brandName !== undefined && brandName !== null) {
      sets.push('brand_name = ?');
      params.push(brandName === '' ? null : brandName.trim());
    }
    if (voiceId !== undefined && voiceId !== null) {
      sets.push('voice_id = ?');
      params.push(voiceId === '' ? 'default' : voiceId);
    }
    if (durationTarget !== undefined && durationTarget !== null) {
      sets.push('duration_target = ?');
      params.push(durationTarget || 180);
    }
    if (sceneData !== undefined && sceneData !== null) {
      sets.push('scene_data = ?');
      params.push(typeof sceneData === 'string' ? sceneData : JSON.stringify(sceneData));
    }
    if (narrationScript !== undefined && narrationScript !== null) {
      sets.push('narration_script = ?');
      params.push(typeof narrationScript === 'string' ? narrationScript : JSON.stringify(narrationScript));
    }
    if (musicTrackId !== undefined && musicTrackId !== null) {
      sets.push('music_track_id = ?');
      params.push(musicTrackId === '' ? 'corporate-technology' : musicTrackId);
    }
    if (customInstructions !== undefined && customInstructions !== null) {
      sets.push('custom_instructions = ?');
      params.push(customInstructions === '' ? null : customInstructions.trim());
    }

    // Three-state guard for persona_image_url: truthy → use it, empty string → clear to null, null/undefined → keep existing
    const { personaImageUrl } = req.body;
    if (personaImageUrl !== undefined && personaImageUrl !== null) {
      sets.push('persona_image_url = ?');
      params.push(personaImageUrl === '' ? null : personaImageUrl);
    }

    // Three-state guard for brand_logo_url
    const { brandLogoUrl } = req.body;
    if (brandLogoUrl !== undefined && brandLogoUrl !== null) {
      sets.push('brand_logo_url = ?');
      params.push(brandLogoUrl === '' ? null : brandLogoUrl);
    }

    // Description field
    const { description } = req.body;
    if (description !== undefined && description !== null) {
      sets.push('description = ?');
      params.push(description === '' ? null : description.trim());
    }

    // Public player page fields
    const { publicEnabled, publicUsername, publicPassword } = req.body;
    if (publicEnabled !== undefined && publicEnabled !== null) {
      sets.push('public_enabled = ?');
      params.push(publicEnabled ? 1 : 0);
    }
    if (publicUsername !== undefined && publicUsername !== null) {
      sets.push('public_username = ?');
      params.push(publicUsername === '' ? null : publicUsername.trim());
    }
    if (publicPassword !== undefined && publicPassword !== null) {
      if (publicPassword === '') {
        // Clear password protection
        sets.push('public_password = ?');
        params.push(null);
      } else if (publicPassword !== '••••••••') {
        // Hash new password with bcrypt
        const hash = await bcrypt.hash(publicPassword, 10);
        sets.push('public_password = ?');
        params.push(hash);
      }
      // If '••••••••' → skip (unchanged placeholder)
    }

    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      params.push(req.params.id, user.id);
      await query(`UPDATE videos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update video:', err);
    res.status(500).json({ error: 'Failed to update video' });
  }
});

// DELETE /api/videos/:id — delete a video and all its R2 assets
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Verify ownership before deleting
    const [video] = await query('SELECT id FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Delete video jobs first (foreign key)
    await query('DELETE FROM video_jobs WHERE video_id = ?', [req.params.id]);

    // Delete the video record
    await query('DELETE FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);

    // Clean up R2 assets in background (don't block the response)
    deleteVideoAssets(user.id, req.params.id).catch(err => {
      console.error(`Failed to clean up R2 assets for video ${req.params.id}:`, err.message);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete video:', err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — Pipeline & Generation
// ═══════════════════════════════════════════════

// POST /api/videos/:id/generate-script — run ONLY the script generation step (Gemini)
app.post('/api/videos/:id/generate-script', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const video = rows[0];
    const sceneData = typeof video.scene_data === 'string' ? JSON.parse(video.scene_data || '{}') : (video.scene_data || {});
    // Sort scenes by ID ascending — PocketSIC IDs are auto-increment and represent journey order
    const scenes = (sceneData.scenes || []).slice().sort((a, b) => {
      const idA = a.id || a.sceneId || 0;
      const idB = b.id || b.sceneId || 0;
      return idA - idB;
    });

    if (scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes found. Import a PocketSIC project first.' });
    }

    const scriptWriterData = video.scriptwriter_data
      ? (typeof video.scriptwriter_data === 'string' ? JSON.parse(video.scriptwriter_data) : video.scriptwriter_data)
      : null;

    const script = await generateScript({
      brandName: video.brand_name || sceneData.brand_name || 'Brand',
      brandDescription: sceneData.brand_description || '',
      personaName: sceneData.persona_name || '',
      personaDescription: sceneData.persona_description || '',
      synopsis: sceneData.synopsis || '',
      scenes: scenes.map(s => ({
        id: s.id || s.sceneId,
        channel: s.channel || s.channel_type || '',
        content_summary: s.content_summary || s.description || s.name || '',
      })),
      durationTarget: video.duration_target || 180,
      scriptWriterData,
    });

    // Save script to video record
    await query('UPDATE videos SET narration_script = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(script), req.params.id]);

    res.json({ success: true, script });
  } catch (err) {
    console.error('Script generation failed:', err);
    res.status(500).json({ error: 'Script generation failed: ' + err.message });
  }
});

// POST /api/videos/:id/generate — start the full pipeline
app.post('/api/videos/:id/generate', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Verify ownership and check status
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = rows[0];
    // Allow force-restart if stuck (client sends force=true)
    const isProcessing = ['scripting', 'voiceover', 'capturing', 'compositing', 'uploading'].includes(video.status);
    if (isProcessing && !req.body.force) {
      return res.status(409).json({ error: 'Video is already being generated. Click again to force restart.', status: video.status });
    }

    // Reset status and clear previous jobs
    await query('UPDATE videos SET status = ?, error = NULL, video_url = NULL, thumbnail_url = NULL, voiceover_url = NULL WHERE id = ?', ['draft', req.params.id]);
    await query('DELETE FROM video_jobs WHERE video_id = ?', [req.params.id]);

    // Clean up old R2 assets in background before regenerating
    deleteVideoAssets(user.id, req.params.id).catch(err => {
      console.warn(`Failed to clean up old R2 assets for video ${req.params.id}:`, err.message);
    });

    // Start pipeline in background (don't await)
    res.json({ success: true, message: 'Pipeline started. Poll /api/videos/:id/status for progress.' });

    // Run pipeline asynchronously
    runPipeline(req.params.id, user.id).catch(err => {
      console.error(`Pipeline failed for video ${req.params.id}:`, err.message);
    });
  } catch (err) {
    console.error('Failed to start pipeline:', err);
    res.status(500).json({ error: 'Failed to start pipeline' });
  }
});

// POST /api/videos/:id/regenerate-segments — selectively regenerate specific segments
app.post('/api/videos/:id/regenerate-segments', async (req, res) => {
  try {
    const { email, changes } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'changes array is required with at least one entry' });
    }

    // Validate each change entry
    for (const c of changes) {
      if (c.order === undefined || c.order === null) {
        return res.status(400).json({ error: 'Each change must include an "order" field' });
      }
      if (!c.narration && !c.brollDescription && !c.regenerateBroll && !c.regenerateVoiceover) {
        return res.status(400).json({ error: `Change for order ${c.order} must include at least one modification` });
      }
    }

    const user = await getOrCreateUser(email);

    // Verify ownership and check status
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const video = rows[0];
    if (video.status !== 'completed') {
      return res.status(409).json({ error: 'Video must be completed before editing segments' });
    }

    // Check segment_assets exist
    const segmentAssets = video.segment_assets
      ? (typeof video.segment_assets === 'string' ? JSON.parse(video.segment_assets) : video.segment_assets)
      : null;
    if (!segmentAssets || !segmentAssets.clips || Object.keys(segmentAssets.clips).length === 0) {
      return res.status(409).json({ error: 'No segment assets available. Please regenerate the full video first.' });
    }

    // Start regeneration in background
    res.json({ success: true, message: 'Segment regeneration started. Poll /api/videos/:id/status for progress.' });

    regenerateSegments(req.params.id, user.id, changes).catch(err => {
      console.error(`Segment regeneration failed for video ${req.params.id}:`, err.message);
    });
  } catch (err) {
    console.error('Failed to start segment regeneration:', err);
    res.status(500).json({ error: 'Failed to start segment regeneration' });
  }
});

// POST /api/videos/:id/smart-edit — LLM-powered natural language segment editing
app.post('/api/videos/:id/smart-edit', async (req, res) => {
  try {
    const { email, instruction } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ error: 'Edit instruction is required' });
    }

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const video = rows[0];
    if (video.status !== 'completed') {
      return res.status(409).json({ error: 'Video must be completed before smart editing' });
    }

    const script = video.narration_script
      ? (typeof video.narration_script === 'string' ? JSON.parse(video.narration_script) : video.narration_script)
      : null;
    if (!script || !script.segments) {
      return res.status(409).json({ error: 'No script found' });
    }

    // Use LLM to parse the instruction into segment changes
    const changes = await parseEditInstruction(
      instruction.trim(),
      script.segments,
      video.brand_name || ''
    );

    if (changes.length === 0) {
      return res.json({ changes: [], message: 'No actionable changes identified for that instruction. Try being more specific about which section to change.' });
    }

    res.json({ changes });
  } catch (err) {
    console.error('Smart edit failed:', err);
    res.status(500).json({ error: 'Smart edit failed: ' + err.message });
  }
});

// GET /api/videos/:id/status — get pipeline progress
app.get('/api/videos/:id/status', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const status = await getPipelineStatus(req.params.id, user.id);

    if (!status) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(status);
  } catch (err) {
    console.error('Failed to get pipeline status:', err);
    res.status(500).json({ error: 'Failed to get pipeline status' });
  }
});

// GET /api/voices — list available voices (with preview URLs)
app.get('/api/voices', async (req, res) => {
  try {
    const voices = await getAvailableVoices();
    res.json({ voices });
  } catch (err) {
    console.error('Failed to get voices:', err);
    res.status(500).json({ error: 'Failed to load voices' });
  }
});

// ═══════════════════════════════════════════════
// MUSIC TRACKS — Curated royalty-free background music
// ═══════════════════════════════════════════════

const { MUSIC_TRACKS } = require('./src/pipeline/musicTracks');

// GET /api/music-tracks — list available background music tracks
app.get('/api/music-tracks', (req, res) => {
  res.json({
    tracks: MUSIC_TRACKS.map(t => ({
      id: t.id,
      name: t.name,
      mood: t.mood,
      duration: t.duration,
    })),
  });
});

// GET /api/music-tracks/:id/preview — get preview URL for a track
app.get('/api/music-tracks/:id/preview', (req, res) => {
  const track = MUSIC_TRACKS.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  // Return a server-proxied URL so CORS/auth issues don't block browser playback
  res.json({ preview_url: `/api/music-tracks/${track.id}/stream` });
});

// GET /api/music-tracks/:id/stream — proxy the audio file for browser playback
app.get('/api/music-tracks/:id/stream', async (req, res) => {
  const track = MUSIC_TRACKS.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  try {
    const audioResp = await fetch(track.url);
    if (!audioResp.ok) {
      return res.status(502).json({ error: `Upstream returned ${audioResp.status}` });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
    const buffer = Buffer.from(await audioResp.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(`Music stream error for ${track.id}:`, err.message);
    res.status(502).json({ error: 'Failed to stream music' });
  }
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — Persona Image (generate / upload / delete)
// ═══════════════════════════════════════════════

// POST /api/videos/:id/generate-persona-image — generate a persona image using Gemini
app.post('/api/videos/:id/generate-persona-image', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Image generation not configured' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const video = rows[0];
    const sceneData = typeof video.scene_data === 'string' ? JSON.parse(video.scene_data || '{}') : (video.scene_data || {});

    const personaName = sceneData.persona_name || 'a professional person';
    const personaDesc = sceneData.persona_description || '';
    const brandName = video.brand_name || sceneData.brand_name || '';

    // Build a prompt for a professional headshot/portrait of the persona
    const prompt = `Professional headshot portrait photograph of ${personaName}${personaDesc ? `, described as: ${personaDesc}` : ''}.
Style: Clean, modern corporate headshot. Warm, natural lighting. Soft background bokeh. Shot from chest up, slightly angled. Genuine, friendly smile. High-quality DSLR photography look.
${brandName ? `This person is a customer of ${brandName}.` : ''}
RULES:
1. Single person only — no groups.
2. No text, logos, or overlays.
3. No screens or devices visible.
4. Professional but approachable appearance.
5. Neutral or warm-toned background.`;

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    // Try image generation models — ordered newest to oldest
    const modelNames = [
      'gemini-3.1-flash-image-preview',
      'gemini-2.5-flash-image',
      'gemini-2.0-flash-exp-image-generation',
    ];

    let imageBuffer = null;
    let usedModel = null;

    for (const modelName of modelNames) {
      try {
        console.log(`[Persona Image] Generating with ${modelName} for video ${req.params.id}...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: { responseModalities: ['TEXT', 'IMAGE'] },
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);

        if (imagePart && imagePart.inlineData) {
          imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
          usedModel = modelName;
          console.log(`[Persona Image] Generated with ${modelName}: ${(imageBuffer.length / 1024).toFixed(1)}KB`);
          break;
        }
        console.warn(`[Persona Image] No image from ${modelName}`);
      } catch (err) {
        console.warn(`[Persona Image] ${modelName} failed: ${err.message}`);
      }
    }

    if (!imageBuffer) {
      return res.status(500).json({ error: 'Failed to generate persona image. All models failed.' });
    }

    // Upload to R2 — write buffer to temp file first (matches the pattern
    // that works for video uploads; direct Buffer uploads return 404 from R2 public URL)
    const { uploadFile } = require('./src/utils/r2');
    const tmpPath = require('path').join(require('os').tmpdir(), `persona_${Date.now()}.png`);
    require('fs').writeFileSync(tmpPath, imageBuffer);
    console.log(`[Persona Image] Wrote ${imageBuffer.length} bytes to temp file: ${tmpPath}`);

    const key = `videos/${user.id}/${req.params.id}/persona_${Date.now()}.png`;
    console.log(`[Persona Image] Uploading to R2: key=${key}, size=${imageBuffer.length}`);
    const imageUrl = await uploadFile(key, tmpPath, 'image/png');
    console.log(`[Persona Image] Upload returned URL: ${imageUrl}`);

    // Clean up temp file
    try { require('fs').unlinkSync(tmpPath); } catch (e) { /* ignore */ }

    // Verify the upload worked by checking HTTP HEAD
    try {
      const verifyResp = await fetch(imageUrl, { method: 'HEAD' });
      console.log(`[Persona Image] Verify upload: HTTP ${verifyResp.status} for ${imageUrl}`);
      if (!verifyResp.ok) {
        console.warn(`[Persona Image] ⚠️ Upload verification FAILED — file not accessible at ${imageUrl}`);
      }
    } catch (verifyErr) {
      console.warn(`[Persona Image] Upload verify error: ${verifyErr.message}`);
    }

    // Save to DB
    await query('UPDATE videos SET persona_image_url = ?, updated_at = NOW() WHERE id = ?', [imageUrl, req.params.id]);

    res.json({ success: true, persona_image_url: imageUrl, model: usedModel });
  } catch (err) {
    console.error('Persona image generation failed:', err);
    res.status(500).json({ error: 'Failed to generate persona image: ' + err.message });
  }
});

// POST /api/videos/:id/upload-persona-image — upload a custom persona image
app.post('/api/videos/:id/upload-persona-image', async (req, res) => {
  try {
    const { email, imageData } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!imageData) return res.status(400).json({ error: 'Image data required (base64)' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    // Parse base64 data URI — supports data:image/png;base64,... or raw base64
    let buffer;
    let ext = 'png';
    if (imageData.startsWith('data:')) {
      const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid image data format' });
      ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      buffer = Buffer.from(imageData, 'base64');
    }

    // Validate size — max 5MB
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }

    // Upload to R2 — write buffer to temp file first (direct Buffer uploads return 404 from R2)
    const { uploadFile } = require('./src/utils/r2');
    const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const key = `videos/${user.id}/${req.params.id}/persona_${Date.now()}.${ext}`;
    const tmpPath = require('path').join(require('os').tmpdir(), `persona_upload_${Date.now()}.${ext}`);
    require('fs').writeFileSync(tmpPath, buffer);
    const imageUrl = await uploadFile(key, tmpPath, contentType);
    try { require('fs').unlinkSync(tmpPath); } catch (e) { /* ignore */ }

    // Save to DB
    await query('UPDATE videos SET persona_image_url = ?, updated_at = NOW() WHERE id = ?', [imageUrl, req.params.id]);

    res.json({ success: true, persona_image_url: imageUrl });
  } catch (err) {
    console.error('Persona image upload failed:', err);
    res.status(500).json({ error: 'Failed to upload persona image: ' + err.message });
  }
});

// DELETE /api/videos/:id/persona-image — remove persona image
app.delete('/api/videos/:id/persona-image', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    await query('UPDATE videos SET persona_image_url = NULL, updated_at = NOW() WHERE id = ?', [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Persona image delete failed:', err);
    res.status(500).json({ error: 'Failed to remove persona image' });
  }
});

// POST /api/videos/:id/upload-brand-logo — upload a custom brand logo
app.post('/api/videos/:id/upload-brand-logo', async (req, res) => {
  try {
    const { email, imageData } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!imageData) return res.status(400).json({ error: 'Image data required (base64)' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id FROM videos WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    // Parse base64 data URI
    let buffer;
    let ext = 'png';
    if (imageData.startsWith('data:')) {
      const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid image data format' });
      ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      buffer = Buffer.from(imageData, 'base64');
    }

    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }

    const { uploadFile } = require('./src/utils/r2');
    const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const key = `videos/${user.id}/${req.params.id}/brand_logo_${Date.now()}.${ext}`;
    const tmpPath = require('path').join(require('os').tmpdir(), `brand_logo_upload_${Date.now()}.${ext}`);
    require('fs').writeFileSync(tmpPath, buffer);
    const imageUrl = await uploadFile(key, tmpPath, contentType);
    try { require('fs').unlinkSync(tmpPath); } catch (e) { /* ignore */ }

    await query('UPDATE videos SET brand_logo_url = ?, updated_at = NOW() WHERE id = ?', [imageUrl, req.params.id]);

    res.json({ success: true, brand_logo_url: imageUrl });
  } catch (err) {
    console.error('Brand logo upload failed:', err);
    res.status(500).json({ error: 'Failed to upload brand logo: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
// ADMIN — Veo Diagnostics (test video generation capability)
// ═══════════════════════════════════════════════

app.get('/api/admin/veo-test', async (req, res) => {
  const email = req.query.email;
  if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Admin only' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.json({ status: 'error', message: 'GEMINI_API_KEY not configured' });

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const models = ['veo-3.1-lite', 'veo-3.1-fast', 'veo-3.1-generate-preview'];
  const results = [];

  for (const modelName of models) {
    try {
      const operation = await ai.models.generateVideos({
        model: modelName,
        prompt: 'A slow pan across a coffee cup on a wooden table, warm morning light',
        config: { aspectRatio: '16:9', resolution: '720p', durationSeconds: '4', numberOfVideos: 1 },
      });
      results.push({ model: modelName, status: 'accepted', operationDone: operation.done });
      // Don't wait for completion — just confirm the API accepts the request
      break; // If one works, report success
    } catch (err) {
      results.push({
        model: modelName,
        status: 'failed',
        error: err.message?.substring(0, 200),
        httpStatus: err.status || null,
      });
    }
  }

  res.json({ status: results.some(r => r.status === 'accepted') ? 'ok' : 'all_failed', results });
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — PocketSIC Proxy (server-side API key)
// ═══════════════════════════════════════════════

const POCKETSIC_BASE_URL = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';
const POCKETSIC_API_KEY = process.env.POCKETSIC_API_KEY;
const SCRIPTWRITER_BASE_URL = process.env.SCRIPTWRITER_BASE_URL || 'https://scriptwriter.aubreydemo.com';
const SCRIPTWRITER_API_KEY = process.env.SCRIPTWRITER_API_KEY;

// GET /api/pocketsic/projects — fetch projects from PocketSIC
app.get('/api/pocketsic/projects', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!POCKETSIC_API_KEY) return res.status(500).json({ error: 'PocketSIC API key not configured on server.' });

    const pResp = await fetch(`${POCKETSIC_BASE_URL}/api/projects?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': POCKETSIC_API_KEY },
    });

    if (!pResp.ok) {
      const errText = await pResp.text();
      return res.status(pResp.status).json({ error: `PocketSIC error: ${errText}` });
    }

    const data = await pResp.json();
    res.json(data);
  } catch (err) {
    console.error('PocketSIC proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch PocketSIC projects' });
  }
});

// GET /api/pocketsic/projects/:id — fetch single project with metadata
app.get('/api/pocketsic/projects/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!POCKETSIC_API_KEY) return res.status(500).json({ error: 'PocketSIC API key not configured on server.' });

    const pResp = await fetch(`${POCKETSIC_BASE_URL}/api/projects/${req.params.id}?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': POCKETSIC_API_KEY },
    });

    if (!pResp.ok) {
      const errText = await pResp.text();
      return res.status(pResp.status).json({ error: `PocketSIC error: ${errText}` });
    }

    const data = await pResp.json();
    // Log brand_profile to discover logo field name
    if (data.project && data.project.brand_profile) {
      console.log('[PocketSIC] brand_profile keys:', Object.keys(data.project.brand_profile));
      const bp = data.project.brand_profile;
      const logoFields = Object.entries(bp).filter(([k, v]) => k.toLowerCase().includes('logo') || (typeof v === 'string' && v.match(/\.(png|jpg|jpeg|svg|webp)/i)));
      if (logoFields.length > 0) console.log('[PocketSIC] Logo fields found:', logoFields.map(([k, v]) => `${k}=${String(v).substring(0, 80)}`));
      else console.log('[PocketSIC] No logo fields found in brand_profile');
    } else {
      console.log('[PocketSIC] project keys:', data.project ? Object.keys(data.project) : 'no project');
      // Also check top-level project for logo fields
      if (data.project) {
        const logoFields = Object.entries(data.project).filter(([k, v]) => k.toLowerCase().includes('logo') || (typeof v === 'string' && String(v).match(/\.(png|jpg|jpeg|svg|webp)/i)));
        if (logoFields.length > 0) console.log('[PocketSIC] Logo fields on project:', logoFields.map(([k, v]) => `${k}=${String(v).substring(0, 80)}`));
      }
    }
    res.json(data);
  } catch (err) {
    console.error('PocketSIC proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch PocketSIC project' });
  }
});

// GET /api/pocketsic/projects/:id/scenes — fetch scenes for a project
app.get('/api/pocketsic/projects/:id/scenes', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!POCKETSIC_API_KEY) return res.status(500).json({ error: 'PocketSIC API key not configured on server.' });

    const pResp = await fetch(`${POCKETSIC_BASE_URL}/api/projects/${req.params.id}/scenes?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': POCKETSIC_API_KEY },
    });

    if (!pResp.ok) {
      const errText = await pResp.text();
      return res.status(pResp.status).json({ error: `PocketSIC error: ${errText}` });
    }

    const data = await pResp.json();
    res.json(data);
  } catch (err) {
    console.error('PocketSIC scenes proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch PocketSIC scenes' });
  }
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — Script Writer Proxy (server-side API key)
// ═══════════════════════════════════════════════

// GET /api/scriptwriter/scripts — list user's scripts from Script Writer
app.get('/api/scriptwriter/scripts', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!SCRIPTWRITER_API_KEY) return res.status(500).json({ error: 'Script Writer API key not configured on server.' });

    const swResp = await fetch(`${SCRIPTWRITER_BASE_URL}/api/scripts?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': SCRIPTWRITER_API_KEY },
    });

    if (!swResp.ok) {
      const errText = await swResp.text();
      return res.status(swResp.status).json({ error: `Script Writer error: ${errText}` });
    }

    const data = await swResp.json();
    res.json(data);
  } catch (err) {
    console.error('Script Writer proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch scripts' });
  }
});

// GET /api/scriptwriter/scripts/:id — get single script with full data
app.get('/api/scriptwriter/scripts/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!SCRIPTWRITER_API_KEY) return res.status(500).json({ error: 'Script Writer API key not configured on server.' });

    const swResp = await fetch(`${SCRIPTWRITER_BASE_URL}/api/scripts/${req.params.id}?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': SCRIPTWRITER_API_KEY },
    });

    if (!swResp.ok) {
      const errText = await swResp.text();
      return res.status(swResp.status).json({ error: `Script Writer error: ${errText}` });
    }

    const data = await swResp.json();
    res.json(data);
  } catch (err) {
    console.error('Script Writer proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch script' });
  }
});

// ═══════════════════════════════════════════════
// VIDEO BUILDER — Share Videos
// ═══════════════════════════════════════════════

// Helper: create a shared copy of a video for a recipient
async function createSharedVideoCopy(sourceVideo, senderEmail, recipientEmail) {
  const recipientUser = await getOrCreateUser(recipientEmail);

  const result = await query(
    `INSERT INTO videos (user_id, name, brand_name, brand_logo_url, pocketsic_project_id, pocketsic_project_name,
      scene_data, narration_script, voiceover_timestamps, video_url, thumbnail_url, voiceover_url,
      voice_id, duration_target, duration_actual, music_track_id, scriptwriter_script_id, scriptwriter_script_name, scriptwriter_data,
      persona_image_url, status, shared_by, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      recipientUser.id,
      sourceVideo.name,
      sourceVideo.brand_name,
      sourceVideo.brand_logo_url || null,
      sourceVideo.pocketsic_project_id,
      sourceVideo.pocketsic_project_name,
      sourceVideo.scene_data ? (typeof sourceVideo.scene_data === 'string' ? sourceVideo.scene_data : JSON.stringify(sourceVideo.scene_data)) : null,
      sourceVideo.narration_script ? (typeof sourceVideo.narration_script === 'string' ? sourceVideo.narration_script : JSON.stringify(sourceVideo.narration_script)) : null,
      sourceVideo.voiceover_timestamps ? (typeof sourceVideo.voiceover_timestamps === 'string' ? sourceVideo.voiceover_timestamps : JSON.stringify(sourceVideo.voiceover_timestamps)) : null,
      sourceVideo.video_url,
      sourceVideo.thumbnail_url,
      sourceVideo.voiceover_url,
      sourceVideo.voice_id,
      sourceVideo.duration_target,
      sourceVideo.duration_actual,
      sourceVideo.music_track_id || 'corporate-technology',
      sourceVideo.scriptwriter_script_id || null,
      sourceVideo.scriptwriter_script_name || null,
      sourceVideo.scriptwriter_data ? (typeof sourceVideo.scriptwriter_data === 'string' ? sourceVideo.scriptwriter_data : JSON.stringify(sourceVideo.scriptwriter_data)) : null,
      sourceVideo.persona_image_url || null,
      sourceVideo.status === 'completed' ? 'completed' : 'draft',
      senderEmail,
    ]
  );

  return result.insertId;
}

// POST /api/videos/:id/share — share a video with another user
app.post('/api/videos/:id/share', async (req, res) => {
  try {
    const { email, recipientEmail } = req.body;
    if (!email || !recipientEmail) {
      return res.status(400).json({ error: 'Sender email and recipientEmail are required' });
    }

    if (email.toLowerCase() === recipientEmail.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot share a video with yourself' });
    }

    const sender = await getOrCreateUser(email);

    // Verify sender owns the video
    const videos = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (videos.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }
    const sourceVideo = videos[0];

    // Check if already shared to this recipient
    const existing = await query(
      'SELECT id, copied_video_id, created_at FROM shared_videos WHERE video_id = ? AND sender_user_id = ? AND recipient_email = ?',
      [req.params.id, sender.id, recipientEmail.toLowerCase()]
    );

    if (existing.length > 0) {
      return res.json({
        alreadyShared: true,
        sharedAt: existing[0].created_at,
        copiedVideoId: existing[0].copied_video_id,
        shareRecordId: existing[0].id
      });
    }

    // First-time share: create copy and tracking record
    const copiedVideoId = await createSharedVideoCopy(sourceVideo, email, recipientEmail);

    await query(
      'INSERT INTO shared_videos (video_id, sender_user_id, sender_email, recipient_email, copied_video_id) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedVideoId]
    );

    res.status(201).json({ success: true, copiedVideoId });
  } catch (err) {
    console.error('Failed to share video:', err);
    res.status(500).json({ error: 'Failed to share video' });
  }
});

// POST /api/videos/:id/share/confirm — replace or send new copy
app.post('/api/videos/:id/share/confirm', async (req, res) => {
  try {
    const { email, recipientEmail, action } = req.body;
    if (!email || !recipientEmail || !action) {
      return res.status(400).json({ error: 'email, recipientEmail, and action are required' });
    }
    if (!['replace', 'copy'].includes(action)) {
      return res.status(400).json({ error: 'action must be "replace" or "copy"' });
    }

    const sender = await getOrCreateUser(email);

    const videos = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (videos.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }
    const sourceVideo = videos[0];

    if (action === 'replace') {
      const existing = await query(
        'SELECT id, copied_video_id FROM shared_videos WHERE video_id = ? AND sender_user_id = ? AND recipient_email = ?',
        [req.params.id, sender.id, recipientEmail.toLowerCase()]
      );

      if (existing.length === 0) {
        return res.status(404).json({ error: 'No previous share found' });
      }

      const copiedId = existing[0].copied_video_id;

      if (copiedId) {
        await query(
          `UPDATE videos SET name = ?, brand_name = ?, brand_logo_url = ?, scene_data = ?, narration_script = ?,
            voiceover_timestamps = ?, video_url = ?, thumbnail_url = ?, voiceover_url = ?,
            duration_actual = ?, status = ?, shared_by = ?, shared_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [
            sourceVideo.name,
            sourceVideo.brand_name,
            sourceVideo.brand_logo_url || null,
            sourceVideo.scene_data ? (typeof sourceVideo.scene_data === 'string' ? sourceVideo.scene_data : JSON.stringify(sourceVideo.scene_data)) : null,
            sourceVideo.narration_script ? (typeof sourceVideo.narration_script === 'string' ? sourceVideo.narration_script : JSON.stringify(sourceVideo.narration_script)) : null,
            sourceVideo.voiceover_timestamps ? (typeof sourceVideo.voiceover_timestamps === 'string' ? sourceVideo.voiceover_timestamps : JSON.stringify(sourceVideo.voiceover_timestamps)) : null,
            sourceVideo.video_url,
            sourceVideo.thumbnail_url,
            sourceVideo.voiceover_url,
            sourceVideo.duration_actual,
            sourceVideo.status === 'completed' ? 'completed' : 'draft',
            email.toLowerCase(),
            copiedId,
          ]
        );
      }

      await query('UPDATE shared_videos SET created_at = NOW() WHERE id = ?', [existing[0].id]);
      res.json({ success: true, action: 'replaced', copiedVideoId: copiedId });
    } else {
      const copiedVideoId = await createSharedVideoCopy(sourceVideo, email, recipientEmail);

      await query(
        'INSERT INTO shared_videos (video_id, sender_user_id, sender_email, recipient_email, copied_video_id) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedVideoId]
      );

      res.status(201).json({ success: true, action: 'copied', copiedVideoId });
    }
  } catch (err) {
    console.error('Failed to confirm share:', err);
    res.status(500).json({ error: 'Failed to complete share action' });
  }
});

// ═══════════════════════════════════════════════
// PUBLIC VIDEO PLAYER PAGE (unauthenticated)
// ═══════════════════════════════════════════════

// JWT secret for short-lived watch tokens (scoped to individual videos)
const WATCH_JWT_SECRET = crypto.createHash('sha256').update('watch-token:' + (process.env.MAGIC_LINK_SECRET || 'dev')).digest('hex');

// Rate limiting for password attempts (in-memory, per video)
const _watchAttempts = {};

function renderWatchPage(video, showLogin) {
  const safeTitle = (video.name || 'Untitled Video').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDesc = (video.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  // Co-branded header: [Brand Logo] | [Salesforce Logo] — uses the same sflogo.png from video intros
  const sfLogoImg = `<img src="/sflogo.png" alt="Salesforce" style="height: 36px; width: auto;">`;
  const brandLogoHtml = video.brand_logo_url
    ? `<div style="display: flex; align-items: center; gap: 16px;">
        <img src="${video.brand_logo_url}" alt="${(video.brand_name || 'Brand').replace(/"/g, '&quot;')}" style="max-height: 36px; max-width: 140px; object-fit: contain;">
        <div style="width: 1px; height: 28px; background: #D1D5DB;"></div>
        ${sfLogoImg}
      </div>`
    : sfLogoImg;

  const loginFormHtml = `
    <div id="watch-login" style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px; max-width: 400px; margin: 32px auto; text-align: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#0176D3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 auto 16px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <h3 style="font-size: 18px; font-weight: 700; color: #032D60; margin-bottom: 4px;">This video is password protected</h3>
      <p style="font-size: 14px; color: #6B7280; margin-bottom: 24px;">Enter the credentials provided to you to watch this video.</p>
      <div id="watch-error" style="display: none; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 10px; margin-bottom: 16px; color: #991B1B; font-size: 13px;"></div>
      <form id="watch-auth-form" onsubmit="return watchLogin(event)">
        <input id="watch-user" type="text" placeholder="Username" required autocomplete="username" style="width: 100%; padding: 10px 14px; border: 1px solid #D1D5DB; border-radius: 8px; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; font-family: 'Salesforce Sans', sans-serif;">
        <input id="watch-pass" type="password" placeholder="Password" required autocomplete="current-password" style="width: 100%; padding: 10px 14px; border: 1px solid #D1D5DB; border-radius: 8px; font-size: 14px; margin-bottom: 16px; box-sizing: border-box; font-family: 'Salesforce Sans', sans-serif;">
        <button type="submit" id="watch-submit-btn" style="width: 100%; padding: 12px; background: #0176D3; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: 'Salesforce Sans', sans-serif;">▶ Watch Video</button>
      </form>
    </div>`;

  const videoPlayerHtml = `
    <div id="watch-player" style="margin-top: 24px;">
      <div style="position: relative; width: 100%; border-radius: 12px; overflow: hidden; background: #000; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
        <video id="watch-video" controls playsinline preload="metadata" poster="${video.thumbnail_url || ''}"
          style="width: 100%; display: block; border-radius: 12px;"
          src="${video.video_url || ''}">
          Your browser does not support the video tag.
        </video>
      </div>
      ${safeDesc ? `<div style="margin-top: 20px; padding: 20px; background: #F8FAFC; border-radius: 10px; border: 1px solid #E2E8F0;"><p style="font-size: 14px; line-height: 1.7; color: #334155;">${safeDesc}</p></div>` : ''}
    </div>`;

  const noVideoHtml = `
    <div style="margin-top: 32px; text-align: center; padding: 48px 24px; background: #F8FAFC; border-radius: 12px; border: 1px solid #E2E8F0;">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 auto 16px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <p style="font-size: 16px; color: #6B7280;">This video is not yet available.</p>
    </div>`;

  const hasVideo = video.status === 'completed' && video.video_url;

  let bodyContent;
  if (showLogin) {
    bodyContent = loginFormHtml;
  } else if (hasVideo) {
    bodyContent = videoPlayerHtml;
  } else {
    bodyContent = noVideoHtml;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:type" content="video.other">
  ${video.thumbnail_url ? `<meta property="og:image" content="${video.thumbnail_url}">` : ''}
  <style>
    @font-face { font-family: 'Salesforce Sans'; src: url('https://www.salesforce.com/etc.clientlibs/sfdc-aem-master/clientlibs_base/resources/fonts/SalesforceSans-Regular.woff2') format('woff2'); font-weight: 400; }
    @font-face { font-family: 'Salesforce Sans'; src: url('https://www.salesforce.com/etc.clientlibs/sfdc-aem-master/clientlibs_base/resources/fonts/SalesforceSans-Bold.woff2') format('woff2'); font-weight: 700; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Salesforce Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F3F4F6; min-height: 100vh; }
    a { color: #0176D3; text-decoration: none; }
    input:focus, button:focus { outline: 2px solid #0176D3; outline-offset: 2px; }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <!-- Header -->
  <header style="background: white; border-bottom: 1px solid #E5E7EB; padding: 16px 24px;">
    <div style="max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: flex-end;">
      ${brandLogoHtml}
    </div>
  </header>

  <!-- Content -->
  <main style="max-width: 900px; margin: 0 auto; padding: 32px 24px;">
    <h1 style="font-size: 28px; font-weight: 700; color: #032D60; line-height: 1.3;">${safeTitle}</h1>
    ${bodyContent}
  </main>

  <!-- Footer -->
  <footer style="text-align: center; padding: 32px 24px; color: #9CA3AF; font-size: 12px;">
    Powered by Salesforce
  </footer>

  ${showLogin ? `
  <script>
    async function watchLogin(e) {
      e.preventDefault();
      const btn = document.getElementById('watch-submit-btn');
      const errDiv = document.getElementById('watch-error');
      btn.disabled = true;
      btn.textContent = 'Verifying...';
      errDiv.style.display = 'none';

      try {
        const resp = await fetch('/watch/${video.id}/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('watch-user').value,
            password: document.getElementById('watch-pass').value,
          }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || 'Invalid credentials');
        }

        const { token } = await resp.json();
        sessionStorage.setItem('watch_token_${video.id}', token);

        // Fetch video data with token
        const vResp = await fetch('/watch/${video.id}/verify', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (!vResp.ok) throw new Error('Failed to load video');
        const vData = await vResp.json();

        // Replace login form with player
        const loginEl = document.getElementById('watch-login');
        loginEl.outerHTML = '<div id="watch-player" style="margin-top: 24px;">' +
          '<div style="position: relative; width: 100%; border-radius: 12px; overflow: hidden; background: #000; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">' +
          '<video controls playsinline preload="metadata"' +
          (vData.thumbnail_url ? ' poster="' + vData.thumbnail_url + '"' : '') +
          ' style="width: 100%; display: block; border-radius: 12px;"' +
          ' src="' + vData.video_url + '">Your browser does not support the video tag.</video></div>' +
          (vData.description ? '<div style="margin-top: 20px; padding: 20px; background: #F8FAFC; border-radius: 10px; border: 1px solid #E2E8F0;"><p style="font-size: 14px; line-height: 1.7; color: #334155;">' + vData.description.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>') + '</p></div>' : '') +
          '</div>';
      } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '▶ Watch Video';
      }
    }

    // Auto-login if we have a stored token
    (async function() {
      const token = sessionStorage.getItem('watch_token_${video.id}');
      if (!token) return;
      try {
        const resp = await fetch('/watch/${video.id}/verify', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (resp.ok) {
          const vData = await resp.json();
          const loginEl = document.getElementById('watch-login');
          if (loginEl) {
            loginEl.outerHTML = '<div id="watch-player" style="margin-top: 24px;">' +
              '<div style="position: relative; width: 100%; border-radius: 12px; overflow: hidden; background: #000; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">' +
              '<video controls playsinline preload="metadata"' +
              (vData.thumbnail_url ? ' poster="' + vData.thumbnail_url + '"' : '') +
              ' style="width: 100%; display: block; border-radius: 12px;"' +
              ' src="' + vData.video_url + '">Your browser does not support the video tag.</video></div>' +
              (vData.description ? '<div style="margin-top: 20px; padding: 20px; background: #F8FAFC; border-radius: 10px; border: 1px solid #E2E8F0;"><p style="font-size: 14px; line-height: 1.7; color: #334155;">' + vData.description.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>') + '</p></div>' : '') +
              '</div>';
          }
        }
      } catch (e) { /* ignore — show login form */ }
    })();
  </script>
  ` : ''}
</body>
</html>`;
}

// GET /watch/:id — public video player page (unauthenticated)
app.get('/watch/:id', async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, name, brand_name, brand_logo_url, description, video_url, thumbnail_url, status, public_enabled, public_username, public_password FROM videos WHERE id = ?',
      [req.params.id]
    );

    if (rows.length === 0 || !rows[0].public_enabled) {
      return res.status(404).send(renderWatchPage({ name: 'Video Not Found', status: 'draft' }, false).replace(
        /<main[^>]*>[\s\S]*<\/main>/,
        '<main style="max-width: 900px; margin: 0 auto; padding: 80px 24px; text-align: center;"><h1 style="font-size: 24px; color: #6B7280;">This video is not available</h1><p style="margin-top: 12px; color: #9CA3AF;">The video you\'re looking for doesn\'t exist or isn\'t publicly shared.</p></main>'
      ));
    }

    const video = rows[0];
    const needsAuth = !!video.public_password;

    res.send(renderWatchPage(video, needsAuth));
  } catch (err) {
    console.error('[Watch] Failed to load watch page:', err);
    res.status(500).send('Something went wrong. Please try again later.');
  }
});

// POST /watch/:id/auth — password verification for protected videos
app.post('/watch/:id/auth', express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Rate limiting: max 5 attempts per video per 60 seconds
    const key = `watch_${req.params.id}`;
    const now = Date.now();
    if (!_watchAttempts[key]) _watchAttempts[key] = [];
    _watchAttempts[key] = _watchAttempts[key].filter(t => now - t < 60000);
    if (_watchAttempts[key].length >= 5) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    }
    _watchAttempts[key].push(now);

    const rows = await query(
      'SELECT id, public_enabled, public_username, public_password FROM videos WHERE id = ?',
      [req.params.id]
    );

    if (rows.length === 0 || !rows[0].public_enabled || !rows[0].public_password) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = rows[0];

    // Check username (case-insensitive)
    if (video.public_username && username.toLowerCase() !== video.public_username.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Check password
    const passwordValid = await bcrypt.compare(password, video.public_password);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Issue short-lived JWT scoped to this video
    const token = jwt.sign({ videoId: video.id, type: 'watch' }, WATCH_JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) {
    console.error('[Watch] Auth failed:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// GET /watch/:id/verify — return video data for authenticated watch sessions
app.get('/watch/:id/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token required' });
    }

    const token = authHeader.split(' ')[1];
    let payload;
    try {
      payload = jwt.verify(token, WATCH_JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (payload.videoId !== parseInt(req.params.id) || payload.type !== 'watch') {
      return res.status(403).json({ error: 'Token not valid for this video' });
    }

    const rows = await query(
      'SELECT id, name, description, video_url, thumbnail_url, brand_logo_url, status, public_enabled FROM videos WHERE id = ?',
      [req.params.id]
    );

    if (rows.length === 0 || !rows[0].public_enabled) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = rows[0];
    res.json({
      name: video.name,
      description: video.description,
      video_url: video.status === 'completed' ? video.video_url : null,
      thumbnail_url: video.thumbnail_url,
      brand_logo_url: video.brand_logo_url,
    });
  } catch (err) {
    console.error('[Watch] Verify failed:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// SPA catch-all — serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════
// STARTUP DIAGNOSTICS
// ═══════════════════════════════════════════════

/**
 * Non-blocking startup check: probe Veo API to verify the API key has
 * video generation access (requires paid-tier billing).
 * Logs results so they show up in Heroku logs automatically.
 */
async function checkVeoCapability() {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const veoModels = ['veo-3.1-generate-preview'];

  console.log('[Startup Veo Check] Testing Veo video generation capability...');

  for (const modelName of veoModels) {
    try {
      // Just initiate a short generation — we cancel immediately, we only care
      // about whether the API key is authorized for this model.
      const operation = await ai.models.generateVideos({
        model: modelName,
        prompt: 'A single blue circle on white background',
        config: {
          aspectRatio: '16:9',
          resolution: '720p',
          durationSeconds: 5,
          numberOfVideos: 1,
        },
      });

      // If we get here without an error, the model is accessible
      console.log(`[Startup Veo Check] ✓ ${modelName} — ACCESSIBLE (operation started)`);

      // We don't need the actual video — just log that it works.
      // The operation will eventually time out or be garbage collected.
      // Log the operation name for reference.
      if (operation.name) {
        console.log(`[Startup Veo Check]   Operation: ${operation.name}`);
      }

      // One model working is enough — stop testing
      return;
    } catch (err) {
      const errMsg = err.message || String(err);
      console.warn(`[Startup Veo Check] ✗ ${modelName} — FAILED: ${errMsg}`);

      if (err.status) console.warn(`[Startup Veo Check]   HTTP ${err.status}: ${err.statusText || ''}`);
      if (err.errorDetails) {
        console.warn(`[Startup Veo Check]   Details: ${JSON.stringify(err.errorDetails).substring(0, 300)}`);
      }

      // Billing/permission error means no Veo model will work
      if (errMsg.includes('billing') || errMsg.includes('quota') || errMsg.includes('permission') || errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED')) {
        console.error('[Startup Veo Check] ⚠️  Veo requires a paid-tier Gemini API key with billing enabled.');
        console.error('[Startup Veo Check]    B-roll will fall back to still images until this is resolved.');
        return;
      }
    }
  }

  console.warn('[Startup Veo Check] ⚠️  No Veo models accessible. B-roll will use still images.');
}

// ═══════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════

/**
 * On startup, mark any videos stuck in 'processing' as 'failed'.
 * This handles the case where a Heroku dyno restart killed in-progress pipelines.
 */
async function recoverStaleJobs() {
  try {
    const stale = await query(
      "SELECT id, name FROM videos WHERE status = 'processing'"
    );
    if (stale.length > 0) {
      console.log(`[Recovery] Found ${stale.length} stuck video(s) — marking as failed so they can be retried.`);
      for (const v of stale) {
        await query(
          "UPDATE videos SET status = 'failed', error = 'Server restarted during processing. Please retry.' WHERE id = ?",
          [v.id]
        );
        await query(
          "UPDATE video_jobs SET status = 'failed', error = 'Server restarted', completed_at = NOW() WHERE video_id = ? AND status IN ('pending', 'running')",
          [v.id]
        );
        console.log(`[Recovery] Video ${v.id} ("${v.name}") marked as failed.`);
      }
    }
  } catch (err) {
    console.warn('[Recovery] Stale job recovery failed:', err.message);
  }
}

async function start() {
  try {
    await migrate();
    console.log('✓ Database ready');
    await recoverStaleJobs();
  } catch (err) {
    console.error('⚠️  Database migration failed:', err.message);
    console.warn('  Features requiring a database will not work until JAWSDB_URL is configured');
  }

  const server = app.listen(PORT, () => {
    console.log(`Video Builder running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️  GEMINI_API_KEY not set — AI features will not work');
    } else {
      // Run Veo capability check in background (non-blocking)
      checkVeoCapability().catch(() => {});
    }
    if (!process.env.ELEVENLABS_API_KEY) {
      console.warn('⚠️  ELEVENLABS_API_KEY not set — voiceover will not work');
    }
    if (!process.env.R2_ACCOUNT_ID) {
      console.warn('⚠️  R2 credentials not set — video upload will not work');
    }
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
}

start();
