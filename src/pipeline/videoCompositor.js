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
 * Determine if a channel is "passive" — i.e., it has native CSS/JS animations
 * that play on their own and should LOOP when the clip is shorter than the target.
 * Interactive channels (messaging, website, retail) should FREEZE on the last frame
 * because looping would replay the entire conversation/interaction sequence.
 */
function isPassiveChannel(channel) {
  if (!channel) return false;
  const ch = (channel || '').toLowerCase().replace(/[^a-z]/g, '');
  return ch.includes('insta') || ch.includes('social') || ch.includes('facebook') || ch.includes('tiktok');
}

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
  musicTrackUrl, // URL to a background music MP3 (optional)
  brandName,
  brandLogoUrl,  // URL to the brand logo (for intro overlay)
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
    for (const sp of entry.sourcePaths) {
      if (!fs.existsSync(sp)) {
        throw new Error(`Media file missing for segment ${entry.order}: ${sp}`);
      }
    }
  }

  if (onProgress) onProgress(10);

  // ── Step 2: Normalize each segment into 1920x1080 clips ──
  // Log full timeline for debugging
  console.log(`[Compositor] Timeline (${timelineEntries.length} entries):`);
  timelineEntries.forEach(e => {
    console.log(`  [${e.order}] ${e.type} | ${e.duration}s | video=${e.isVideo} | ${path.basename(e.sourcePath)}`);
  });

  const normalizedClips = [];
  for (let i = 0; i < timelineEntries.length; i++) {
    const entry = timelineEntries[i];
    const clipPath = path.join(workDir, `clip_${String(i).padStart(3, '0')}.mp4`);

    console.log(`[Compositor] Normalizing clip ${i}: type=${entry.type}, duration=${entry.duration}s, isVideo=${entry.isVideo}, clips=${entry.sourcePaths.length}`);

    const isBrollEntry = entry.type === 'intro' || entry.type === 'transition' || entry.type === 'outro'
                      || entry.type === 'broll';

    if (entry.isVideo && isBrollEntry && entry.sourcePaths.length > 1) {
      // Multiple b-roll video clips — concatenate them then trim to target duration
      await concatBrollClips(entry.sourcePaths, clipPath, entry.duration, workDir, i);
    } else if (entry.isVideo) {
      // Single video clip — scale/pad to 1920x1080 and trim to target duration
      // For INTERACTIVE scene captures (messaging, website, retail): freeze on last frame
      //   → looping would replay the entire conversation/clicks
      // For PASSIVE/animated scenes (Instagram, social, TikTok): loop the animation
      //   → these have native CSS/JS animations that naturally repeat
      // For b-roll: loop to fill time (ambient footage, safe to repeat)
      const isSceneCapture = entry.type === 'scene';
      const isPassiveScene = isSceneCapture && isPassiveChannel(entry.channel);
      const freezeIfShort = isSceneCapture && !isPassiveScene;
      console.log(`[Compositor] Scene clip decision: type=${entry.type}, channel=${entry.channel}, isSceneCapture=${isSceneCapture}, isPassive=${isPassiveScene}, freezeIfShort=${freezeIfShort}`);
      // Passive scenes (Instagram/social) must ALWAYS loop — their captured clips
      // may have frozen frames at the tail from animations completing. Even if the
      // clip duration is close to target, we loop to avoid showing the freeze.
      await normalizeVideoClip(entry.sourcePath, clipPath, entry.duration, freezeIfShort, isPassiveScene);
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

  // ── Step 2b: Ensure intro has enough time for logo overlay animation ──
  // If the intro clip is shorter than 10s and we have a brand logo, pad it.
  // We also need to delay the voiceover audio by the same padding amount
  // so all subsequent segments stay in sync.
  let voiceoverDelay = 0; // seconds of silence to prepend to voiceover audio
  const MIN_INTRO_FOR_LOGO = 10; // minimum intro duration when logo overlay is active

  if (brandLogoUrl && normalizedClips.length > 0 && timelineEntries[0].type === 'intro') {
    const introDuration = timelineEntries[0].duration;
    if (introDuration < MIN_INTRO_FOR_LOGO) {
      const padding = MIN_INTRO_FOR_LOGO - introDuration;
      console.log(`[Compositor] Intro is ${introDuration.toFixed(1)}s but logo overlay needs ${MIN_INTRO_FOR_LOGO}s — padding by ${padding.toFixed(1)}s`);

      // Re-create the intro clip with the longer duration
      const introEntry = timelineEntries[0];
      const paddedClipPath = path.join(workDir, 'clip_000_padded.mp4');

      if (introEntry.isVideo && introEntry.sourcePaths.length > 1) {
        await concatBrollClips(introEntry.sourcePaths, paddedClipPath, MIN_INTRO_FOR_LOGO, workDir, 999);
      } else if (introEntry.isVideo) {
        await normalizeVideoClip(introEntry.sourcePath, paddedClipPath, MIN_INTRO_FOR_LOGO, false);
      } else {
        await imageToVideo(introEntry.sourcePath, paddedClipPath, MIN_INTRO_FOR_LOGO);
      }

      safeDelete(normalizedClips[0]);
      fs.renameSync(paddedClipPath, normalizedClips[0]);

      timelineEntries[0].duration = MIN_INTRO_FOR_LOGO;
      voiceoverDelay = padding;
      console.log(`[Compositor] Intro padded to ${MIN_INTRO_FOR_LOGO}s, voiceover will be delayed by ${padding.toFixed(1)}s`);
    }

    // Apply logo overlay
    try {
      const introClip = normalizedClips[0];
      const overlaidClip = path.join(workDir, 'clip_000_overlay.mp4');
      await applyIntroLogoOverlay(introClip, overlaidClip, brandLogoUrl, workDir);
      // Replace the intro clip with the overlaid version
      safeDelete(introClip);
      fs.renameSync(overlaidClip, introClip);
      console.log('[Compositor] ✓ Intro logo overlay applied');
    } catch (err) {
      console.warn(`[Compositor] Logo overlay failed (non-fatal): ${err.message}`);
      // Continue without overlay — the original intro clip is still valid
    }
  }

  // ── Step 2c: Apply logo overlay to outro clip ──
  if (brandLogoUrl && normalizedClips.length > 0) {
    const lastIdx = timelineEntries.length - 1;
    if (timelineEntries[lastIdx].type === 'outro') {
      try {
        const outroClip = normalizedClips[lastIdx];
        const overlaidOutro = path.join(workDir, `clip_${String(lastIdx).padStart(3, '0')}_overlay.mp4`);
        await applyIntroLogoOverlay(outroClip, overlaidOutro, brandLogoUrl, workDir);
        safeDelete(outroClip);
        fs.renameSync(overlaidOutro, outroClip);
        console.log('[Compositor] ✓ Outro logo overlay applied');
      } catch (err) {
        console.warn(`[Compositor] Outro logo overlay failed (non-fatal): ${err.message}`);
      }
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

  // ── Step 3b: Download background music if specified ──
  let musicPath = null;
  if (musicTrackUrl) {
    try {
      console.log(`[Compositor] Downloading background music from: ${musicTrackUrl.substring(0, 80)}...`);
      musicPath = path.join(workDir, 'bgmusic.mp3');
      const musicResp = await fetch(musicTrackUrl);
      if (musicResp.ok) {
        const musicBuffer = Buffer.from(await musicResp.arrayBuffer());
        fs.writeFileSync(musicPath, musicBuffer);
        console.log(`[Compositor] Background music downloaded: ${(musicBuffer.length / 1024).toFixed(0)}KB`);
      } else {
        console.warn(`[Compositor] Music download failed (${musicResp.status}). Skipping background music.`);
        musicPath = null;
      }
    } catch (err) {
      console.warn(`[Compositor] Music download error: ${err.message}. Skipping background music.`);
      musicPath = null;
    }
  }

  // ── Step 4: Overlay voiceover audio (+ background music if available) ──
  // If we padded the intro, delay the voiceover audio to keep narration in sync
  let effectiveVoiceoverPath = voiceoverPath;
  if (voiceoverDelay > 0 && voiceoverPath && fs.existsSync(voiceoverPath)) {
    const delayedPath = path.join(workDir, 'voiceover_delayed.mp3');
    const delayMs = Math.round(voiceoverDelay * 1000);
    console.log(`[Compositor] Delaying voiceover by ${voiceoverDelay.toFixed(1)}s (${delayMs}ms) to sync with padded intro`);
    await runFfmpeg([
      '-y',
      '-i', voiceoverPath,
      '-af', `adelay=${delayMs}|${delayMs}`,
      '-c:a', 'libmp3lame', '-q:a', '2',
      delayedPath,
    ], `delaying voiceover by ${voiceoverDelay.toFixed(1)}s`);
    effectiveVoiceoverPath = delayedPath;
  }

  const finalVideoPath = path.join(workDir, `video_${Date.now()}.mp4`);
  if (effectiveVoiceoverPath && fs.existsSync(effectiveVoiceoverPath)) {
    await overlayAudio(silentVideoPath, effectiveVoiceoverPath, finalVideoPath, onProgress, musicPath);
  } else if (musicPath) {
    // No voiceover but has music — overlay just the music
    await overlayMusicOnly(silentVideoPath, musicPath, finalVideoPath, onProgress);
  } else {
    fs.copyFileSync(silentVideoPath, finalVideoPath);
  }

  if (onProgress) onProgress(90);

  // ── Step 5: Thumbnail ──
  const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
  await generateThumbnail(finalVideoPath, thumbnailPath);

  // ── Step 6: Get duration ──
  const duration = await getVideoDuration(finalVideoPath);

  // Build segment clip map (order → normalized clip path) for selective regeneration.
  // These clips will be uploaded to R2 by the orchestrator.
  const segmentClipMap = [];
  for (let i = 0; i < timelineEntries.length; i++) {
    segmentClipMap.push({
      order: timelineEntries[i].order,
      type: timelineEntries[i].type,
      clipPath: normalizedClips[i],
    });
  }

  // Cleanup intermediate files (but NOT the normalized clips — the orchestrator uploads them first)
  safeDelete(silentVideoPath);
  safeDelete(concatPath);
  if (musicPath) safeDelete(musicPath);
  if (effectiveVoiceoverPath !== voiceoverPath) safeDelete(effectiveVoiceoverPath);

  return {
    videoPath: finalVideoPath,
    thumbnailPath,
    duration: Math.round(duration * 100) / 100,
    segmentClips: segmentClipMap,  // for segment asset persistence
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

  // Build an ordered list of timestamp entries so we can look up "next segment start time"
  // to include inter-segment silence gaps in the visual duration.
  const orderedTimestamps = timestamps && timestamps.segments
    ? timestamps.segments.slice().sort((a, b) => a.order - b.order)
    : [];

  // Map from order → index in orderedTimestamps for quick lookup
  const tsIndexMap = {};
  orderedTimestamps.forEach((ts, idx) => { tsIndexMap[ts.order] = idx; });

  const entries = [];

  for (const seg of segments) {
    // B-roll media may be an array of paths (multiple clips) or a single path
    let sourcePaths = null;
    let isVideo = false;

    // Scene capture (now video clips)
    if (seg.visualType === 'scene_capture' && seg.sceneId && sceneImages[seg.sceneId]) {
      sourcePaths = [sceneImages[seg.sceneId]];
      isVideo = sceneImages[seg.sceneId].endsWith('.mp4');
    }
    // B-roll — may be a single path (string) or array of paths
    else if (brollImages[seg.order]) {
      const brollEntry = brollImages[seg.order];
      if (Array.isArray(brollEntry)) {
        sourcePaths = brollEntry;
      } else {
        sourcePaths = [brollEntry];
      }
      isVideo = sourcePaths[0].endsWith('.mp4');
    }

    if (!sourcePaths || sourcePaths.length === 0) {
      console.warn(`No media for segment ${seg.order} (type: ${seg.type}). Skipping.`);
      continue;
    }

    const ts = tsMap[seg.order];
    let duration;

    if (ts) {
      // Use the gap from this segment's startTime to the NEXT segment's startTime.
      // This ensures the visual holds through any silence between narration segments,
      // preventing the scene from switching before the next narration begins.
      const tsIdx = tsIndexMap[seg.order];
      const nextTs = (tsIdx !== undefined && tsIdx < orderedTimestamps.length - 1)
        ? orderedTimestamps[tsIdx + 1]
        : null;

      if (nextTs) {
        // Duration = time from this segment's audio start to the next segment's audio start
        duration = nextTs.startTime - ts.startTime;
        console.log(`[Compositor] Segment ${seg.order}: audio ${ts.startTime.toFixed(1)}s-${ts.endTime.toFixed(1)}s, next starts ${nextTs.startTime.toFixed(1)}s → visual ${duration.toFixed(1)}s`);
      } else {
        // Last segment with timestamps — use its own narration duration
        duration = ts.endTime - ts.startTime;
        console.log(`[Compositor] Segment ${seg.order} (last): audio ${ts.startTime.toFixed(1)}s-${ts.endTime.toFixed(1)}s → visual ${duration.toFixed(1)}s`);
      }
    } else {
      duration = seg.estimatedDuration || 10;
    }

    if (duration < 1) duration = 1;

    // NOTE: No b-roll minimum override — visual duration MUST match audio timeline
    // to prevent scenes from drifting ahead of their narration.
    // EXCEPTION: The intro segment needs a minimum duration for the logo overlay
    // animation (~10s). If the intro audio is shorter, we pad the visual with silence.
    // This is safe because the voiceover is overlaid as a single track — extra visual
    // time at the start just means a brief moment of silence after the intro narration
    // before the scene narration starts, which feels natural.

    entries.push({
      order: seg.order,
      sourcePaths,  // Array of paths (multiple clips for b-roll, single for scene capture)
      sourcePath: sourcePaths[0],  // Backward compat — primary clip
      isVideo,
      duration,
      type: seg.type,
      channel: seg.channel || null,  // Needed to determine loop vs freeze for scene clips
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
 *
 * For SCENE CAPTURE clips (freezeIfShort=true):
 *   If clip is LONGER than target → speed up to fit all content in the time window.
 *     e.g. 45s capture in a 21s slot = 2.1x speed (shows entire conversation).
 *     Capped at 3x to stay watchable.
 *   If clip is SHORTER than target → freeze on the last frame to fill remaining time.
 *     NEVER loop scene captures — looping replays the entire conversation (clicks,
 *     typing indicators, message reveals), making it look like extra messages were sent.
 *
 * For B-ROLL clips (freezeIfShort=false):
 *   If shorter than target → loop to fill (ambient footage, safe to repeat).
 *
 * No slow-motion is applied. B-roll clips that need more time use multiple
 * clips (generated by the b-roll generator) instead of slowing down.
 */
async function normalizeVideoClip(inputPath, outputPath, targetDuration, freezeIfShort = false, forceLoop = false) {
  const clipDuration = await getVideoDuration(inputPath);

  // If forceLoop is set (passive scenes like Instagram/social), ALWAYS loop.
  // These scenes have CSS/JS animations that play once (~14s) then freeze.
  // Looping with -stream_loop + -t trim ensures the animation repeats
  // seamlessly for the full narration duration, regardless of whether the
  // captured clip is shorter, equal to, or longer than the target.
  if (forceLoop && !freezeIfShort) {
    console.log(`[Compositor] Passive scene clip ${clipDuration.toFixed(1)}s → looping to fill ${targetDuration.toFixed(1)}s (forceLoop, ALWAYS loop for passive)`);
    return runFfmpeg([
      '-y',
      '-stream_loop', '-1',
      '-i', inputPath,
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-t', String(targetDuration),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      outputPath,
    ], `normalizing passive scene clip (force-looped to fill ${targetDuration.toFixed(1)}s)`);
  }

  // If clip is LONGER than target → speed up to fit all content
  if (clipDuration > targetDuration * 1.1) {
    const speedup = clipDuration / targetDuration;
    const cappedSpeedup = Math.min(speedup, 3.0); // cap at 3x to stay watchable
    const ptsFactor = 1 / cappedSpeedup;
    console.log(`[Compositor] Speeding up clip ${cappedSpeedup.toFixed(2)}x to fit ${clipDuration.toFixed(1)}s into ${targetDuration.toFixed(1)}s`);
    return runFfmpeg([
      '-y',
      '-i', inputPath,
      '-vf', `setpts=${ptsFactor.toFixed(4)}*PTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-t', String(targetDuration),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      outputPath,
    ], `normalizing clip (${cappedSpeedup.toFixed(1)}x speed-up)`);
  }

  // If clip is SHORTER than target:
  if (clipDuration < targetDuration * 0.95) {
    if (freezeIfShort) {
      // SCENE CAPTURE: freeze on last frame to fill remaining time.
      // We extract the last frame as a PNG, create a still video from it,
      // then concatenate the original clip + still video.
      // This avoids relying on tpad which may not be available on all FFmpeg builds.
      const padDuration = targetDuration - clipDuration;
      console.log(`[Compositor] Scene clip ${clipDuration.toFixed(1)}s < target ${targetDuration.toFixed(1)}s — freezing last frame for ${padDuration.toFixed(1)}s (extract+concat method)`);

      const dir = path.dirname(outputPath);
      const base = path.basename(outputPath, '.mp4');
      const lastFramePath = path.join(dir, `${base}_lastframe.png`);
      const stillClipPath = path.join(dir, `${base}_still.mp4`);
      const normalizedOrigPath = path.join(dir, `${base}_orig_norm.mp4`);
      const concatListPath = path.join(dir, `${base}_freeze_concat.txt`);

      // Step A: Normalize the original clip to target resolution/codec
      await runFfmpeg([
        '-y', '-i', inputPath,
        '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-r', String(FPS), '-pix_fmt', 'yuv420p', '-an',
        '-movflags', '+faststart',
        normalizedOrigPath,
      ], 'freeze: normalize original clip');

      // Step B: Extract the last frame as a PNG
      await runFfmpeg([
        '-y', '-sseof', '-0.1',
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        lastFramePath,
      ], 'freeze: extract last frame');

      // Step C: Create a still video from the last frame (no zoom, just static)
      await runFfmpeg([
        '-y', '-loop', '1',
        '-i', lastFramePath,
        '-vf', `scale=${WIDTH}:${HEIGHT},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-t', String(Math.ceil(padDuration) + 1), // slight extra, trimmed at concat
        '-r', String(FPS), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        stillClipPath,
      ], `freeze: create still video (${padDuration.toFixed(1)}s)`);

      // Step D: Concatenate original + still using concat demuxer, trim to target
      fs.writeFileSync(concatListPath, `file '${normalizedOrigPath}'\nfile '${stillClipPath}'\n`);
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-t', String(targetDuration),
        '-movflags', '+faststart',
        outputPath,
      ], `freeze: concat orig+still (total ${targetDuration.toFixed(1)}s)`);

      // Cleanup temp files
      try { fs.unlinkSync(lastFramePath); } catch {}
      try { fs.unlinkSync(stillClipPath); } catch {}
      try { fs.unlinkSync(normalizedOrigPath); } catch {}
      try { fs.unlinkSync(concatListPath); } catch {}

      return;
    } else {
      // B-ROLL or PASSIVE SCENE (Instagram/social): loop to fill time
      console.log(`[Compositor] Clip ${clipDuration.toFixed(1)}s < target ${targetDuration.toFixed(1)}s — looping to fill`);
      return runFfmpeg([
        '-y',
        '-stream_loop', '-1',  // Loop input indefinitely
        '-i', inputPath,
        '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-t', String(targetDuration),
        '-r', String(FPS),
        '-pix_fmt', 'yuv420p',
        '-an',
        '-movflags', '+faststart',
        outputPath,
      ], `normalizing b-roll clip (looped to fill ${targetDuration.toFixed(1)}s)`);
    }
  }

  // Default: trim to target at normal speed
  return runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-t', String(targetDuration),
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outputPath,
  ], `normalizing clip (trim at 1x speed)`);
}

/**
 * Concatenate multiple b-roll video clips into a single clip, trimmed to target duration.
 * Used when a b-roll segment needs more than 8s and multiple Veo clips were generated.
 */
async function concatBrollClips(sourcePaths, outputPath, targetDuration, workDir, index) {
  // First normalize each individual clip to 1920x1080
  const normalizedParts = [];
  for (let j = 0; j < sourcePaths.length; j++) {
    const partPath = path.join(workDir, `broll_part_${index}_${j}.mp4`);
    await runFfmpeg([
      '-y',
      '-i', sourcePaths[j],
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      partPath,
    ], `normalizing b-roll part ${j}`);
    normalizedParts.push(partPath);
  }

  // Build concat file
  const concatFile = path.join(workDir, `broll_concat_${index}.txt`);
  const concatContent = normalizedParts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  // Concatenate and trim to target duration
  const concatPath = path.join(workDir, `broll_joined_${index}.mp4`);
  await runFfmpeg([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-t', String(targetDuration),
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outputPath,
  ], `concatenating ${sourcePaths.length} b-roll clips (${targetDuration}s)`);

  // Clean up intermediate files
  for (const p of normalizedParts) safeDelete(p);
  safeDelete(concatFile);

  console.log(`[Compositor] Concatenated ${sourcePaths.length} b-roll clips → ${targetDuration}s`);
}

/**
 * Apply an animated logo overlay to the intro clip: [Brand Logo] + [Salesforce Logo]
 *
 * The overlay elements fade in sequentially, hold, then all fade out:
 *   - 3s: semi-transparent scrim bar fades in (1s fade)
 *   - 4s: brand logo fades in (0.8s fade)
 *   - 5s: "+" symbol fades in (0.5s fade)
 *   - 6s: Salesforce logo fades in (0.8s fade)
 *   - Hold until fadeOutStart (last 1.5s of clip)
 *   - All elements fade out together (1s fade)
 *
 * The scrim bar colour adapts to the brand logo:
 *   - Dark/black logo → semi-transparent WHITE scrim
 *   - Light/white logo → semi-transparent BLACK scrim (default)
 *
 * Layout (centered horizontally and vertically):
 *   ┌─────────────────────────────────────────┐
 *   │           semi-transparent scrim         │
 *   │     [Brand Logo]  +  [SF Logo]          │
 *   │           semi-transparent scrim         │
 *   └─────────────────────────────────────────┘
 */
async function applyIntroLogoOverlay(inputPath, outputPath, brandLogoUrl, workDir) {
  // Download brand logo
  const brandLogoPath = path.join(workDir, 'brand_logo.png');
  console.log(`[Compositor] Downloading brand logo: ${brandLogoUrl.substring(0, 80)}...`);

  const resp = await fetch(brandLogoUrl);
  if (!resp.ok) throw new Error(`Failed to download brand logo: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(brandLogoPath, buffer);
  console.log(`[Compositor] Brand logo downloaded: ${(buffer.length / 1024).toFixed(0)}KB`);

  // Salesforce logo and plus symbols — located at the app root
  const appRoot = path.join(__dirname, '..', '..');
  const sfLogoPath = path.join(appRoot, 'sflogo.png');
  const plusPathWhite = path.join(appRoot, 'plus_symbol.png');       // white "+" for black scrim
  const plusPathBlack = path.join(appRoot, 'plus_symbol_black.png'); // black "+" for white scrim

  if (!fs.existsSync(sfLogoPath)) {
    throw new Error(`Salesforce logo not found at ${sfLogoPath}`);
  }
  if (!fs.existsSync(plusPathWhite)) {
    throw new Error(`Plus symbol (white) not found at ${plusPathWhite}`);
  }

  // ── Detect brand logo brightness to choose scrim colour ──
  // Sample the brand logo to determine if it's dark or light.
  // Dark logos need a white/light scrim; light logos need a black/dark scrim.
  let scrimColor = 'black';
  let scrimOpacity = 0.5;
  try {
    // Use FFmpeg to get mean brightness via signalstats filter
    const statsOutput = execSync(
      `${FFMPEG_PATH} -i "${brandLogoPath}" -vf "format=gray,scale=8:8" -f rawvideo -pix_fmt gray -frames:v 1 pipe:1 2>/dev/null`,
      { encoding: 'latin1', timeout: 10000, maxBuffer: 1024 }
    );
    // statsOutput is binary — each byte is a pixel brightness (0-255)
    let totalBrightness = 0;
    let pixelCount = 0;
    for (let i = 0; i < statsOutput.length; i++) {
      totalBrightness += statsOutput.charCodeAt(i);
      pixelCount++;
    }
    const avgBrightness = pixelCount > 0 ? Math.round(totalBrightness / pixelCount) : 128;
    console.log(`[Compositor] Brand logo avg brightness: ${avgBrightness}/255 (${pixelCount} samples)`);
    if (avgBrightness < 100) {
      // Dark logo → use white scrim so the logo is visible
      scrimColor = 'white';
      scrimOpacity = 0.45;
      console.log('[Compositor] Using WHITE scrim (dark brand logo detected)');
    } else {
      console.log('[Compositor] Using BLACK scrim (light brand logo detected)');
    }
  } catch (err) {
    console.warn(`[Compositor] Brightness detection failed (using default black scrim): ${err.message}`);
  }

  // Choose plus symbol colour to contrast with scrim:
  // Black scrim → white plus, White scrim → black plus
  const plusPath = (scrimColor === 'white' && fs.existsSync(plusPathBlack)) ? plusPathBlack : plusPathWhite;
  console.log(`[Compositor] Using ${scrimColor === 'white' ? 'BLACK' : 'WHITE'} plus symbol`);

  // ── Get intro clip duration to adapt timing ──
  let clipDuration = 10;
  try {
    const probeOut = execSync(
      `${FFMPEG_PATH} -i "${inputPath}" 2>&1`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (durMatch) {
      clipDuration = parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
    }
  } catch (err) {
    // FFmpeg returns non-zero exit code when only probing — parse stderr from err.stderr or err.stdout
    const output = (err.stderr || err.stdout || '').toString();
    const durMatch = output.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (durMatch) {
      clipDuration = parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
    } else {
      console.warn(`[Compositor] Could not probe intro duration, using ${clipDuration}s default`);
    }
  }
  console.log(`[Compositor] Intro clip duration: ${clipDuration.toFixed(1)}s`);

  // ── Timing ──
  // Ideal timing: scrim@3s → brand@4s → plus@5s → SF@6s → hold 4s → fadeOut@~10s
  // For shorter clips, scale timings proportionally so everything fits.
  let scrimFadeIn, brandFadeIn, plusFadeIn, sfFadeIn;
  let scrimFadeDur, logoFadeDur, plusFadeDur, fadeOutDur, fadeOutStart;

  if (clipDuration >= 10) {
    // Full timing — clip is long enough
    scrimFadeIn = 3.0;
    brandFadeIn = 4.0;
    plusFadeIn  = 5.0;
    sfFadeIn    = 6.0;
    scrimFadeDur = 1.0;
    logoFadeDur  = 0.8;
    plusFadeDur   = 0.5;
    fadeOutDur = 1.0;
    fadeOutStart = clipDuration - 1.5;
  } else {
    // Compressed timing for short clips — scale to fit within clip duration
    // Reserve 1s at the end for fade-out, 1s at the start for clean intro
    const available = clipDuration - 2.0; // leave 1s start margin + 1s end margin
    const spacing = Math.max(0.5, available / 5); // divide available time across 4 fade-ins + 1 hold
    scrimFadeIn = 1.0;
    brandFadeIn = scrimFadeIn + spacing;
    plusFadeIn  = brandFadeIn + spacing;
    sfFadeIn    = plusFadeIn + spacing;
    scrimFadeDur = Math.min(0.8, spacing);
    logoFadeDur  = Math.min(0.6, spacing);
    plusFadeDur   = Math.min(0.4, spacing);
    fadeOutDur = Math.min(0.8, clipDuration * 0.1);
    fadeOutStart = clipDuration - 1.0;
  }

  console.log(`[Compositor] Overlay timing — scrim:${scrimFadeIn.toFixed(1)}s brand:${brandFadeIn.toFixed(1)}s plus:${plusFadeIn.toFixed(1)}s sf:${sfFadeIn.toFixed(1)}s fadeOut:${fadeOutStart.toFixed(1)}s (clip: ${clipDuration.toFixed(1)}s)`);

  // ── Filter sizing ──
  const logoMaxW = 200;
  const logoMaxH = 140;
  const plusSize = 40;
  const plusGap = 80;    // gap between each logo edge and the "+" symbol
  const scrimH = 220;

  // ── Build the FFmpeg filter_complex ──
  //
  // Strategy: We overlay each element using the `enable` filter to control when
  // it appears, and use fade-in/fade-out on each overlay's alpha channel.
  //
  // For the scrim: we create a solid colour rectangle and apply alpha fade.
  // For each logo/plus: we fade the overlay's alpha.

  // Calculate centered layout: [brand logo] ─ gap ─ [+] ─ gap ─ [SF logo]
  const totalLayoutW = logoMaxW + plusGap + plusSize + plusGap + logoMaxW;
  const layoutStartX = Math.round((WIDTH - totalLayoutW) / 2);
  const brandX = layoutStartX;
  const plusX = layoutStartX + logoMaxW + plusGap;
  const sfX = plusX + plusSize + plusGap;

  console.log(`[Compositor] Logo layout: totalW=${totalLayoutW}, startX=${layoutStartX}, brandX=${brandX}, plusX=${plusX}, sfX=${sfX}`);

  const filterComplex = [
    // Scale brand logo, pad to box, apply alpha fade-in then fade-out
    `[1:v]scale=${logoMaxW}:${logoMaxH}:force_original_aspect_ratio=decrease,pad=${logoMaxW}:${logoMaxH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,fade=t=in:st=${brandFadeIn}:d=${logoFadeDur}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOutDur}:alpha=1[brand]`,

    // Scale SF logo, pad, alpha fade
    `[2:v]scale=${logoMaxW}:${logoMaxH}:force_original_aspect_ratio=decrease,pad=${logoMaxW}:${logoMaxH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,fade=t=in:st=${sfFadeIn}:d=${logoFadeDur}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOutDur}:alpha=1[sf]`,

    // Scale plus symbol, alpha fade
    `[3:v]scale=${plusSize}:${plusSize}:force_original_aspect_ratio=decrease,pad=${plusSize}:${plusSize}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,fade=t=in:st=${plusFadeIn}:d=${plusFadeDur}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOutDur}:alpha=1[plus]`,

    // Create the scrim bar: a solid colour image the same duration as the video,
    // with alpha fade-in and fade-out. We use `color` source + crop to get the right size.
    `color=c=${scrimColor}@${scrimOpacity}:s=${WIDTH}x${scrimH}:d=${clipDuration},format=rgba,fade=t=in:st=${scrimFadeIn}:d=${scrimFadeDur}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOutDur}:alpha=1[scrim]`,

    // Overlay scrim onto video (centered vertically)
    `[0:v][scrim]overlay=x=0:y=(H-h)/2:shortest=1[withscrim]`,

    // Overlay brand logo (left side of centered layout)
    `[withscrim][brand]overlay=x=${brandX}:y=(H-${logoMaxH})/2:shortest=1[withbrand]`,

    // Overlay plus symbol (centered between logos with equal gaps)
    `[withbrand][plus]overlay=x=${plusX}:y=(H-${plusSize})/2:shortest=1[withplus]`,

    // Overlay SF logo (right side of centered layout)
    `[withplus][sf]overlay=x=${sfX}:y=(H-${logoMaxH})/2:shortest=1[out]`,
  ].join(';');

  const durStr = String(Math.ceil(clipDuration));
  await runFfmpeg([
    '-y',
    '-i', inputPath,                                    // input 0: intro video
    '-loop', '1', '-t', durStr, '-i', brandLogoPath,   // input 1: brand logo (looped to video length)
    '-loop', '1', '-t', durStr, '-i', sfLogoPath,      // input 2: SF logo (looped)
    '-loop', '1', '-t', durStr, '-i', plusPath,         // input 3: plus symbol (looped)
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '0:a?',   // preserve audio if present
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], 'intro logo overlay (animated)');

  // Cleanup downloaded logo
  safeDelete(brandLogoPath);
}

/**
 * Create a video from a still image with a smooth, slow zoom effect.
 *
 * Instead of FFmpeg's `zoompan` filter (which produces sub-pixel jitter),
 * this uses a loop input + scale + crop pipeline:
 *   1. Loop the image for the needed duration
 *   2. Scale it UP by 15% (so we have room to "zoom in")
 *   3. Crop a 1920x1080 window from the center that slowly shrinks
 *      (simulating a slow zoom-in)
 *
 * The result is a perfectly smooth zoom with no jitter.
 */
function imageToVideo(imagePath, outputPath, duration) {
  // Use -loop 1 to create a video stream from the image, then apply
  // a slow animated crop that gets smaller over time (= zoom in effect).
  // Scale the source up first so the crop region can shrink smoothly.
  //
  // Formula: crop starts at full 1920x1080, ends at ~88% (1689x950).
  // This creates a ~14% zoom-in over the clip duration.
  const totalFrames = Math.ceil(duration * FPS);
  const startW = WIDTH;           // 1920
  const endW = Math.round(WIDTH * 0.86);  // ~1651
  const startH = HEIGHT;          // 1080
  const endH = Math.round(HEIGHT * 0.86); // ~929

  // Animate the crop: linearly interpolate from start to end size
  // n = current frame, ${totalFrames} = total frames
  // Scale image up first so we have pixel headroom for the shrinking crop
  const scaleUp = `scale=${Math.round(WIDTH * 1.15)}:${Math.round(HEIGHT * 1.15)}`;
  const cropFilter = `crop='${startW}-((${startW}-${endW})*n/${totalFrames})':'${startH}-((${startH}-${endH})*n/${totalFrames})'`;
  const scaleBack = `scale=${WIDTH}:${HEIGHT}`;

  return runFfmpeg([
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-vf', `${scaleUp},${cropFilter},${scaleBack},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-t', String(duration),
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], `image→video (smooth zoom)`);
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
 * Overlay voiceover audio onto a video, optionally mixing with background music.
 * Uses the LONGER of the two audio streams so narration never gets cut off.
 * Background music is mixed at low volume (-18dB) and looped to fill the video.
 */
async function overlayAudio(videoPath, audioPath, outputPath, onProgress, musicPath) {
  const audioDur = await getAudioDuration(audioPath);
  const videoDur = await getVideoDuration(videoPath);
  const targetDuration = Math.max(videoDur, audioDur + 1.0);
  console.log(`[FFmpeg] Audio overlay: video=${videoDur.toFixed(1)}s, audio=${audioDur.toFixed(1)}s, music=${musicPath ? 'yes' : 'no'}`);

  if (musicPath && fs.existsSync(musicPath)) {
    // Mix voiceover + background music using amix filter
    // Voiceover at full volume, music at ~12% volume (subtle background)
    return runFfmpeg([
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex',
      '[1:a]volume=1.0[voice];[2:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=3[aout]',
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(Math.ceil(targetDuration)),
      '-movflags', '+faststart',
      outputPath,
    ], 'audio overlay + music mix');
  } else {
    // Voiceover only (no background music)
    return runFfmpeg([
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0',
      '-t', String(Math.ceil(targetDuration)),
      '-movflags', '+faststart',
      outputPath,
    ], 'audio overlay (voiceover only)');
  }
}

/**
 * Overlay only background music (no voiceover) onto a video.
 */
function overlayMusicOnly(videoPath, musicPath, outputPath, onProgress) {
  return runFfmpeg([
    '-y',
    '-i', videoPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', '[1:a]volume=0.3[music]',
    '-map', '0:v:0',
    '-map', '[music]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ], 'music-only overlay');
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

module.exports = { composeVideo, applyIntroLogoOverlay, normalizeVideoClip };
