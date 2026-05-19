const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { query } = require('../db/connection');
const { generateScript } = require('./scriptGenerator');
const { generateVoiceover } = require('./voiceoverGenerator');
const { captureAllScenes, captureScene } = require('./sceneCapture');
const { generateAllBroll } = require('./brollGenerator');
const { composeVideo, applyIntroLogoOverlay } = require('./videoCompositor');
const { uploadVideoAssets, uploadSegmentClips } = require('../utils/r2');

/**
 * Run the full video generation pipeline for a video record.
 *
 * Steps:
 *   1. script    — Generate narration script from scene data
 *   2. voiceover — Generate TTS audio with timestamps
 *   3. capture   — Capture PocketSIC scenes via Puppeteer
 *   4. broll     — Generate b-roll images for intro/transition/outro
 *   5. composite — Compose final MP4 with FFmpeg
 *   6. upload    — Upload to R2 and update video record
 *
 * Each step is tracked as a video_job row in the database.
 *
 * @param {number} videoId  — videos.id
 * @param {number} userId   — users.id
 * @param {object} options  — Override options
 * @returns {Promise<object>} Final video record
 */
async function runPipeline(videoId, userId, options = {}) {
  const workDir = path.join(os.tmpdir(), `vb_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Load video record
    const [video] = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [videoId, userId]);
    if (!video) throw new Error('Video not found');

    const sceneData = typeof video.scene_data === 'string' ? JSON.parse(video.scene_data) : (video.scene_data || {});
    // Sort scenes by ID ascending — PocketSIC IDs are auto-increment and represent journey order.
    // scene_data.scenes may be stored in reverse or arbitrary order from the import.
    const scenes = (sceneData.scenes || []).slice().sort((a, b) => {
      const idA = a.id || a.sceneId || 0;
      const idB = b.id || b.sceneId || 0;
      return idA - idB;
    });
    const scriptWriterData = video.scriptwriter_data
      ? (typeof video.scriptwriter_data === 'string' ? JSON.parse(video.scriptwriter_data) : video.scriptwriter_data)
      : null;

    if (scenes.length === 0) {
      throw new Error('No scenes found. Import a PocketSIC project first.');
    }

    // ── Resolve brand logo URL (fallback to PocketSIC if missing) ──
    let brandLogoUrl = video.brand_logo_url || sceneData.brand_logo_url || null;
    if (!brandLogoUrl && video.pocketsic_project_id) {
      try {
        const POCKETSIC_BASE_URL = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';
        const POCKETSIC_API_KEY = process.env.POCKETSIC_API_KEY;
        if (POCKETSIC_API_KEY) {
          // Fetch the user's email for the PocketSIC API call
          const [user] = await query('SELECT email FROM users WHERE id = ?', [userId]);
          const email = user ? user.email : '';
          const pResp = await fetch(
            `${POCKETSIC_BASE_URL}/api/projects/${video.pocketsic_project_id}?email=${encodeURIComponent(email)}`,
            { headers: { 'X-API-Key': POCKETSIC_API_KEY } }
          );
          if (pResp.ok) {
            const pData = await pResp.json();
            const proj = pData.project || pData;
            const bp = proj.brand_profile || {};
            brandLogoUrl = bp.logoUrl || bp.logo_url || bp.logo || proj.brand_logo_url || proj.logo_url || null;
            if (brandLogoUrl) {
              console.log(`[Pipeline] Resolved brand logo from PocketSIC: ${brandLogoUrl}`);
              // Persist so we don't need to fetch again
              await query('UPDATE videos SET brand_logo_url = ? WHERE id = ?', [brandLogoUrl, videoId]);
            }
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] Failed to fetch brand logo from PocketSIC (non-fatal): ${err.message}`);
      }
    }

    // ── Resolve persona image URL (fallback to PocketSIC if missing) ──
    let personaImageUrl = video.persona_image_url || null;
    if (!personaImageUrl && video.pocketsic_project_id) {
      try {
        const POCKETSIC_BASE_URL_P = process.env.POCKETSIC_BASE_URL || 'https://pocketsic.aubreydemo.com';
        const POCKETSIC_API_KEY_P = process.env.POCKETSIC_API_KEY;
        if (POCKETSIC_API_KEY_P) {
          const [user] = await query('SELECT email FROM users WHERE id = ?', [userId]);
          const email = user ? user.email : '';
          const pResp2 = await fetch(
            `${POCKETSIC_BASE_URL_P}/api/projects/${video.pocketsic_project_id}?email=${encodeURIComponent(email)}`,
            { headers: { 'X-API-Key': POCKETSIC_API_KEY_P } }
          );
          if (pResp2.ok) {
            const pData2 = await pResp2.json();
            const proj2 = pData2.project || pData2;
            const persona = proj2.persona || {};
            personaImageUrl = persona.imageUrl || persona.image_url || persona.image || proj2.persona_image_url || null;
            if (personaImageUrl) {
              console.log(`[Pipeline] Resolved persona image from PocketSIC: ${personaImageUrl}`);
              await query('UPDATE videos SET persona_image_url = ? WHERE id = ?', [personaImageUrl, videoId]);
            }
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] Failed to fetch persona image from PocketSIC (non-fatal): ${err.message}`);
      }
    }

    // ── Step 1: Script Generation ──
    // If user already generated/edited a script, reuse it; otherwise generate one now
    const existingScript = video.narration_script
      ? (typeof video.narration_script === 'string' ? JSON.parse(video.narration_script) : video.narration_script)
      : null;

    await updateVideoStatus(videoId, 'scripting');
    const scriptJobId = await createJob(videoId, userId, 'script');

    let script;
    try {
      if (existingScript && existingScript.segments && existingScript.segments.length > 0) {
        // Reuse the pre-generated/edited script
        script = existingScript;
        await updateJob(scriptJobId, 'running');
        await completeJob(scriptJobId, { totalSegments: script.totalSegments, reused: true });
      } else {
        await updateJob(scriptJobId, 'running');

        script = await generateScript({
          brandName: video.brand_name || sceneData.brand_name || 'Brand',
          brandDescription: sceneData.brand_description || '',
          personaName: sceneData.persona_name || '',
          personaDescription: sceneData.persona_description || '',
          synopsis: sceneData.synopsis || '',
          scenes: scenes.map(s => ({
            id: s.id || s.sceneId,
            channel: s.channel || s.channel_type || '',
            content_summary: s.content_summary || s.description || '',
          })),
          durationTarget: video.duration_target || 180,
          scriptWriterData,
          customInstructions: video.custom_instructions || '',
        });

        // Save script to video record
        await query('UPDATE videos SET narration_script = ? WHERE id = ?', [JSON.stringify(script), videoId]);
        await completeJob(scriptJobId, { totalSegments: script.totalSegments });
      }
    } catch (err) {
      await failJob(scriptJobId, err.message);
      throw err;
    }

    // ── Step 2: Voiceover Generation ──
    await updateVideoStatus(videoId, 'voiceover');
    const voiceJobId = await createJob(videoId, userId, 'voiceover');

    let voiceoverResult;
    try {
      await updateJob(voiceJobId, 'running');

      const narrationSegments = script.segments.filter(s => s.narration);
      voiceoverResult = await generateVoiceover({
        segments: narrationSegments,
        voiceId: video.voice_id !== 'default' ? video.voice_id : undefined,
        outputDir: workDir,
      });

      // Save timestamps to video record
      await query(
        'UPDATE videos SET voiceover_timestamps = ? WHERE id = ?',
        [JSON.stringify(voiceoverResult.timestamps), videoId]
      );
      await completeJob(voiceJobId, {
        duration: voiceoverResult.totalDuration,
        audioPath: voiceoverResult.audioPath,
      });
    } catch (err) {
      await failJob(voiceJobId, err.message);
      throw err;
    }

    // ── Step 3: Scene Capture ──
    await updateVideoStatus(videoId, 'capturing');
    const captureJobId = await createJob(videoId, userId, 'capture');

    let sceneImages = {};
    try {
      const sceneSegments = script.segments.filter(s => s.type === 'scene' && s.sceneId);
      const total = sceneSegments.length;
      await updateJob(captureJobId, 'running', 0, total);

      const captureInputs = sceneSegments.map(s => ({
        sceneId: s.sceneId,
        channel: s.channel || 'default',
        duration: s.estimatedDuration || 10,
      }));

      const captures = await captureAllScenes(captureInputs, workDir, (done, total) => {
        updateJobProgress(captureJobId, done, total);
      });

      captures.forEach(c => {
        sceneImages[c.sceneId] = c.imagePath;
      });

      await completeJob(captureJobId, { captured: captures.length });
    } catch (err) {
      await failJob(captureJobId, err.message);
      throw err;
    }

    // ── Step 4: B-Roll Generation ──
    // Safeguard: ensure intro and outro segments have brollDescription and visualType set.
    // The LLM sometimes omits brollDescription on the outro, causing it to be excluded
    // from b-roll generation and rendered as a still frame instead.
    for (const seg of script.segments) {
      if ((seg.type === 'intro' || seg.type === 'outro' || seg.type === 'transition') && !seg.brollDescription) {
        const brandDesc = sceneData.brand_description || video.brand_name || 'brand';
        if (seg.type === 'intro') {
          seg.brollDescription = `Wide cinematic establishing shot of a beautiful environment related to ${brandDesc}. Warm, inviting atmosphere.`;
        } else if (seg.type === 'outro') {
          seg.brollDescription = `Warm, inspiring cinematic closing shot — golden hour lighting, beautiful environment related to ${brandDesc}. Satisfying, uplifting mood.`;
        } else {
          seg.brollDescription = `Cinematic transition shot — atmospheric environment related to ${brandDesc}, passage of time.`;
        }
        seg.visualType = 'broll';
        console.log(`[Pipeline] Added missing brollDescription to ${seg.type} segment (order ${seg.order})`);
      }
      if ((seg.type === 'intro' || seg.type === 'outro' || seg.type === 'transition') && seg.visualType !== 'broll') {
        seg.visualType = 'broll';
        console.log(`[Pipeline] Fixed visualType to 'broll' for ${seg.type} segment (order ${seg.order})`);
      }
    }

    const brollJobId = await createJob(videoId, userId, 'broll');
    let brollImages = {};

    try {
      const brollSegments = script.segments.filter(
        s => s.visualType === 'broll' && s.brollDescription
      );

      if (brollSegments.length > 0 && video.include_broll !== false) {
        const total = brollSegments.length;
        await updateJob(brollJobId, 'running', 0, total);

        const brolls = await generateAllBroll(
          brollSegments,
          video.brand_name || sceneData.brand_name || 'Brand',
          workDir,
          (done, total) => {
            updateJobProgress(brollJobId, done, total);
          },
          personaImageUrl,
          voiceoverResult.timestamps,  // Pass timestamps so b-roll knows required durations
          script.segments,             // Pass all segments for next-segment-start calculation
          sceneData.brand_description || '',   // Brand description for contextual b-roll
          sceneData.persona_description || ''  // Persona description for contextual b-roll
        );

        brolls.forEach(b => {
          // mediaPaths is an array of clip paths (may be 1 or more)
          brollImages[b.order] = b.mediaPaths || [b.imagePath];
        });
      }

      await completeJob(brollJobId, { generated: Object.keys(brollImages).length });
    } catch (err) {
      // B-roll failure is non-fatal — continue with placeholders
      console.warn(`B-roll generation partially failed: ${err.message}`);
      await completeJob(brollJobId, { error: err.message, partial: true });
    }

    // ── Step 5: Video Composition ──
    await updateVideoStatus(videoId, 'compositing');
    const compositeJobId = await createJob(videoId, userId, 'composite');

    let compositeResult;
    try {
      await updateJob(compositeJobId, 'running');

      // Resolve background music track URL if set
      let musicTrackUrl = null;
      if (video.music_track_id && video.music_track_id !== 'none') {
        try {
          const { getMusicTrackUrl } = require('./musicTracks');
          musicTrackUrl = getMusicTrackUrl(video.music_track_id);
          if (musicTrackUrl) console.log(`[Pipeline] Background music: ${video.music_track_id}`);
        } catch (err) {
          console.warn(`[Pipeline] Failed to resolve music track: ${err.message}`);
        }
      }

      compositeResult = await composeVideo({
        segments: script.segments,
        timestamps: voiceoverResult.timestamps,
        sceneImages,
        brollImages,
        voiceoverPath: voiceoverResult.audioPath,
        musicTrackUrl,
        brandName: video.brand_name || sceneData.brand_name || '',
        brandLogoUrl,
        outputDir: workDir,
        onProgress: (percent) => {
          updateJobProgress(compositeJobId, Math.round(percent), 100);
        },
      });

      await completeJob(compositeJobId, {
        duration: compositeResult.duration,
        videoPath: compositeResult.videoPath,
      });
    } catch (err) {
      await failJob(compositeJobId, err.message);
      throw err;
    }

    // ── Step 5b: Upload individual segment clips for selective regeneration ──
    try {
      if (compositeResult.segmentClips && compositeResult.segmentClips.length > 0) {
        console.log(`[Pipeline] Uploading ${compositeResult.segmentClips.length} segment clips to R2...`);
        const segClipUrls = await uploadSegmentClips(userId, videoId, compositeResult.segmentClips);

        // Also store voiceover URL per-segment (timestamps are already in DB)
        const segmentAssets = {
          clips: segClipUrls,   // { order: r2_url }
          voiceoverUrl: null,   // will be set after upload step
        };
        await query('UPDATE videos SET segment_assets = ? WHERE id = ?', [JSON.stringify(segmentAssets), videoId]);
        console.log(`[Pipeline] ✓ Segment assets saved (${Object.keys(segClipUrls).length} clips)`);
      }
    } catch (err) {
      console.warn(`[Pipeline] Segment clip upload failed (non-fatal): ${err.message}`);
    }

    // Clean up normalized clip files now that they're uploaded
    if (compositeResult.segmentClips) {
      for (const sc of compositeResult.segmentClips) {
        try { if (sc.clipPath && fs.existsSync(sc.clipPath)) fs.unlinkSync(sc.clipPath); } catch {}
      }
    }

    // ── Step 6: Upload to R2 ──
    await updateVideoStatus(videoId, 'uploading');
    const uploadJobId = await createJob(videoId, userId, 'upload');

    try {
      await updateJob(uploadJobId, 'running');

      const urls = await uploadVideoAssets(userId, videoId, {
        videoPath: compositeResult.videoPath,
        thumbnailPath: compositeResult.thumbnailPath,
        voiceoverPath: voiceoverResult.audioPath,
      });

      // Update segment_assets with voiceover URL
      try {
        const [vid] = await query('SELECT segment_assets FROM videos WHERE id = ?', [videoId]);
        if (vid && vid.segment_assets) {
          const sa = typeof vid.segment_assets === 'string' ? JSON.parse(vid.segment_assets) : vid.segment_assets;
          sa.voiceoverUrl = urls.voiceoverUrl || null;
          await query('UPDATE videos SET segment_assets = ? WHERE id = ?', [JSON.stringify(sa), videoId]);
        }
      } catch (e) { /* non-fatal */ }

      // Update video record with URLs and final status
      await query(
        `UPDATE videos SET
          video_url = ?,
          thumbnail_url = ?,
          voiceover_url = ?,
          duration_actual = ?,
          status = 'completed',
          error = NULL
        WHERE id = ?`,
        [
          urls.videoUrl || null,
          urls.thumbnailUrl || null,
          urls.voiceoverUrl || null,
          compositeResult.duration,
          videoId,
        ]
      );

      await completeJob(uploadJobId, urls);
    } catch (err) {
      await failJob(uploadJobId, err.message);
      throw err;
    }

    // Clean up work directory
    cleanupDir(workDir);

    // Return updated video
    const [finalVideo] = await query('SELECT * FROM videos WHERE id = ?', [videoId]);
    return finalVideo;

  } catch (err) {
    // Mark video as failed
    await query('UPDATE videos SET status = ?, error = ? WHERE id = ?', ['failed', err.message, videoId]);
    cleanupDir(workDir);
    throw err;
  }
}

// ─── Job Tracking Helpers ───

async function createJob(videoId, userId, step) {
  const id = crypto.randomUUID();
  await query(
    'INSERT INTO video_jobs (id, video_id, user_id, step, status) VALUES (?, ?, ?, ?, ?)',
    [id, videoId, userId, step, 'pending']
  );
  return id;
}

async function updateJob(jobId, status, progress, total) {
  const sets = ['status = ?', 'started_at = NOW()'];
  const params = [status];
  if (progress !== undefined) {
    sets.push('progress = ?');
    params.push(progress);
  }
  if (total !== undefined) {
    sets.push('total = ?');
    params.push(total);
  }
  params.push(jobId);
  await query(`UPDATE video_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
}

async function updateJobProgress(jobId, progress, total) {
  await query('UPDATE video_jobs SET progress = ?, total = ? WHERE id = ?', [progress, total, jobId]);
}

async function completeJob(jobId, output) {
  await query(
    'UPDATE video_jobs SET status = ?, output = ?, completed_at = NOW() WHERE id = ?',
    ['completed', output ? JSON.stringify(output) : null, jobId]
  );
}

async function failJob(jobId, errorMessage) {
  await query(
    'UPDATE video_jobs SET status = ?, error = ?, completed_at = NOW() WHERE id = ?',
    ['failed', errorMessage, jobId]
  );
}

async function updateVideoStatus(videoId, status) {
  await query('UPDATE videos SET status = ? WHERE id = ?', [status, videoId]);
}

// ─── Utilities ───

function cleanupDir(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`Failed to clean up ${dirPath}: ${e.message}`);
  }
}

