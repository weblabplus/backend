// ============================================================
// E-Fulfillment API (e-Prescription / ΗΔΙΚΑ) v2.0
// Άντληση στοιχείων χρήστη μέσω GET /api/me
//
// Ο φορέας απαιτεί την κλήση /api/me για κάθε σύνδεση και τουλάχιστον μία
// φορά κάθε 24 ώρες. Αν περάσει το όριο, κάθε άλλη κλήση επιστρέφει:
//   603: You must refresh your connection. The connection time limit has been exceeded.
// Αν ο χρήστης δεν έχει καλέσει ποτέ, επιστρέφει:
//   601: You must create first connection.
// ============================================================

import { dbService } from '../db/db.service';
import type { FinanceEntry } from '../db/db.service';
import { examParameters } from './exam-parameters.service';
import {
  upsertPatientShareReceivable,
  upsertPayerReimbursementReceivable,
  cancelPatientShareReceivable,
  cancelPayerReimbursementReceivable,
  type PatientShareLine,
} from './finance-patient-share.service';
import type { Exam, Patient, Referral, Visit } from '@medilab/core';

// ── Types ──

export interface EfulfillmentCredentials {
  username: string;
  password: string;
  /** Πραγματική εξωτερική IP του χρήστη (header X-DOCTOR-IP) */
  doctorIp?: string;
}

/** Κανονικοποιημένα στοιχεία χρήστη από το PractitionerRole του φορέα */
export interface PractitionerProfile {
  amka?: string;
  afm?: string;
  practitionerId?: string;
  etaaRegNo?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  gender?: string;
  birthDate?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  specialties: string[];
  organizationId?: string;
  organizationName?: string;
  healthcareServices: string[];
  /** Στοιχεία μονάδας (Location: examCenterId, AFM, διεύθυνση) */
  examCenterId?: string;
  healthCareUnitId?: string;
  userUnitId?: string;
  isExamCenter?: boolean;
  canExecuteExam?: boolean;
  canAddExamResults?: boolean;
  isPublicHealthProvider?: boolean;
  address?: string;
  resourceType?: string;
  fetchedAt: string;
}

export interface EfulfillmentState {
  hasCredentials: boolean;
  username?: string;
  lastSyncAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  /** Λήγει 24 ώρες μετά το lastSyncAt (όριο φορέα) */
  expiresAt?: string | null;
  /** Χρόνος μέχρι την επόμενη αυτόματη ανανέωση */
  nextRefreshAt?: string | null;
  profile?: PractitionerProfile | null;
}

export interface EfulfillmentResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** 601 = δεν έχει γίνει ποτέ σύνδεση, 603 = έληξε το 24ωρο, 600 = λάθος Api-Key, 439/421 = άγνωστο ΑΜΚΑ/barcode */
  code?:
    | '601'
    | '603'
    | '600'
    | '439'
    | '421'
    | '2018'
    | '2019'
    | 'API_KEY'
    | 'NO_PATIENT'
    | 'NO_REFERRAL'
    /** Ο φορέας δέχεται μόνο ολική εκτέλεση (όλες οι εξετάσεις μαζί) */
    | 'FULL_ONLY'
    /** Το παραπεμπτικό έχει ήδη εκτελεστεί στον φορέα */
    | 'ALREADY_EXECUTED'
    | 'NETWORK'
    | 'AUTH'
    | 'UNKNOWN';
}

// ── Παραπεμπτικά (nopaper) ──

/** Παραπεμπτικό από το /api/me/referrals/nopaper */
export interface EpresReferral {
  id: number | string;
  barcode: string;
  statusId?: number;
  statusName?: string;
  amka?: string;
  firstName?: string;
  lastName?: string;
  socialInsuranceShortName?: string;
  issueDate?: string;
  expiryDate?: string;
  examinationGroupId?: number;
  examinationGroupName?: string;
  isProactive?: boolean;
}

export interface ReferralSearchResult {
  referrals: EpresReferral[];
  total: number;
  page: number;
  totalPages: number;
  patientName?: string;
  unitId?: number;
}

// ── Άντληση παραπεμπτικού προς εκτέλεση (barcode) ──

/** Γραμμή εξέτασης από το orderDetail του παραπεμπτικού */
export interface EpresExam {
  /** ID γραμμής εξέτασης (orderDetail[].id) */
  lineId: string;
  /** Κωδικός εξέτασης (extension examination/id) */
  examId?: string;
  /** Ονομασία εξέτασης (από τον φορέα ή τον τοπικό κατάλογο) */
  name: string;
  /** Τιμή/περιγραφή όπως επιστράφηκε */
  rawName?: string;
  /** Τιμή εκτέλεσης (extension examination/executionPrice) */
  executionPrice?: number;
  /** Ποσό συμμετοχής ασφαλισμένου (extension examinationPrescribed/participationPercentAmt) */
  participationAmount?: number;
  /** Τιμή κατά τη συνταγογράφηση (extension examinationPrescribed/examinationPricePrescr) */
  prescribedPrice?: number;
}

/** Παραπεμπτικό προς εκτέλεση από GET /api/referrals/{barcode}/unit/{unitId}/dispense */
export interface EpresDispenseReferral {
  barcode: string;
  status?: string;
  intent?: string;
  /** Ομάδα εξετάσεων */
  examGroupCode?: string;
  examGroupName?: string;
  /** Ημερομηνία έκδοσης (authoredOn) */
  authoredOn?: string;
  /** Λήξη δυνατότητας εκτέλεσης (occurrenceDateTime) */
  occurrenceDateTime?: string;
  /** Εναλλακτικό πεδίο λήξης, όταν ο φορέας το επιστρέφει ως expiryDate */
  expiryDate?: string;
  /** Λήξη από extension (π.χ. …/expirationDate), όταν υπάρχει */
  expiryFromExtension?: string;
  /** Η αποτελεσματική ημερομηνία λήξης που χρησιμοποιήθηκε για τον έλεγχο */
  effectiveExpiry?: string;
  /** Αιτιολογία */
  reason?: string;
  notes?: string;
  /** Συνολικός αριθμός εκτελέσεων */
  totalExecutions?: number;
  /** Ασφαλιστικός φορέας (Coverage.identifier — Social Insurance Id) */
  insuranceId?: string;
  /** Ποσοστό συμμετοχής ασθενούς από το Coverage (costToBeneficiary) */
  participationPercent?: number;
  /** Στοιχεία ασθενούς */
  patient?: {
    amka?: string;
    ama?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    gender?: string;
    birthDate?: string;
    phone?: string;
  };
  /** Εξετάσεις του παραπεμπτικού */
  exams: EpresExam[];
  resourceType?: string;
}

export interface DispenseSearchResult {
  referral: EpresDispenseReferral;
  unitId: string;
  /** true αν το barcode έχει ήδη καταχωρηθεί */
  alreadyImported: boolean;
  existingReferralId?: string;
  existingVisitId?: string;
  /** true αν το παραπεμπτικό έχει λήξει */
  expired: boolean;
  /** Ημερομηνίες (ημέρες) μέχρι τη λήξη· αρνητικό αν έχει λήξει */
  daysUntilExpiry?: number;
  /** Ανθρώπινη περιγραφή της κατάστασης λήξης */
  expiryMessage?: string;
  /** Υπάρχων ασθενής στη βάση με αυτό το ΑΜΚΑ (null = θα δημιουργηθεί νέος) */
  existingPatient?: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    gender?: string;
    amka?: string;
  } | null;
}

// ── Configuration ──

const HOUR = 60 * 60 * 1000;
/** Όριο φορέα: 24 ώρες */
export const CONNECTION_TTL_MS = 24 * HOUR;
/** Προληπτική ανανέωση πριν λήξει το 24ωρο */
export const REFRESH_INTERVAL_MS = (Number(process.env.EFULFILLMENT_REFRESH_HOURS) || 20) * HOUR;
const REQUEST_TIMEOUT_MS = Number(process.env.EFULFILLMENT_TIMEOUT_MS) || 15000;

function getBaseUrl(): string {
  return (
    process.env.EFULFILLMENT_BASE_URL || 'https://testeps.e-prescription.gr/efulfillment'
  ).replace(/\/+$/, '');
}

function getApiKey(): string {
  return process.env.EFULFILLMENT_API_KEY || '';
}

export function isEfulfillmentConfigured(): boolean {
  return Boolean(getApiKey());
}

// ── HTTP client ──

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** Εξαγωγή κωδικού σφάλματος φορέα από το σώμα της απάντησης */
function extractCode(status: number, body: string): EfulfillmentResult<never>['code'] {
  if (/\b603\b/.test(body) || /refresh your connection/i.test(body)) return '603';
  if (/\b601\b/.test(body) || /create first connection/i.test(body)) return '601';
  if (/"code"\s*:\s*600\b/.test(body) || /application key is not valid/i.test(body)) return 'API_KEY';
  if (/"code"\s*:\s*439\b/.test(body) || /there is no patient with amka/i.test(body)) return 'NO_PATIENT';
  if (/"code"\s*:\s*421\b/.test(body) || /there is no referral with barcode/i.test(body)) return 'NO_REFERRAL';
  if (/"code"\s*:\s*2018\b/.test(body) || /executioncaseid must be/i.test(body)) return 'FULL_ONLY';
  if (/"code"\s*:\s*2019\b/.test(body) || /examination is already executed/i.test(body)) {
    return 'ALREADY_EXECUTED';
  }
  if (status === 401 || status === 403) return 'AUTH';
  return 'UNKNOWN';
}

/** Μηνύματα για τους κωδικούς σφάλματος του φορέα */
const ERROR_MESSAGES: Record<string, string> = {
  '2018':
    'Ο φορέας απαιτεί ολική εκτέλεση του παραπεμπτικού: πρέπει να εκτελεστούν όλες οι εξετάσεις μαζί. Επιλέξτε όλες τις εξετάσεις και δοκιμάστε ξανά.',
  '2019':
    'Το παραπεμπτικό έχει ήδη εκτελεστεί στον φορέα. Δεν χρειάζεται νέα εκτέλεση — μπορείτε να αντλήσετε τα αποτελέσματα ή να ακυρώσετε την εκτέλεση.',
  '421': 'Δεν βρίσκεται παραπεμπτικό με αυτό το barcode στον φορέα.',
  '439': 'Δεν βρίσκεται ασθενής με αυτό το ΑΜΚΑ στον φορέα.',
  '600': 'Το Api-Key της εφαρμογής δεν είναι έγκυρο. Ελέγξτε το EFULFILLMENT_API_KEY.',
  '601': 'Δεν έχει δημιουργηθεί σύνδεση με τον φορέα. Αποθηκεύστε ξανά τα στοιχεία σύνδεσης.',
  '603': 'Έληξε το 24ωρο όριο της σύνδεσης. Γίνεται αυτόματη ανανέωση...',
};

