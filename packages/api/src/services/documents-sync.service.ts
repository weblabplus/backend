// ============================================================
// Συγχρονισμός παραστατικών από Emporiko Documents API
// (κέντρο αναφοράς ΜΙΚΡΟΑΝΑΛΥΣΗ).
//
// GET {baseUrl}/api/documents?date_from=…&date_to=…&code=…
// Basic auth με τα διαπιστευτήρια του Documents API.
// Οι κινήσεις εισάγονται ως οφειλές προς το κέντρο (idempotent upsert).
// ============================================================

import {
  dbService,
  financeStatusFromAmounts,
  type FinanceEntry,
  type FinanceEntrySource,
  type ReferenceCenter,
} from '../db/db.service';

const DEFAULT_CENTER_ID = 'microanalysis';
const SYNC_MONTHS_BACK = 6;
/** Μέγιστο διάστημα ανά κλήση όταν συγχρονίζουμε μεγάλο εύρος (π.χ. 30ετία) */
const SYNC_CHUNK_MONTHS = 6;
/** Ασφάλεια: έως 60 τμήματα (30 έτη) */
const MAX_SYNC_WINDOWS = 60;
/** Πλήθος κινήσεων ανά μαζική εγγραφή */
const SYNC_WRITE_BATCH = 200;

/** Γραμμή από το /api/documents του Emporiko Documents API */
export interface EmporikoDocument {
  id?: number | string | null;
  tradecode?: string | null;
  DESCR?: string | null;
  ftrdate?: string | null;
  /** Ημερομηνία μέχρι την οποία πρέπει να πληρωθεί η κίνηση */
  expiredate?: string | null;
  einvoiceid?: string | number | null;
  EINVOICEURL?: string | null;
  AMOUNT?: number | string | null;
  vatamount?: number | string | null;
  totamount?: number | string | null;
  /**
   * Υπόλοιπο προς εξόφληση. 0 = εξοφλημένο, αρνητικό = πιστωμένο.
   * Το άθροισμά του είναι το σύνολο των οφειλών προς το κέντρο.
   */
  DeductedAmount?: number | string | null;
}

/** Ανάγνωση πεδίου ανεξάρτητα από το casing του API (π.χ. DeductedAmount / deductedamount) */
function pickField<T = any>(doc: Record<string, any>, ...names: string[]): T | undefined {
  if (!doc) return undefined;
  for (const name of names) {
    if (doc[name] !== undefined && doc[name] !== null) return doc[name] as T;
  }
  const lowerNames = names.map(n => n.toLowerCase());
  for (const key of Object.keys(doc)) {
    if (lowerNames.includes(key.toLowerCase())) {
      const value = doc[key];
      if (value !== undefined && value !== null) return value as T;
    }
  }
  return undefined;
}

