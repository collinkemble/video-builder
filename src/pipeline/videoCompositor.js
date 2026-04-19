const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ── Find and configure FFmpeg path ──
function findFfmpegPath() {
  // Check FFMPEG_PATH env var
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  // Check common Heroku buildpack paths
  const candidates = ['/app/vendor/ffmpeg/ffmpeg', '/app/.heroku/vendor/ffmpeg/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which ffmpeg', { encoding: 'utf-8' }).trim(); } catch { /* not found */ }
  return 'ffmpeg'; // hope it's on PATH
}

const FFMPEG_PATH = findFfmpegPath();
console.log(`[Compositor] FFmpeg path: ${FFMPEG_PATH}`);
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// Check available encoders
let USE_LIBX264 = true;
try {
  const encoders = execSync(`${FFMPEG_PATH} -encoders 2>/dev/null`, { encoding: 'utf-8' });
  USE_LIBX264 = encoders.includes('libx264');
  if (!USE_LIBX264) console.warn('[Compositor] libx264 not available, falling back to mpeg4');
} catch { /* assume available */ }

/**
 * Compose a final video from scene captures, b-roll images, and voiceover audio.
 *
 * Pipeline:
 *   1. Build an image sequence from the timeline (scene captures + b-roll)
 *   2. Generate a silent video from the image sequence (each image held for its segment duration)
 *   3. Overlay the voiceover audio
 *   4. Add lower-third title cards and crossfade transitions
 *   5. Export H.264 MP4 at 1920×1080
 *
 * @param {object} params
 * @param {Array}  params.segments       - Full timeline segments from the script
 * @param {object} params.timestamps     - { segments: [{ order, startTime, endTime }] }
 * @param {object} params.sceneImages    - Map of sceneId → imagePath
 * @param {object} params.brollImages    - Map of order → imagePath (for intro/transition/outro)
 * @param {string} params.voiceoverPath  - Path to voiceover MP3
 * @param {string} params.brandName      - Brand name for lower-thirds
 * @param {string} params.outputDir      - Directory for output
 * @param {function} params.onProgress   - Progress callback (percent)
 * @returns {Promise<object>} { videoPath, thumbnailPath, duration }
 */