function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'Κενή απάντηση από τον φορέα';

  // Το gateway του φορέα (IBM Security Verify Access) επιστρέφει σελίδα HTML
  if (/^<(!doctype|html|meta)/i.test(trimmed)) {
    return 'Ο φορέας απέρριψε την αυθεντικοποίηση (401). Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας.';
  }

  try {
    const parsed = JSON.parse(trimmed);

    // Μορφή ApiError του φορέα: { code, description, type, title, status }
    if (typeof parsed?.code === 'number' || typeof parsed?.code === 'string') {
      const code = String(parsed.code);
      const mapped = ERROR_MESSAGES[code];
      const description = parsed?.description ? String(parsed.description) : '';
      if (mapped) return description ? `${mapped} (${description})` : mapped;
      if (description) return `Σφάλμα φορέα ${code}: ${description}`;
    }

    const issue = parsed?.issue?.[0]?.diagnostics || parsed?.issue?.[0]?.details?.text;
    if (issue) return String(issue);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.error) return String(parsed.error);
    if (parsed?.description) return String(parsed.description);
  } catch {
    // Όχι JSON — επιστροφή του κειμένου
  }

  return trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** GET /api/me — άντληση στοιχείων χρήστη (και δημιουργία/ανανέωση σύνδεσης) */