/** Κανονικοποίηση ημερομηνίας σε YYYY-MM-DD (υποστηρίζει ISO και DD/MM/YYYY) */
function normalizeDateOnly(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const greek = raw.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (greek) {
    const day = greek[1].padStart(2, '0');
    const month = greek[2].padStart(2, '0');
    return `${greek[3]}-${month}-${day}`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export interface DocumentsSyncResult {
  centerId: string;
  centerName: string;
  from: string;
  to: string;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  error?: string;
}

interface DocumentsConfig {
  url: string;
  username: string;
  password: string;
  code: string;
}

export class DocumentsSyncError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentsSyncError';
    this.code = code;
  }
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function monthsBack(months: number, from: Date = new Date()): Date {
  const date = new Date(from);
  date.setMonth(date.getMonth() - months);
  return date;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(num) ? num : 0;
}

/** Ρυθμίσεις API: center config πρώτα, μετά env (για ΜΙΚΡΟΑΝΑΛΥΣΗ) */
function resolveDocumentsConfig(center: ReferenceCenter): DocumentsConfig {
  const cfg = (center.config || {}) as Record<string, any>;
  const isDefaultCenter = center.id === DEFAULT_CENTER_ID;

  return {
    url: String(cfg.documentsUrl || (isDefaultCenter ? process.env.EMPORIKO_DOCUMENTS_URL : '') || '')
      .trim()
      .replace(/\/+$/, ''),
    username: String(
      cfg.documentsUsername || (isDefaultCenter ? process.env.EMPORIKO_DOCUMENTS_USERNAME : '') || ''
    ).trim(),
    password: String(
      cfg.documentsPassword || (isDefaultCenter ? process.env.EMPORIKO_DOCUMENTS_PASSWORD : '') || ''
    ).trim(),
    code: String(
      cfg.documentsCode ||
        (isDefaultCenter ? process.env.EMPORIKO_DOCUMENTS_CODE : '') ||
        cfg.senderCode ||
        ''
    ).trim(),
  };
}

/** Είναι ρυθμισμένο το Documents API για το κέντρο; */
export function isDocumentsApiConfigured(center: ReferenceCenter): boolean {
  const cfg = resolveDocumentsConfig(center);
  return Boolean(cfg.url && cfg.username && cfg.password && cfg.code);
}

async function fetchDocuments(
  center: ReferenceCenter,
  cfg: DocumentsConfig,
  from: string,
  to: string
): Promise<EmporikoDocument[]> {
  const timeout = Number(process.env.EMPORIKO_DOCUMENTS_TIMEOUT_MS) || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const params = new URLSearchParams({ date_from: from, date_to: to, code: cfg.code });
  const url = `${cfg.url}/api/documents?${params.toString()}`;
  const authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: authorization },
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.detail || detail;
      } catch {
        /* keep raw text */
      }
      throw new DocumentsSyncError(
        `HTTP_${res.status}`,
        `Το Documents API του «${center.name}» απάντησε με HTTP ${res.status}: ${detail}`
      );
    }

    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DocumentsSyncError(
        'INVALID_RESPONSE',
        `Το Documents API του «${center.name}» επέστρεψε μη έγκυρο JSON`
      );
    }

    if (!body || body.success === false || !Array.isArray(body.data)) {
      throw new DocumentsSyncError(
        'INVALID_RESPONSE',
        `Το Documents API του «${center.name}» δεν επέστρεψε λίστα παραστατικών`
      );
    }

    return body.data as EmporikoDocument[];
  } catch (err: any) {
    if (err instanceof DocumentsSyncError) throw err;

    const aborted = err?.name === 'AbortError';
    throw new DocumentsSyncError(
      aborted ? 'TIMEOUT' : 'NETWORK',
      aborted
        ? `Το Documents API του «${center.name}» δεν απάντησε εντός ${timeout / 1000}s`
        : `Σφάλμα δικτύου (${center.name}): ${err?.message || err}`
    );
  } finally {
    clearTimeout(timer);
  }
}

function documentEntryId(centerId: string, doc: EmporikoDocument): string {
  const raw =
    doc.id !== undefined && doc.id !== null
      ? String(doc.id)
      : `${doc.tradecode || 'doc'}_${String(doc.ftrdate || '').slice(0, 10)}`;
  return `finance_doc_${centerId}_${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Είδος παραστατικού του κέντρου */
export type EmporikoDocumentType = 'invoice' | 'receipt' | 'credit';

/** Αναγνώριση είδους παραστατικού από την περιγραφή */
function documentType(doc: EmporikoDocument, isCredit: boolean): EmporikoDocumentType {
  if (isCredit) return 'credit';
  const descr = String(doc.DESCR || '').toUpperCase();
  if (descr.includes('ΑΠΟΔΕΙΞΗ') || descr.includes('ΕΙΣΠΡΑΞ')) return 'receipt';
  if (descr.includes('ΠΙΣΤΩΤΙΚ')) return 'credit';
  return 'invoice';
}

/** Ποσό οφειλής: συνολικό (με ΦΠΑ), με fallback καθαρό + ΦΠΑ */
function documentAmount(doc: EmporikoDocument): { total: number; net: number; vat: number } {
  const raw = doc as Record<string, any>;
  const net = round2(Math.abs(toNumber(pickField(raw, 'AMOUNT'))));
  const vat = round2(Math.abs(toNumber(pickField(raw, 'vatamount'))));
  const totalRaw = toNumber(pickField(raw, 'totamount'));
  const total = round2(Math.abs(totalRaw) || net + vat);
  return { total, net, vat };
}

/**
 * Υπόλοιπο προς εξόφληση από το API (DeductedAmount).
 * 0 = εξοφλημένο, αρνητικό = πιστωμένο.
 */
function documentOutstanding(doc: EmporikoDocument): number | undefined {
  const raw = pickField(doc as Record<string, any>, 'DeductedAmount');
  return raw === undefined ? undefined : round2(toNumber(raw));
}

function buildDescription(doc: EmporikoDocument): string {
  const series = String(doc.DESCR || '').trim();
  const tradeCode = String(doc.tradecode || '').trim();

  if (series && tradeCode) return `${series} ${tradeCode}`;
  if (series) return series;
  if (tradeCode) return `Παραστατικό ${tradeCode}`;
  return 'Παραστατικό κέντρου αναφοράς';
}

function buildNotes(center: ReferenceCenter, doc: EmporikoDocument): string {
  const parts = [`Emporiko #${doc.id ?? '-'}`];
  if (doc.einvoiceid) parts.push(`e-invoice ${doc.einvoiceid}`);
  if (doc.EINVOICEURL) parts.push(String(doc.EINVOICEURL));
  parts.push(`Κέντρο: ${center.name}`);
  return parts.join(' · ');
}

