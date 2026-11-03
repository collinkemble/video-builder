/**
 * Video Builder storage functions, built on the provider-neutral helper (./storage.js).
 * STORAGE_PROVIDER=r2 (default) or s3. All writes/deletes are limited to videos/ (own prefix).
 * Function names are unchanged so existing callers keep working.
 */
const fs = require('fs');
const storage = require('./storage');

/**
 * Upload a file (Buffer, or path to a local file) to an exact key. Returns the public URL.
 * Files over 5MB are streamed to reduce memory pressure.
 */
async function uploadFile(key, body, contentType) {
  const start = Date.now();
  let fileBody = body;
  let size = 0;
  let stream = false;

  if (typeof body === 'string' && fs.existsSync(body)) {
    size = fs.statSync(body).size;
    if (size > 5 * 1024 * 1024) { fileBody = fs.createReadStream(body); stream = true; }
    else fileBody = fs.readFileSync(body);
  }
  if (!stream && !Buffer.isBuffer(fileBody)) fileBody = Buffer.from(fileBody);
  if (!stream) size = fileBody.length;

  console.log(`[storage] Uploading key=${key} size=${(size / 1024 / 1024).toFixed(1)}MB type=${contentType}${stream ? ' (streaming)' : ''}`);
  const url = await storage.putObject(key, fileBody, contentType, {
    contentLength: size, cacheControl: 'public, max-age=31536000',
  });
  if (stream && fileBody.destroy) fileBody.destroy();

  const head = await storage.headObject(key);
  if (head) console.log(`[storage] ✅ Verified ${key} (${head.ContentLength} bytes) in ${Date.now() - start}ms`);
  else console.warn(`[storage] ⚠️ Could not verify ${key} after upload`);
  return url;
}

const getPresignedUrl = (key, expiresIn = 3600) => storage.getPresignedUrl(key, expiresIn);
const deleteFile = key => storage.deleteKey(key);

/** Upload video, thumbnail and voiceover. Timestamped keys so regenerations get fresh URLs. */
async function uploadVideoAssets(userId, videoId, files) {
  const ts = Date.now();
  const prefix = `videos/${userId}/${videoId}`;
  const result = {};
  if (files.videoPath) result.videoUrl = await uploadFile(`${prefix}/video_${ts}.mp4`, files.videoPath, 'video/mp4');
  if (files.thumbnailPath) result.thumbnailUrl = await uploadFile(`${prefix}/thumbnail_${ts}.jpg`, files.thumbnailPath, 'image/jpeg');
  if (files.voiceoverPath) result.voiceoverUrl = await uploadFile(`${prefix}/voiceover_${ts}.mp3`, files.voiceoverPath, 'audio/mpeg');
  console.log(`[storage] uploadVideoAssets done for ${userId}/${videoId}`);
  return result;
}

/**
 * Delete a video's generated files before a regeneration. Keeps what the USER provided and the
 * new render still needs: persona images and uploaded custom-scene files (custom_*).
 */
async function deleteVideoAssets(userId, videoId) {
  const keys = (await storage.listKeys(`videos/${userId}/${videoId}/`)).filter(k => !k.includes('/persona_') && !/\/custom_[^/]*$/.test(k));
  const n = await storage.deleteKeys(keys);
  console.log(`[storage] Cleaned up ${n} files for video ${userId}/${videoId}`);
  return n;
}

/** Upload individual segment clips for selective regeneration. Returns { order: url }. */
async function uploadSegmentClips(userId, videoId, clips) {
  const ts = Date.now();
  const prefix = `videos/${userId}/${videoId}/segments`;
  const result = {};
  for (const { order, clipPath } of clips) {
    if (!clipPath || !fs.existsSync(clipPath)) continue;
    try { result[order] = await uploadFile(`${prefix}/clip_${order}_${ts}.mp4`, clipPath, 'video/mp4'); }
    catch (err) { console.warn(`[storage] Failed to upload segment clip ${order}: ${err.message}`); }
  }
  console.log(`[storage] Uploaded ${Object.keys(result).length}/${clips.length} segment clips`);
  return result;
}

/** Download a URL (public or presigned) to a local path. */
async function downloadFile(url, outputPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  fs.writeFileSync(outputPath, Buffer.from(await resp.arrayBuffer()));
  return outputPath;
}

/**
 * Download an asset to a local file. Files in this app's storage are read directly from the
 * bucket (not via the public URL), so access rules on the public URL can't block the render.
 * A missing file throws an error with code 'ASSET_MISSING'.
 */
async function downloadAsset(url, outputPath) {
  const key = storage.isStorageUrl(url) ? storage.urlToKey(url) : null;
  if (key) {
    try {
      const { buffer } = await storage.getObjectBuffer(key);
      fs.writeFileSync(outputPath, buffer);
      return outputPath;
    } catch (err) {
      const missing = err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404));
      if (missing) { const e = new Error('file is no longer in storage'); e.code = 'ASSET_MISSING'; throw e; }
      console.warn(`[storage] Direct read of ${key} failed (${err.message}) — trying the public URL`);
    }
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    const e = new Error(`download failed (HTTP ${resp.status})`);
    if (resp.status === 403 || resp.status === 404) e.code = 'ASSET_MISSING';
    throw e;
  }
  fs.writeFileSync(outputPath, Buffer.from(await resp.arrayBuffer()));
  return outputPath;
}

/** User-facing message for a custom scene whose file can't be loaded. */
function customAssetError(order, err) {
  return err && err.code === 'ASSET_MISSING'
    ? `The uploaded file for the custom scene in section ${order} is missing. Please upload it again in that section, then regenerate.`
    : `Could not load the uploaded file for the custom scene in section ${order}: ${err.message}`;
}

module.exports = {
  uploadFile, getPresignedUrl, deleteFile, uploadVideoAssets, deleteVideoAssets, uploadSegmentClips, downloadFile,
  downloadAsset, customAssetError,
  // pass-throughs for callers that need the generic helper
  isStorageUrl: storage.isStorageUrl, urlToKey: storage.urlToKey, isConfigured: storage.isConfigured,
  assertNoEmbeddedImages: storage.assertNoEmbeddedImages,
};