export async function fetchMe(
  credentials: EfulfillmentCredentials
): Promise<EfulfillmentResult<PractitionerProfile>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'AUTH', error: 'Δεν έχει οριστεί EFULFILLMENT_API_KEY' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${getBaseUrl()}/api/me`, {
      method: 'GET',
      headers: {
        Authorization: basicAuth(credentials.username, credentials.password),
        'Api-Key': apiKey,
        Accept: 'application/fhir+json,application/json',
        'Content-Type': 'application/fhir+json,application/json',
        ...(credentials.doctorIp ? { 'X-DOCTOR-IP': credentials.doctorIp } : {}),
      },
      signal: controller.signal,
    });

    const body = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        code: extractCode(res.status, body),
        error: extractMessage(body) || `Ο φορέας απάντησε με HTTP ${res.status}`,
      };
    }

    const contentType = res.headers.get('content-type') || '';
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Το gateway (IBM Security Verify Access) επιστρέφει σελίδα HTML όταν
      // η αυθεντικοποίηση δεν ολοκληρώθηκε ή όταν απαιτείται SSO.
      if (/html/i.test(contentType) || /^\s*</.test(body)) {
        return {
          ok: false,
          code: 'AUTH',
          error:
            'Ο φορέας επέστρεψε σελίδα σύνδεσης αντί για δεδομένα. ' +
            'Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας στο e-Prescription.',
        };
      }
      return { ok: false, code: 'UNKNOWN', error: 'Μη έγκυρη JSON απάντηση από τον φορέα' };
    }

    // Το FHIR μπορεί να επιστρέψει OperationOutcome με σφάλμα σε 200
    if (parsed?.resourceType === 'OperationOutcome') {
      return {
        ok: false,
        code: extractCode(res.status, body),
        error: parsed?.issue?.[0]?.diagnostics || 'Ο φορέας επέστρεψε σφάλμα (OperationOutcome)',
      };
    }

    // ApiError του φορέα (π.χ. { code: 600, description: 'Application key is not valid' })
    if (parsed?.title === 'ApiError' || typeof parsed?.code === 'number') {
      return {
        ok: false,
        code: extractCode(res.status, body),
        error: extractMessage(body),
      };
    }

    return { ok: true, data: normalizePractitionerRole(parsed) };
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

// ── Normalization ──

function identifierValue(identifiers: any[] | undefined, typeText: string): string | undefined {
  if (!Array.isArray(identifiers)) return undefined;
  const match = identifiers.find(
    i => String(i?.type?.text || '').toLowerCase() === typeText.toLowerCase()
  );
  return match?.value ? String(match.value) : undefined;
}

// ── Παραπεμπτικά (GET /api/me/referrals/nopaper) ──

export interface NopaperQuery {
  amkaOrEkaa: string;
  unitId: number;
  pin?: string;
  page?: number;
  size?: number;
  from?: string;
  to?: string;
}

function normalizeReferral(item: any): EpresReferral {
  const p = item?.patientInfo || {};
  return {
    id: item?.id ?? item?.barcode ?? '',
    barcode: String(item?.barcode || ''),
    statusId: item?.status?.id,
    statusName: item?.status?.status,
    amka: p.amka ? String(p.amka) : undefined,
    firstName: p.firstName ? String(p.firstName).trim() : undefined,
    lastName: p.lastName ? String(p.lastName).trim() : undefined,
    socialInsuranceShortName: p.socialInsuranceShortName
      ? String(p.socialInsuranceShortName)
      : undefined,
    issueDate: item?.issueDate,
    expiryDate: item?.expiryDate,
    examinationGroupId: item?.examinationGroup?.id,
    examinationGroupName: item?.examinationGroup?.name,
    isProactive: item?.isProactive,
  };
}

/** GET /api/me/referrals/nopaper — αναζήτηση παραπεμπτικών ασθενή με ΑΜΚΑ */
export async function fetchNopaperReferrals(
  credentials: EfulfillmentCredentials,
  query: NopaperQuery
): Promise<EfulfillmentResult<ReferralSearchResult>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'API_KEY', error: 'Δεν έχει οριστεί Api-Key εφαρμογής' };
  }

  const params = new URLSearchParams({
    amkaOrEkaa: query.amkaOrEkaa,
    unitId: String(query.unitId),
  });
  if (query.pin) params.set('pin', query.pin);
  if (query.page) params.set('page', String(query.page));
  if (query.size) params.set('size', String(query.size));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${getBaseUrl()}/api/me/referrals/nopaper?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: basicAuth(credentials.username, credentials.password),
        'Api-Key': apiKey,
        Accept: 'application/json',
        ...(credentials.doctorIp ? { 'X-DOCTOR-IP': credentials.doctorIp } : {}),
      },
      signal: controller.signal,
    });

    const body = await res.text();
    const contentType = res.headers.get('content-type') || '';

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (!res.ok) {
        return {
          ok: false,
          code: extractCode(res.status, body),
          error: extractMessage(body) || `Ο φορέας απάντησε με HTTP ${res.status}`,
        };
      }
      if (/html/i.test(contentType) || /^\s*</.test(body)) {
        return {
          ok: false,
          code: 'AUTH',
          error:
            'Ο φορέας επέστρεψε σελίδα σύνδεσης αντί για δεδομένα. ' +
            'Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας στο e-Prescription.',
        };
      }
      return { ok: false, code: 'UNKNOWN', error: 'Μη έγκυρη JSON απάντηση από τον φορέα' };
    }

    if (!res.ok || parsed?.title === 'ApiError' || typeof parsed?.code === 'number') {
      return {
        ok: false,
        code: extractCode(res.status, body),
        error: extractMessage(body),
      };
    }

    // Ο φορέας επιστρέφει το πεδίο `contents` (πληθυντικός) στο /referrals/nopaper
    const content: any[] = Array.isArray(parsed?.contents)
      ? parsed.contents
      : Array.isArray(parsed?.content)
      ? parsed.content
      : [];
    const referrals = content.map(normalizeReferral).filter(r => r.barcode);

    return {
      ok: true,
      data: {
        referrals,
        total: Number(parsed?.totalEntries ?? referrals.length),
        page: Number(parsed?.number ?? query.page ?? 0),
        totalPages: Number(parsed?.totalPages ?? 1),
        patientName: referrals[0]
          ? [referrals[0].firstName, referrals[0].lastName].filter(Boolean).join(' ')
          : undefined,
        unitId: query.unitId,
      },
    };
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

/**
 * Αναζήτηση παραπεμπτικών με ΑΜΚΑ χρησιμοποιώντας τα αποθηκευμένα credentials
 * και το unitId από τα στοιχεία χρήστη (/api/me).
 */export async function searchReferralsByAmka(
  userId: string,
  amkaOrEkaa: string,
  options: { pin?: string; page?: number; size?: number; from?: string; to?: string; unitId?: number } = {}
): Promise<EfulfillmentResult<ReferralSearchResult>> {
  const state = await dbService.getEfulfillmentState(userId);
  if (!state.hasCredentials) {
    return {
      ok: false,
      code: 'AUTH',
      error: 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης φορέα (Ρυθμίσεις → Στοιχεία Φορέα)',
    };
  }

  // Ο φορέας απαιτεί ενεργή σύνδεση (<24h)
  const fresh = await ensureFreshConnection(userId);
  if (fresh && !fresh.ok) {
    return { ok: false, code: fresh.code, error: fresh.error };
  }

  const latest = await dbService.getEfulfillmentState(userId);
  const rawUnitId =
    options.unitId ??
    Number(latest.profile?.userUnitId || latest.profile?.healthCareUnitId || 0);

  if (!rawUnitId || Number.isNaN(rawUnitId)) {
    return {
      ok: false,
      code: 'UNKNOWN',
      error:
        'Δεν βρέθηκε unitId στα στοιχεία χρήστη. Ανανεώστε τα στοιχεία φορέα από τις Ρυθμίσεις.',
    };
  }

  return withConnection(userId, creds =>
    fetchNopaperReferrals(creds, {
      amkaOrEkaa,
      unitId: rawUnitId,
      pin: options.pin,
      page: options.page,
      size: options.size,
      from: options.from,
      to: options.to,
    })
  );
}

// ── Άντληση παραπεμπτικού προς εκτέλεση ──

/** Εξαγωγή τιμής από extension list βάσει url suffix */
function extensionValue(extensions: any[] | undefined, urlSuffix: string): any {
  if (!Array.isArray(extensions)) return undefined;
  const ext = extensions.find(e => String(e?.url || '').toLowerCase().endsWith(urlSuffix.toLowerCase()));
  if (!ext) return undefined;
  return ext.valueString ?? ext.valueInteger ?? ext.valueMoney?.value ?? ext.valueBoolean ?? ext.valueCode;
}

/**
 * Κανονικοποίηση του ServiceRequest που επιστρέφει το
 * GET /api/referrals/{barcode}/unit/{unitId}/dispense.
 */
export function normalizeDispenseReferral(
  serviceRequest: any,
  barcode: string,
  catalogNames: Map<string, string> = new Map()
): EpresDispenseReferral {
  const contained: any[] = Array.isArray(serviceRequest?.contained) ? serviceRequest.contained : [];
  const patient = contained.find(
    c => String(c?.resourceType || '').toLowerCase() === 'patient'
  );
  const coverage = contained.find(
    c => String(c?.resourceType || '').toLowerCase() === 'coverage'
  );

  const patientName = Array.isArray(patient?.name) ? patient.name[0] : undefined;
  const given: string[] = Array.isArray(patientName?.given) ? patientName.given.map(String) : [];
  const firstName = given.length > 0 ? given.join(' ').trim() : undefined;
  const lastName = patientName?.family ? String(patientName.family).trim() : undefined;

  const telecom: any[] = Array.isArray(patient?.telecom) ? patient.telecom : [];
  const phone = telecom.find(t => t?.system === 'phone')?.value;

  // Ομάδα εξετάσεων: category[].coding[]
  let examGroupCode: string | undefined;
  let examGroupName: string | undefined;
  for (const item of Array.isArray(serviceRequest?.category) ? serviceRequest.category : []) {
    const coding = Array.isArray(item?.coding) ? item.coding[0] : undefined;
    if (coding?.code) {
      examGroupCode = String(coding.code);
      examGroupName = coding?.display ? String(coding.display) : undefined;
      break;
    }
  }

  // Γραμμές εξετάσεων
  const exams: EpresExam[] = [];
  for (const line of Array.isArray(serviceRequest?.orderDetail) ? serviceRequest.orderDetail : []) {
    const lineId = line?.id ? String(line.id) : '';
    const examId = extensionValue(line?.extension, '/examination/id');
    const rawName =
      line?.code?.text ||
      (Array.isArray(line?.code?.coding) ? line.code.coding[0]?.display : undefined) ||
      line?.display;

    const codeKey = examId !== undefined ? String(examId) : lineId;
    const name =
      (rawName && String(rawName)) ||
      catalogNames.get(codeKey) ||
      `Εξέταση ${codeKey || '—'}`;

    exams.push({
      lineId,
      examId: examId !== undefined ? String(examId) : undefined,
      name,
      rawName: rawName ? String(rawName) : undefined,
      executionPrice: (() => {
        // Το executionPrice μπορεί να επιστρέφεται χωρίς value (μόνο currency).
        // Σε αυτή την περίπτωση χρησιμοποιούμε το examinationPricePrescr.
        const direct = extensionValue(line?.extension, '/executionprice');
        const directNum = direct !== undefined && direct !== null ? Number(direct) : NaN;
        if (!Number.isNaN(directNum) && directNum > 0) return directNum;

        const prescr = extensionValue(line?.extension, '/examinationpriceprescr');
        const prescrNum = prescr !== undefined && prescr !== null ? Number(prescr) : NaN;
        if (!Number.isNaN(prescrNum) && prescrNum > 0) return prescrNum;

        return Number.isNaN(directNum) ? undefined : directNum;
      })(),
      participationAmount: (() => {
        // Ποσό συμμετοχής ασφαλισμένου για τη συγκεκριμένη γραμμή
        const value = extensionValue(line?.extension, '/participationpercentamt');
        if (value === undefined || value === null || value === '') return undefined;
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
      })(),
      prescribedPrice: (() => {
        const value = extensionValue(line?.extension, '/examinationpriceprescr');
        if (value === undefined || value === null || value === '') return undefined;
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
      })(),
    });
  }

  // Λήξη: ο φορέας τη δίνει συνήθως στο occurrenceDateTime, αλλά μπορεί να
  // εμφανιστεί και ως expiryDate ή σε extension.
  const expiryFromExtension = (() => {
    const ext: any[] = Array.isArray(serviceRequest?.extension) ? serviceRequest.extension : [];
    const found = ext.find((e: any) => {
      const url = String(e?.url || '').toLowerCase();
      return url.includes('expir') || url.includes('validuntil') || url.includes('validto');
    });
    if (!found) return undefined;
    const v =
      found.valueDateTime ?? found.valueString ?? found.valueDate ?? found.valueInstant;
    return v ? String(v) : undefined;
  })();

  const expiryCandidates = [
    serviceRequest?.occurrenceDateTime,
    serviceRequest?.expiryDate,
    expiryFromExtension,
  ]
    .filter(Boolean)
    .map(String);

  const effectiveExpiry = resolveExpiry(expiryCandidates);

  return {
    barcode,
    status: serviceRequest?.status,
    intent: serviceRequest?.intent,
    examGroupCode,
    examGroupName,
    authoredOn: serviceRequest?.authoredOn,
    occurrenceDateTime: serviceRequest?.occurrenceDateTime,
    expiryDate: serviceRequest?.expiryDate,
    expiryFromExtension,
    effectiveExpiry,
    reason: Array.isArray(serviceRequest?.reasonCode)
      ? serviceRequest.reasonCode.map((r: any) => r?.text).filter(Boolean).join(', ') || undefined
      : undefined,
    notes: Array.isArray(serviceRequest?.notes)
      ? serviceRequest.notes.map((n: any) => n?.text).filter(Boolean).join(' · ') || undefined
      : undefined,
    totalExecutions: (() => {
      const v = extensionValue(serviceRequest?.extension, '/totalexecutions');
      return v !== undefined ? Number(v) : undefined;
    })(),
    insuranceId: Array.isArray(coverage?.identifier)
      ? coverage.identifier
          .map((entry: any) => entry?.value)
          .filter(Boolean)
          .map(String)[0]
      : undefined,
    participationPercent: (() => {
      const raw = coverage?.costToBeneficiary?.[0]?.valueQuantity?.value;
      const num = raw === undefined || raw === null ? NaN : Number(raw);
      return Number.isFinite(num) ? num : undefined;
    })(),
    patient: patient
      ? {
          amka: identifierValue(patient?.identifier, 'AMKA'),
          ama: identifierValue(patient?.identifier, 'AMA'),
          firstName,
          lastName,
          fullName: [firstName, lastName].filter(Boolean).join(' ') || undefined,
          gender: patient?.gender,
          birthDate: patient?.birthDate,
          phone: phone ? String(phone) : undefined,
        }
      : undefined,
    exams,
    resourceType: serviceRequest?.resourceType,
  };
}

/** GET /api/referrals/{barcode}/unit/{unitId}/dispense — άντληση παραπεμπτικού προς εκτέλεση */
export async function fetchReferralForDispense(
  credentials: EfulfillmentCredentials,
  barcode: string,
  unitId: string,
  catalogNames: Map<string, string> = new Map()
): Promise<EfulfillmentResult<EpresDispenseReferral>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'API_KEY', error: 'Δεν έχει οριστεί Api-Key εφαρμογής' };
  }

  const url =
    `${getBaseUrl()}/api/referrals/${encodeURIComponent(barcode)}/unit/` +
    `${encodeURIComponent(unitId)}/dispense`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuth(credentials.username, credentials.password),
        'Api-Key': apiKey,
        Accept: 'application/fhir+json,application/json',
        ...(credentials.doctorIp ? { 'X-DOCTOR-IP': credentials.doctorIp } : {}),
      },
      signal: controller.signal,
    });

    const body = await res.text();
    const contentType = res.headers.get('content-type') || '';

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (!res.ok) {
        return {
          ok: false,
          code: extractCode(res.status, body),
          error: extractMessage(body) || `Ο φορέας απάντησε με HTTP ${res.status}`,
        };
      }
      if (/html/i.test(contentType) || /^\s*</.test(body)) {
        return {
          ok: false,
          code: 'AUTH',
          error:
            'Ο φορέας επέστρεψε σελίδα σύνδεσης αντί για δεδομένα. ' +
            'Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας στο e-Prescription.',
        };
      }
      return { ok: false, code: 'UNKNOWN', error: 'Μη έγκυρη JSON απάντηση από τον φορέα' };
    }

    if (!res.ok || parsed?.title === 'ApiError' || typeof parsed?.code === 'number') {
      return {
        ok: false,
        code: extractCode(res.status, body),
        error: extractMessage(body),
      };
    }

    return { ok: true, data: normalizeDispenseReferral(parsed, barcode, catalogNames) };
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

/** Αποτέλεσμα εκτέλεσης παραπεμπτικού */
export interface DispenseExecutionResult {
  barcode: string;
  /** Πόσες γραμμές εξετάσεων εκτελέστηκαν */
  executedLineIds: string[];
  /** true = ολική εκτέλεση, false = μερική */
  fullExecution: boolean;
  status?: string;
  occurredAt: string;
  /** Πρώτη ημερομηνία εκτέλεσης που επέστρεψε ο φορέας (αν υπάρχει) */
  executionNo?: string;
  /** true όταν ο φορέας επέστρεψε 2019 (ήδη εκτελεσμένο) — δεν έγινε νέα κλήση */
  alreadyExecuted?: boolean;
}

/**
 * POST /api/referrals/{barcode}/dispense — Εκτέλεση Παραπεμπτικού.
 *
 * Στέλνει ServiceRequest με τις επιλεγμένες γραμμές εξετάσεων (`orderDetail[].id`).
 * `supportingInfo.executionCaseId`: 0 = μερική εκτέλεση, 1 = ολική.
 */
export async function executeReferral(
  credentials: EfulfillmentCredentials,
  input: {
    barcode: string;
    unitId: string;
    exams: Array<{ lineId: string; executionPrice?: number }>;
    /** Όλες οι γραμμές του παραπεμπτικού επιλέχθηκαν; */
    fullExecution: boolean;
    patient?: EpresDispenseReferral['patient'];
  }
): Promise<EfulfillmentResult<DispenseExecutionResult>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'API_KEY', error: 'Δεν έχει οριστεί Api-Key εφαρμογής' };
  }

  const lines = input.exams.filter(e => String(e.lineId || '').trim());
  if (lines.length === 0) {
    return {
      ok: false,
      code: 'UNKNOWN',
      error: 'Δεν επιλέχθηκαν εξετάσεις προς εκτέλεση',
    };
  }

  const patient = input.patient;
  const identifiers: any[] = [];
  if (patient?.amka) {
    identifiers.push({ use: 'official', type: { text: 'AMKA' }, value: patient.amka });
  }
  if (patient?.ama) {
    identifiers.push({ use: 'official', type: { text: 'AMA' }, value: patient.ama });
  }

  const body = {
    resourceType: 'ServiceRequest',
    contained: [
      {
        resourceType: 'Patient',
        id: '1',
        identifier: identifiers,
        ...(patient?.lastName || patient?.firstName
          ? {
              name: [
                {
                  family: patient?.lastName || '',
                  given: patient?.firstName ? [patient.firstName] : [],
                },
              ],
            }
          : {}),
        ...(patient?.gender ? { gender: patient.gender } : {}),
        ...(patient?.birthDate ? { birthDate: patient.birthDate } : {}),
      },
    ],
    status: 'active',
    intent: 'order',
    orderDetail: lines.map(line => ({
      id: String(line.lineId),
      extension: [
        {
          url: 'www.e-prescription.gr/fhirextensions/examination/executionPrice',
          valueMoney: {
            value:
              typeof line.executionPrice === 'number' && !Number.isNaN(line.executionPrice)
                ? line.executionPrice
                : 0,
          },
        },
      ],
    })),
    subject: { reference: '#1' },
    locationCode: [{ coding: [{ code: String(input.unitId) }] }],
    code: { coding: [{ code: input.barcode }] },
    supportingInfo: [
      {
        identifier: {
          type: { text: 'executionCaseId' },
          value: input.fullExecution ? '1' : '0',
        },
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${getBaseUrl()}/api/referrals/${encodeURIComponent(input.barcode)}/dispense`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(credentials.username, credentials.password),
          'Api-Key': apiKey,
          Accept: 'application/fhir+json,application/json',
          'Content-Type': 'application/fhir+json',
          ...(credentials.doctorIp ? { 'X-DOCTOR-IP': credentials.doctorIp } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    const raw = await res.text();
    const contentType = res.headers.get('content-type') || '';

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!res.ok) {
        return {
          ok: false,
          code: extractCode(res.status, raw),
          error: extractMessage(raw) || `Ο φορέας απάντησε με HTTP ${res.status}`,
        };
      }
      if (/html/i.test(contentType) || /^\s*</.test(raw)) {
        return {
          ok: false,
          code: 'AUTH',
          error:
            'Ο φορέας επέστρεψε σελίδα σύνδεσης αντί για δεδομένα. ' +
            'Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας στο e-Prescription.',
        };
      }
      return { ok: false, code: 'UNKNOWN', error: 'Μη έγκυρη JSON απάντηση από τον φορέα' };
    }

    if (!res.ok || parsed?.title === 'ApiError' || typeof parsed?.code === 'number') {
      return {
        ok: false,
        code: extractCode(res.status, raw),
        error: extractMessage(raw),
      };
    }

    // Το αποτέλεσμα μπορεί να επιστρέψει το εκτελεσμένο παραπεμπτικό ή ShortDispenseDTO
    const executedLineIds: string[] = [];
    if (Array.isArray(parsed?.orderDetail)) {
      for (const line of parsed.orderDetail) {
        if (line?.id) executedLineIds.push(String(line.id));
      }
    }

    return {
      ok: true,
      data: {
        barcode: input.barcode,
        executedLineIds: executedLineIds.length > 0
          ? executedLineIds
          : lines.map(l => String(l.lineId)),
        fullExecution: input.fullExecution,
        status: parsed?.status,
        occurredAt: new Date().toISOString(),
        executionNo:
          parsed?.id !== undefined && parsed?.id !== null ? String(parsed.id) : undefined,
      },
    };
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