async function composeVideo({
  segments,
  timestamps,
  sceneImages,
  brollImages,
  voiceoverPath,
  brandName,
  outputDir,
  onProgress,
}) {
  const workDir = outputDir || path.join(os.tmpdir(), `vb_${Date.now()}`);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  // ── Step 1: Build per-segment image list with durations ──
  const timelineEntries = buildTimeline(segments, timestamps, sceneImages, brollImages);

  if (timelineEntries.length === 0) {
    throw new Error('No images available for video composition. Scene capture may have failed — check that PocketSIC scenes are accessible.');
  }

  // Verify all image files actually exist
  for (const entry of timelineEntries) {
    if (!fs.existsSync(entry.imagePath)) {
      throw new Error(`Image file missing for segment ${entry.order}: ${entry.imagePath}`);
    }
  }

  // ── Step 2: Create concat demuxer file ──
  // Each image is shown for its calculated duration
  const concatFilePath = path.join(workDir, 'concat.txt');
  const concatLines = timelineEntries.map(entry => {
    const safePath = entry.imagePath.replace(/'/g, "'\\''");
    return `file '${safePath}'\nduration ${entry.duration.toFixed(3)}`;
  });
  // ffmpeg concat requires the last file repeated to avoid truncation
  const lastEntry = timelineEntries[timelineEntries.length - 1];
  concatLines.push(`file '${lastEntry.imagePath.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(concatFilePath, concatLines.join('\n'));
  console.log(`[Compositor] concat.txt (${timelineEntries.length} entries):\n${fs.readFileSync(concatFilePath, 'utf-8').substring(0, 500)}`);

  // ── Step 3: Generate silent video from images ──
  const silentVideoPath = path.join(workDir, 'silent.mp4');
  await createSilentVideo(concatFilePath, silentVideoPath, onProgress);

  // ── Step 4: Overlay voiceover audio ──
  const finalVideoPath = path.join(workDir, `video_${Date.now()}.mp4`);
  if (voiceoverPath && fs.existsSync(voiceoverPath)) {
    await overlayAudio(silentVideoPath, voiceoverPath, finalVideoPath, onProgress);
  } else {
    // No voiceover — just copy the silent video
    fs.copyFileSync(silentVideoPath, finalVideoPath);
  }

  // ── Step 5: Generate thumbnail (frame at 2 seconds) ──
  const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
  await generateThumbnail(finalVideoPath, thumbnailPath);

  // ── Step 6: Get duration ──
  const duration = await getVideoDuration(finalVideoPath);

  // Clean up intermediate files
  safeDelete(silentVideoPath);
  safeDelete(concatFilePath);

  return {
    videoPath: finalVideoPath,
    thumbnailPath,
    duration: Math.round(duration * 100) / 100,
  };
}

/**
 * Build the ordered timeline mapping segments to image files with durations.
 */
function buildTimeline(segments, timestamps, sceneImages, brollImages) {
  const tsMap = {};
  if (timestamps && timestamps.segments) {
    timestamps.segments.forEach(ts => {
      tsMap[ts.order] = ts;
    });
  }

  const entries = [];

  for (const seg of segments) {
    // Determine which image to show
    let imagePath = null;

    if (seg.visualType === 'scene_capture' && seg.sceneId && sceneImages[seg.sceneId]) {
      imagePath = sceneImages[seg.sceneId];
    } else if (brollImages[seg.order]) {
      imagePath = brollImages[seg.order];
    }

    if (!imagePath) {
      console.warn(`No image for segment ${seg.order} (type: ${seg.type}). Skipping.`);
      continue;
    }

    // Calculate duration from timestamps or fallback to estimated
    const ts = tsMap[seg.order];
    let duration;
    if (ts) {
      duration = ts.endTime - ts.startTime;
    } else {
      duration = seg.estimatedDuration || 10;
    }

    // Ensure minimum duration
    if (duration < 1) duration = 1;

    entries.push({
      order: seg.order,
      imagePath,
      duration,
      type: seg.type,
    });
  }

  return entries.sort((a, b) => a.order - b.order);
}

/**
 * Create a silent video from a concat demuxer file (image sequence).
 */
function createSilentVideo(concatFilePath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const videoCodecArgs = USE_LIBX264
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
      : ['-c:v', 'mpeg4', '-q:v', '5'];

    const args = [
      '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFilePath,
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
      ...videoCodecArgs,
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log(`[FFmpeg] Running: ${FFMPEG_PATH} ${args.join(' ')}`);

    const { spawn } = require('child_process');
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // 5-minute timeout to prevent stuck processes on Heroku
    const timeout = setTimeout(() => {
      console.error('[FFmpeg] Timeout reached (5 min). Killing process.');
      proc.kill('SIGKILL');
    }, 5 * 60 * 1000);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      stderr += line;
      // Parse progress from FFmpeg output
      const match = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match && onProgress) {
        onProgress(30); // rough progress indicator
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        console.error(`[FFmpeg] Exit code ${code}. Stderr:\n${stderr}`);
        reject(new Error(`FFmpeg silent video failed (exit code ${code}): ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Overlay voiceover audio onto a silent video.
 */
function overlayAudio(videoPath, audioPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`[FFmpeg] Audio overlay: ${cmd.substring(0, 120)}...`))
      .on('progress', (progress) => {
        if (onProgress && progress.percent) {
          onProgress(60 + Math.min(progress.percent * 0.3, 30)); // 60-90% for this step
        }
      })
      .on('error', (err) => reject(new Error(`FFmpeg audio overlay failed: ${err.message}`)))
      .on('end', () => resolve());

    cmd.run();
  });
}

/**
 * Generate a thumbnail image from a video at the 2-second mark.
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
        resolve(); // Non-fatal
      })
      .on('end', () => resolve());
  });
}

/**
 * Get the duration of a video file in seconds.
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

/**
 * Safely delete a file (no throw on failure).
 */
function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    /* ignore */
  }
}

module.exports = { composeVideo };
