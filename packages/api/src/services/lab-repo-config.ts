// ============================================================
// Lab Data Repository — κοινή διαμόρφωση
//
// Το Api-Key διαβάζεται **από το περιβάλλον κατά τη φόρτωση του module**
// (πριν το `dbService.loadSettingsIntoEnv('EFULFILLMENT_')` αντικαταστήσει
// το `process.env.EFULFILLMENT_API_KEY` με την τιμή της βάσης).
//
// Τα διαπιστευτήρια (username/password) είναι **τα ίδια με του φορέα** και
// διαβάζονται από τη βάση (`user_efulfillment`), ώστε να μη χρειάζεται
// hardcoded τιμή. Λάθος κωδικός → επαναλαμβανόμενα 401 → κλείδωμα λογαριασμού.
// ============================================================

import { dbService } from '../db/db.service';
import { BOOT_LAB_REPO_API_KEY } from '../env';

/** Api-Key όπως υπάρχει στο .env κατά την εκκίνηση (πριν το DB override) */
const BOOT_API_KEY = BOOT_LAB_REPO_API_KEY;

const BASE_URL = (
  process.env.LAB_REPO_BASE_URL ||
  'https://testeps.e-prescription.gr/labdatarepository'
).replace(/\/+$/, '');

/** Εφεδρικά διαπιστευτήρια (μόνο αν δεν υπάρχουν αποθηκευμένα στη βάση) */
const FALLBACK_USERNAME = process.env.LAB_REPO_USERNAME || '';
const FALLBACK_PASSWORD = process.env.LAB_REPO_PASSWORD || '';

/** Api-Key εφαρμογής για το Lab Data Repository */
export function labRepoApiKey(): string {
  return overrideApiKey || BOOT_API_KEY;
}

/** Live override (από τη βάση / admin UI) — υπερισχύει του .env */
let overrideApiKey = '';

export function setLabRepoApiKey(key: string | null): void {
  overrideApiKey = (key || '').trim();
}

export const LAB_REPO_API_KEY_SETTING = 'LAB_REPO_API_KEY';

/** Φόρτωση του Api-Key από τη βάση (αν έχει οριστεί από admin) */
export async function loadLabRepoApiKeyFromDb(): Promise<string | null> {
  const stored = await dbService.getSetting(LAB_REPO_API_KEY_SETTING).catch(() => null);
  if (stored) setLabRepoApiKey(stored);
  return stored;
}

export async function saveLabRepoApiKey(key: string): Promise<void> {
  await dbService.setSetting(LAB_REPO_API_KEY_SETTING, key.trim());
  setLabRepoApiKey(key);
}

/** Μασκαρισμένη ένδειξη του ενεργού key, για το UI */
export function maskedLabRepoApiKey(): string {
  const k = labRepoApiKey();
  if (!k) return '(κενό)';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Από πού προέρχεται το ενεργό key */
export function labRepoApiKeySource(): 'database' | 'env' | 'none' {
  if (overrideApiKey) return 'database';
  return BOOT_API_KEY ? 'env' : 'none';
}

export const LAB_REPO_BASE_URL = BASE_URL;

export interface LabRepoCredentials {
  username: string;
  password: string;
}

/**
 * Διαπιστευτήρια που έχουν επιλυθεί τελευταία φορά (cache για συναρτήσεις
 * χωρίς πρόσβαση σε userId, π.χ. master data sync).
 */
let cachedCredentials: LabRepoCredentials | null = null;

export function setLabRepoCredentials(credentials: LabRepoCredentials | null): void {
  cachedCredentials = credentials;
}

export function labRepoAuthHeaders(credentials?: LabRepoCredentials): Record<string, string> {
  const c =
    credentials ??
    cachedCredentials ??
    (FALLBACK_USERNAME && FALLBACK_PASSWORD
      ? { username: FALLBACK_USERNAME, password: FALLBACK_PASSWORD }
      : null);

  if (!c) {
    throw new Error(
      'Δεν βρέθηκαν διαπιστευτήρια φορέα για το Lab Data Repository — συνδεθείτε από τις Ρυθμίσεις'
    );
  }

  return {
    Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`,
    'Api-Key': labRepoApiKey(),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Διαγνωστική: επιστρέφει ΠΟΙΟ username χρησιμοποιείται (χωρίς password)
 * και από πού προήλθε, ώστε να συγκριθεί με το Postman.
 */
export async function describeLabRepoCredentials(userId?: string): Promise<{
  username: string | null;
  source: 'env' | 'database' | 'none';
  passwordLength: number;
  apiKeyTail: string;
}> {
  if (FALLBACK_USERNAME && FALLBACK_PASSWORD) {
    return {
      username: FALLBACK_USERNAME,
      source: 'env',
      passwordLength: FALLBACK_PASSWORD.length,
      apiKeyTail: `…${labRepoApiKey().slice(-4)}`,
    };
  }
  if (userId) {
    const creds = await dbService.getEfulfillmentCredentials(userId).catch(() => null);
    if (creds?.username && creds?.password) {
      return {
        username: creds.username,
        source: 'database',
        passwordLength: creds.password.length,
        apiKeyTail: `…${labRepoApiKey().slice(-4)}`,
      };
    }
  }
  return { username: null, source: 'none', passwordLength: 0, apiKeyTail: `…${labRepoApiKey().slice(-4)}` };
}

/**
 * Επίλυση διαπιστευτηρίων για το Lab Data Repository.
 *
 * Προτεραιότητα:
 *  1. `LAB_REPO_USERNAME` / `LAB_REPO_PASSWORD` από το περιβάλλον — ρητή ρύθμιση
 *     για το Lab Data Repository, όταν διαφέρουν από του e-Prescription.
 *  2. Αποθηκευμένα διαπιστευτήρια φορέα (`user_efulfillment`) — ίδια με το
 *     e-Prescription, όπως τα έχει δώσει ο χρήστης.
 *
 * @param userId όταν δοθεί, χρησιμοποιούνται τα δικά του διαπιστευτήρια
 */
export async function resolveLabRepoCredentials(
  userId?: string
): Promise<LabRepoCredentials | null> {
  if (FALLBACK_USERNAME && FALLBACK_PASSWORD) {
    return { username: FALLBACK_USERNAME, password: FALLBACK_PASSWORD };
  }
  if (userId) {
    const creds = await dbService.getEfulfillmentCredentials(userId).catch(() => null);
    if (creds?.username && creds?.password) {
      return { username: creds.username, password: creds.password };
    }
  }
  return null;
}