/**
 * Πλήρης ροή barcode: εκτέλεση στον φορέα για τις επιλεγμένες εξετάσεις
 * και μετά καταχώρηση σε νέα επίσκεψη.
 *
 * Αν η εκτέλεση αποτύχει, δεν γίνεται καμία εγγραφή στη βάση.
 */
export async function executeAndImportReferral(
  userId: string,
  input: {
    barcode: string;
    referral: EpresDispenseReferral;
    selectedLineIds: string[];
    doctorId?: string;
    unitId?: string;
  }
): Promise<{ ok: true; data: ImportBarcodeResult } | { ok: false; code?: string; error: string }> {
  const barcode = String(input.barcode || '').trim();
  const selected = (input.selectedLineIds || []).map(String);

  if (!barcode) return { ok: false, error: 'Απαιτείται barcode' };
  if (selected.length === 0) {
    return { ok: false, error: 'Επιλέξτε τουλάχιστον μία εξέταση προς εκτέλεση' };
  }

  // Διπλοεγγραφή;
  const existing = await dbService.getReferral(`referral_epres_${barcode}`);
  if (existing) {
    return { ok: false, code: 'ALREADY_IMPORTED', error: `Το παραπεμπτικό ${barcode} έχει ήδη καταχωρηθεί` };
  }

  // Λήξη;
  const expiry =
    input.referral.effectiveExpiry ||
    input.referral.occurrenceDateTime ||
    input.referral.expiryDate;
  if (isReferralExpired(expiry)) {
    return {
      ok: false,
      code: 'EXPIRED',
      error: `Το παραπεμπτικό ${barcode} έχει λήξει και δεν μπορεί να εκτελεστεί`,
    };
  }

  // Σύνδεση με τον φορέα
  const fresh = await ensureFreshConnection(userId);
  if (fresh && !fresh.ok) {
    return { ok: false, code: fresh.code, error: fresh.error || 'Σφάλμα σύνδεσης με τον φορέα' };
  }

  const latest = await dbService.getEfulfillmentState(userId);
  const unitId = String(
    input.unitId || latest.profile?.userUnitId || latest.profile?.healthCareUnitId || ''
  );
  if (!unitId) {
    return {
      ok: false,
      error:
        'Δεν βρέθηκε unitId στα στοιχεία χρήστη. Ανανεώστε τα στοιχεία φορέα από τις Ρυθμίσεις.',
    };
  }

  // Επιλεγμένες γραμμές από το ανακτηθέν παραπεμπτικό
  const selectedExams = input.referral.exams.filter(e => selected.includes(String(e.lineId)));
  if (selectedExams.length === 0) {
    return { ok: false, error: 'Οι επιλεγμένες εξετάσεις δεν βρέθηκαν στο παραπεμπτικό' };
  }

  const fullExecution = selectedExams.length === input.referral.exams.length;

  // 1) Εκτέλεση στον φορέα
  const exec = await withConnection(userId, creds =>
    executeReferral(creds, {
      barcode,
      unitId,
      exams: selectedExams.map(e => ({ lineId: e.lineId, executionPrice: e.executionPrice })),
      fullExecution,
      patient: input.referral.patient,
    })
  );

  if (!exec.ok) {
    // 2019: το παραπεμπτικό έχει ήδη εκτελεστεί στον φορέα.
    // Δεν ξανα-execute-άρουμε — γίνεται απευθείας καταχώρηση ως εκτελεσμένο.
    if (exec.code === 'ALREADY_EXECUTED' || exec.code === '2019') {
      try {
        const data = await importReferralAsVisit({
          barcode,
          referral: input.referral,
          doctorId: input.doctorId,
          selectedLineIds: selected,
          execution: {
            barcode,
            fullExecution: true,
            occurredAt: new Date().toISOString(),
            executedLineIds: selected,
            alreadyExecuted: true,
          },
        });
        return { ok: true, data };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Σφάλμα καταχώρησης' };
      }
    }

    return {
      ok: false,
      code: exec.code,
      error: exec.error || 'Η εκτέλεση του παραπεμπτικού απέτυχε στον φορέα',
    };
  }

  // 2) Καταχώρηση (μόνο οι εκτελεσμένες εξετάσεις)
  try {
    const data = await importReferralAsVisit({
      barcode,
      referral: input.referral,
      doctorId: input.doctorId,
      selectedLineIds: selected,
      execution: exec.data,
    });
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Σφάλμα καταχώρησης' };
  }
}

/** Αποτέλεσμα ακύρωσης εκτέλεσης */
export interface CancelExecutionResult {
  barcode: string;
  /** true = ακύρωση ολικής εκτέλεσης, false = ακύρωση μερικής */
  fullCancellation: boolean;
  executionNo?: string;
  cancelledAt: string;
}

/**
 * POST /api/referrals/{barcode}/dispense/cancel
 * ή POST /api/referrals/{barcode}/dispense/cancel-part/{executionNo}
 *
 * Αποχαρακτηρίζει την εκτέλεση παραπεμπτικού στον φορέα.
 */
export async function cancelReferralExecution(
  credentials: EfulfillmentCredentials,
  input: { barcode: string; fullCancellation: boolean; executionNo?: string }
): Promise<EfulfillmentResult<CancelExecutionResult>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'API_KEY', error: 'Δεν έχει οριστεί Api-Key εφαρμογής' };
  }

  if (!input.fullCancellation && !input.executionNo) {
    return {
      ok: false,
      code: 'UNKNOWN',
      error: 'Απαιτείται αριθμός εκτέλεσης (executionNo) για ακύρωση μερικής εκτέλεσης',
    };
  }

  const url = input.fullCancellation
    ? `${getBaseUrl()}/api/referrals/${encodeURIComponent(input.barcode)}/dispense/cancel`
    : `${getBaseUrl()}/api/referrals/${encodeURIComponent(input.barcode)}/dispense/cancel-part/` +
      encodeURIComponent(String(input.executionNo));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(credentials.username, credentials.password),
        'Api-Key': apiKey,
        Accept: 'application/fhir+json,application/json',
        'Content-Type': 'application/fhir+json',
        ...(credentials.doctorIp ? { 'X-DOCTOR-IP': credentials.doctorIp } : {}),
      },
      signal: controller.signal,
    });

    const raw = await res.text();
    const contentType = res.headers.get('content-type') || '';

    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      if (!res.ok) {
        return {
          ok: false,
          code: extractCode(res.status, raw),
          error: extractMessage(raw) || `Ο φορέας απάντησε με HTTP ${res.status}`,
        };
      }
      if (/html/i.test(contentType) || /^\s*</.test(raw)) {
        return {
          ok: false,
          code: 'AUTH',
          error:
            'Ο φορέας επέστρεψε σελίδα σύνδεσης αντί για δεδομένα. ' +
            'Ελέγξτε τα στοιχεία σύνδεσης ή την καταχώρηση της IP σας στο e-Prescription.',
        };
      }
      return { ok: false, code: 'UNKNOWN', error: 'Μη έγκυρη JSON απάντηση από τον φορέα' };
    }

    if (!res.ok || parsed?.title === 'ApiError' || (parsed && typeof parsed?.code === 'number')) {
      return {
        ok: false,
        code: extractCode(res.status, raw),
        error: extractMessage(raw),
      };
    }

    return {
      ok: true,
      data: {
        barcode: input.barcode,
        fullCancellation: input.fullCancellation,
        executionNo: input.executionNo,
        cancelledAt: new Date().toISOString(),
      },
    };
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

