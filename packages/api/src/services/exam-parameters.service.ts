// ============================================================
// Exam Parameters Service (Master Data → δικοί μας πίνακες)
//
// Συγχρονίζει τις παραμέτρους κάθε εξέτασης από το ΗΔΙΚΑ Lab Data
// Repository στους πίνακες `exam_parameters` + `exam_catalog`:
//
//  1. GET /api/masterdata/exam-codes/loinc
//     → examCode, examDescription, edapyCode, suggestedLoincs[]
//  2. GET /api/masterdata/loinc
//     → loincCode, loincComponent, loincUnits, loincsExaminations[]
//       (ποια εξέταση έχει το LOINC ως παράμετρο)
//
// Το join των δύο πηγών γίνεται με το **edapyCode** (το examCode δεν
// υπάρχει στο δεύτερο endpoint).
// ============================================================

import { dbService, type ExamParameterRow, type ExamLoincRelation } from '../db/db.service';
import { labRepoApiKey } from './lab-repo-config';
import { examLoinc } from './exam-loinc.service';
import { recordRepoLock } from './lab-results.service';
import type { Exam, ExamParameter } from '@medilab/core';

// ── Types ──

export interface ExamParameterSyncProgress {
  phase: 'exams' | 'loinc' | 'write';
  page: number;
  totalPages: number;
  count: number;
}

export interface ExamParameterSyncResult {
  exams: number;
  parameters: number;
  /** Παράμετροι που ήρθαν από τη δεύτερη πηγή (loinc → examinations) */
  fromLoincRelations: number;
  /** Σχέσεις LOINC→εξέταση που δεν αντιστοιχίστηκαν σε examCode */
  unmatchedRelations: number;
  /** Σχέσεις όπου το edapyCode είναι διπλότυπο — επιλέχθηκε ντετερμινιστικά */
  ambiguousRelations: number;
  /** Από πού διαβάστηκε κάθε πηγή (API ή ήδη συγχρονισμένοι πίνακες) */
  sourceExams: 'api' | 'local';
  sourceLoinc: 'database' | 'api';
  durationMs: number;
}

interface MasterExamRow {
  examCode: string;
  examDescription: string | null;
  edapyCode: string | null;
  suggestedLoincs: Array<{
    loincCode?: string;
    loincComponent?: string;
    loincSystem?: string;
    loincScale?: string;
    loincMethod?: string;
    loincUnits?: string | null;
    longName?: string;
  }>;
}

type LoincRelation = ExamLoincRelation;

// ── Constants ──

const API_BASE = (
  process.env.LAB_REPO_BASE_URL || 'https://testeps.e-prescription.gr/labdatarepository'
).replace(/\/+$/, '');
const API_USERNAME = process.env.LAB_REPO_USERNAME || 'dontpointapi';
const API_PASSWORD = process.env.LAB_REPO_PASSWORD || 'Ipatnioptnod!111';
const API_KEY = process.env.LAB_REPO_API_KEY || 'i1dd7mkja8c0hcvtlaulmxsumtwfk12v';

