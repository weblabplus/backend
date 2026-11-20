// ============================================================
// Φόρτωση περιβάλλοντος — ΠΡΕΠΕΙ να είναι το πρώτο import του server.
//
// Στο CommonJS τα `require()` των imports εκτελούνται με τη σειρά που
// εμφανίζονται, πριν από οποιαδήποτε άλλη εντολή του αρχείου. Επειδή το
// `lab-repo-config` διαβάζει το Api-Key κατά τη φόρτωση του module, χωρίς
// αυτό το αρχείο το key θα ήταν `undefined` και κάθε κλήση θα έπαιρνε 401.
// ============================================================

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '..', '..', '..', '.env.local') });

/** Api-Key του Lab Data Repository όπως υπάρχει στο .env (πριν το DB override) */
export const BOOT_LAB_REPO_API_KEY = (
  process.env.LAB_REPO_API_KEY ||
  process.env.EFULFILLMENT_API_KEY ||
  ''
).trim();

/** Api-Key του E-Fulfillment όπως υπάρχει στο .env (πριν το DB override) */
export const BOOT_EFULFILLMENT_API_KEY = (process.env.EFULFILLMENT_API_KEY || '').trim();