/** Έλεγχος αν υπάρχουν καταχωρημένα αποτελέσματα σε εξετάσεις */
function hasAnyResults(exams: Exam[]): boolean {
  return exams.some(exam => {
    if (typeof exam.result === 'string' && exam.result.trim() !== '') return true;
    if (Array.isArray(exam.parameters)) {
      return exam.parameters.some(
        p => typeof p.result === 'string' && p.result.trim() !== ''
      );
    }
    return false;
  });
}

export interface CancelReferralOutcome {
  referral: Referral;
  exams: Exam[];
  cancellation: CancelExecutionResult;
}

/** Σφάλματα ακύρωσης με κωδικό για το route */
export class CancelNotAllowedError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'CancelNotAllowedError';
  }
}

/**
 * Αποχαρακτηρίζει την εκτέλεση ενός παραπεμπτικού που έχει καταχωρηθεί από barcode.
 *
 * - Επιτρέπεται μόνο όταν το παραπεμπτικό είναι `partially_executed` ή `fully_executed`
 * - **Δεν επιτρέπεται** αν έχει καταχωρηθεί έστω και ένα αποτέλεσμα σε εξέταση
 * - Ολική εκτέλεση → `POST …/dispense/cancel`
 *   Μερική εκτέλεση → `POST …/dispense/cancel-part/{executionNo}`
 * - Μετά την επιτυχή ακύρωση, το παραπεμπτικό επιστρέφει σε `pending` και οι εξετάσεις
 *   σε `ordered`, ώστε να μπορούν να εκτελεστούν ξανά.
 */
export async function cancelImportedReferral(
  userId: string,
  referralId: string
): Promise<CancelReferralOutcome> {
  const referral = await dbService.getReferral(referralId);
  if (!referral) {
    throw new CancelNotAllowedError('Το παραπεμπτικό δεν βρέθηκε', 'NOT_FOUND');
  }

  const status = String(referral.status);
  const isFully = status === 'fully_executed';
  const isPartially = status === 'partially_executed';

  if (!isFully && !isPartially) {
    throw new CancelNotAllowedError(
      'Το παραπεμπτικό δεν έχει εκτελεστεί, οπότε δεν υπάρχει εκτέλεση προς ακύρωση',
      'NOT_EXECUTED'
    );
  }

  const exams = await dbService.listExams(referralId);
  if (hasAnyResults(exams)) {
    throw new CancelNotAllowedError(
      'Έχουν καταχωρηθεί αποτελέσματα σε εξετάσεις του παραπεμπτικού — δεν είναι δυνατή η ακύρωση εκτέλεσης',
      'RESULTS_ENTERED'
    );
  }

  const barcode = referralId.replace(/^referral_epres_/, '');
  const anyReferral = referral as any;
  const executionNo: string | undefined = anyReferral.executionNo
    ? String(anyReferral.executionNo)
    : undefined;

  // Σύνδεση με τον φορέα
  const fresh = await ensureFreshConnection(userId);
  if (fresh && !fresh.ok) {
    throw new CancelNotAllowedError(
      fresh.error || 'Σφάλμα σύνδεσης με τον φορέα',
      fresh.code || 'AUTH'
    );
  }

  const fullCancellation = isFully;

  if (!fullCancellation && !executionNo) {
    throw new CancelNotAllowedError(
      'Δεν βρέθηκε αριθμός εκτέλεσης (executionNo) για ακύρωση μερικής εκτέλεσης',
      'NO_EXECUTION_NO'
    );
  }

  const result = await withConnection(userId, creds =>
    cancelReferralExecution(creds, { barcode, fullCancellation, executionNo })
  );

  if (!result.ok) {
    throw new CancelNotAllowedError(
      result.error || 'Η ακύρωση απέτυχε στον φορέα',
      result.code || 'CANCEL_FAILED'
    );
  }

  // Ενημέρωση βάσης: παραπεμπτικό → pending, εξετάσεις → ordered
  const now = new Date().toISOString();
  const cleanedNotes = (referral.notes || '')
    .split(' · ')
    .filter(part => !part.startsWith('Εκτέλεση φορέα:'))
    .join(' · ');

  const updatedReferral = await dbService.saveReferral({
    ...referral,
    status: 'pending' as any,
    notes: cleanedNotes,
    updatedAt: now,
    // Καθαρισμός στοιχείων εκτέλεσης — το παραπεμπτικό μπορεί να εκτελεστεί ξανά
    executionNo: undefined,
    executionType: undefined,
    executedLineIds: undefined,
    executedAt: undefined,
  } as any);

  const updatedExams: Exam[] = [];
  for (const exam of exams) {
    const examNotes = (exam.notes || '')
      .split(' · ')
      .filter(part => !part.startsWith('Εκτελέστηκε στον φορέα'))
      .join(' · ');

    const updated = await dbService.saveExam({
      ...exam,
      status: 'ordered' as any,
      notes: examNotes || undefined,
      updatedAt: now,
    } as any);
    updatedExams.push(updated);
  }

  // Η συμμετοχή του ασθενούς και η αποζημίωση φορέα δεν οφείλονται πλέον
  try {
    await cancelPatientShareReceivable(referralId);
    await cancelPayerReimbursementReceivable(referralId);
  } catch (err: any) {
    console.warn('Finance receivables cancellation failed:', err?.message || err);
  }

  return { referral: updatedReferral, exams: updatedExams, cancellation: result.data! };
}

/**
 * Άντληση παραπεμπτικού με barcode, με έλεγχο αν έχει ήδη καταχωρηθεί
 * (id = referral_epres_<barcode>) και αν έχει λήξει.
 */
export async function searchReferralByBarcode(
  userId: string,
  barcode: string,
  options: { unitId?: string } = {}
): Promise<EfulfillmentResult<DispenseSearchResult>> {
  const state = await dbService.getEfulfillmentState(userId);
  if (!state.hasCredentials) {
    return {
      ok: false,
      code: 'AUTH',
      error: 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης φορέα (Ρυθμίσεις → Στοιχεία Φορέα)',
    };
  }

  const fresh = await ensureFreshConnection(userId);
  if (fresh && !fresh.ok) {
    return { ok: false, code: fresh.code, error: fresh.error };
  }

  const latest = await dbService.getEfulfillmentState(userId);
  const unitId = String(
    options.unitId ||
      latest.profile?.userUnitId ||
      latest.profile?.healthCareUnitId ||
      ''
  );

  if (!unitId) {
    return {
      ok: false,
      code: 'UNKNOWN',
      error:
        'Δεν βρέθηκε unitId στα στοιχεία χρήστη. Ανανεώστε τα στοιχεία φορέα από τις Ρυθμίσεις.',
    };
  }

  // Έλεγχος διπλοεγγραφής πριν την κλήση
  const existing = await dbService.getReferral(`referral_epres_${barcode}`);

  // Ονόματα εξετάσεων από τον τοπικό κατάλογο (enrichment)
  const result = await withConnection(userId, creds =>
    fetchReferralForDispense(creds, barcode, unitId)
  );

  if (!result.ok) {
    return { ok: false, code: result.code, error: result.error };
  }

  // Εμπλουτισμός ονομάτων από exam_catalog όπου λείπει
  const referral = result.data!;
  const unknownCodes = referral.exams
    .filter(e => !e.rawName && e.examId)
    .map(e => String(e.examId));
  if (unknownCodes.length > 0) {
    const names = await dbService.getExamCatalogNames(unknownCodes);
    for (const exam of referral.exams) {
      if (!exam.rawName && exam.examId && names.has(exam.examId)) {
        exam.name = names.get(exam.examId)!;
      }
    }
  }

  // Ο ασθενής υπάρχει ήδη στη βάση με αυτό το ΑΜΚΑ;
  const providerAmka = String(referral.patient?.amka || referral.patient?.ama || '');
  const existingPatient = providerAmka
    ? await dbService.findPatientByAmka(providerAmka)
    : await dbService.findPatientByNameAndDob(
        referral.patient?.firstName || '',
        referral.patient?.lastName || '',
        referral.patient?.birthDate
      );

  return {
    ok: true,
    data: {
      referral,
      unitId,
      alreadyImported: Boolean(existing),
      existingReferralId: existing?.id,
      existingVisitId: existing?.visitId,
      expired: isReferralExpired(referral.effectiveExpiry),
      daysUntilExpiry: daysUntilExpiry(referral.effectiveExpiry),
      expiryMessage: expiryStatusMessage(referral.effectiveExpiry),
      existingPatient: existingPatient
        ? {
            id: existingPatient.id,
            firstName: existingPatient.firstName,
            lastName: existingPatient.lastName,
            dateOfBirth: existingPatient.dateOfBirth,
            gender: existingPatient.gender,
            amka: existingPatient.amka,
          }
        : null,
    },
  };
}

