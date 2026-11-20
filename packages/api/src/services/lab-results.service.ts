// ============================================================
// Lab Results Service — «Καταχώρηση Εργαστηριακών Αποτελεσμάτων»
//
// POST /api/results του Lab Data Repository (ΗΔΙΚΑ).
// Καλείται όταν ένα παραπεμπτικό μεταβαίνει σε `completed`, ώστε να
// αποσταλούν τα αποτελέσματα των εξετάσεων στον φορέα.
// ============================================================

import { dbService } from '../db/db.service';
import { labRepoApiKey, labRepoAuthHeaders, LAB_REPO_BASE_URL, resolveLabRepoCredentials, describeLabRepoCredentials, type LabRepoCredentials } from './lab-repo-config';
import { examParameters } from './exam-parameters.service';
import { ensureFreshConnection } from './efulfillment.service';
import type { Exam, ExamParameter, Patient, Referral } from '@medilab/core';

// ── Στοιχεία εργαστηρίου ──
//
// Επωνυμία και ΑΦΜ αντλούνται **αυτόματα** από τα «Στοιχεία Φορέα»
// (`/api/me` → organizationName / afm) που έχει ήδη εισάγει ο χρήστης.
// Ο χρήστης συμπληρώνει μόνο τον κωδικό εγκατάστασης ΕΟΠΥΥ.

export interface LabProfile {
  /** Παράκαμψη επωνυμίας (αν κενό → από Στοιχεία Φορέα) */
  labName?: string;
  /** Παράκαμψη ΑΦΜ (αν κενό → από Στοιχεία Φορέα) */
  vatNumber?: string;
  /** Κωδικός Εγκατάστασης ΕΟΠΥΥ — δεν υπάρχει στο /api/me, άρα πάντα χειροκίνητος */
  licenseNumber?: string;
  /** Εφεδρική ειδικότητα ιατρού, αν το /api/me δεν τη δίνει */
  doctorSpecialty?: string;
}

/** Πλήρη στοιχεία εργαστηρίου, έτοιμα για το payload */
export interface LabIdentity {
  labName: string;
  vatNumber: string;
  licenseNumber: string;
  /** Κωδικοί μονάδας από το /api/me (βοηθητικοί για έλεγχο) */
  examCenterId?: string;
  userUnitId?: string;
  healthCareUnitId?: string;
}

export const LAB_PROFILE_KEY = 'LAB_PROFILE';

// ── Cooldown λόγω acct_locked ──
//
// Ο φορέας κλειδώνει τον λογαριασμό μετά από πολλαπλές αποτυχημένες προσπάθειες.
// Απαιτούνται 30 λεπτά **χωρίς καμία νέα κλήση** και κάθε νέα αποτυχημένη
// προσπάθεια επαναφέρει το χρονόμετρο. Αποθηκεύουμε την ώρα κλειδώματος στη
// βάση ώστε να ισχύει και μετά από restart ή σε άλλες συσκευές.

export const LAB_LOCK_KEY = 'LAB_REPO_LOCK';
export const LOCK_COOLDOWN_MS = 30 * 60 * 1000;

export interface LabRepoLock {
  /** Πότε καταγράφηκε το κλείδωμα (ISO) */
  lockedAt: string;
  /** Πότε επιτρέπεται ξανά κλήση (ISO) */
  unlockAt: string;
  /** Το αρχικό `operation` του φορέα */
  operation: string;
}