const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${API_USERNAME}:${API_PASSWORD}`).toString('base64')}`,
    'Api-Key': API_KEY,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function normalizeCode(code: unknown): string {
  return String(code ?? '').trim();
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Master Data API HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Μη έγκυρη απάντηση από το Master Data API (πιθανώς σελίδα σύνδεσης): ${text.slice(0, 200)}`
      );
    }

    // Το gateway επιστρέφει 200 με `operation` σε περίπτωση λογιστικού προβλήματος
    // (π.χ. {"operation":"acct_locked"}) αντί για σφάλμα HTTP.
    if (parsed && typeof parsed === 'object' && parsed.operation && !parsed.content) {
      const op = String(parsed.operation);
      // Καταγραφή 30λεπτου cooldown ώστε να μη συνεχιστούν οι κλήσεις
      if (op.toLowerCase().includes('acct_locked')) {
        await recordRepoLock(op);
      }
      throw new Error(`Master Data API: ${op}`);
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ── Service ──

export class ExamParametersService {
  private syncing = false;
  private progress: ExamParameterSyncProgress = {
    phase: 'exams',
    page: 0,
    totalPages: 0,
    count: 0,
  };
  private lastResult: (ExamParameterSyncResult & { finishedAt: string }) | null = null;
  private lastError: string | null = null;

  get isSyncing(): boolean {
    return this.syncing;
  }

  get currentProgress(): ExamParameterSyncProgress {
    return this.progress;
  }

  get lastSync(): (ExamParameterSyncResult & { finishedAt: string }) | null {
    return this.lastResult;
  }

  get error(): string | null {
    return this.lastError;
  }

  // ── Συγχρονισμός ──

  /**
   * Πλήρης συγχρονισμός: διαβάζει τις δύο πηγές Master Data, χτίζει τη
   * σχέση εξέταση→παραμέτρους και αντικαθιστά τον πίνακα `exam_parameters`.
   * Είναι ατομικός (transaction) — σε αποτυχία μένει το προηγούμενο σύνολο.
   */
  async syncFromApi(
    onProgress?: (p: ExamParameterSyncProgress) => void
  ): Promise<ExamParameterSyncResult> {
    if (this.syncing) {
      throw new Error('Ο συγχρονισμός παραμέτρων είναι ήδη σε εξέλιξη');
    }

    this.syncing = true;
    this.lastError = null;
    const started = Date.now();
    let sourceExams: 'api' | 'local' = 'api';
    let sourceLoinc: 'database' | 'api' = 'database';
    const report = (p: ExamParameterSyncProgress) => {
      this.progress = p;
      onProgress?.(p);
    };

    try {
      // ── Πηγή 1: εξετάσεις + suggestedLoincs ──
      report({ phase: 'exams', page: 0, totalPages: 0, count: 0 });
      let catalogEntries: MasterExamRow[];
      try {
        catalogEntries = await this.fetchExamCatalog(report);
      } catch (err: any) {
        // Το Master Data API μπορεί να μην είναι προσβάσιμο (IP whitelisting).
        // Σε αυτή την περίπτωση χρησιμοποιούμε τον ήδη συγχρονισμένο πίνακα.
        console.warn(
          '⚠️ Master Data API μη διαθέσιμο — χρήση τοπικού exam_catalog:',
          err?.message || err
        );
        catalogEntries = await dbService.listExamCatalogEntries();
        if (catalogEntries.length === 0) throw err;
        sourceExams = 'local';
        report({ phase: 'exams', page: 1, totalPages: 1, count: catalogEntries.length });
      }

      if (catalogEntries.length === 0) {
        throw new Error(
          'Δεν βρέθηκαν εξετάσεις στο Master Data — ο συγχρονισμός ακυρώθηκε και τα υπάρχοντα δεδομένα διατηρήθηκαν'
        );
      }

      // ── Πηγή 2: LOINC → examinations ──
      report({ phase: 'loinc', page: 0, totalPages: 0, count: 0 });
      const loincResult = await this.loadLoincRelations(report);
      const relations = loincResult.relations;
      sourceLoinc = loincResult.source;

      // ── Σύνθεση ──
      report({ phase: 'write', page: 0, totalPages: 0, count: 0 });
      const { rows, fromLoincRelations, unmatchedRelations, ambiguousRelations } = this.buildRows(
        catalogEntries,
        relations
      );

      if (rows.length === 0) {
        throw new Error(
          'Ο συγχρονισμός δεν παρήγαγε παραμέτρους — τα υπάρχοντα δεδομένα διατηρήθηκαν'
        );
      }

      await dbService.replaceExamParameters(rows);

      // ── Εμπλουτισμός exam_catalog (λοιπά στοιχεία Master Data) ──
      const meta = this.buildCatalogMeta(catalogEntries, relations, rows);
      await dbService.updateExamCatalogParamMeta(meta);

      const result: ExamParameterSyncResult = {
        exams: new Set(rows.map(r => r.examCode)).size,
        parameters: rows.length,
        fromLoincRelations,
        unmatchedRelations,
        ambiguousRelations,
        sourceExams,
        sourceLoinc,
        durationMs: Date.now() - started,
      };
      this.lastResult = { ...result, finishedAt: new Date().toISOString() };
      report({ phase: 'write', page: 1, totalPages: 1, count: rows.length });

      console.log(
        `✅ Exam parameters sync: ${result.exams} εξετάσεις, ${result.parameters} παράμετροι ` +
          `(${fromLoincRelations} από loinc relations, ${unmatchedRelations} χωρίς examCode)`
      );
      return result;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      console.error('❌ Exam parameters sync failed:', this.lastError);
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  /** Λήψη όλων των σελίδων του /api/masterdata/exam-codes/loinc */
  private async fetchExamCatalog(
    report: (p: ExamParameterSyncProgress) => void
  ): Promise<MasterExamRow[]> {
    const firstUrl = `${API_BASE}/api/masterdata/exam-codes/loinc?page=1&pageSize=${PAGE_SIZE}&onlyWithLoincs=false`;
    const first = await fetchJson(firstUrl);
    if (!Array.isArray(first?.content)) {
      throw new Error('Μη αναμενόμενη απάντηση Master Data API (λείπει το content)');
    }
    const totalPages = Math.max(1, Number(first?.totalPages) || 1);
    const entries: MasterExamRow[] = [];

    const pushPage = (content: any[]) => {
      for (const item of content || []) {
        const examCode = normalizeCode(item?.examCode);
        if (!examCode) continue;
        entries.push({
          examCode,
          examDescription: item?.examDescription ? String(item.examDescription) : null,
          edapyCode: item?.edapyCode ? normalizeCode(item.edapyCode) : null,
          suggestedLoincs: Array.isArray(item?.suggestedLoincs) ? item.suggestedLoincs : [],
        });
      }
    };

    pushPage(first?.content);
    report({ phase: 'exams', page: 1, totalPages, count: entries.length });

    for (let page = 2; page <= totalPages; page++) {
      const data = await fetchJson(
        `${API_BASE}/api/masterdata/exam-codes/loinc?page=${page}&pageSize=${PAGE_SIZE}&onlyWithLoincs=false`
      );
      pushPage(data?.content);
      report({ phase: 'exams', page, totalPages, count: entries.length });
    }

    return entries;
  }

  /**
   * Σχέσεις LOINC → εξετάσεις.
   * Χρησιμοποιεί τα ήδη συγχρονισμένα master data (πίνακας `exam_loinc`),
   * ώστε να μη μεταφέρονται ξανά ~70MB. Αν ο πίνακας είναι κενός, κατεβάζει
   * τα δεδομένα απευθείας από το endpoint.
   */
  private async loadLoincRelations(
    report: (p: ExamParameterSyncProgress) => void
  ): Promise<{ relations: LoincRelation[]; source: 'database' | 'api' }> {
    const fromDb = await dbService.listExamLoincRelations();
    if (fromDb.length > 0) {
      report({ phase: 'loinc', page: 1, totalPages: 1, count: fromDb.length });
      return { relations: fromDb, source: 'database' };
    }

    // Fallback: απευθείας από το Master Data API
    const firstUrl = `${API_BASE}/api/masterdata/loinc?page=1&pageSize=${PAGE_SIZE}`;
    const first = await fetchJson(firstUrl);
    if (!Array.isArray(first?.content)) {
      throw new Error('Μη αναμενόμενη απάντηση Master Data API (λείπει το content)');
    }
    const totalPages = Math.max(1, Number(first?.totalPages) || 1);
    const relations: LoincRelation[] = [];

    const pushPage = (content: any[]) => {
      for (const item of content || []) {
        const exams = Array.isArray(item?.loincsExaminations) ? item.loincsExaminations : [];
        if (exams.length === 0) continue;
        const loincCode = normalizeCode(item?.loincCode);
        if (!loincCode) continue;
        relations.push({
          loincCode,
          loincComponent: item?.loincComponent ? String(item.loincComponent) : null,
          loincSystem: item?.loincSystem ? String(item.loincSystem) : null,
          loincScale: item?.loincScale ? String(item.loincScale) : null,
          loincMethod: item?.loincMethod ? String(item.loincMethod) : null,
          loincUnits: item?.loincUnits ? String(item.loincUnits) : null,
          longName: item?.longName ? String(item.longName) : null,
          examinations: exams.map((x: any) => ({
            examinationId:
              x?.examinationId !== undefined && x?.examinationId !== null
                ? Number(x.examinationId)
                : null,
            examinationDescription: x?.examinationDescription
              ? String(x.examinationDescription)
              : null,
            examinationGroup: x?.examinationGroup ? String(x.examinationGroup) : null,
            edapyCode: x?.edapyCode ? normalizeCode(x.edapyCode) : null,
          })),
        });
      }
    };

    pushPage(first?.content);
    report({ phase: 'loinc', page: 1, totalPages, count: relations.length });

    for (let page = 2; page <= totalPages; page++) {
      const data = await fetchJson(`${API_BASE}/api/masterdata/loinc?page=${page}&pageSize=${PAGE_SIZE}`);
      pushPage(data?.content);
      report({ phase: 'loinc', page, totalPages, count: relations.length });
    }

    return { relations, source: 'api' };
  }

  /** Σύνθεση των γραμμών exam_parameters από τις δύο πηγές */
  private buildRows(
    catalog: MasterExamRow[],
    relations: LoincRelation[]
  ): {
    rows: ExamParameterRow[];
    fromLoincRelations: number;
    unmatchedRelations: number;
    ambiguousRelations: number;
  } {
    const rows = new Map<string, ExamParameterRow>();
    const positions = new Map<string, number>();
    // Το edapyCode ΔΕΝ είναι μοναδικό (131 ομάδες διπλότυπων στο master data),
    // οπότε κρατάμε όλα τα examCodes ανά edapyCode ταξινομημένα.
    const edapyToExamCodes = new Map<string, Array<{ examCode: string; description: string }>>();

    for (const exam of catalog) {
      if (!exam.edapyCode) continue;
      const list = edapyToExamCodes.get(exam.edapyCode) ?? [];
      list.push({ examCode: exam.examCode, description: exam.examDescription || '' });
      edapyToExamCodes.set(exam.edapyCode, list);
    }
    for (const list of edapyToExamCodes.values()) {
      list.sort((a, b) => a.examCode.localeCompare(b.examCode));
    }

    /** Επίλυση edapyCode → examCode (ντετερμινιστικά, με προτίμηση στο ίδιο όνομα) */
    const resolveExamCode = (
      edapyCode: string,
      examinationDescription: string | null
    ): { examCode: string | null; ambiguous: boolean } => {
      const candidates = edapyToExamCodes.get(edapyCode);
      if (!candidates || candidates.length === 0) return { examCode: null, ambiguous: false };
      if (candidates.length === 1) return { examCode: candidates[0].examCode, ambiguous: false };

      const target = (examinationDescription || '').trim().toLowerCase();
      if (target) {
        const byName = candidates.filter(
          c => c.description.trim().toLowerCase() === target
        );
        if (byName.length === 1) return { examCode: byName[0].examCode, ambiguous: false };
      }
      return { examCode: candidates[0].examCode, ambiguous: true };
    };

    const nextPosition = (examCode: string): number => {
      const next = positions.get(examCode) ?? 0;
      positions.set(examCode, next + 1);
      return next;
    };

    const makeRow = (
      examCode: string,
      loincCode: string,
      position: number,
      source: 'exam-codes' | 'loinc'
    ): ExamParameterRow => ({
      id: `${examCode}:${loincCode || `p${position}`}`,
      examCode,
      position,
      loincCode: loincCode || null,
      loincComponent: null,
      loincSystem: null,
      loincScale: null,
      loincMethod: null,
      loincUnits: null,
      longName: null,
      examinationId: null,
      examinationDescription: null,
      examinationGroup: null,
      edapyCode: null,
      source,
    });

    // ── Πηγή 1: suggestedLoincs ανά εξέταση (διατηρεί τη σειρά του φορέα) ──
    for (const exam of catalog) {
      for (const sl of exam.suggestedLoincs) {
        const loincCode = normalizeCode(sl?.loincCode);
        const position = nextPosition(exam.examCode);
        const row = makeRow(exam.examCode, loincCode, position, 'exam-codes');
        row.loincComponent = sl?.loincComponent ? String(sl.loincComponent) : null;
        row.loincSystem = sl?.loincSystem ? String(sl.loincSystem) : null;
        row.loincScale = sl?.loincScale ? String(sl.loincScale) : null;
        row.loincMethod = sl?.loincMethod ? String(sl.loincMethod) : null;
        row.loincUnits = sl?.loincUnits ? String(sl.loincUnits) : null;
        row.longName = sl?.longName ? String(sl.longName) : null;
        row.edapyCode = exam.edapyCode;
        if (!rows.has(row.id)) rows.set(row.id, row);
      }
    }

    // ── Πηγή 2: loincsExaminations (συμπληρώνει + εμπλουτίζει) ──
    let fromLoincRelations = 0;
    let unmatchedRelations = 0;
    let ambiguousRelations = 0;

    for (const rel of relations) {
      for (const ex of rel.examinations) {
        // Χωρίς edapyCode δεν μπορούμε να αντιστοιχίσουμε τη σχέση σε examCode
        if (!ex.edapyCode) {
          unmatchedRelations++;
          continue;
        }

        const resolved = resolveExamCode(ex.edapyCode, ex.examinationDescription);
        if (!resolved.examCode) {
          unmatchedRelations++;
          continue;
        }
        if (resolved.ambiguous) ambiguousRelations++;

        const examCode = resolved.examCode;
        const id = `${examCode}:${rel.loincCode}`;

        const existing = rows.get(id);
        if (existing) {
          existing.examinationId ??= ex.examinationId;
          existing.examinationGroup ??= ex.examinationGroup;
          existing.examinationDescription ??= ex.examinationDescription;
          existing.loincUnits ??= rel.loincUnits;
          continue;
        }

        const position = nextPosition(examCode);
        const row = makeRow(examCode, rel.loincCode, position, 'loinc');
        row.loincComponent = rel.loincComponent;
        row.loincSystem = rel.loincSystem;
        row.loincScale = rel.loincScale;
        row.loincMethod = rel.loincMethod;
        row.loincUnits = rel.loincUnits;
        row.longName = rel.longName;
        row.examinationId = ex.examinationId;
        row.examinationDescription = ex.examinationDescription;
        row.examinationGroup = ex.examinationGroup;
        row.edapyCode = ex.edapyCode;
        rows.set(row.id, row);
        fromLoincRelations++;
      }
    }

    // Σειρά: πρώτα η σειρά του φορέα, μετά ό,τι προσέθεσε η 2η πηγή
    const ordered = Array.from(rows.values()).sort(
      (a, b) => a.examCode.localeCompare(b.examCode) || a.position - b.position
    );

    return { rows: ordered, fromLoincRelations, unmatchedRelations, ambiguousRelations };
  }

  /** Στοιχεία εξέτασης για τον πίνακα exam_catalog */
  private buildCatalogMeta(
    catalog: MasterExamRow[],
    relations: LoincRelation[],
    rows: ExamParameterRow[]
  ): Array<{
    examCode: string;
    examinationId: number | null;
    examinationGroup: string | null;
    parameterCount: number;
  }> {
    const byEdapy = new Map<string, { examinationId: number | null; examinationGroup: string | null }>();
    for (const rel of relations) {
      for (const ex of rel.examinations) {
        if (!ex.edapyCode) continue;
        const current = byEdapy.get(ex.edapyCode);
        if (!current) {
          byEdapy.set(ex.edapyCode, {
            examinationId: ex.examinationId,
            examinationGroup: ex.examinationGroup,
          });
        } else {
          current.examinationId ??= ex.examinationId;
          current.examinationGroup ??= ex.examinationGroup;
        }
      }
    }

    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.examCode, (counts.get(row.examCode) || 0) + 1);

    return catalog.map(exam => {
      const meta = exam.edapyCode ? byEdapy.get(exam.edapyCode) : undefined;
      return {
        examCode: exam.examCode,
        examinationId: meta?.examinationId ?? null,
        examinationGroup: meta?.examinationGroup ?? null,
        parameterCount: counts.get(exam.examCode) || 0,
      };
    });
  }

  // ── Lookups για την εφαρμογή ──

  /** Παράμετροι εξέτασης σε μορφή `ExamParameter` (για prefill) */
  async getExamParameters(examCode: string): Promise<ExamParameter[]> {
    const rows = await dbService.listExamParameters(examCode);
    return rows.map(r => this.toExamParameter(r));
  }

  /** Μετατροπή γραμμής πίνακα → ExamParameter (ίδια μορφή με /api/loinc/parameters) */
  private toExamParameter(row: ExamParameterRow): ExamParameter {
    const name = row.loincComponent
      ? `${row.loincComponent}${row.loincSystem ? ` (${row.loincSystem})` : ''}`
      : row.longName || row.loincCode || `Παράμετρος ${row.position + 1}`;

    return {
      name,
      unit: row.loincUnits || undefined,
      loincNum: row.loincCode || undefined,
    };
  }

  /**
   * Εντοπισμός του examCode μιας εξέτασης:
   *  1. `exam.examCode` (ήδη γνωστό)
   *  2. `notes` με «Κωδικός εξέτασης: NNN» (εισαγωγή από παραπεμπτικό)
   *  3. μοναδική αντιστοίχιση μέσω `loincCode`
   *  4. ακριβές όνομα στην `exam_catalog`
   */
  async resolveExamCode(exam: Exam): Promise<string | null> {
    if (exam.examCode) {
      const meta = await dbService.getExamMasterMeta(exam.examCode);
      if (meta) return exam.examCode;
    }

    const fromNotes = /Κωδικός εξέτασης:\s*([A-Za-z0-9._-]+)/.exec(exam.notes || '');
    if (fromNotes) {
      const meta = await dbService.getExamMasterMeta(fromNotes[1]);
      if (meta) return fromNotes[1];
    }

    if (exam.loincCode) {
      const codes = await dbService.findExamCodesByLoinc(exam.loincCode);
      if (codes.length === 1) return codes[0];
      if (codes.length > 1) {
        const byName = await dbService.findExamCodeByName(exam.name);
        return byName && codes.includes(byName) ? byName : null;
      }
    }

    return dbService.findExamCodeByName(exam.name);
  }

  /**
   * Συμπληρώνει `examCode` και `parameters` σε νέα εξέταση, εφόσον
   * υπάρχουν στο Master Data και η εξέταση δεν έχει ήδη παραμέτρους.
   */
  async prefillExam(exam: Exam): Promise<Exam> {
    if (exam.parameters && exam.parameters.length > 0) return exam;

    let examCode = exam.examCode ?? null;
    if (!examCode) {
      examCode = await this.resolveExamCode(exam);
    }
    if (!examCode) return exam;

    const parameters = await this.getExamParameters(examCode);
    if (parameters.length === 0) {
      return exam.examCode ? exam : { ...exam, examCode };
    }

    return {
      ...exam,
      examCode,
      parameters: parameters.map(p => ({ ...p })),
    };
  }

  /** Στατιστικά για το UI/status endpoints */
  async getStats() {
    const stats = await dbService.getExamParameterStats();
    return {
      ...stats,
      syncing: this.syncing,
      progress: this.progress,
      lastResult: this.lastResult,
      lastError: this.lastError,
      sourceEntries: {
        examLoincCatalog: examLoinc.size,
      },
    };
  }
}

export const examParameters = new ExamParametersService();
