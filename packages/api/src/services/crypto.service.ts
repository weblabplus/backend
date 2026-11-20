// ============================================================
// Κρυπτογράφηση credentials (AES-256-GCM at rest)
// Χρησιμοποιείται για τα username/password του e-Prescription.
// ============================================================

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const material =
    process.env.EFULFILLMENT_ENCRYPTION_KEY ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.JWT_SECRET;

  if (!material) {
    throw new Error('Δεν έχει οριστεί EFULFILLMENT_ENCRYPTION_KEY (ή BETTER_AUTH_SECRET)');
  }

  // Σταθερό παράγωγο κλειδί 32 bytes από το secret
  return crypto.createHash('sha256').update(`medilab:efulfillment:${material}`).digest();
}

/** Επιστρέφει base64(iv | tag | ciphertext) */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Μη έγκυρο κρυπτογραφημένο περιεχόμενο');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
