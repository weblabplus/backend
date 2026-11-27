// ============================================================
// Booking links — προσωπικό link online ραντεβού ανά χρήστη
//
// Κάθε χρήστης έχει ένα αδιαφανές token· το link είναι
// <booking-app>?ref=<token>. Όταν ολοκληρωθεί κράτηση από αυτό το link,
// το bookingId αντιστοιχίζεται στον χρήστη ώστε ο συγχρονισμός να το
// καταχωρεί στο δικό του ημερολόγιο (doctorId).
// ============================================================

import * as crypto from 'crypto';
import { dbService } from '../db/db.service';

const TOKEN_PREFIX = 'BOOKING_LINK_TOKEN:'; // uid  → token
const OWNER_PREFIX = 'BOOKING_LINK_OWNER:'; // token → uid
const ATTR_PREFIX = 'BOOKING_ATTR:'; // bookingId → uid
const CLINIC_NAME_KEY = 'BOOKING_CLINIC_NAME';

/** Προεπιλεγμένο όνομα μονάδας όταν δεν έχει οριστεί στη βάση. */
export const DEFAULT_CLINIC_NAME = 'Medisend';

function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/** Επιστρέφει το token του χρήστη (το δημιουργεί αν λείπει). */
export async function getOrCreateBookingToken(uid: string): Promise<string> {
  if (!uid) throw new Error('Απαιτείται uid');

  const existing = await dbService.getSetting(`${TOKEN_PREFIX}${uid}`);
  if (existing) {
    // Επαναφέρουμε και το αντίστροφο ευρετήριο αν λείπει (π.χ. μετά από restore).
    const owner = await dbService.getSetting(`${OWNER_PREFIX}${existing}`);
    if (owner !== uid) {
      await dbService.setSetting(`${OWNER_PREFIX}${existing}`, uid);
    }
    return existing;
  }

  const token = newToken();
  await dbService.setSetting(`${TOKEN_PREFIX}${uid}`, token);
  await dbService.setSetting(`${OWNER_PREFIX}${token}`, uid);
  return token;
}

/** Ανανεώνει το token (το παλιό link παύει να ισχύει). */
export async function rotateBookingToken(uid: string): Promise<string> {
  const previous = await dbService.getSetting(`${TOKEN_PREFIX}${uid}`);
  if (previous) {
    await dbService.deleteSetting(`${OWNER_PREFIX}${previous}`);
  }

  const token = newToken();
  await dbService.setSetting(`${TOKEN_PREFIX}${uid}`, token);
  await dbService.setSetting(`${OWNER_PREFIX}${token}`, uid);
  return token;
}

/** token → uid (null αν δεν υπάρχει). */
export async function resolveBookingToken(token: string): Promise<string | null> {
  const clean = String(token || '').trim();
  if (!clean) return null;
  return dbService.getSetting(`${OWNER_PREFIX}${clean}`);
}

/**
 * Καταγράφει ότι το booking δημιουργήθηκε από το link του χρήστη.
 * Επιστρέφει το uid ή null αν το token δεν είναι έγκυρο.
 */
export async function attributeBooking(
  token: string,
  bookingId: string
): Promise<string | null> {
  const uid = await resolveBookingToken(token);
  if (!uid) return null;

  const id = String(bookingId || '').trim();
  if (!id) return null;

  const key = `${ATTR_PREFIX}${id}`;
  const existing = await dbService.getSetting(key);
  if (existing) return existing;

  await dbService.setSetting(key, uid);
  return uid;
}

/** Ποιος χρήστης «κλείστηκε» το συγκεκριμένο booking (αν είναι γνωστό). */
export async function getBookingOwner(bookingId: string): Promise<string | null> {
  const id = String(bookingId || '').trim();
  if (!id) return null;
  return dbService.getSetting(`${ATTR_PREFIX}${id}`);
}

// ── Όνομα μονάδας (branding του booking app) ──

/** Το όνομα της μονάδας που εμφανίζεται στο booking app (fallback). */
export async function getClinicName(): Promise<string> {
  const value = await dbService.getSetting(CLINIC_NAME_KEY);
  const name = (value || '').trim();
  return name || DEFAULT_CLINIC_NAME;
}

/**
 * Όνομα μονάδας για τον ιδιοκτήτη του link, όπως το έχει φέρει το
 * e-Prescription («Στοιχεία Φορέα»):
 *   1. Μονάδα / Φορέας (organizationName)
 *   2. Ονοματεπώνυμο (fullName)
 *   3. Fallback ρύθμιση / default
 */
export async function getClinicNameForUser(uid: string): Promise<string> {
  try {
    const profile = await dbService.getUserProfile(uid);
    const state = await dbService.getEfulfillmentState(profile?.id || profile?.uid || uid);
    const data = state.profile || {};

    const organizationName =
      typeof data.organizationName === 'string' ? data.organizationName.trim() : '';
    if (organizationName) return organizationName;

    const fullName = typeof data.fullName === 'string' ? data.fullName.trim() : '';
    if (fullName) return fullName;

    const combined = [data.firstName, data.lastName]
      .filter((part: unknown): part is string => typeof part === 'string' && Boolean(part.trim()))
      .join(' ')
      .trim();
    if (combined) return combined;
  } catch {
    // Χωρίς e-Prescription credentials → fallback
  }

  return getClinicName();
}