export function normalizePractitionerRole(role: any): PractitionerProfile {
  const contained: any[] = Array.isArray(role?.contained) ? role.contained : [];

  const byType = (type: string) =>
    contained.find(c => String(c?.resourceType || '').toLowerCase() === type.toLowerCase());
  const allByType = (type: string) =>
    contained.filter(c => String(c?.resourceType || '').toLowerCase() === type.toLowerCase());

  const practitioner = byType('Practitioner');
  const organization = byType('Organization');
  const location = byType('Location');
  const services = allByType('HealthcareService');

  const name = Array.isArray(practitioner?.name) ? practitioner.name[0] : undefined;
  const given: string[] = Array.isArray(name?.given) ? name.given.map(String) : [];
  const lastName = name?.family ? String(name.family) : undefined;
  const firstName = given.length > 0 ? given.join(' ') : undefined;

  const telecom: any[] = Array.isArray(practitioner?.telecom) ? practitioner.telecom : [];
  const phone = telecom.find(t => t?.system === 'phone' && t?.use !== 'mobile')?.value;
  const mobile = telecom.find(t => t?.system === 'phone' && t?.use === 'mobile')?.value;
  const email = telecom.find(t => t?.system === 'email')?.value;

  // Ειδικότητες (μπορεί να λείπουν)
  const specialties: string[] = [];
  for (const item of Array.isArray(role?.specialty) ? role.specialty : []) {
    for (const coding of Array.isArray(item?.coding) ? item.coding : []) {
      if (coding?.display) specialties.push(String(coding.display));
      else if (coding?.code) specialties.push(String(coding.code));
    }
  }

  // Το ΑΦΜ επιστρέφεται ως `TaxNumber` στον Practitioner ή ως `AFM` στο Location
  const afm =
    identifierValue(practitioner?.identifier, 'TaxNumber') ||
    identifierValue(practitioner?.identifier, 'AFM') ||
    identifierValue(practitioner?.identifier, 'ΑΦΜ') ||
    identifierValue(location?.identifier, 'AFM') ||
    identifierValue(location?.identifier, 'TaxNumber');

  // Χαρακτηριστικά μονάδας από HealthcareService.characteristic[].coding[]
  const characteristics: any[] = [];
  for (const item of Array.isArray(services[0]?.characteristic) ? services[0].characteristic : []) {
    for (const coding of Array.isArray(item?.coding) ? item.coding : []) {
      characteristics.push(coding);
    }
  }
  const characteristicCode = (display: string) =>
    characteristics.find(c => String(c?.display || '').toLowerCase() === display.toLowerCase())?.code;

  const isExamCenter = characteristicCode('isExamCenter');
  const canExecuteExam = characteristicCode('canExecuteExam');
  const canAddExamResults = characteristicCode('canAddExamResults');
  const healthCareUnitId = characteristicCode('healthCareUnitId');
  const isPublicHealthProvider = characteristicCode('isPublicHealthProvider');

  const addressLine = Array.isArray(location?.address?.[0]?.line)
    ? location.address[0].line.join(', ')
    : location?.address?.[0]?.text;
  const addressCity = location?.address?.[0]?.city;
  const address = [addressLine, addressCity].filter(Boolean).join(', ') || undefined;

  return {
    amka: identifierValue(practitioner?.identifier, 'AMKA'),
    afm,
    practitionerId: identifierValue(practitioner?.identifier, 'ID'),
    etaaRegNo: identifierValue(practitioner?.identifier, 'etaaRegNo'),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' ') || undefined,
    gender: practitioner?.gender,
    birthDate: practitioner?.birthDate,
    phone: phone ? String(phone) : undefined,
    mobile: mobile ? String(mobile) : undefined,
    email: email ? String(email) : undefined,
    specialties,
    organizationId: organization?.id ? String(organization.id) : undefined,
    organizationName: organization?.name
      ? String(organization.name)
      : services[0]?.name
      ? String(services[0].name)
      : undefined,
    healthcareServices: services
      .map(s => (s?.name ? String(s.name) : s?.id ? String(s.id) : null))
      .filter((v): v is string => Boolean(v)),
    examCenterId: identifierValue(location?.identifier, 'examCenterId'),
    userUnitId: identifierValue(services[0]?.identifier, 'userUnitId'),
    healthCareUnitId: healthCareUnitId ? String(healthCareUnitId) : undefined,
    isExamCenter: isExamCenter === 'true' || isExamCenter === true,
    canExecuteExam: canExecuteExam === 'true' || canExecuteExam === true,
    canAddExamResults: canAddExamResults === 'true' || canAddExamResults === true,
    isPublicHealthProvider: isPublicHealthProvider === 'true' || isPublicHealthProvider === true,
    address,
    resourceType: role?.resourceType,
    fetchedAt: new Date().toISOString(),
  };
}
// ── Persistence + sync orchestration ──

