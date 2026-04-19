const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey() {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key) throw new Error('APP_ENCRYPTION_KEY environment variable not set');
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt a string with AES-256-GCM
 * @param {string} plaintext
 * @returns {{ encrypted: string, iv: string, tag: string }}
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt a string encrypted with AES-256-GCM
 * @param {string} encrypted - hex-encoded ciphertext
 * @param {string} iv - hex-encoded initialization vector
 * @param {string} tag - hex-encoded auth tag
 * @returns {string} plaintext
 */
function decrypt(encrypted, iv, tag) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
