require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { runPipeline, getPipelineStatus } = require('./src/pipeline/orchestrator');
const { generateScript } = require('./src/pipeline/scriptGenerator');
const { getAvailableVoices } = require('./src/pipeline/voiceoverGenerator');
const { deleteVideoAssets } = require('./src/utils/r2');

const app = express();
const PORT = process.env.PORT || 3000;

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
    ['scene_data', 'scene_ids', 'narration_script', 'voiceover_timestamps', 'scriptwriter_data'].forEach(field => {
      if (typeof video[field] === 'string') {
        try { video[field] = JSON.parse(video[field]); } catch (e) { /* keep as string */ }
      }
    });

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

    const result = await query(
      `INSERT INTO videos (user_id, name, brand_name, pocketsic_project_id, pocketsic_project_name,
        scene_data, voice_id, duration_target, scriptwriter_script_id, scriptwriter_script_name, scriptwriter_data, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        user.id,
        name.trim(),
        brandName || null,
        pocketsicProjectId || null,
        pocketsicProjectName || null,
        sceneData ? JSON.stringify(sceneData) : null,
        voiceId || 'default',
        durationTarget || 180,
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
    const { email, name, brandName, voiceId, durationTarget, sceneData, narrationScript } = req.body;
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
    const scenes = sceneData.scenes || [];

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
    `INSERT INTO videos (user_id, name, brand_name, pocketsic_project_id, pocketsic_project_name,
      scene_data, narration_script, voiceover_timestamps, video_url, thumbnail_url, voiceover_url,
      voice_id, duration_target, duration_actual, scriptwriter_script_id, scriptwriter_script_name, scriptwriter_data,
      status, shared_by, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      recipientUser.id,
      sourceVideo.name,
      sourceVideo.brand_name,
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
      sourceVideo.scriptwriter_script_id || null,
      sourceVideo.scriptwriter_script_name || null,
      sourceVideo.scriptwriter_data ? (typeof sourceVideo.scriptwriter_data === 'string' ? sourceVideo.scriptwriter_data : JSON.stringify(sourceVideo.scriptwriter_data)) : null,
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
          `UPDATE videos SET name = ?, brand_name = ?, scene_data = ?, narration_script = ?,
            voiceover_timestamps = ?, video_url = ?, thumbnail_url = ?, voiceover_url = ?,
            duration_actual = ?, status = ?, shared_by = ?, shared_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [
            sourceVideo.name,
            sourceVideo.brand_name,
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

// SPA catch-all — serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
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

async function start() {
  try {
    await migrate();
    console.log('✓ Database ready');
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
