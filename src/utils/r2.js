const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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

  let fileBody = body;
  if (typeof body === 'string' && fs.existsSync(body)) {
    fileBody = fs.readFileSync(body);
  }

  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileBody,
    ContentType: contentType,
  }));

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
  const prefix = `videos/${userId}/${videoId}`;
  const result = {};

  if (files.videoPath) {
    result.videoUrl = await uploadFile(
      `${prefix}/video.mp4`,
      files.videoPath,
      'video/mp4'
    );
  }

  if (files.thumbnailPath) {
    result.thumbnailUrl = await uploadFile(
      `${prefix}/thumbnail.jpg`,
      files.thumbnailPath,
      'image/jpeg'
    );
  }

  if (files.voiceoverPath) {
    result.voiceoverUrl = await uploadFile(
      `${prefix}/voiceover.mp3`,
      files.voiceoverPath,
      'audio/mpeg'
    );
  }

  return result;
}

module.exports = {
  uploadFile,
  getPresignedUrl,
  deleteFile,
  uploadVideoAssets,
};
