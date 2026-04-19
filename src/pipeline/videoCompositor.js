const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ── Find and configure FFmpeg path ──
function findFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const candidates = ['/app/vendor/ffmpeg/ffmpeg', '/app/.heroku/vendor/ffmpeg/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which ffmpeg', { encoding: 'utf-8' }).trim(); } catch { /* not found */ }
  return 'ffmpeg';
}

const FFMPEG_PATH = findFfmpegPath();
console.log(`[Compositor] FFmpeg path: ${FFMPEG_PATH}`);
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// Target resolution
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

/**
 * Compose a final video from scene video clips, b-roll images, and voiceover audio.
 *
 * Pipeline:
 *   1. Build timeline: map segments to video clips (scenes) or still images (b-roll)
 *   2. Normalize each segment into a standardized MP4 clip at 1920x1080
 *   3. Concatenate all clips into a single silent video
 *   4. Overlay voiceover audio
 *   5. Generate thumbnail
 */
async function composeVideo({
  segments,
  timestamps,
  sceneImages,  // { sceneId: clipPath } — now MP4 clips from scene capture
  brollImages,  // { order: imagePath } — still PNG images from b-roll generator
  voiceoverPath,
  brandName,
  outputDir,
  onProgress,
}) {
  const workDir = outputDir || path.join(os.tmpdir(), `vb_${Date.now()}`);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  // ── Step 1: Build timeline ──
  const timelineEntries = buildTimeline(segments, timestamps, sceneImages, brollImages);

  if (timelineEntries.length === 0) {
    throw new Error('No media available for video composition. Scene capture may have failed.');
  }

  // Verify all source files exist
  for (const entry of timelineEntries) {
    if (!fs.existsSync(entry.sourcePath)) {
      throw new Error(`Media file missing for segment ${entry.order}: ${entry.sourcePath}`);
    }
  }

  if (onProgress) onProgress(10);

  // ── Step 2: Normalize each segment into 1920x1080 clips ──
  const normalizedClips = [];
  for (let i = 0; i < timelineEntries.length; i++) {
    const entry = timelineEntries[i];
    const clipPath = path.join(workDir, `clip_${String(i).padStart(3, '0')}.mp4`);

    if (entry.isVideo) {
      // Scene capture clip — scale/pad to 1920x1080 and trim/pad to target duration
      await normalizeVideoClip(entry.sourcePath, clipPath, entry.duration);
    } else {
      // B-roll still image — create a video of the image held for the duration
      await imageToVideo(entry.sourcePath, clipPath, entry.duration);
    }

    normalizedClips.push(clipPath);

    if (onProgress) {
      const pct = 10 + Math.round(40 * ((i + 1) / timelineEntries.length));
      onProgress(pct);
    }
  }

  // ── Step 3: Concatenate all clips ──
  const concatPath = path.join(workDir, 'concat.txt');
  const concatContent = normalizedClips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(concatPath, concatContent);
  console.log(`[Compositor] Concatenating ${normalizedClips.length} clips...`);

  const silentVideoPath = path.join(workDir, 'silent.mp4');
  await concatClips(concatPath, silentVideoPath, onProgress);

  if (onProgress) onProgress(70);

  // ── Step 4: Overlay voiceover audio ──
  const finalVideoPath = path.join(workDir, `video_${Date.now()}.mp4`);
  if (voiceoverPath && fs.existsSync(voiceoverPath)) {
    await overlayAudio(silentVideoPath, voiceoverPath, finalVideoPath, onProgress);
  } else {
    fs.copyFileSync(silentVideoPath, finalVideoPath);
  }

  if (onProgress) onProgress(90);

  // ── Step 5: Thumbnail ──
  const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
  await generateThumbnail(finalVideoPath, thumbnailPath);

  // ── Step 6: Get duration ──
  const duration = await getVideoDuration(finalVideoPath);

  // Cleanup intermediate files
  for (const clip of normalizedClips) safeDelete(clip);
  safeDelete(silentVideoPath);
  safeDelete(concatPath);

  return {
    videoPath: finalVideoPath,
    thumbnailPath,
    duration: Math.round(duration * 100) / 100,
  };
}

/**
 * Build the ordered timeline from script segments, timestamps, and media.
 */