/**
 * Συγχρονίζει τα παραστατικά του κέντρου.
 * Idempotent: ίδιο document id → ενημέρωση υπάρχουσας κίνησης,
 * χωρίς να χάνονται πληρωμές/σημειώσεις χρήστη.
 *
 * @param centerId Κέντρο αναφοράς (default: ΜΙΚΡΟΑΝΑΛΥΣΗ)
 * @param options.monthsBack Πόσο πίσω θα ανακτηθούν παραστατικά (default: 6 μήνες)
 */
export async function syncCenterDocuments(
  centerId: string = DEFAULT_CENTER_ID,
  options: { monthsBack?: number } = {}
): Promise<DocumentsSyncResult> {
  const center = await dbService.getReferenceCenter(centerId);
  if (!center) {
    throw new DocumentsSyncError('CENTER_NOT_FOUND', 'Το κέντρο αναφοράς δεν βρέθηκε');
  }

  const cfg = resolveDocumentsConfig(center);
  if (!cfg.url || !cfg.username || !cfg.password || !cfg.code) {
    throw new DocumentsSyncError(
      'DOCUMENTS_NOT_CONFIGURED',
      `Δεν έχει ρυθμιστεί το Documents API για το «${center.name}» (URL, username, password, code)`
    );
  }

  const months =
    Number.isFinite(options.monthsBack) && (options.monthsBack as number) > 0
      ? Number(options.monthsBack)
      : SYNC_MONTHS_BACK;

  const to = isoDate(new Date());
  const from = isoDate(monthsBack(months));

  // Μεγάλα διαστήματα (π.χ. 30ετία) ανακτώνται τμηματικά ανά 6μηνο,
  // ώστε να μην εξαρτόμαστε από τυχόν όρια του Documents API.
  const documents: EmporikoDocument[] = [];
  const fetchErrors: string[] = [];

  if (months <= SYNC_CHUNK_MONTHS) {
    documents.push(...(await fetchDocuments(center, cfg, from, to)));
  } else {
    const overallStart = monthsBack(months);
    let windowEnd = new Date();
    let windows = 0;

    while (windows < MAX_SYNC_WINDOWS) {
      const windowStartRaw = monthsBack(SYNC_CHUNK_MONTHS, windowEnd);
      const windowStart = windowStartRaw < overallStart ? overallStart : windowStartRaw;
      const chunkFrom = isoDate(windowStart);
      const chunkTo = isoDate(windowEnd);

      try {
        documents.push(...(await fetchDocuments(center, cfg, chunkFrom, chunkTo)));
      } catch (err: any) {
        // Μία αποτυχία δεν ακυρώνει ολόκληρο το ιστορικό
        fetchErrors.push(`${chunkFrom} → ${chunkTo}: ${err?.message || err}`);
      }

      windows++;
      if (windowStart <= overallStart) break;

      const previousEnd = new Date(windowStart);
      previousEnd.setDate(previousEnd.getDate() - 1);
      windowEnd = previousEnd;
    }

    if (documents.length === 0 && fetchErrors.length === windows && fetchErrors.length > 0) {
      throw new DocumentsSyncError('FETCH_FAILED', fetchErrors[0]);
    }
  }

  const result: DocumentsSyncResult = {
    centerId: center.id,
    centerName: center.name,
    from,
    to,
    fetched: documents.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [...fetchErrors],
  };

  const now = new Date().toISOString();

  // Υπάρχουσες κινήσεις του κέντρου σε ένα query (αντί για N queries)
  const existingEntries = await dbService.listFinanceEntries({
    partyType: 'reference_center',
    partyId: center.id,
  });
  const existingById = new Map(existingEntries.map(entry => [entry.id, entry]));

  let pending: FinanceEntry[] = [];

  for (const doc of documents) {
    try {
      const { total, net, vat } = documentAmount(doc);
      if (total <= 0) {
        result.skipped++;
        continue;
      }

      const id = documentEntryId(center.id, doc);
      const existing = existingById.get(id);
      const issueDate =
        normalizeDateOnly(pickField(doc as Record<string, any>, 'ftrdate')) || now.slice(0, 10);
      const dueDate = normalizeDateOnly(pickField(doc as Record<string, any>, 'expiredate'));
      const tradeCode = doc.tradecode ? String(doc.tradecode) : undefined;
      const series = doc.DESCR ? String(doc.DESCR) : undefined;
      const description = buildDescription(doc);
      const notes = buildNotes(center, doc);
      // Πιστωτικά παραστατικά (αρνητικό σύνολο) → απαίτηση από το κέντρο
      const isCredit = toNumber(pickField(doc as Record<string, any>, 'totamount')) < 0;
      const direction: FinanceEntry['direction'] = isCredit ? 'receivable' : 'debt';
      const docType = documentType(doc, isCredit);

      // Εξόφληση από το API: DeductedAmount = υπόλοιπο (0 → εξοφλημένο)
      const outstanding = documentOutstanding(doc);
      const manualPaid = round2(
        (existing?.payments || []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
      );
      const paidAmount =
        docType === 'receipt'
          ? total
          : outstanding === undefined
          ? Math.min(total, Math.max(0, Number(existing?.paidAmount) || 0))
          : round2(Math.min(total, Math.max(Math.max(0, total - outstanding), manualPaid)));

      const source: FinanceEntrySource = {
        system: 'emporiko-documents',
        centerId: center.id,
        documentId: doc.id !== undefined && doc.id !== null ? String(doc.id) : undefined,
        documentType: docType,
        tradeCode,
        series,
        einvoiceId: doc.einvoiceid ? String(doc.einvoiceid) : undefined,
        einvoiceUrl: doc.EINVOICEURL ? String(doc.EINVOICEURL) : undefined,
        netAmount: net,
        vatAmount: vat,
        totalAmount: total,
        ...(outstanding !== undefined ? { deductedAmount: outstanding } : {}),
      };

      if (existing) {
        const updated: FinanceEntry = {
          ...existing,
          direction,
          partyType: 'reference_center',
          partyId: center.id,
          partyName: center.name,
          amount: total,
          paidAmount,
          description,
          issueDate,
          dueDate: dueDate ?? existing.dueDate,
          source,
          // Διατηρούμε τις πληρωμές και τις σημειώσεις του χρήστη
          notes: existing.notes || notes,
          status: financeStatusFromAmounts({
            amount: total,
            paidAmount,
            status: existing.status,
          }),
          updatedAt: now,
        };
        pending.push(updated);
        result.updated++;
      } else {
        const entry: FinanceEntry = {
          id,
          direction,
          partyType: 'reference_center',
          partyId: center.id,
          partyName: center.name,
          description,
          amount: total,
          paidAmount,
          status: financeStatusFromAmounts({ amount: total, paidAmount }),
          issueDate,
          dueDate,
          notes,
          payments: [],
          source,
          createdAt: now,
          updatedAt: now,
        };
        pending.push(entry);
        result.created++;
      }

      if (pending.length >= SYNC_WRITE_BATCH) {
        await dbService.saveFinanceEntries(pending);
        pending = [];
      }
    } catch (err: any) {
      result.errors.push(`#${doc.id ?? '?'}: ${err?.message || err}`);
    }
  }

  if (pending.length > 0) {
    await dbService.saveFinanceEntries(pending);
  }

  return result;
}