export async function syncUser(
  userId: string,
  options: { force?: boolean } = {}
): Promise<EfulfillmentResult<PractitionerProfile>> {
  const creds = await dbService.getEfulfillmentCredentials(userId);
  if (!creds) {
    return { ok: false, code: 'AUTH', error: 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης φορέα' };
  }

  const result = await fetchMe(creds);
  const now = new Date();

  if (result.ok && result.data) {
    await dbService.saveEfulfillmentSync(userId, result.data, now, null);
    return result;
  }

  await dbService.saveEfulfillmentSync(userId, null, null, result.error || 'Άγνωστο σφάλμα', now);

  // Το 603 σημαίνει ότι έληξε το 24ωρο: η επόμενη κλήση /api/me το ανανεώνει.
  // Το κάναμε ήδη με το fetchMe, οπότε δεν χρειάζεται δεύτερη προσπάθεια εδώ.
  return result;
}

/**
 * Εξασφαλίζει έγκυρη σύνδεση με τον φορέα.
 * Καλεί /api/me αν δεν έχει γίνει ποτέ ή αν πέρασε το διάστημα ανανέωσης.
 */
export async function ensureFreshConnection(
  userId: string,
  options: { maxAgeMs?: number } = {}
): Promise<EfulfillmentResult<PractitionerProfile> | null> {
  const state = await dbService.getEfulfillmentState(userId);
  if (!state.hasCredentials) return null;

  const maxAge = options.maxAgeMs ?? REFRESH_INTERVAL_MS;
  const lastSync = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
  const age = Date.now() - lastSync;

  if (lastSync > 0 && age < maxAge) {
    return { ok: true, data: state.profile ?? undefined };
  }

  return syncUser(userId);
}

/**
 * Εκτελεί μια κλήση προς τον φορέα· αν επιστρέψει 603 (έληξε το 24ωρο),
 * ανανεώνει τη σύνδεση με /api/me και επαναλαμβάνει μία φορά.
 * Χρησιμοποιείται από τα endpoints που απαιτούν ενεργή σύνδεση.
 */
export async function withConnection<T>(
  userId: string,
  call: (creds: EfulfillmentCredentials) => Promise<EfulfillmentResult<T>>
): Promise<EfulfillmentResult<T>> {
  const creds = await dbService.getEfulfillmentCredentials(userId);
  if (!creds) {
    return { ok: false, code: 'AUTH', error: 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης φορέα' };
  }

  const first = await call(creds);
  if (first.ok || first.code !== '603') return first;

  // Ανανέωση σύνδεσης και επανάληψη
  const refresh = await syncUser(userId, { force: true });
  if (!refresh.ok) return first;

  return call(creds);
}

/** Λίστα χρηστών που χρειάζονται προληπτική ανανέωση */
export async function listStaleUsers(olderThanMs = REFRESH_INTERVAL_MS): Promise<string[]> {
  return dbService.listEfulfillmentStaleUsers(olderThanMs);
}

// ── Εισαγωγή παραπεμπτικών ως επίσκεψη ──

export const IMPORT_VISIT_REASON = 'Άυλη συνταγογράφηση';

export interface ImportReferralsInput {
  amka: string;
  /** Επιλεγμένα παραπεμπτικά από την αναζήτηση */
  referrals: EpresReferral[];
  patient?: {
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
    gender?: 'MALE' | 'FEMALE' | 'OTHER';
  };
  doctorId?: string;
  /** Better Auth user id — απαιτείται για ανάκτηση της συμμετοχής από τον φορέα */
  userId?: string;
}

export interface ImportReferralsResult {
  patient: Patient;
  patientCreated: boolean;
  visit: Visit;
  referrals: Referral[];
  skipped: number;
}

function toIsoDate(value?: string): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/** true αν η ημερομηνία λήξης έχει περάσει (συγκρίνει μόνο ημερομηνία, όχι ώρα) */
export function isReferralExpired(expiryDate?: string): boolean {
  if (!expiryDate) return false; // χωρίς ημερομηνία λήξης → δεν θεωρείται ληγμένο
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDay = new Date(expiry);
  expiryDay.setHours(0, 0, 0, 0);

  return expiryDay.getTime() < today.getTime();
}

/**
 * Επιλέγει την πραγματική ημερομηνία λήξης από όποιο πεδίο τη δίνει ο φορέας.
 * Σειρά προτεραιότητας: occurrenceDateTime → expiryDate → extension.
 * Επιστρέφει την νωρίτερη έγκυρη ημερομηνία που βρέθηκε.
 */
export function resolveExpiry(
  candidates: Array<string | undefined>
): string | undefined {
  const valid = candidates
    .filter((v): v is string => Boolean(v))
    .filter(v => !Number.isNaN(new Date(v).getTime()));

  if (valid.length === 0) return undefined;

  // Η νωρίτερη λήξη είναι η δεσμευτική
  return valid.reduce((earliest, current) =>
    new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
  );
}

/** Ημέρες μέχρι τη λήξη (αρνητικό = έχει λήξει), ή undefined αν δεν υπάρχει λήξη */
export function daysUntilExpiry(expiryDate?: string): number | undefined {
  if (!expiryDate) return undefined;
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return undefined;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDay = new Date(expiry);
  expiryDay.setHours(0, 0, 0, 0);

  return Math.round((expiryDay.getTime() - today.getTime()) / 86400000);
}

/** Μήνυμα κατάστασης λήξης για το UI */
export function expiryStatusMessage(expiryDate?: string): string {
  const days = daysUntilExpiry(expiryDate);
  if (days === undefined) return 'Δεν δίνεται ημερομηνία λήξης από τον φορέα';
  if (days < 0) return `Έληξε πριν ${Math.abs(days)} ημέρα(ες)`;
  if (days === 0) return 'Λήγει σήμερα';
  return `Λήγει σε ${days} ημέρα(ες)`;
}

/**
 * Εντοπίζει τον ασθενή με ΑΜΚΑ και, αν δεν υπάρχει, τον δημιουργεί.
 * Αν ο φορέας δεν δώσει ΑΜΚΑ, γίνεται fallback σε ονοματεπώνυμο + ημ. γέννησης
 * ώστε να μην δημιουργούνται διπλότυπα.
 */
export async function resolvePatientForImport(input: {
  amka?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  doctorId?: string;
}): Promise<{ patient: Patient; created: boolean }> {
  const amkaDigits = String(input.amka || '').replace(/\D/g, '');
  const firstName = input.firstName?.trim() || 'Άγνωστο';
  const lastName = input.lastName?.trim() || 'Άγνωστο';

  if (amkaDigits) {
    const found = await dbService.findPatientByAmka(amkaDigits);
    if (found) return { patient: found, created: false };
  } else {
    // Χωρίς ΑΜΚΑ: fallback σε ονοματεπώνυμο + ημ. γέννησης
    const byName = await dbService.findPatientByNameAndDob(
      firstName,
      lastName,
      input.dateOfBirth
    );
    if (byName) return { patient: byName, created: false };
  }

  const genderMap: Record<string, 'MALE' | 'FEMALE' | 'OTHER'> = {
    male: 'MALE',
    female: 'FEMALE',
    MALE: 'MALE',
    FEMALE: 'FEMALE',
    OTHER: 'OTHER',
  };

  const patient = await dbService.savePatient({
    id: `patient_${Date.now()}`,
    firstName,
    lastName,
    dateOfBirth: input.dateOfBirth || '',
    gender: genderMap[String(input.gender || '')] || 'OTHER',
    amka: amkaDigits || undefined,
    doctorId: input.doctorId,
  } as any);

  return { patient, created: true };
}

export interface ImportReferralsResult {
  patient: Patient;
  patientCreated: boolean;
  visit: Visit;
  referrals: Referral[];
  skipped: number;
  /** Barcodes που δεν καταχωρήθηκαν επειδή έχουν λήξει */
  expired: string[];
}

// ── Εισαγωγή μεμονωμένου παραπεμπτικού (barcode) ──

export interface ImportBarcodeResult {
  patient: Patient;
  patientCreated: boolean;
  visit: Visit;
  referral: Referral;
  exams: Exam[];
  /** Αποτέλεσμα εκτέλεσης στον φορέα (αν ζητήθηκε) */
  execution?: DispenseExecutionResult;
  /** Απαίτηση συμμετοχής ασθενούς που δημιουργήθηκε στο Ταμείο (αν υπάρχει ποσό) */
  patientShare?: FinanceEntry | null;
  /** Απαίτηση αποζημίωσης από τον ασφαλιστικό φορέα (αν υπάρχει ποσό) */
  payerShare?: FinanceEntry | null;
}

/**
 * Δημιουργεί νέα επίσκεψη «Άυλη συνταγογράφηση» για σήμερα, καταχωρεί το
 * παραπεμπτικό (barcode) και τις εξετάσεις του.
 * Αποτρέπει διπλοεγγραφή: αν υπάρχει ήδη `referral_epres_<barcode>`, πετάει σφάλμα.
 */
export async function importReferralAsVisit(input: {
  barcode: string;
  referral: EpresDispenseReferral;
  doctorId?: string;
  /** Αν οριστεί, καταχωρούνται μόνο αυτές οι γραμμές εξετάσεων */
  selectedLineIds?: string[];
  /** Αποτέλεσμα εκτέλεσης στον φορέα (προαιρετικό, για ενημέρωση των σημειώσεων) */
  execution?: DispenseExecutionResult;
}): Promise<ImportBarcodeResult> {
  const barcode = String(input.barcode || '').trim();
  if (!barcode) throw new Error('Απαιτείται barcode');

  const referralId = `referral_epres_${barcode}`;
  const existing = await dbService.getReferral(referralId);
  if (existing) {
    throw new Error(`Το παραπεμπτικό ${barcode} έχει ήδη καταχωρηθεί`);
  }

  const ref = input.referral;
  const expiry = ref.effectiveExpiry || ref.occurrenceDateTime || ref.expiryDate;
  if (isReferralExpired(expiry)) {
    throw new Error(`Το παραπεμπτικό ${barcode} έχει λήξει και δεν μπορεί να καταχωρηθεί`);
  }

  const amka = ref.patient?.amka || ref.patient?.ama || '';
  const firstName = ref.patient?.firstName?.trim() || 'Άγνωστο';
  const lastName = ref.patient?.lastName?.trim() || 'Άγνωστο';
  const patientName = `${firstName} ${lastName}`.trim();

  // 1) Ασθενής: εύρεση με ΑΜΚΑ (ή ονοματεπώνυμο ως fallback) ή δημιουργία
  const resolved = await resolvePatientForImport({
    amka,
    firstName,
    lastName,
    dateOfBirth: ref.patient?.birthDate,
    gender: ref.patient?.gender,
    doctorId: input.doctorId,
  });
  const patient = resolved.patient;
  const patientCreated = resolved.created;

  // 2) Νέα επίσκεψη για σήμερα
  const now = new Date().toISOString();
  const visitDate = now.slice(0, 10);
  const examCount = ref.exams.length;

  const visit = await dbService.saveVisit({
    id: `visit_${Date.now()}`,
    patientId: patient.id,
    patientName,
    visitDate,
    reason: IMPORT_VISIT_REASON,
    notes:
      `Εισαγωγή παραπεμπτικού ${barcode} από e-Prescription` +
      (examCount > 0 ? ` · ${examCount} εξέταση(εις)` : '') +
      (amka ? ` · ΑΜΚΑ ${amka}` : ''),
    doctorId: input.doctorId,
    status: 'in_progress' as any,
    createdAt: now,
    updatedAt: now,
  } as any);

  // 3) Παραπεμπτικό
  const noteParts = [`Barcode: ${barcode}`];
  if (ref.status) noteParts.push(`Κατάσταση: ${ref.status}`);
  if (ref.authoredOn) noteParts.push(`Έκδοση: ${toIsoDate(ref.authoredOn)}`);
  const refExpiry = ref.effectiveExpiry || ref.occurrenceDateTime || ref.expiryDate;
  if (refExpiry) noteParts.push(`Λήξη: ${toIsoDate(refExpiry)}`);
  if (ref.reason) noteParts.push(`Αιτιολογία: ${ref.reason}`);
  if (ref.notes) noteParts.push(ref.notes);
  if (input.execution) {
    noteParts.push(
      `Εκτέλεση φορέα: ${input.execution.fullExecution ? 'ολική' : 'μερική'} ` +
        `(${input.execution.executedLineIds.length} εξετάσεις)` +
        (input.execution.executionNo ? ` · executionNo ${input.execution.executionNo}` : '')
    );
  }

  const specialty =
    ref.examGroupName || ref.reason || 'Άυλη συνταγογράφηση';
  const reason = ref.examGroupName || ref.reason || `Παραπεμπτικό ${barcode}`;

    // Κατάσταση παραπεμπτικού: «Σε εξέλιξη — Μερικώς/Ολικώς Εκτελεσμένο»
    const referralStatus = !input.execution
      ? ('pending' as any)
      : input.execution.fullExecution
      ? ('fully_executed' as any)
      : ('partially_executed' as any);

  const referral = await dbService.saveReferral({
    id: referralId,
    visitId: visit.id,
    patientId: patient.id,
    patientName,
    visitReason: visit.reason,
    specialty,
    reason,
    hospital: '',
    referralDate: toIsoDate(ref.authoredOn),
    status: referralStatus,
    notes: noteParts.join(' · '),
    reportUrl: '',
    doctorId: input.doctorId,
    createdAt: now,
    updatedAt: now,
    // Στοιχεία εκτέλεσης (χρειάζονται για ακύρωση μερικής εκτέλεσης)
    ...(input.execution
      ? {
          barcode,
          executionNo: input.execution.executionNo,
          executionType: input.execution.fullExecution ? 'full' : 'partial',
          executedLineIds: input.execution.executedLineIds,
          executedAt: input.execution.occurredAt,
        }
      : {}),
  } as any);

  // 4) Εξετάσεις του παραπεμπτικού (μόνο οι επιλεγμένες γραμμές)
  const selected = new Set((input.selectedLineIds || []).map(String));
  const examRows =
    selected.size > 0 ? ref.exams.filter(e => selected.has(String(e.lineId))) : ref.exams;

  const exams: Exam[] = [];
  for (let i = 0; i < examRows.length; i++) {
    const e = examRows[i];
    let exam = {
      id: `exam_epres_${barcode}_${e.examId || e.lineId || i}`,
      referralId: referral.id,
      visitId: visit.id,
      patientId: patient.id,
      patientName,
      name: e.name,
      category: ref.examGroupName || 'Άυλη συνταγογράφηση',
      // Μετά την εκτέλεση οι εξετάσεις είναι «Σε εξέλιξη» (αναμονή αποτελεσμάτων)
      status: input.execution ? ('in_progress' as any) : ('ordered' as any),
      notes: [
        e.examId ? `Κωδικός εξέτασης: ${e.examId}` : null,
        e.lineId ? `lineId: ${e.lineId}` : null,
        input.execution ? `Εκτελέστηκε στον φορέα ${toIsoDate(input.execution.occurredAt)}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
      examCode: e.examId,
      doctorId: input.doctorId,
      createdAt: now,
      updatedAt: now,
    } as Exam;

    // Παράμετροι από το Master Data (νέα εξέταση → prefill)
    try {
      exam = await examParameters.prefillExam(exam);
    } catch (err) {
      console.warn('Exam parameter prefill failed (συνεχίζουμε χωρίς):', err);
    }

    const saved = await dbService.saveExam(exam);
    exams.push(saved);
  }

  // 5) Συμμετοχή ασθενούς + αποζημίωση φορέα → απαιτήσεις στο Ταμείο
  const shares = await createReferralReceivables({
    referralId: referral.id,
    referralBarcode: barcode,
    patientId: patient.id,
    patientName,
    exams: examRows,
    insuranceId: ref.insuranceId,
    issueDate: input.execution?.occurredAt
      ? toIsoDate(input.execution.occurredAt)
      : toIsoDate(now),
    executionNo: input.execution?.executionNo,
    doctorId: input.doctorId,
  });

  return {
    patient,
    patientCreated,
    visit,
    referral,
    exams,
    execution: input.execution,
    patientShare: shares.patientShare,
    payerShare: shares.payerShare,
  };
}

/**
 * Δημιουργεί τις απαιτήσεις του παραπεμπτικού στο Ταμείο:
 * συμμετοχή ασθενούς και αποζημίωση από τον ασφαλιστικό φορέα.
 * Δεν διακόπτει τη ροή καταχώρησης αν αποτύχει.
 */
async function createReferralReceivables(args: {
  referralId: string;
  referralBarcode?: string;
  patientId: string;
  patientName?: string;
  exams: EpresExam[];
  insuranceId?: string;
  issueDate?: string;
  executionNo?: string;
  doctorId?: string;
  /** Η αποζημίωση φορέα δημιουργείται μόνο όταν το παραπεμπτικό έχει εκτελεστεί */
  includePayer?: boolean;
}): Promise<{ patientShare: FinanceEntry | null; payerShare: FinanceEntry | null }> {
  const lines: PatientShareLine[] = (args.exams || []).map(exam => ({
    name: exam.name,
    participation: exam.participationAmount,
    price: exam.executionPrice ?? exam.prescribedPrice,
  }));

  let patientShare: FinanceEntry | null = null;
  let payerShare: FinanceEntry | null = null;

  try {
    patientShare = await upsertPatientShareReceivable({
      referralId: args.referralId,
      referralBarcode: args.referralBarcode,
      patientId: args.patientId,
      patientName: args.patientName,
      lines,
      issueDate: args.issueDate,
      executionNo: args.executionNo,
      doctorId: args.doctorId,
    });
  } catch (err: any) {
    console.warn('Patient participation finance entry failed:', err?.message || err);
  }

  if (args.includePayer === false) return { patientShare, payerShare };

  try {
    payerShare = await upsertPayerReimbursementReceivable({
      referralId: args.referralId,
      referralBarcode: args.referralBarcode,
      insuranceId: args.insuranceId,
      lines,
      issueDate: args.issueDate,
      executionNo: args.executionNo,
      doctorId: args.doctorId,
    });
  } catch (err: any) {
    console.warn('Payer reimbursement finance entry failed:', err?.message || err);
  }

  return { patientShare, payerShare };
}

/**
 * Δημιουργεί επίσκεψη «Άυλη συνταγογράφηση» για σήμερα και καταχωρεί
 * τα επιλεγμένα παραπεμπτικά του φορέα σε αυτήν.
 * Αν ο ασθενής με αυτό το ΑΜΚΑ δεν υπάρχει, δημιουργείται.
 */
export async function importReferralsAsVisit(
  input: ImportReferralsInput
): Promise<ImportReferralsResult> {
  const amka = input.amka.trim();
  if (!amka) throw new Error('Απαιτείται ΑΜΚΑ');
  if (!Array.isArray(input.referrals) || input.referrals.length === 0) {
    throw new Error('Δεν επιλέχθηκαν παραπεμπτικά');
  }

  // Παραλείπει παραπεμπτικά που έχουν ήδη εισαχθεί (id = referral_epres_<barcode>)
  // ή έχουν λήξει (expiryDate στο παρελθόν)
  const pending: EpresReferral[] = [];
  const expired: string[] = [];
  let skipped = 0;

  for (const ref of input.referrals) {
    const barcode = String(ref.barcode || '').trim();
    if (!barcode) {
      skipped++;
      continue;
    }
    if (isReferralExpired(ref.expiryDate)) {
      expired.push(barcode);
      continue;
    }
    const existing = await dbService.getReferral(`referral_epres_${barcode}`);
    if (existing) {
      skipped++;
      continue;
    }
    pending.push(ref);
  }

  if (pending.length === 0) {
    if (expired.length > 0 && expired.length === input.referrals.length) {
      throw new Error(
        `Όλα τα επιλεγμένα παραπεμπτικά έχουν λήξει (${expired.join(', ')})`
      );
    }
    throw new Error('Τα επιλεγμένα παραπεμπτικά έχουν ήδη εισαχθεί');
  }

  const first = pending[0];
  const firstName =
    input.patient?.firstName?.trim() || first.firstName?.trim() || 'Άγνωστο';
  const lastName = input.patient?.lastName?.trim() || first.lastName?.trim() || 'Άγνωστο';
  const patientName = `${firstName} ${lastName}`.trim();

  // 1) Ασθενής: εύρεση με ΑΜΚΑ ή δημιουργία
  const resolved = await resolvePatientForImport({
    amka,
    firstName,
    lastName,
    dateOfBirth: input.patient?.dateOfBirth,
    gender: input.patient?.gender,
    doctorId: input.doctorId,
  });
  const patient = resolved.patient;
  const patientCreated = resolved.created;

  // 2) Επίσκεψη σήμερα με τίτλο «Άυλη συνταγογράφηση»
  const now = new Date().toISOString();
  const visitDate = now.slice(0, 10);

  const visit = await dbService.saveVisit({
    id: `visit_${Date.now()}`,
    patientId: patient.id,
    patientName,
    visitDate,
    reason: IMPORT_VISIT_REASON,
    notes: `Εισαγωγή ${pending.length} παραπεμπτικού(ών) από e-Prescription · ΑΜΚΑ ${amka}`,
    doctorId: input.doctorId,
    // Τα παραπεμπτικά ξεκινούν σε εκκρεμότητα → η επίσκεψη είναι «Σε εξέλιξη»
    status: 'in_progress' as any,
    createdAt: now,
    updatedAt: now,
  } as any);

  // 3) Παραπεμπτικά
  const created: Referral[] = [];

  for (const ref of pending) {
    const barcode = String(ref.barcode || '').trim();

    const groupName = ref.examinationGroupName || ref.socialInsuranceShortName || '';
    const specialty = groupName || 'Άυλη συνταγογράφηση';
    const reason = groupName || `Παραπεμπτικό ${barcode}`;

    const noteParts = [`Barcode: ${barcode}`];
    if (ref.statusName) noteParts.push(`Κατάσταση: ${ref.statusName}`);
    if (ref.expiryDate) noteParts.push(`Λήξη: ${toIsoDate(ref.expiryDate)}`);
    if (ref.isProactive) noteParts.push('Προληπτική δράση');

    const referral = await dbService.saveReferral({
      id: `referral_epres_${barcode}`,
      visitId: visit.id,
      patientId: patient.id,
      patientName,
      visitReason: visit.reason,
      specialty,
      reason,
      hospital: '',
      referralDate: toIsoDate(ref.issueDate),
      status: 'pending' as any,
      notes: noteParts.join(' · '),
      reportUrl: '',
      doctorId: input.doctorId,
      createdAt: now,
      updatedAt: now,
    } as any);

    created.push(referral);

    // Συμμετοχή ασθενούς: αντλείται από τον φορέα (best effort)
    if (input.userId) {
      await createPatientShareForBarcode({
        userId: input.userId,
        referralId: referral.id,
        referralBarcode: barcode,
        patientId: patient.id,
        patientName,
        doctorId: input.doctorId,
      });
    }
  }

  return { patient, patientCreated, visit, referrals: created, skipped, expired };
}

/**
 * Ανακτά το παραπεμπτικό από τον φορέα και δημιουργεί την απαίτηση
 * συμμετοχής του ασθενούς, χωρίς να διακόπτει τη ροή καταχώρησης.
 */
async function createPatientShareForBarcode(args: {
  userId: string;
  referralId: string;
  referralBarcode: string;
  patientId: string;
  patientName?: string;
  doctorId?: string;
}): Promise<void> {
  try {
    const state = await dbService.getEfulfillmentState(args.userId);
    const unitId = String(
      state.profile?.userUnitId || state.profile?.healthCareUnitId || ''
    );
    if (!unitId) return;

    const result = await withConnection(args.userId, creds =>
      fetchReferralForDispense(creds, args.referralBarcode, unitId)
    );
    if (!result.ok || !result.data) {
      console.warn(
        `Δεν ανακτήθηκαν στοιχεία συμμετοχής για ${args.referralBarcode}: ${result.error || 'άγνωστο σφάλμα'}`
      );
      return;
    }

    await createReferralReceivables({
      referralId: args.referralId,
      referralBarcode: args.referralBarcode,
      patientId: args.patientId,
      patientName: args.patientName,
      exams: result.data.exams,
      insuranceId: result.data.insuranceId,
      doctorId: args.doctorId,
      // Χωρίς εκτέλεση δεν δημιουργείται απαίτηση αποζημίωσης από τον φορέα
      includePayer: false,
    });
  } catch (err: any) {
    console.warn('Patient participation lookup failed:', err?.message || err);
  }
}

/**
 * Δοκιμή του Api-Key με τα αποθηκευμένα credentials του χρήστη.
 * Ο φορέας ελέγχει πρώτα την αυθεντικοποίηση (gateway 401) και μετά το Api-Key (600),
 * οπότε χρειάζονται πραγματικά credentials για ασφαλές συμπέρασμα.
 */
export async function testApiKey(
  credentials?: EfulfillmentCredentials
): Promise<{ ok: boolean; error?: string; code?: string; inconclusive?: boolean }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, code: 'API_KEY', error: 'Δεν έχει οριστεί Api-Key' };
  }

  if (!credentials) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      error: 'Αποθηκεύστε πρώτα τα στοιχεία σύνδεσης (username/password) για να δοκιμαστεί το Api-Key',
      inconclusive: true,
    };
  }

  const result = await fetchMe(credentials);

  if (result.ok) {
    return { ok: true };
  }
  if (result.code === 'API_KEY' || result.code === '600') {
    return { ok: false, code: 'API_KEY', error: result.error };
  }
  if (result.code === 'AUTH') {
    return {
      ok: false,
      code: 'AUTH',
      error:
        'Το Api-Key δεν απορρίφθηκε, αλλά η αυθεντικοποίηση απέτυχε. ' +
        'Ελέγξτε τα username/password και την καταχώρηση της IP σας.',
      inconclusive: true,
    };
  }

  return { ok: false, code: result.code, error: result.error, inconclusive: true };
}