function buildTimeline(segments, timestamps, sceneImages, brollImages) {
  const tsMap = {};
  if (timestamps && timestamps.segments) {
    timestamps.segments.forEach(ts => { tsMap[ts.order] = ts; });
  }

  const entries = [];

  for (const seg of segments) {
    let sourcePath = null;
    let isVideo = false;

    // Scene capture (now video clips)
    if (seg.visualType === 'scene_capture' && seg.sceneId && sceneImages[seg.sceneId]) {
      sourcePath = sceneImages[seg.sceneId];
      isVideo = sourcePath.endsWith('.mp4');
    }
    // B-roll (still images)
    else if (brollImages[seg.order]) {
      sourcePath = brollImages[seg.order];
      isVideo = sourcePath.endsWith('.mp4');
    }

    if (!sourcePath) {
      console.warn(`No media for segment ${seg.order} (type: ${seg.type}). Skipping.`);
      continue;
    }

    const ts = tsMap[seg.order];
    let duration = ts ? (ts.endTime - ts.startTime) : (seg.estimatedDuration || 10);
    if (duration < 1) duration = 1;

    entries.push({
      order: seg.order,
      sourcePath,
      isVideo,
      duration,
      type: seg.type,
    });
  }

  const sorted = entries.sort((a, b) => a.order - b.order);

  // Add 2 seconds of padding to the last segment to prevent narration cutoff
  if (sorted.length > 0) {
    sorted[sorted.length - 1].duration += 2;
  }

  return sorted;
}

/**
 * Normalize a video clip to 1920x1080, target duration.
 * If clip is shorter than target: pad with last frame (freeze).
 * If clip is longer: trim to target.
 */
function normalizeVideoClip(inputPath, outputPath, targetDuration) {
  return runFfmpeg([
    '-y',
    '-i', inputPath,
    '-t', String(targetDuration),
    '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outputPath,
  ], `normalizing clip`);
}

/**
 * Create a video from a still image held for a given duration.
 */
function imageToVideo(imagePath, outputPath, duration) {
  return runFfmpeg([
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-t', String(duration),
    '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], `image→video`);
}

/**
 * Concatenate normalized clips using the concat demuxer.
 */
function concatClips(concatFilePath, outputPath, onProgress) {
  return runFfmpeg([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFilePath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], 'concatenating clips');
}

/**
 * Get duration of an audio file in seconds.
 */
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format?.duration || 0;
      resolve(parseFloat(duration));
    });
  });
}

/**
 * Overlay voiceover audio onto a video.
 * Uses the LONGER of the two streams so narration never gets cut off.
 * If audio is longer than video, the last video frame freezes until audio finishes.
 */
function overlayAudio(videoPath, audioPath, outputPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get audio duration to ensure video covers the full narration
      const audioDur = await getAudioDuration(audioPath);
      const videoDur = await getVideoDuration(videoPath);
      console.log(`[FFmpeg] Audio overlay: video=${videoDur.toFixed(1)}s, audio=${audioDur.toFixed(1)}s`);

      // Pad with 1 second of silence after narration so it doesn't feel abrupt
      const targetDuration = Math.max(videoDur, audioDur + 1.0);

      const cmd = ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-map', '0:v:0',
          '-map', '1:a:0',
          // Use -t to set exact duration — no -shortest so audio isn't cut off
          '-t', String(Math.ceil(targetDuration)),
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('start', (cmd) => console.log(`[FFmpeg] Audio overlay: ${cmd.substring(0, 120)}...`))
        .on('progress', (progress) => {
          if (onProgress && progress.percent) {
            onProgress(70 + Math.min(progress.percent * 0.2, 20));
          }
        })
        .on('error', (err) => reject(new Error(`FFmpeg audio overlay failed: ${err.message}`)))
        .on('end', () => resolve());
      cmd.run();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Run an FFmpeg command via spawn with timeout.
 */
function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => {
      console.error(`[FFmpeg] Timeout (3 min) for ${label}. Killing.`);
      proc.kill('SIGKILL');
    }, 3 * 60 * 1000);

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        console.error(`[FFmpeg ${label}] Exit code ${code}. Stderr:\n${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg ${label} failed (exit ${code}): ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`FFmpeg spawn error (${label}): ${err.message}`));
    });
  });
}

/**
 * Generate thumbnail at 2-second mark.
 */
function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:02'],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '1280x720',
      })
      .on('error', (err) => {
        console.warn(`Thumbnail generation failed: ${err.message}. Skipping.`);
        resolve();
      })
      .on('end', () => resolve());
  });
}

/**
 * Get duration of a video in seconds.
 */
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format?.duration || 0;
      resolve(parseFloat(duration));
    });
  });
}

function safeDelete(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
}

module.exports = { composeVideo };
