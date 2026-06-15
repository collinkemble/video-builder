const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

let s3Client = null;

function getS3Client() {
  if (s3Client) return s3Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }

  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return s3Client;
}

const BUCKET = process.env.R2_BUCKET || 'video-builder';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/**
 * Upload a file to R2
 * @param {string} key - S3 key (e.g. "videos/1/2/video.mp4")
 * @param {Buffer|string} body - File content or path to file
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Public URL
 */
async function uploadFile(key, body, contentType) {
  const client = getS3Client();
  const startTime = Date.now();

  let fileBody = body;
  let fileSize = 0;

  if (typeof body === 'string' && fs.existsSync(body)) {
    // Get file size first for logging
    const stat = fs.statSync(body);
    fileSize = stat.size;
    console.log(`[R2] Reading file: ${body} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    // For files under 50MB, read into buffer (simpler, reliable)
    // For larger files, still read into buffer but log a warning
    if (fileSize > 50 * 1024 * 1024) {
      console.warn(`[R2] ⚠️ Large file upload: ${(fileSize / 1024 / 1024).toFixed(1)}MB — may use significant memory`);
    }
    fileBody = fs.readFileSync(body);
    console.log(`[R2] File read into memory: ${(fileBody.length / 1024 / 1024).toFixed(1)}MB in ${Date.now() - startTime}ms`);
  }

  // Ensure fileBody is a Buffer for reliable upload with explicit ContentLength
  if (!Buffer.isBuffer(fileBody)) {
    fileBody = Buffer.from(fileBody);
  }
  fileSize = fileBody.length;

  console.log(`[R2] Uploading: key=${key}, size=${(fileSize / 1024 / 1024).toFixed(1)}MB, type=${contentType}`);
  const uploadStart = Date.now();

  const putResult = await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileBody,
    ContentType: contentType,
    ContentLength: fileBody.length,
    CacheControl: 'public, max-age=31536000',
  }));

  const uploadDuration = Date.now() - uploadStart;
  console.log(`[R2] PutObject complete: key=${key}, size=${fileBody.length}, etag=${putResult.ETag || 'none'}, status=${putResult.$metadata?.httpStatusCode}, took=${uploadDuration}ms`);

  // Free the buffer immediately after upload to reduce memory pressure
  fileBody = null;

  // Verify the object exists in R2 after upload using HEAD (not GET — avoids re-downloading)
  try {
    const headResult = await client.send(new HeadObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }));
    console.log(`[R2] ✅ Verified object exists: key=${key}, contentLength=${headResult.ContentLength}`);
  } catch (verifyErr) {
    console.warn(`[R2] ⚠️ Object verification FAILED after upload: key=${key}, error=${verifyErr.message}`);
  }

  const totalDuration = Date.now() - startTime;
  console.log(`[R2] ✅ Upload complete: key=${key}, total=${totalDuration}ms`);

  return `${PUBLIC_URL}/${key}`;
}

/**
 * Generate a presigned download URL
 * @param {string} key - S3 key
 * @param {number} expiresIn - Seconds until expiration (default 3600)
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUrl(key, expiresIn = 3600) {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Delete a file from R2
 * @param {string} key - S3 key
 */
async function deleteFile(key) {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
}

/**
 * Upload video assets (video, thumbnail, voiceover)
 * @param {number} userId
 * @param {number} videoId
 * @param {object} files - { videoPath, thumbnailPath, voiceoverPath }
 * @returns {Promise<object>} - { videoUrl, thumbnailUrl, voiceoverUrl }
 */
async function uploadVideoAssets(userId, videoId, files) {
  // Use a timestamp in the R2 key so regenerated videos get a fresh URL.
  // This prevents CDN/browser caches from serving the old video after regeneration.
  const ts = Date.now();
  const prefix = `videos/${userId}/${videoId}`;
  const result = {};

  console.log(`[R2] uploadVideoAssets: starting for video ${userId}/${videoId}`);

  if (files.videoPath) {
    console.log(`[R2] uploadVideoAssets: uploading video...`);
    result.videoUrl = await uploadFile(
      `${prefix}/video_${ts}.mp4`,
      files.videoPath,
      'video/mp4'
    );
    console.log(`[R2] uploadVideoAssets: video uploaded → ${result.videoUrl}`);
  }

  if (files.thumbnailPath) {
    console.log(`[R2] uploadVideoAssets: uploading thumbnail...`);
    result.thumbnailUrl = await uploadFile(
      `${prefix}/thumbnail_${ts}.jpg`,
      files.thumbnailPath,
      'image/jpeg'
    );
    console.log(`[R2] uploadVideoAssets: thumbnail uploaded`);
  }

  if (files.voiceoverPath) {
    console.log(`[R2] uploadVideoAssets: uploading voiceover...`);
    result.voiceoverUrl = await uploadFile(
      `${prefix}/voiceover_${ts}.mp3`,
      files.voiceoverPath,
      'audio/mpeg'
    );
    console.log(`[R2] uploadVideoAssets: voiceover uploaded`);
  }

  console.log(`[R2] uploadVideoAssets: all assets uploaded for video ${userId}/${videoId}`);
  return result;
}

/**
 * Delete all R2 assets for a video (video, thumbnail, voiceover, and any other files under the prefix).
 * @param {number} userId
 * @param {number} videoId
 * @returns {Promise<number>} Number of files deleted
 */
async function deleteVideoAssets(userId, videoId) {
  const client = getS3Client();
  const prefix = `videos/${userId}/${videoId}/`;

  let deleted = 0;
  let continuationToken;

  // List and delete all objects under the video prefix
  do {
    const listResult = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = listResult.Contents || [];

    for (const obj of objects) {
      // Skip persona images — they should persist across regenerations
      if (obj.Key.includes('/persona_')) {
        console.log(`[R2] Skipping persona image: ${obj.Key}`);
        continue;
      }
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: obj.Key,
        }));
        deleted++;
        console.log(`[R2] Deleted: ${obj.Key}`);
      } catch (err) {
        console.warn(`[R2] Failed to delete ${obj.Key}: ${err.message}`);
      }
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`[R2] Cleaned up ${deleted} files for video ${userId}/${videoId}`);
  return deleted;
}

/**
 * Upload individual segment clips to R2 for selective regeneration.
 * @param {number} userId
 * @param {number} videoId
 * @param {Array<{order: number, clipPath: string}>} clips - Array of {order, clipPath}
 * @returns {Promise<object>} Map of order → R2 URL
 */
async function uploadSegmentClips(userId, videoId, clips) {
  const ts = Date.now();
  const prefix = `videos/${userId}/${videoId}/segments`;
  const result = {};

  for (const { order, clipPath } of clips) {
    if (!clipPath || !fs.existsSync(clipPath)) continue;
    try {
      const url = await uploadFile(
        `${prefix}/clip_${order}_${ts}.mp4`,
        clipPath,
        'video/mp4'
      );
      result[order] = url;
    } catch (err) {
      console.warn(`[R2] Failed to upload segment clip ${order}: ${err.message}`);
    }
  }

  console.log(`[R2] Uploaded ${Object.keys(result).length}/${clips.length} segment clips`);
  return result;
}

/**
 * Download a file from a URL to a local path.
 * Works with R2 public URLs and presigned URLs.
 * @param {string} url - URL to download from
 * @param {string} outputPath - Local path to save to
 * @returns {Promise<string>} outputPath
 */
async function downloadFile(url, outputPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

module.exports = {
  uploadFile,
  getPresignedUrl,
  deleteFile,
  uploadVideoAssets,
  deleteVideoAssets,
  uploadSegmentClips,
  downloadFile,
};
