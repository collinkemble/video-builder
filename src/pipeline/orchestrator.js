const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { query } = require('../db/connection');
const { generateScript } = require('./scriptGenerator');
const { generateVoiceover } = require('./voiceoverGenerator');
const { captureAllScenes } = require('./sceneCapture');
const { generateAllBroll } = require('./brollGenerator');
const { composeVideo } = require('./videoCompositor');
const { uploadVideoAssets } = require('../utils/r2');

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
    const scenes = sceneData.scenes || [];
    const scriptWriterData = video.scriptwriter_data
      ? (typeof video.scriptwriter_data === 'string' ? JSON.parse(video.scriptwriter_data) : video.scriptwriter_data)
      : null;

    if (scenes.length === 0) {
      throw new Error('No scenes found. Import a PocketSIC project first.');
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
          }
        );

        brolls.forEach(b => {
          brollImages[b.order] = b.imagePath;
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

module.exports = { runPipeline, getPipelineStatus };