/**
 * Get the current pipeline status for a video.
 * Returns the video record plus all job rows.
 */
async function getPipelineStatus(videoId, userId) {
  const [video] = await query(
    'SELECT id, name, status, error, duration_actual, video_url, thumbnail_url, created_at, updated_at FROM videos WHERE id = ? AND user_id = ?',
    [videoId, userId]
  );

  if (!video) return null;

  const jobs = await query(
    'SELECT id, step, status, progress, total, error, started_at, completed_at FROM video_jobs WHERE video_id = ? ORDER BY created_at ASC',
    [videoId]
  );

  return { video, jobs };
}

/**
 * Regenerate specific segments of a completed video and recomposite.
 *
 * Workflow:
 *   1. Download existing normalized segment clips from R2
 *   2. For changed segments: regenerate voiceover and/or b-roll
 *   3. Normalize new clips
 *   4. Recomposite full video using mix of existing + new clips
 *   5. Upload new video and update record
 *
 * @param {number} videoId
 * @param {number} userId
 * @param {Array<object>} changes - [{ order, narration?, brollDescription?, regenerateVoiceover?, regenerateBroll? }]
 * @returns {Promise<object>} Updated video record
 */
async function regenerateSegments(videoId, userId, changes) {
  const workDir = path.join(os.tmpdir(), `vb_regen_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Load video record
    const [video] = await query('SELECT * FROM videos WHERE id = ? AND user_id = ?', [videoId, userId]);
    if (!video) throw new Error('Video not found');
    if (video.status !== 'completed') throw new Error('Video must be completed before editing segments');

    const segmentAssets = video.segment_assets
      ? (typeof video.segment_assets === 'string' ? JSON.parse(video.segment_assets) : video.segment_assets)
      : null;
    if (!segmentAssets || !segmentAssets.clips) {
      throw new Error('No segment assets available. Please regenerate the full video first.');
    }

    const script = video.narration_script
      ? (typeof video.narration_script === 'string' ? JSON.parse(video.narration_script) : video.narration_script)
      : null;
    if (!script || !script.segments) throw new Error('No script found');

    const sceneData = typeof video.scene_data === 'string' ? JSON.parse(video.scene_data || '{}') : (video.scene_data || {});
    const voiceoverTimestamps = video.voiceover_timestamps
      ? (typeof video.voiceover_timestamps === 'string' ? JSON.parse(video.voiceover_timestamps) : video.voiceover_timestamps)
      : null;

    await updateVideoStatus(videoId, 'compositing');

    // Delete any old jobs for this video so pipeline progress shows fresh state
    await query('DELETE FROM video_jobs WHERE video_id = ?', [videoId]);

    // Build a map of which orders are being changed
    const changeMap = {};
    for (const c of changes) {
      changeMap[c.order] = c;
    }

    // Apply narration/brollDescription edits to the script
    let scriptModified = false;
    for (const c of changes) {
      const seg = script.segments.find(s => s.order === c.order);
      if (!seg) continue;
      if (c.narration !== undefined && c.narration !== null) {
        seg.narration = c.narration;
        scriptModified = true;
      }
      if (c.brollDescription !== undefined && c.brollDescription !== null) {
        seg.brollDescription = c.brollDescription;
        scriptModified = true;
      }
    }
    if (scriptModified) {
      await query('UPDATE videos SET narration_script = ? WHERE id = ?', [JSON.stringify(script), videoId]);
    }

    // Determine if any segment needs voiceover regeneration
    const needsVoiceover = changes.some(c => c.regenerateVoiceover || (c.narration !== undefined && c.narration !== null));
    const needsBroll = changes.some(c => c.regenerateBroll);

    // Create tracking jobs for pipeline progress display
    const voiceoverJobId = await createJob(videoId, userId, 'voiceover');
    const brollJobId = needsBroll ? await createJob(videoId, userId, 'broll') : null;
    const compositeJobId = await createJob(videoId, userId, 'composite');
    const uploadJobId = await createJob(videoId, userId, 'upload');

    // ── Regenerate voiceover if needed ──
    let voiceoverResult = null;
    let voiceoverPath = null;

    await updateJob(voiceoverJobId, 'running');
    if (needsVoiceover) {
      console.log('[Regen] Regenerating full voiceover (narration changed)...');
      const narrationSegments = script.segments.filter(s => s.narration);
      voiceoverResult = await generateVoiceover({
        segments: narrationSegments,
        voiceId: video.voice_id !== 'default' ? video.voice_id : undefined,
        outputDir: workDir,
      });

      await query(
        'UPDATE videos SET voiceover_timestamps = ? WHERE id = ?',
        [JSON.stringify(voiceoverResult.timestamps), videoId]
      );
      voiceoverPath = voiceoverResult.audioPath;
    } else {
      // Use existing voiceover — download from R2
      if (video.voiceover_url) {
        voiceoverPath = path.join(workDir, 'voiceover_existing.mp3');
        const { downloadFile } = require('../utils/r2');
        await downloadFile(video.voiceover_url, voiceoverPath);
        console.log('[Regen] Downloaded existing voiceover');
      }
    }
    await completeJob(voiceoverJobId, { regenVoiceover: needsVoiceover });

    // Use updated or existing timestamps
    const timestamps = voiceoverResult
      ? voiceoverResult.timestamps
      : voiceoverTimestamps;

    // ── Download existing segment clips from R2 ──
    console.log('[Regen] Downloading existing segment clips...');
    const { downloadFile: dlFile } = require('../utils/r2');
    const existingClips = {}; // order → local path

    for (const [orderStr, url] of Object.entries(segmentAssets.clips)) {
      const order = parseInt(orderStr, 10);
      if (changeMap[order] && changeMap[order].regenerateBroll) {
        // Skip — will regenerate this one
        continue;
      }
      try {
        const localPath = path.join(workDir, `existing_clip_${order}.mp4`);
        await dlFile(url, localPath);
        existingClips[order] = localPath;
      } catch (err) {
        console.warn(`[Regen] Failed to download clip for order ${order}: ${err.message}`);
      }
    }

    // ── Regenerate b-roll for changed segments ──
    const brollChanges = changes.filter(c => c.regenerateBroll);
    const newBrollClips = {}; // order → local path

    if (brollJobId) await updateJob(brollJobId, 'running');
    if (brollChanges.length > 0) {
      console.log(`[Regen] Regenerating b-roll for ${brollChanges.length} segment(s)...`);

      // Resolve persona image
      let personaImageUrl = video.persona_image_url || null;

      const { generateBroll, calcClipsNeeded } = require('./brollGenerator');
      const { spawn } = require('child_process');
      const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

      // Variation styles for multi-clip segments (same as full pipeline)
      const variationStyles = [
        null,  // First clip uses the original description unchanged
        'Show a COMPLETELY DIFFERENT scene and setting — different location, different activity, different mood. Do NOT repeat any action or prop from the previous shot.',
        'Show an OUTDOOR establishing shot — wide angle, environmental, no close-ups of objects. Completely different from previous clips.',
        'Show a warm CLOSE-UP of hands or a facial expression — intimate, emotional moment. No props, no objects, no packages.',
      ];

      for (const c of brollChanges) {
        const seg = script.segments.find(s => s.order === c.order);
        if (!seg) continue;
        // Scene captures don't have brollDescription — handle them first
        if (seg.visualType === 'scene_capture' && seg.sceneId) {
          // Recapture the PocketSIC scene instead of skipping
          try {
            // Calculate target duration from timestamps
            const tsMap = {};
            if (timestamps && timestamps.segments) {
              timestamps.segments.forEach(ts => { tsMap[ts.order] = ts; });
            }
            const orderedTs = timestamps && timestamps.segments
              ? timestamps.segments.slice().sort((a, b) => a.order - b.order)
              : [];
            const ts = tsMap[seg.order];
            let duration = seg.estimatedDuration || 10;
            if (ts) {
              const tsIdx = orderedTs.findIndex(t => t.order === seg.order);
              const nextTs = (tsIdx >= 0 && tsIdx < orderedTs.length - 1) ? orderedTs[tsIdx + 1] : null;
              duration = nextTs ? (nextTs.startTime - ts.startTime) : (ts.endTime - ts.startTime);
            }
            if (duration < 1) duration = 1;

            console.log(`[Regen] Recapturing scene ${seg.sceneId} (channel: ${seg.channel}, ${duration.toFixed(1)}s)...`);
            const clipPath = await captureScene({
              sceneId: seg.sceneId,
              channel: seg.channel || 'default',
              duration,
              outputDir: workDir,
            });

            if (clipPath && fs.existsSync(clipPath)) {
              // Normalize the captured clip to 1920x1080 and target duration
              const normalizedPath = path.join(workDir, `regen_clip_${c.order}.mp4`);
              const isPassive = (seg.channel || '').toLowerCase().replace(/[^a-z]/g, '');
              const shouldLoop = isPassive.includes('insta') || isPassive.includes('social') || isPassive.includes('facebook') || isPassive.includes('tiktok');

              if (shouldLoop) {
                // Passive scenes (Instagram): loop to fill target duration
                await new Promise((resolve, reject) => {
                  const proc = spawn(ffmpegPath, [
                    '-y', '-stream_loop', '-1', '-i', clipPath,
                    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-t', String(duration), '-r', '30', '-pix_fmt', 'yuv420p',
                    '-an', '-movflags', '+faststart', normalizedPath,
                  ], { stdio: ['ignore', 'pipe', 'pipe'] });
                  let stderr = '';
                  proc.stderr.on('data', d => stderr += d);
                  proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr.slice(-200)}`)));
                  proc.on('error', reject);
                });
              } else {
                // Interactive scenes: freeze last frame if too short
                const { normalizeVideoClip } = require('./videoCompositor');
                await normalizeVideoClip(clipPath, normalizedPath, duration, true);
              }

              newBrollClips[c.order] = normalizedPath;
              console.log(`[Regen] ✓ Scene ${seg.sceneId} recaptured and normalized (${duration.toFixed(1)}s)`);
            } else {
              console.warn(`[Regen] Scene capture returned no clip — keeping existing`);
            }
          } catch (err) {
            console.warn(`[Regen] Scene recapture failed for segment ${c.order}: ${err.message}`);
          }
          continue;
        }

        // B-roll segments require a description for generation
        if (!seg.brollDescription) continue;

        try {
          // Calculate target duration from timestamps
          const tsMap = {};
          if (timestamps && timestamps.segments) {
            timestamps.segments.forEach(ts => { tsMap[ts.order] = ts; });
          }
          const orderedTs = timestamps && timestamps.segments
            ? timestamps.segments.slice().sort((a, b) => a.order - b.order)
            : [];

          const ts = tsMap[seg.order];
          let duration = seg.estimatedDuration || 10;
          if (ts) {
            const tsIdx = orderedTs.findIndex(t => t.order === seg.order);
            const nextTs = (tsIdx >= 0 && tsIdx < orderedTs.length - 1) ? orderedTs[tsIdx + 1] : null;
            duration = nextTs ? (nextTs.startTime - ts.startTime) : (ts.endTime - ts.startTime);
          }
          if (duration < 1) duration = 1;

          // Calculate how many 8s clips we need (same logic as full pipeline)
          const clipsNeeded = calcClipsNeeded(seg, timestamps, script.segments);
          console.log(`[Regen] Segment ${c.order}: ${duration.toFixed(1)}s → generating ${clipsNeeded} clip(s)`);

          // Generate clips SEQUENTIALLY to avoid Veo rate limits during regen
          // (full pipeline uses parallel because it has many segments, but regen
          // focuses on 1-2 segments so sequential avoids rate-limit fallback to images)
          const mediaPaths = [];
          for (let ci = 0; ci < clipsNeeded; ci++) {
            let desc = seg.brollDescription || 'Professional lifestyle image';
            if (ci > 0 && ci < variationStyles.length) {
              desc = `${variationStyles[ci]} General theme: ${desc.substring(0, 80)}`;
            } else if (ci >= variationStyles.length) {
              desc = `Cinematic environmental wide shot — cityscape, nature, or architecture. Unrelated to previous clips. Theme context: ${desc.substring(0, 60)}`;
            }

            // Only first clip gets persona reference for consistency
            const usePersona = personaImageUrl && ci === 0;

            // Small delay between clips to avoid rate limiting (skip for first clip)
            if (ci > 0) {
              console.log(`[Regen] Waiting 3s before generating clip ${ci + 1}/${clipsNeeded}...`);
              await new Promise(r => setTimeout(r, 3000));
            }

            const mediaPath = await generateBroll({
              description: desc,
              brandName: video.brand_name || sceneData.brand_name || 'Brand',
              brandDescription: sceneData.brand_description || '',
              personaDescription: sceneData.persona_description || '',
              outputDir: workDir,
              segmentType: seg.type || '',
              segmentChannel: seg.channel || '',
              personaImageUrl: usePersona ? personaImageUrl : null,
            });
            mediaPaths.push(mediaPath);
            console.log(`[Regen] Clip ${ci + 1}/${clipsNeeded}: ${mediaPath ? (mediaPath.endsWith('.mp4') ? 'VIDEO' : 'IMAGE') : 'FAILED'}`);
          }
          const validPaths = mediaPaths.filter(p => p);

          if (validPaths.length === 0) {
            console.warn(`[Regen] No clips generated for segment ${c.order}`);
            continue;
          }

          const normalizedPath = path.join(workDir, `regen_clip_${c.order}.mp4`);

          if (validPaths.length === 1) {
            // Single clip — normalize to fill duration
            const mediaPath = validPaths[0];
            const isVideo = mediaPath.endsWith('.mp4');

            if (isVideo) {
              // For a single clip ≤8s covering a ≤8s segment, no looping needed.
              // For a single clip covering a longer segment (fallback), loop is acceptable.
              await new Promise((resolve, reject) => {
                const proc = spawn(ffmpegPath, [
                  '-y', '-stream_loop', '-1', '-i', mediaPath,
                  '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
                  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                  '-t', String(duration), '-r', '30', '-pix_fmt', 'yuv420p',
                  '-an', '-movflags', '+faststart', normalizedPath,
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stderr = '';
                proc.stderr.on('data', d => stderr += d);
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr.slice(-200)}`)));
                proc.on('error', reject);
              });
            } else {
              // Image → video with zoom effect
              const totalFrames = Math.ceil(duration * 30);
              await new Promise((resolve, reject) => {
                const proc = spawn(ffmpegPath, [
                  '-y', '-loop', '1', '-i', mediaPath,
                  '-vf', `scale=2208:1242,crop='1920-((1920-1651)*n/${totalFrames})':'1080-((1080-929)*n/${totalFrames})',scale=1920:1080,format=yuv420p`,
                  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                  '-t', String(duration), '-r', '30', '-pix_fmt', 'yuv420p',
                  '-movflags', '+faststart', normalizedPath,
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stderr = '';
                proc.stderr.on('data', d => stderr += d);
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr.slice(-200)}`)));
                proc.on('error', reject);
              });
            }
          } else {
            // Multiple clips — normalize each, then concatenate and trim to target duration
            console.log(`[Regen] Concatenating ${validPaths.length} clips for segment ${c.order}...`);
            const normalizedParts = [];

            for (let j = 0; j < validPaths.length; j++) {
              const mediaPath = validPaths[j];
              const isVideo = mediaPath.endsWith('.mp4');
              const partPath = path.join(workDir, `regen_part_${c.order}_${j}.mp4`);

              if (isVideo) {
                await new Promise((resolve, reject) => {
                  const proc = spawn(ffmpegPath, [
                    '-y', '-i', mediaPath,
                    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-r', '30', '-pix_fmt', 'yuv420p',
                    '-an', '-movflags', '+faststart', partPath,
                  ], { stdio: ['ignore', 'pipe', 'pipe'] });
                  let stderr = '';
                  proc.stderr.on('data', d => stderr += d);
                  proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr.slice(-200)}`)));
                  proc.on('error', reject);
                });
              } else {
                // Image fallback — create 8s zoom clip
                const partFrames = Math.ceil(8 * 30);
                await new Promise((resolve, reject) => {
                  const proc = spawn(ffmpegPath, [
                    '-y', '-loop', '1', '-i', mediaPath,
                    '-vf', `scale=2208:1242,crop='1920-((1920-1651)*n/${partFrames})':'1080-((1080-929)*n/${partFrames})',scale=1920:1080,format=yuv420p`,
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-t', '8', '-r', '30', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', partPath,
                  ], { stdio: ['ignore', 'pipe', 'pipe'] });
                  let stderr = '';
                  proc.stderr.on('data', d => stderr += d);
                  proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr.slice(-200)}`)));
                  proc.on('error', reject);
                });
              }
              normalizedParts.push(partPath);
            }

            // Concatenate all normalized parts and trim to target duration
            const concatFilePath = path.join(workDir, `regen_concat_${c.order}.txt`);
            fs.writeFileSync(concatFilePath, normalizedParts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

            await new Promise((resolve, reject) => {
              const proc = spawn(ffmpegPath, [
                '-y', '-f', 'concat', '-safe', '0', '-i', concatFilePath,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-t', String(duration), '-r', '30', '-pix_fmt', 'yuv420p',
                '-an', '-movflags', '+faststart', normalizedPath,
              ], { stdio: ['ignore', 'pipe', 'pipe'] });
              let stderr = '';
              proc.stderr.on('data', d => stderr += d);
              proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Concat failed: ${stderr.slice(-200)}`)));
              proc.on('error', reject);
            });

            // Clean up parts
            for (const p of normalizedParts) {
              try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
            }
            try { if (fs.existsSync(concatFilePath)) fs.unlinkSync(concatFilePath); } catch {}
          }

          newBrollClips[c.order] = normalizedPath;
          console.log(`[Regen] ✓ B-roll regenerated for segment ${c.order} (${validPaths.length} clip(s), ${duration.toFixed(1)}s)`);
        } catch (err) {
          console.warn(`[Regen] B-roll regen failed for segment ${c.order}: ${err.message}`);
        }
      }
    }

    if (brollJobId) await completeJob(brollJobId, { clips: Object.keys(newBrollClips).length });

    // ── Build final clip list in order ──
    const allSegmentOrders = script.segments.map(s => s.order).sort((a, b) => a - b);
    const orderedClipPaths = [];

    for (const order of allSegmentOrders) {
      if (newBrollClips[order]) {
        orderedClipPaths.push(newBrollClips[order]);
      } else if (existingClips[order]) {
        orderedClipPaths.push(existingClips[order]);
      } else {
        console.warn(`[Regen] Missing clip for segment ${order} — skipping`);
      }
    }

    if (orderedClipPaths.length === 0) {
      throw new Error('No clips available for recomposition');
    }

    // ── Apply logo overlay to intro and outro BEFORE concat ──
    // Only apply to clips that were regenerated — existing clips already have the overlay baked in.
    const brandLogoUrl = video.brand_logo_url || sceneData.brand_logo_url || null;
    if (brandLogoUrl) {
      const introSeg = script.segments.find(s => s.type === 'intro');
      if (introSeg && newBrollClips[introSeg.order]) {
        const introIdx = allSegmentOrders.indexOf(introSeg.order);
        if (introIdx >= 0 && orderedClipPaths[introIdx]) {
          try {
            const introClip = orderedClipPaths[introIdx];
            const overlaidClip = path.join(workDir, `regen_intro_overlay.mp4`);
            console.log(`[Regen] Applying logo overlay to regenerated intro (segment ${introSeg.order})...`);
            await applyIntroLogoOverlay(introClip, overlaidClip, brandLogoUrl, workDir);
            try { fs.unlinkSync(introClip); } catch {}
            fs.renameSync(overlaidClip, introClip);
            console.log('[Regen] ✓ Intro logo overlay applied');
          } catch (err) {
            console.warn(`[Regen] Logo overlay failed for intro (non-fatal): ${err.message}`);
          }
        }
      }

      const outroSeg = script.segments.find(s => s.type === 'outro');
      if (outroSeg && newBrollClips[outroSeg.order]) {
        const outroIdx = allSegmentOrders.indexOf(outroSeg.order);
        if (outroIdx >= 0 && orderedClipPaths[outroIdx]) {
          try {
            const outroClip = orderedClipPaths[outroIdx];
            const overlaidOutro = path.join(workDir, `regen_outro_overlay.mp4`);
            console.log(`[Regen] Applying logo overlay to regenerated outro (segment ${outroSeg.order})...`);
            await applyIntroLogoOverlay(outroClip, overlaidOutro, brandLogoUrl, workDir);
            try { fs.unlinkSync(outroClip); } catch {}
            fs.renameSync(overlaidOutro, outroClip);
            console.log('[Regen] ✓ Outro logo overlay applied');
          } catch (err) {
            console.warn(`[Regen] Logo overlay failed for outro (non-fatal): ${err.message}`);
          }
        }
      }
    }

    // ── Recomposite ──
    await updateJob(compositeJobId, 'running');
    console.log(`[Regen] Recompositing with ${orderedClipPaths.length} clips...`);
    const concatPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatPath, orderedClipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const { spawn } = require('child_process');

    const silentPath = path.join(workDir, 'silent.mp4');
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-c', 'copy', '-movflags', '+faststart', silentPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Concat failed: ${stderr.slice(-200)}`)));
      proc.on('error', reject);
    });

    // ── Overlay voiceover audio ──
    const finalPath = path.join(workDir, `video_regen_${Date.now()}.mp4`);

    // Resolve background music
    let musicPath = null;
    if (video.music_track_id && video.music_track_id !== 'none') {
      try {
        const { getMusicTrackUrl } = require('./musicTracks');
        const musicUrl = getMusicTrackUrl(video.music_track_id);
        if (musicUrl) {
          musicPath = path.join(workDir, 'bgmusic.mp3');
          const musicResp = await fetch(musicUrl);
          if (musicResp.ok) {
            fs.writeFileSync(musicPath, Buffer.from(await musicResp.arrayBuffer()));
          } else {
            musicPath = null;
          }
        }
      } catch (e) { musicPath = null; }
    }

    if (voiceoverPath && fs.existsSync(voiceoverPath)) {
      // Build audio mixing FFmpeg command
      const audioArgs = ['-y', '-i', silentPath, '-i', voiceoverPath];
      let filterComplex;

      if (musicPath && fs.existsSync(musicPath)) {
        audioArgs.push('-i', musicPath);
        filterComplex = '[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[vo];' +
          '[2:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.12[bg];' +
          '[vo][bg]amix=inputs=2:duration=first:dropout_transition=3[aout]';
        audioArgs.push('-filter_complex', filterComplex, '-map', '0:v', '-map', '[aout]');
      } else {
        audioArgs.push('-map', '0:v', '-map', '1:a');
      }

      audioArgs.push(
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart', finalPath
      );

      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, audioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Audio overlay failed: ${stderr.slice(-200)}`)));
        proc.on('error', reject);
      });
    } else {
      fs.copyFileSync(silentPath, finalPath);
    }

    // ── Upload new video ──
    await completeJob(compositeJobId, {});
    await updateJob(uploadJobId, 'running');
    await updateVideoStatus(videoId, 'uploading');

    const urls = await uploadVideoAssets(userId, videoId, {
      videoPath: finalPath,
      voiceoverPath: needsVoiceover ? voiceoverPath : null,
    });

    // Upload new segment clips for future edits
    const newClipEntries = [];
    for (const order of allSegmentOrders) {
      const clipPath = newBrollClips[order] || existingClips[order];
      if (clipPath) newClipEntries.push({ order, clipPath });
    }
    const newSegClipUrls = await uploadSegmentClips(userId, videoId, newClipEntries);

    // Get duration
    let duration = 0;
    try {
      const durationOutput = require('child_process').execSync(
        `${ffmpegPath} -i "${finalPath}" 2>&1 | grep Duration || true`,
        { encoding: 'utf-8' }
      );
      const match = durationOutput.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (match) duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
    } catch {}

    // Update video record
    const updatedSA = {
      clips: newSegClipUrls,
      voiceoverUrl: urls.voiceoverUrl || segmentAssets.voiceoverUrl || null,
    };

    await query(
      `UPDATE videos SET
        video_url = ?,
        voiceover_url = COALESCE(?, voiceover_url),
        duration_actual = ?,
        segment_assets = ?,
        status = 'completed',
        error = NULL
      WHERE id = ?`,
      [
        urls.videoUrl || video.video_url,
        urls.voiceoverUrl || null,
        duration || video.duration_actual,
        JSON.stringify(updatedSA),
        videoId,
      ]
    );

    await completeJob(uploadJobId, urls);
    cleanupDir(workDir);

    const [finalVideo] = await query('SELECT * FROM videos WHERE id = ?', [videoId]);
    return finalVideo;

  } catch (err) {
    await query('UPDATE videos SET status = ?, error = ? WHERE id = ?', ['completed', err.message, videoId]);
    cleanupDir(workDir);
    throw err;
  }
}

module.exports = { runPipeline, getPipelineStatus, regenerateSegments };