export async function getRepoLock(): Promise<LabRepoLock | null> {
  const raw = await dbService.getSetting(LAB_LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LabRepoLock;
    if (!parsed?.unlockAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Ενεργό κλείδωμα (αν έχει παρέλθει η ώρα, καθαρίζεται) */
export async function getActiveRepoLock(): Promise<LabRepoLock | null> {
  const lock = await getRepoLock();
  if (!lock) return null;
  if (Date.now() >= new Date(lock.unlockAt).getTime()) {
    await clearRepoLock();
    return null;
  }
  return lock;
}

export async function clearRepoLock(): Promise<void> {
  await dbService.deleteSetting(LAB_LOCK_KEY).catch(() => {});
}

/** Καταγραφή κλειδώματος — επαναφέρει το 30λεπτο κάθε φορά */
export async function recordRepoLock(operation: string): Promise<LabRepoLock> {
  const now = Date.now();
  const lock: LabRepoLock = {
    lockedAt: new Date(now).toISOString(),
    unlockAt: new Date(now + LOCK_COOLDOWN_MS).toISOString(),
    operation,
  };
  await dbService.setSetting(LAB_LOCK_KEY, JSON.stringify(lock));
  return lock;
}

/** Διαγνωστικά στοιχεία διαπιστευτηρίων (χωρίς password) */
export {
  describeLabRepoCredentials,
  saveLabRepoApiKey,
  maskedLabRepoApiKey,
  labRepoApiKeySource,
} from './lab-repo-config';

/** Υπόλοιπο χρόνου αναμονής σε ms (0 = ελεύθερο) */
export function lockRemainingMs(lock: LabRepoLock): number {
  return Math.max(0, new Date(lock.unlockAt).getTime() - Date.now());
}

const API_BASE = LAB_REPO_BASE_URL;
/**
 * Api-Key εφαρμογής για το Lab Data Repository — από το κοινό module
 * `lab-repo-config` (διαβάζεται στο boot, πριν το DB override του env).
 */
const REQUEST_TIMEOUT_MS = Number(process.env.LAB_REPO_TIMEOUT_MS) || 60_000;

function authHeaders(credentials: LabRepoCredentials): Record<string, string> {
  return labRepoAuthHeaders(credentials);
}

// ── Payload types (καθρέπτης του ExamsMetaDataDTO) ──

export interface ResultIndicator {
  orderNo: number;
  formatType: number;
  description?: string;
  code?: string;
  examResultDate: string;
  valueType: 1 | 2;
  value?: string;
  unit?: string;
  refUnit?: string;
  abnormalStatus?: 'BELOW_LIMIT' | 'INSIDE_LIMIT' | 'ABOVE_LIMIT';
  extraAttr?: string;
  extraAttrDesc?: string;
  loincCode?: string;
  isNote?: boolean;
}

export interface ResultExamItem {
  header?: string;
  orderNo: number;
  indicatorCount: number;
  indicators: ResultIndicator[];
  examCode?: number;
  examinationPrescribedId?: number;
}

export interface ResultExamGroup {
  pageTitle: string;
  data: ResultExamItem[];
  doctorAmka: string;
  doctorFirstName: string;
  doctorLastName: string;
  doctorSpecialty: string;
}

export interface LabResultsPayload {
  patientAmka: string;
  doctorAmka: string;
  patientFirstName: string;
  patientLastName: string;
  doctorFirstName: string;
  doctorLastName: string;
  doctorSpecialty: string;
  examSampleDate: string;
  examResultDate: string;
  labName: string;
  orderID: string;
  exams: ResultExamGroup[];
  vatNumber: string;
  licenseNumber: string;
  examPresBarcode?: string[];
}

export type LabResultsResponse = Record<string, any>;

// ── Σφάλματα ──

export class LabResultsError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'LabResultsError';
  }
}

// ── Helpers ──

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function toIsoDate(value?: string | null): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (ISO_DATE.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Μόνο ψηφία, για ΑΜΚΑ/ΑΦΜ */
function digits(value?: string | null): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Οι παράμετροι μιας εξέτασης: `parameters[]` ή η απλή τιμή */
function examIndicatorSource(exam: Exam): ExamParameter[] {
  const params = Array.isArray(exam.parameters) ? exam.parameters : [];
  const filled = params.filter(p => (p.result ?? '').trim() !== '');
  if (filled.length > 0) return filled;
  if ((exam.result ?? '').trim() !== '') {
    return [
      { name: exam.name, result: exam.result, unit: exam.unit, referenceRange: exam.referenceRange },
    ];
  }
  return [];
}

/** Χαρακτηρισμός εκτός ορίων από το referenceRange (π.χ. "19.0-48.0") */
function abnormalFromRange(
  value: string,
  range?: string
): ResultIndicator['abnormalStatus'] | undefined {
  if (!range) return undefined;
  const match = /(-?\d+(?:[.,]\d+)?)\s*[-–]\s*(-?\d+(?:[.,]\d+)?)/.exec(range);
  if (!match) return undefined;
  const low = Number(match[1].replace(',', '.'));
  const high = Number(match[2].replace(',', '.'));
  const numeric = Number(String(value).replace(',', '.'));
  if (Number.isNaN(numeric) || Number.isNaN(low) || Number.isNaN(high)) return undefined;
  if (numeric < low) return 'BELOW_LIMIT';
  if (numeric > high) return 'ABOVE_LIMIT';
  return 'INSIDE_LIMIT';
}

function isNumeric(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(Number(String(value).replace(',', '.')));
}

/** Επεξήγηση των `operation` του gateway (επιστρέφονται με HTTP 200) */
function describeOperation(operation: string): string {
  const op = operation.toLowerCase();
  if (op.includes('acct_locked') || op.includes('unauthorized')) {
    return (
      'Ο λογαριασμός της εφαρμογής στο Lab Data Repository είναι κλειδωμένος ' +
      'λόγω πολλαπλών αποτυχημένων προσπαθειών σύνδεσης. Απαιτούνται 30 λεπτά ' +
      'χωρίς καμία νέα κλήση πριν από νέα προσπάθεια. Κάθε νέα αποτυχημένη ' +
      'προσπάθεια επαναφέρει το χρόνο αναμονής.'
    );
  }
  if (op.includes('acct_') && (op.includes('expired') || op.includes('disabled'))) {
    return `Ο λογαριασμός της εφαρμογής στο Lab Data Repository δεν είναι ενεργός (${operation}).`;
  }
  if (op.includes('invalid') || op.includes('auth') || op.includes('denied')) {
    return `Ο φορέας απέρριψε την πρόσβαση (${operation}).`;
  }
  return `Ο φορέας επέστρεψε κατάσταση «${operation}» αντί για επιτυχή καταχώρηση.`;
}

/** Barcode παραπεμπτικού (πεδίο ή από το id `referral_epres_<barcode>`) */
export function referralBarcode(referral: Referral): string | null {
  const direct = (referral as any).barcode;
  if (direct) return String(direct).trim();
  const match = /^referral_epres_(.+)$/.exec(referral.id);
  return match ? match[1] : null;
}

// ── Κατασκευή payload ──

export interface BuildContext {
  referral: Referral;
  exams: Exam[];
  patient: Patient;
  labProfile: LabProfile;
  doctor: { amka: string; firstName: string; lastName: string; specialty: string };
}

/**
 * Μετατροπή των εξετάσεων της εφαρμογής σε ExamsMetaDataDTO.
 * Κάθε εξέταση → ένα `DataDTO` με τους δείκτες της.
 */
export function buildResultsPayload(ctx: BuildContext): LabResultsPayload {
  const { referral, exams, patient, labProfile, doctor } = ctx;

  const barcode = referralBarcode(referral);
  if (!barcode) {
    throw new LabResultsError(
      'Το παραπεμπτικό δεν προέρχεται από ηλεκτρονικό παραπεμπτικό (λείπει barcode)',
      'NO_BARCODE'
    );
  }

  const resultDates: string[] = [];
  const data: ResultExamItem[] = [];

  // Σταθερή σειρά (η βάση επιστρέφει created_at DESC που δεν είναι deterministic)
  const ordered = [...exams].sort(
    (a, b) =>
      String(a.examDate || a.createdAt).localeCompare(String(b.examDate || b.createdAt)) ||
      a.name.localeCompare(b.name)
  );

  ordered.forEach((exam, index) => {
    const sources = examIndicatorSource(exam);
    if (sources.length === 0) return;

    const examDate =
      toIsoDate(exam.examDate) ||
      toIsoDate(exam.updatedAt) ||
      toIsoDate(referral.referralDate) ||
      today();
    resultDates.push(examDate);

    const indicators: ResultIndicator[] = sources.map((p, pIndex) => {
      const value = String(p.result ?? '').trim();
      const indicator: ResultIndicator = {
        orderNo: pIndex + 1,
        formatType: 1,
        description: p.name,
        examResultDate: examDate,
        valueType: isNumeric(value) ? 1 : 2,
      };
      if (value) indicator.value = value;
      if (p.unit) indicator.unit = p.unit.slice(0, 40);
      if (p.referenceRange) indicator.refUnit = p.referenceRange.slice(0, 1024);
      const abnormal = abnormalFromRange(value, p.referenceRange);
      if (abnormal) indicator.abnormalStatus = abnormal;
      if (p.loincNum) indicator.loincCode = p.loincNum;
      return indicator;
    });

    const item: ResultExamItem = {
      header: exam.name,
      orderNo: index + 1,
      indicatorCount: indicators.length,
      indicators,
    };

    // Κωδικός εξέτασης ΗΔΙΚΑ (απαιτείται για παραπεμπτικά ΕΟΠΥΥ)
    const examCode = Number((exam as any).examCode);
    if (Number.isFinite(examCode) && examCode > 0) item.examCode = examCode;

    // ID συνταγογραφημένης εξέτασης (από το lineId του παραπεμπτικού)
    const prescribed = Number((exam as any).examinationPrescribedId ?? (exam as any).lineId ?? NaN);
    if (Number.isFinite(prescribed) && prescribed > 0) {
      item.examinationPrescribedId = prescribed;
    }

    data.push(item);
  });

  if (data.length === 0) {
    throw new LabResultsError(
      'Δεν υπάρχουν καταχωρημένα αποτελέσματα σε καμία εξέταση του παραπεμπτικού',
      'NO_RESULTS'
    );
  }

  // Λήψη δείγματος = η παλαιότερη ημερομηνία εξέτασης
  const sampleCandidates = exams
    .map(e => toIsoDate((e as any).sampleDate) || toIsoDate(e.examDate))
    .filter((d): d is string => Boolean(d))
    .sort();
  const examSampleDate =
    sampleCandidates[0] || toIsoDate(referral.referralDate) || today();

  const examResultDate = resultDates.sort().slice(-1)[0] || today();

  const patientAmka = digits(patient.amka);
  if (patientAmka.length !== 11) {
    throw new LabResultsError(
      'Ο ασθενής δεν έχει έγκυρο ΑΜΚΑ (11 ψηφία) — απαιτείται για την καταχώρηση αποτελεσμάτων',
      'NO_PATIENT_AMKA'
    );
  }

  const doctorAmka = digits(doctor.amka);
  if (doctorAmka.length !== 11) {
    throw new LabResultsError(
      'Δεν βρέθηκε έγκυρο ΑΜΚΑ ιατρού από τα στοιχεία φορέα — ανανεώστε τα στοιχεία φορέα',
      'NO_DOCTOR_AMKA'
    );
  }

  const vatNumber = digits(labProfile.vatNumber);
  if (vatNumber.length !== 9) {
    throw new LabResultsError(
      'Δεν βρέθηκε έγκυρο ΑΦΜ στα Στοιχεία Φορέα — ανανεώστε τα στοιχεία φορέα από τις Ρυθμίσεις',
      'NO_LAB_VAT'
    );
  }

  if (!labProfile.licenseNumber?.trim()) {
    throw new LabResultsError(
      'Λείπει ο κωδικός εγκατάστασης ΕΟΠΥΥ — Ρυθμίσεις → Στοιχεία Εργαστηρίου',
      'NO_LAB_LICENSE'
    );
  }

  if (!labProfile.labName?.trim()) {
    throw new LabResultsError(
      'Δεν βρέθηκε επωνυμία μονάδας στα Στοιχεία Φορέα — ανανεώστε τα στοιχεία φορέα από τις Ρυθμίσεις',
      'NO_LAB_NAME'
    );
  }

  return {
    patientAmka,
    doctorAmka,
    patientFirstName: patient.firstName,
    patientLastName: patient.lastName,
    doctorFirstName: doctor.firstName,
    doctorLastName: doctor.lastName,
    doctorSpecialty: doctor.specialty,
    examSampleDate,
    examResultDate,
    labName: labProfile.labName.trim(),
    orderID: barcode,
    exams: [
      {
        pageTitle: referral.specialty || 'ΕΡΓΑΣΤΗΡΙΑΚΕΣ ΕΞΕΤΑΣΕΙΣ',
        data,
        doctorAmka,
        doctorFirstName: doctor.firstName,
        doctorLastName: doctor.lastName,
        doctorSpecialty: doctor.specialty,
      },
    ],
    vatNumber,
    licenseNumber: labProfile.licenseNumber.trim(),
    examPresBarcode: [barcode],
  };
}

// ── Κλήση φορέα ──

export async function postLabResults(
  payload: LabResultsPayload,
  credentials: LabRepoCredentials
): Promise<{ ok: true; data: LabResultsResponse } | { ok: false; code: string; error: string; operation?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/api/results`, {
      method: 'POST',
      headers: authHeaders(credentials),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();

    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      return {
        ok: false,
        code: res.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR',
        error: `Μη έγκυρη απάντηση από τον φορέα: ${raw.slice(0, 300)}`,
      };
    }

    // Το gateway απαντά 200 με `operation` αντί για σφάλμα HTTP.
    // Π.χ. {"operation":"acct_locked"} όταν ο λογαριασμός της εφαρμογής είναι κλειδωμένος.
    if (parsed && typeof parsed === 'object' && parsed.operation) {
      return {
        ok: false,
        code: 'PROVIDER_OPERATION',
        error: describeOperation(String(parsed.operation)),
        operation: String(parsed.operation),
      };
    }

    if (!res.ok) {
      // Διπλότυπη καταχώρηση: μία ενεργή εγγραφή ανά orderID + ΑΦΜ + κωδικό.
      if (res.status === 400 && /υπάρχει ήδη εγγραφή|already exists/i.test(raw)) {
        return {
          ok: false,
          code: 'ALREADY_SUBMITTED',
          error:
            'Υπάρχει ήδη καταχωρημένο αποτέλεσμα στον φορέα για αυτό το παραπεμπτικό ' +
            '(ίδιο orderID + ΑΦΜ + κωδικός εγκατάστασης). Δεν αποστέλλεται ξανά — ' +
            'για νέα αποστολή χρειάζεται πρώτα ακύρωση των αποτελεσμάτων.',
        };
      }

      // Ο φορέας επιστρέφει 403 με σαφή αιτία στο σώμα:
      //   {"title":"Invalid Api-Key","message":"error.http.403","status":401}
      // Σε αυτή την περίπτωση ΔΕΝ φταίει ο κωδικός χρήστη ούτε υπάρχει κλείδωμα.
      const apiKeyInvalid =
        String(parsed?.title || '').toLowerCase().includes('invalid api-key') ||
        parsed?.message === 'error.http.403';
      if (apiKeyInvalid) {
        return {
          ok: false,
          code: 'INVALID_API_KEY',
          error:
            'Το Api-Key της εφαρμογής για το Lab Data Repository δεν είναι έγκυρο ' +
            '(error.http.403 / Invalid Api-Key). Τα διαπιστευτήρια χρήστη είναι σωστά — ' +
            'χρειάζεται το δικό σας Api-Key, όχι αυτό του παραδείγματος του spec.',
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: 'HTTP_401',
          operation: 'unauthorized',
          error:
            'Ο φορέας απέρριψε την πρόσβαση (401). Πιθανές αιτίες: (α) ο λογαριασμός είναι ' +
            'κλειδωμένος λόγω πολλαπλών αποτυχημένων προσπαθειών — απαιτούνται 30 λεπτά χωρίς ' +
            'καμία νέα κλήση και κάθε νέα αποτυχία επαναφέρει τον χρόνο, ή (β) η IP δεν είναι ' +
            'δηλωμένη / το Api-Key δεν είναι έγκυρο.',
        };
      }
      const message = parsed?.message || parsed?.detail || parsed?.title || `HTTP ${res.status}`;
      return { ok: false, code: `HTTP_${res.status}`, error: String(message) };
    }

    return { ok: true, data: parsed ?? {} };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      code: 'NETWORK',
      error: aborted
        ? `Ο φορέας δεν απάντησε εντός ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Σφάλμα δικτύου: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Ρυθμίσεις εργαστηρίου ──

export async function getLabProfile(): Promise<LabProfile | null> {
  const raw = await dbService.getSetting(LAB_PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as LabProfile;
  } catch {
    return null;
  }
}

export async function saveLabProfile(profile: LabProfile): Promise<void> {
  await dbService.setSetting(LAB_PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Συνθέτει τα πλήρη στοιχεία εργαστηρίου με σειρά προτεραιότητας:
 *  1. Ό,τι έχει ορίσει/αλλάξει ο χρήστης (`LAB_PROFILE`)
 *  2. Τα «Στοιχεία Φορέα» από το `/api/me` (`organizationName`, `afm`)
 *
 * Έτσι η φόρμα είναι προσυμπληρωμένη αλλά ο χρήστης μπορεί να την αλλάξει.
 */
export async function resolveLabIdentity(userId: string): Promise<LabIdentity | null> {
  const [state, saved] = await Promise.all([
    dbService.getEfulfillmentState(userId),
    getLabProfile(),
  ]);

  const profile = state.profile;
  const labName =
    saved?.labName?.trim() ||
    profile?.organizationName?.trim() ||
    profile?.healthcareServices?.[0]?.trim() ||
    '';
  const vatNumber = digits(saved?.vatNumber) || digits(profile?.afm);
  const licenseNumber = saved?.licenseNumber?.trim() || '';

  if (!labName && !vatNumber && !licenseNumber) return null;
  return {
    labName,
    vatNumber,
    licenseNumber,
    examCenterId: profile?.examCenterId,
    userUnitId: profile?.userUnitId,
    healthCareUnitId: profile?.healthCareUnitId,
  };
}

// ── Orchestration ──

export interface SubmitResultsOutcome {
  referral: Referral;
  sentAt: string;
  examCount: number;
  indicatorCount: number;
  payload: LabResultsPayload;
  response: LabResultsResponse;
}

/** Στοιχεία ιατρού από το αποθηκευμένο profile του φορέα */
async function resolveDoctor(userId: string): Promise<BuildContext['doctor']> {
  const state = await dbService.getEfulfillmentState(userId);
  const profile = state.profile;
  const saved = await getLabProfile();

  const amka = digits(profile?.amka);
  const firstName = profile?.firstName?.trim();
  const lastName = profile?.lastName?.trim();

  let specialty = profile?.specialties?.[0]?.trim() || '';
  if (!specialty && saved?.doctorSpecialty) specialty = saved.doctorSpecialty;
  if (!specialty) specialty = 'ΒΙΟΠΑΘΟΛΟΓΟΣ';

  return {
    amka,
    firstName: firstName || '—',
    lastName: lastName || '—',
    specialty,
  };
}

/**
 * Αποστολή αποτελεσμάτων παραπεμπτικού στον φορέα.
 *
 * Έλεγχοι πριν την κλήση:
 *  - το παραπεμπτικό έχει barcode (προέρχεται από e-Prescription)
 *  - δεν έχει ήδη αποσταλεί (`resultsSubmittedAt`)
 *  - υπάρχουν αποτελέσματα σε τουλάχιστον μία εξέταση
 *  - υπάρχουν στοιχεία εργαστηρίου + ΑΜΚΑ ιατρού/ασθενή
 */
export async function submitReferralResults(
  userId: string,
  referralId: string,
  options: { force?: boolean } = {}
): Promise<SubmitResultsOutcome> {
  const referral = await dbService.getReferral(referralId);
  if (!referral) {
    throw new LabResultsError('Το παραπεμπτικό δεν βρέθηκε', 'NOT_FOUND');
  }

  // ── Έλεγχος κλειδώματος λογαριασμού φορέα ──
  const lock = await getActiveRepoLock();
  if (lock) {
    const minutes = Math.ceil(lockRemainingMs(lock) / 60000);
    throw new LabResultsError(
      `Ο λογαριασμός στο Lab Data Repository είναι κλειδωμένος λόγω αποτυχημένων ` +
        `προσπαθειών. Απομένουν ${minutes} λεπτά αναμονής χωρίς νέα κλήση — ` +
        `κάθε νέα αποτυχημένη προσπάθεια επαναφέρει το χρόνο αναμονής.`,
      'REPO_LOCKED'
    );
  }

  const barcode = referralBarcode(referral);
  if (!barcode) {
    throw new LabResultsError(
      'Το παραπεμπτικό δεν προέρχεται από ηλεκτρονικό παραπεμπτικό (λείπει barcode)',
      'NO_BARCODE'
    );
  }

  // Σημείωση: δεν μπλοκάρουμε με βάση το `resultsSubmittedAt`, γιατί μπορεί να
  // υπάρχουν ΝΕΕΣ εξετάσεις με αποτέλεσμα. Ο έλεγχος γίνεται πιο κάτω
  // (στέλνονται μόνο οι μη-ολοκληρωμένες εξετάσεις με αποτέλεσμα).

  const [allExams, patient] = await Promise.all([
    dbService.listExams(referralId),
    dbService.getPatient(referral.patientId),
  ]);

  if (!patient) {
    throw new LabResultsError('Ο ασθενής του παραπεμπτικού δεν βρέθηκε', 'NO_PATIENT');
  }

  // Αν υπάρχει ήδη καταχώρηση στον φορέα, δεν επιτρέπεται νέα — απαιτείται ακύρωση
  if ((referral as any).resultsSubmittedAt && !options.force) {
    throw new LabResultsError(
      'Έχει ήδη γίνει καταχώρηση αποτελεσμάτων στον φορέα για αυτό το παραπεμπτικό. ' +
        'Ακυρώστε πρώτα τα αποτελέσματα για να μπορείτε να στείλετε νέα.',
      'ALREADY_SUBMITTED'
    );
  }

  // Αποστέλλονται εξετάσεις που είναι ΟΛΟΚΛΗΡΩΜΕΝΕΣ, έχουν αποτέλεσμα και
  // δεν έχουν ήδη σταλεί στον φορέα.
  const exams = allExams.filter(exam => {
    if (String(exam.status) !== 'completed') return false;
    if ((exam as any).resultsSubmittedAt) return false;
    const hasParams =
      Array.isArray(exam.parameters) && exam.parameters.some(p => (p.result ?? '').trim() !== '');
    const hasSimple = (exam.result ?? '').trim() !== '';
    return hasParams || hasSimple;
  });

  if (exams.length === 0) {
    const allSubmitted =
      allExams.length > 0 && allExams.every(e => (e as any).resultsSubmittedAt);
    throw new LabResultsError(
      allSubmitted
        ? 'Όλες οι ολοκληρωμένες εξετάσεις έχουν ήδη αποσταλεί στον φορέα'
        : 'Δεν υπάρχουν ολοκληρωμένες εξετάσεις με αποτέλεσμα προς αποστολή',
      'NOTHING_NEW'
    );
  }

  const labProfile = await resolveLabIdentity(userId);
  if (!labProfile) {
    throw new LabResultsError(
      'Δεν βρέθηκαν στοιχεία εργαστηρίου — συνδεθείτε πρώτα με τον φορέα και συμπληρώστε τον κωδικό ΕΟΠΥΥ στις Ρυθμίσεις',
      'NO_LAB_PROFILE'
    );
  }

  const doctor = await resolveDoctor(userId);

  // Συμπλήρωση examCode από το Master Data όπου λείπει (απαιτείται για ΕΟΠΥΥ)
  const enriched: Exam[] = [];
  for (const exam of exams) {
    if ((exam as any).examCode) {
      enriched.push(exam);
      continue;
    }
    try {
      const code = await examParameters.resolveExamCode(exam);
      enriched.push(code ? ({ ...exam, examCode: code } as Exam) : exam);
    } catch {
      enriched.push(exam);
    }
  }

  const payload = buildResultsPayload({
    referral,
    exams: enriched,
    patient,
    labProfile,
    doctor,
  });

  // Ανανέωση σύνδεσης φορέα αν έχει λήξει το 24ωρο
  const fresh = await ensureFreshConnection(userId);
  if (fresh && !fresh.ok) {
    throw new LabResultsError(fresh.error || 'Σφάλμα σύνδεσης με τον φορέα', fresh.code || 'AUTH');
  }

  // Διαπιστευτήρια φορέα (ίδια με e-Prescription)
  const creds = await resolveLabRepoCredentials(userId);
  if (!creds) {
    throw new LabResultsError(
      'Δεν βρέθηκαν διαπιστευτήρια φορέα — συνδεθείτε πρώτα από τις Ρυθμίσεις → Στοιχεία Φορέα',
      'NO_CREDENTIALS'
    );
  }

  const result = await postLabResults(payload, creds);
  if (!result.ok) {
    // Cooldown ΜΟΝΟ όταν ο φορέας κλειδώσει τον λογαριασμό (acct_locked / 401).
    // Το INVALID_API_KEY δεν κλειδώνει λογαριασμό — δεν πρέπει να μπλοκάρει.
    const op = (result.operation || '').toLowerCase();
    if (op.includes('acct_locked') || op === 'unauthorized') {
      await recordRepoLock(result.operation || 'unauthorized');
    }
    throw new LabResultsError(
      result.error || 'Η καταχώρηση αποτελεσμάτων απέτυχε στον φορέα',
      result.code || 'SUBMIT_FAILED'
    );
  }

  // Επιτυχία → καθαρισμός τυχόν παλιού κλειδώματος
  await clearRepoLock();

  const sentAt = new Date().toISOString();
  const indicatorCount = payload.exams[0].data.reduce((sum, d) => sum + d.indicatorCount, 0);

  // Σήμανση των εξετάσεων που στάλθηκαν + διαγραφή παραμέτρων χωρίς αποτέλεσμα
  for (const exam of exams) {
    try {
      const keptParams = (Array.isArray(exam.parameters) ? exam.parameters : []).filter(
        p => (p.result ?? '').trim() !== ''
      );
      await dbService.updateExam(exam.id, {
        resultsSubmittedAt: sentAt,
        parameters: keptParams,
      } as any);
    } catch {
      /* ignore */
    }
  }

  const noteParts = (referral.notes || '')
    .split(' · ')
    .filter(p => p && !p.startsWith('Αποτελέσματα:'));

  noteParts.push(
    `Αποτελέσματα: ${payload.exams[0].data.length} εξετάσεις, ${indicatorCount} δείκτες (${toIsoDate(sentAt)})`
  );

  const updated = await dbService.updateReferral(referralId, {
    notes: noteParts.join(' · '),
    resultsSubmittedAt: sentAt,
    resultsSubmittedCount: indicatorCount,
  } as any);

  return {
    referral: updated,
    sentAt,
    examCount: payload.exams[0].data.length,
    indicatorCount,
    payload,
    response: result.data,
  };
}

// ── Άντληση αποτελεσμάτων από το Lab Data Repository ──

export interface LabResultSummary {
  id: string;
  orderID?: string;
  examPresBarcode?: string[];
  examResultDate?: string;
  examSampleDate?: string;
  labName?: string;
  [key: string]: any;
}

export interface LabResultDetail {
  orderID?: string;
  examResultDate?: string;
  exams?: Array<{
    pageTitle?: string;
    data?: Array<{
      header?: string;
      examCode?: number;
      indicators?: Array<{
        description?: string;
        value?: string;
        unit?: string;
        refUnit?: string;
        loincCode?: string;
        abnormalStatus?: string;
      }>;
    }>;
  }>;
  [key: string]: any;
}

/** GET /api/get-result?examPresBarcode=… — «Άντληση Εργαστηριακών Αποτελεσμάτων» */
export async function fetchLabResultSummaries(
  credentials: LabRepoCredentials,
  barcode: string
): Promise<
  { ok: true; data: LabResultSummary[] } | { ok: false; code: string; error: string }
> {
  const url = `${LAB_REPO_BASE_URL}/api/get-result?examPresBarcode=${encodeURIComponent(barcode)}`;
  return labRepoGet<LabResultSummary[]>(url, credentials, 'summaries');
}

/** GET /api/exams/id/{id} — «Άντληση Εργαστηριακού Αποτελέσματος βάσει id» */
export async function fetchLabResultById(
  credentials: LabRepoCredentials,
  id: string
): Promise<{ ok: true; data: LabResultDetail[] } | { ok: false; code: string; error: string }> {
  const url = `${LAB_REPO_BASE_URL}/api/exams/id/${encodeURIComponent(id)}`;
  return labRepoGet<LabResultDetail[]>(url, credentials, 'detail');
}

/** Κοινή GET κλήση προς το Lab Data Repository */
async function labRepoGet<T>(
  url: string,
  credentials: LabRepoCredentials,
  kind: 'summaries' | 'detail'
): Promise<{ ok: true; data: T } | { ok: false; code: string; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: labRepoAuthHeaders(credentials),
      signal: controller.signal,
    });

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      return { ok: false, code: 'INVALID_RESPONSE', error: 'Μη έγκυρη απάντηση από τον φορέα' };
    }

    const apiKeyInvalid =
      String(parsed?.title || '').toLowerCase().includes('invalid api-key') ||
      parsed?.message === 'error.http.403';
    if (apiKeyInvalid) {
      return {
        ok: false,
        code: 'INVALID_API_KEY',
        error: 'Το Api-Key για το Lab Data Repository δεν είναι έγκυρο (Invalid Api-Key)',
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        code: 'NOT_FOUND_RESULT',
        error:
          kind === 'summaries'
            ? 'Δεν βρέθηκαν καταχωρημένα αποτελέσματα για αυτό το παραπεμπτικό'
            : 'Δεν βρέθηκε το αποτέλεσμα',
      };
    }

    // Ο φορέας επιστρέφει 400 όταν δεν υπάρχει ενεργό αποτέλεσμα για το barcode
    if (res.status === 400 && /δεν βρέθηκε ενεργό αποτέλεσμα|no active result/i.test(raw)) {
      return {
        ok: false,
        code: 'NOT_FOUND_RESULT',
        error: 'Δεν υπάρχουν ενεργά αποτελέσματα για αυτό το παραπεμπτικό στον φορέα',
      };
    }

    if (!res.ok) {
      const message = parsed?.detail || parsed?.message || parsed?.title || `HTTP ${res.status}`;
      return { ok: false, code: `HTTP_${res.status}`, error: String(message) };
    }

    // Ο φορέας επιστρέφει είτε array είτε { timestamp, content: [...] }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.content)
      ? parsed.content
      : parsed
      ? [parsed]
      : [];
    return { ok: true, data: list as T };
  } catch (err: any) {
    return {
      ok: false,
      code: 'NETWORK',
      error: err?.name === 'AbortError' ? 'Ο φορέας δεν απάντησε εγκαίρως' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncReferralResultsOutcome {
  /** Πόσα IDs επέστρεψε η πρώτη κλήση */
  resultIds: number;
  /** Πόσες εξετάσεις ενημερώθηκαν */
  updatedExams: number;
  /** Πόσοι δείκτες γράφτηκαν */
  indicators: number;
  message: string;
  /** IDs αποτελεσμάτων του φορέα (για πιθανή ακύρωση) */
  labResultIds?: string[];
}

/** DELETE /api/results/cancel/{id} — «Ακύρωση Εργαστηριακού Αποτελέσματος» */
export async function cancelLabResult(
  credentials: LabRepoCredentials,
  id: string
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${LAB_REPO_BASE_URL}/api/results/cancel/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: labRepoAuthHeaders(credentials), signal: controller.signal }
    );

    if (res.status === 204 || res.ok) return { ok: true };

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* ignore */
    }
    if (String(parsed?.title || '').toLowerCase().includes('invalid api-key')) {
      return { ok: false, code: 'INVALID_API_KEY', error: 'Μη έγκυρο Api-Key' };
    }
    if (res.status === 404) {
      return { ok: false, code: 'NOT_FOUND_RESULT', error: 'Το αποτέλεσμα δεν βρέθηκε στον φορέα' };
    }
    const message = parsed?.detail || parsed?.message || parsed?.title || `HTTP ${res.status}`;
    // 400 «δεν βρέθηκε ενεργό αποτέλεσμα» = έχει ήδη ακυρωθεί
    if (res.status === 400 && /δεν βρέθηκε|no active result/i.test(raw)) {
      return { ok: false, code: 'NOT_FOUND_RESULT', error: 'Το αποτέλεσμα έχει ήδη ακυρωθεί' };
    }
    return { ok: false, code: `HTTP_${res.status}`, error: String(message) };
  } catch (err: any) {
    return {
      ok: false,
      code: 'NETWORK',
      error: err?.name === 'AbortError' ? 'Ο φορέας δεν απάντησε εγκαίρως' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Επαναφέρει ΟΛΕΣ τις εξετάσεις του παραπεμπτικού σε «Σε εξέλιξη» με κενά
 * αποτελέσματα, ώστε να μπορούν να καταχωρηθούν ξανά.
 */
async function restoreExamsAfterCancel(
  referralId: string,
  _referral: Referral
): Promise<number> {
  const exams = await dbService.listExams(referralId);
  let restored = 0;

  for (const exam of exams) {
    if (String(exam.status) === 'cancelled') continue;

    // Επαναφορά ΟΛΩΝ των παραμέτρων από το Master Data (όχι μόνο όσες είχαν
    // αποτέλεσμα) — π.χ. μετά την αποστολή στον φορέα είχαν περιοριστεί.
    let baseParams: Array<{ name: string; result?: string; unit?: string; referenceRange?: string; loincNum?: string }> =
      Array.isArray(exam.parameters) ? exam.parameters : [];

    try {
      const examCode = await examParameters.resolveExamCode(exam);
      if (examCode) {
        const fresh = await examParameters.getExamParameters(examCode);
        if (fresh.length > 0) baseParams = fresh;
      }
    } catch {
      /* διατήρηση των υπαρχουσών παραμέτρων */
    }

    // ΠΑΝΤΑ «Σε εξέλιξη» — το snapshot μπορεί να περιέχει λανθασμένο
    // `completed` από προηγούμενη άντληση, οπότε δεν το εμπιστευόμαστε.
    await dbService.updateExam(exam.id, {
      parameters: baseParams.map(p => ({ ...p, result: '' })),
      result: '',
      status: 'in_progress' as any,
      resultsSubmittedAt: null,
    } as any);
    restored++;
  }

  return restored;
}

export interface CancelResultsOutcome {
  cancelled: number;
  failed: number;
  restoredExams: number;
  /** Μέγιστο orderNo που επέστρεψε η «Άντληση βάσει id» */
  maxOrderNo?: number;
  message: string;
}

/**
 * Ακύρωση των αντληθέντων αποτελεσμάτων στον φορέα και επαναφορά των
 * εξετάσεων της εφαρμογής στην κατάσταση πριν την άντληση.
 */
export async function cancelReferralResultsFromProvider(
  userId: string,
  referralId: string
): Promise<CancelResultsOutcome> {
  const referral = await dbService.getReferral(referralId);
  if (!referral) throw new LabResultsError('Το παραπεμπτικό δεν βρέθηκε', 'NOT_FOUND');

  let storedIds: string[] = Array.isArray((referral as any).labResultIds)
    ? (referral as any).labResultIds.map(String)
    : [];

  // Αν δεν έχουν αποθηκευτεί IDs, τα αναζητούμε ζωντανά με το barcode
  if (storedIds.length === 0) {
    const barcode = referralBarcode(referral);
    const creds = await resolveLabRepoCredentials(userId);
    if (barcode && creds) {
      const summaries = await fetchLabResultSummaries(creds, barcode);
      if (summaries.ok) {
        storedIds = summaries.data.map(s => String(s?.id ?? '').trim()).filter(Boolean);
      }
    }
  }

  if (storedIds.length === 0) {
    // Δεν υπάρχουν IDs στον φορέα — γίνεται μόνο τοπική επαναφορά (όλες οι
    // παράμετροι από το Master Data, με κενές τιμές).
    const restoredOnly = await restoreExamsAfterCancel(referralId, referral);
    await dbService.updateReferral(referralId, {
      labResultIds: [],
      preFetchExams: [],
      resultsFetchedAt: undefined,
      resultsSubmittedAt: null,
      resultsSubmittedCount: null,
    } as any);
    return {
      cancelled: 0,
      failed: 0,
      restoredExams: restoredOnly,
      message:
        restoredOnly > 0
          ? `Ακυρώθηκε η καταχώρηση για ${restoredOnly} εξετάσεις — μπορείτε να τις στείλετε ξανά`
          : 'Δεν χρειάστηκε επαναφορά καμίας εξέτασης',
    };
  }

  const creds = await resolveLabRepoCredentials(userId);
  if (!creds) throw new LabResultsError('Δεν βρέθηκαν διαπιστευτήρια φορέα', 'NO_CREDENTIALS');

  let cancelled = 0;
  let failed = 0;
  let maxOrderNo = 0;

  for (const id of storedIds) {
    // Πριν την ακύρωση, διάβασε το αποτέλεσμα για να βρεθεί το μέγιστο orderNo
    try {
      const detail = await fetchLabResultById(creds, id);
      if (detail.ok) {
        for (const result of detail.data) {
          for (const group of result.exams || []) {
            for (const item of group.data || []) {
              const candidates: number[] = [];
              const dataNo = Number((item as any).orderNo);
              if (Number.isFinite(dataNo)) candidates.push(dataNo);
              for (const ind of item.indicators || []) {
                const indNo = Number((ind as any).orderNo);
                if (Number.isFinite(indNo)) candidates.push(indNo);
              }
              for (const n of candidates) if (n > maxOrderNo) maxOrderNo = n;
            }
          }
        }
      }
    } catch {
      /* ignore — το orderNo είναι μόνο για το μήνυμα */
    }

    const res = await cancelLabResult(creds, id);
    if (res.ok || res.code === 'NOT_FOUND_RESULT') cancelled++;
    else failed++;
  }

  // Επαναφορά όλων των παραμέτρων από το Master Data (με κενές τιμές)
  const restoredExams = await restoreExamsAfterCancel(referralId, referral);

  await dbService.updateReferral(referralId, {
    labResultIds: [],
    preFetchExams: [],
    resultsFetchedAt: undefined,
    resultsSubmittedAt: null,
    resultsSubmittedCount: null,
  } as any);

  const totalResults = maxOrderNo > 0 ? maxOrderNo : cancelled;
  return {
    cancelled,
    failed,
    restoredExams,
    maxOrderNo,
    message: `Επαναφέρθηκαν ${totalResults} αποτελέσματα και ${restoredExams} εξετάσεις σε «Σε εξέλιξη»`,
  };
}

/**
 * Πλήρης ροή άντλησης αποτελεσμάτων για παραπεμπτικό e-Prescription:
 *
 *  1. `GET /api/get-result?examPresBarcode=<barcode>` → λίστα με `id`
 *  2. Για κάθε `id`: `GET /api/exams/id/{id}` → πλήρη αποτελέσματα
 *  3. Ενημέρωση των εξετάσεων της εφαρμογής με τις τιμές των δεικτών
 */
export async function syncReferralResultsFromProvider(
  userId: string,
  referralId: string
): Promise<SyncReferralResultsOutcome> {
  const referral = await dbService.getReferral(referralId);
  if (!referral) throw new LabResultsError('Το παραπεμπτικό δεν βρέθηκε', 'NOT_FOUND');

  const barcode = referralBarcode(referral);
  if (!barcode) throw new LabResultsError('Το παραπεμπτικό δεν έχει barcode', 'NO_BARCODE');

  const creds = await resolveLabRepoCredentials(userId);
  if (!creds) throw new LabResultsError('Δεν βρέθηκαν διαπιστευτήρια φορέα', 'NO_CREDENTIALS');

  const lock = await getActiveRepoLock();
  if (lock) {
    const minutes = Math.ceil(lockRemainingMs(lock) / 60000);
    throw new LabResultsError(
      `Ο λογαριασμός είναι κλειδωμένος. Απομένουν ${minutes} λεπτά αναμονής.`,
      'REPO_LOCKED'
    );
  }

  // 1) Λίστα αποτελεσμάτων με βάση το barcode του παραπεμπτικού
  const summaries = await fetchLabResultSummaries(creds, barcode);
  if (!summaries.ok) {
    if (summaries.code === 'NOT_FOUND_RESULT') {
      return { resultIds: 0, updatedExams: 0, indicators: 0, message: summaries.error };
    }
    throw new LabResultsError(summaries.error, summaries.code);
  }

  const ids = summaries.data
    .map(s => String(s?.id ?? '').trim())
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) {
    return { resultIds: 0, updatedExams: 0, indicators: 0, message: 'Δεν βρέθηκαν αποτελέσματα' };
  }

  const exams = await dbService.listExams(referralId);
  let updatedExams = 0;
  let indicators = 0;

  // Snapshot της κατάστασης πριν την άντληση (για επαναφορά σε ακύρωση)
  const snapshot = exams.map(e => ({
    id: e.id,
    parameters: e.parameters ?? [],
    result: e.result ?? '',
    unit: e.unit,
    referenceRange: e.referenceRange,
    status: e.status,
    examDate: e.examDate,
  }));

  // 2) Λεπτομέρειες για κάθε id
  for (const id of ids) {
    const detail = await fetchLabResultById(creds, id);
    if (!detail.ok) continue;

    for (const result of detail.data) {
      for (const group of result.exams || []) {
        for (const item of group.data || []) {
          const inds = item.indicators || [];
          if (inds.length === 0) continue;

          const target = matchExamForResult(exams, item);
          if (!target) continue;
          // Ολοκληρωμένες εξετάσεις δεν ξαναενημερώνονται
          if (String(target.status) === 'completed') continue;

          const parameters = inds.map(ind => {
            const raw = ind.value != null ? String(ind.value).trim() : '';
            const value = raw === 'null' || raw === 'undefined' ? '' : raw;
            return {
              name: ind.description || 'Παράμετρος',
              result: value,
              unit: ind.unit || undefined,
              referenceRange: ind.refUnit || undefined,
              loincNum: ind.loincCode || undefined,
            };
          });

          const first = parameters.find(p => p.result) || parameters[0];
          const hasResult = parameters.some(p => p.result);

          await dbService.updateExam(target.id, {
            parameters,
            result: parameters.length === 1 ? first.result : '',
            unit: parameters.length === 1 ? first.unit : undefined,
            referenceRange: parameters.length === 1 ? first.referenceRange : undefined,
            examDate: toIsoDate(result.examResultDate) || target.examDate,
            ...(hasResult ? { status: 'completed' as any } : {}),
          });

          updatedExams++;
          indicators += parameters.filter(p => p.result).length;
        }
      }
    }
  }

  // Αποθήκευση IDs + snapshot για πιθανή ακύρωση
  if (updatedExams > 0) {
    await dbService.updateReferral(referralId, {
      labResultIds: ids,
      preFetchExams: snapshot,
      resultsFetchedAt: new Date().toISOString(),
    } as any);
  }

  return {
    resultIds: ids.length,
    updatedExams,
    indicators,
    labResultIds: ids,
    message:
      updatedExams > 0
        ? `Αντλήθηκαν αποτελέσματα για ${updatedExams} εξετάσεις (${indicators} δείκτες)`
        : 'Βρέθηκαν αποτελέσματα αλλά δεν αντιστοιχίστηκαν σε εξετάσεις του παραπεμπτικού',
  };
}

/** Αντιστοίχιση αποτελέσματος φορέα σε εξέταση της εφαρμογής */
function matchExamForResult(
  exams: Exam[],
  item: { header?: string; examCode?: number }
): Exam | null {
  if (item.examCode != null) {
    const byCode = exams.find(e => String((e as any).examCode || '') === String(item.examCode));
    if (byCode) return byCode;
  }
  const header = (item.header || '').trim().toLowerCase();
  if (!header) return null;

  const byName = exams.find(e => e.name.trim().toLowerCase() === header);
  if (byName) return byName;

  const loose = exams.find(
    e => e.name.toLowerCase().includes(header) || header.includes(e.name.trim().toLowerCase())
  );
  return loose || null;
}

/**
 * Αυτόματη αποστολή όταν το παραπεμπτικό ολοκληρώνεται.
 * Δεν πετάει σφάλμα — επιστρέφει το αποτέλεσμα ώστε το UI να ενημερώσει.
 */
export async function maybeAutoSubmitResults(
  userId: string,
  referralId: string
): Promise<{ attempted: boolean; ok: boolean; message?: string; code?: string }> {
  try {
    const referral = await dbService.getReferral(referralId);
    if (!referral) return { attempted: false, ok: false };
    if (!referralBarcode(referral)) return { attempted: false, ok: false };
    if ((referral as any).resultsSubmittedAt) return { attempted: false, ok: false };

    const outcome = await submitReferralResults(userId, referralId);
    return {
      attempted: true,
      ok: true,
      message: `Τα αποτελέσματα στάλθηκαν στον φορέα (${outcome.indicatorCount} δείκτες)`,
    };
  } catch (err: any) {
    // Τίποτα νέο προς αποστολή → δεν είναι σφάλμα για την αυτόματη ροή
    if (err?.code === 'NOTHING_NEW') {
      return { attempted: false, ok: true, code: 'NOTHING_NEW' };
    }
    return {
      attempted: true,
      ok: false,
      code: err?.code,
      message: err?.message || 'Η αποστολή αποτελεσμάτων απέτυχε',
    };
  }
}
