// ============================================================
// Exam LOINC Service
// Αντλεί κωδικούς LOINC από το Lab Data Repository masterdata
// endpoint και τους αποθηκεύει στο PostgreSQL (exam_loinc)
// + τοπική cache. Εναλλακτική πηγή δεδομένων από το exam-catalog.
// ============================================================

import * as fs from 'fs';
import { labRepoAuthHeaders, type LabRepoCredentials } from './lab-repo-config';
import * as path from 'path';
import { DATA_DIR } from '../config/data-dir';
import { dbService } from '../db/db.service';

// ── Types ──

export interface LoincsExamination {
  id: number;
  examinationId: number;
  examinationDescription: string | null;
  examinationGroup: string | null;
  edapyCode: string | null;
}

export interface ExamLoincEntry {
  loincCode: string;
  loincComponent: string;     // Greek component name
  loincProperty: string;
  loincTimeAspect: string;
  loincSystem: string;         // Greek system
  loincScale: string;
  loincMethod: string;         // Greek method
  loincClass: string;
  loincRelatedNames: string;
  longName: string;
  loincComponentEn: string;
  loincUnits: string | null;
  loincDescription: string;
  // Linked exam info (may be null)
  examCode: string | null;
  examDescription: string | null;
  edapyCode: string | null;
  // Exams this LOINC belongs to as a parameter
  loincsExaminations: LoincsExamination[];
}

export interface ExamLoincSearchResult {
  loincCode: string;
  loincComponent: string;   // Greek component name
  loincSystem: string;       // Greek system
  loincMethod: string;       // Greek method
  loincScale: string;
  loincClass: string;
  longName: string;
  greekName: string;         // Formatted Greek display name
  examCode: string | null;
  examDescription: string | null;
}

// ── Constants ──

const CACHE_DIR = DATA_DIR;
const EXAM_LOINC_CACHE_FILE = path.join(CACHE_DIR, 'exam-loinc.json');

const API_BASE = 'https://testeps.e-prescription.gr/labdatarepository';
const API_USERNAME = 'dontpointapi';
const API_PASSWORD = 'Ipatnioptnod!111';

function getAuthHeaders(credentials?: LabRepoCredentials): Record<string, string> {
  return labRepoAuthHeaders(credentials);
}

// ── Service ──

export class ExamLoincService {
  /** In-memory cache: loincCode → ExamLoincEntry */
  private catalog: Map<string, ExamLoincEntry> = new Map();
  private loaded = false;
  private totalEntries = 0;
  private syncing = false;
  private syncProgress = { page: 0, totalPages: 0, count: 0 };

  /** Φόρτωση της cache από το δίσκο κατά την εκκίνηση */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      if (fs.existsSync(EXAM_LOINC_CACHE_FILE)) {
        const raw = fs.readFileSync(EXAM_LOINC_CACHE_FILE, 'utf-8');
        const entries: ExamLoincEntry[] = JSON.parse(raw);
        this.catalog.clear();
        for (const entry of entries) {
          this.catalog.set(entry.loincCode, entry);
        }
        this.totalEntries = entries.length;
        this.loaded = true;
        console.log(`📋 Exam LOINC catalog loaded: ${this.totalEntries} entries from disk cache`);
      } else {
        this.loaded = true;
        console.log('📋 Exam LOINC catalog: no disk cache found — run sync to populate');
      }
    } catch (err) {
      console.warn('⚠️ Failed to load exam LOINC cache:', err);
      this.loaded = true;
    }
  }

  get isLoaded(): boolean {
    return this.loaded && this.catalog.size > 0;
  }

  get size(): number {
    return this.catalog.size;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  get progress(): { page: number; totalPages: number; count: number } {
    return { ...this.syncProgress };
  }

  // ── PostgreSQL Sync ──

  /** Αποθήκευση όλων των LOINC entries στο PostgreSQL */
  private async saveToPostgres(entries: ExamLoincEntry[]): Promise<void> {
    if (!dbService.isInitialized) {
      console.warn('⚠️ PostgreSQL not available — saving to disk only');
      return;
    }

    const pgEntries = entries.map(entry => ({
      loincCode: entry.loincCode,
      data: {
        loincCode: entry.loincCode,
        loincComponent: entry.loincComponent,
        loincProperty: entry.loincProperty,
        loincTimeAspect: entry.loincTimeAspect,
        loincSystem: entry.loincSystem,
        loincScale: entry.loincScale,
        loincMethod: entry.loincMethod,
        loincClass: entry.loincClass,
        loincRelatedNames: entry.loincRelatedNames,
        longName: entry.longName,
        loincComponentEn: entry.loincComponentEn,
        loincUnits: entry.loincUnits || null,
        loincDescription: entry.loincDescription,
        examCode: entry.examCode || null,
        examDescription: entry.examDescription || null,
        edapyCode: entry.edapyCode || null,
        loincsExaminations: entry.loincsExaminations,
      },
    }));

    const BATCH_SIZE = 500;
    for (let i = 0; i < pgEntries.length; i += BATCH_SIZE) {
      const chunk = pgEntries.slice(i, i + BATCH_SIZE);
      await dbService.saveExamLoincBatch(chunk);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(pgEntries.length / BATCH_SIZE);
      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        console.log(`  📤 PostgreSQL exam_loinc batch ${batchNum}/${totalBatches} (${chunk.length} rows)`);
      }
    }

    console.log(`✅ ${entries.length} LOINC entries written to PostgreSQL exam_loinc`);
  }

  // ── API Sync ──

  /**
   * Συγχρονισμός όλων των LOINC entries από το masterdata endpoint.
   * Κατεβάζει → αποθηκεύει σε Firestore → αποθηκεύει τοπικά.
   *
   * @param startPage - Προαιρετική σελίδα έναρξης (offset). Αν > 1,
   *   παραλείπει τις σελίδες 2..startPage-1. Η σελίδα 1 διαβάζεται πάντα
   *   για τα metadata (totalPages).
   */
  async syncFromApi(
    onProgress?: (page: number, totalPages: number, count: number) => void,
    startPage?: number,
  ): Promise<{ total: number; pages: number; startPage: number; endPage: number }> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    const effectiveStartPage = Math.max(1, startPage || 1);
    this.syncing = true;
    this.syncProgress = { page: 0, totalPages: 0, count: 0 };

    try {
      const headers = getAuthHeaders();

      // Πρώτη σελίδα για να μάθουμε το σύνολο
      const firstUrl = `${API_BASE}/api/masterdata/loinc?page=1&pageSize=1000`;
      console.log(`🔄 Starting exam LOINC sync from ΗΔΙΚΑ masterdata (startPage=${effectiveStartPage})...`);
      const firstResp = await fetch(firstUrl, { headers });

      if (!firstResp.ok) {
        const errText = await firstResp.text();
        throw new Error(`API error (${firstResp.status}): ${errText}`);
      }

      const firstData = await firstResp.json() as {
        totalPages: number;
        totalEntries: number;
        content: any[];
      };

      const totalPages = firstData.totalPages;
      const totalEntries = firstData.totalEntries;
      console.log(`🔄 Exam LOINC: ${totalEntries} entries, ${totalPages} pages`);

      // Process first page
      const allEntries: ExamLoincEntry[] = [];
      this.processPage(firstData.content, allEntries);

      this.syncProgress = { page: 1, totalPages, count: allEntries.length };
      if (onProgress) onProgress(1, totalPages, allEntries.length);

      // Fetch remaining pages (respecting offset)
      const fetchStartPage = Math.max(2, effectiveStartPage);
      const batchSize = 5;
      for (let p = fetchStartPage; p <= totalPages; p += batchSize) {
        const endPage = Math.min(p + batchSize - 1, totalPages);
        const promises: Promise<any>[] = [];

        for (let pageNum = p; pageNum <= endPage; pageNum++) {
          const url = `${API_BASE}/api/masterdata/loinc?page=${pageNum}&pageSize=1000`;
          promises.push(
            fetch(url, { headers }).then(async resp => {
              if (!resp.ok) throw new Error(`Page ${pageNum} failed: ${resp.status}`);
              return resp.json();
            })
          );
        }

        const results = await Promise.all(promises);
        for (const data of results) {
          this.processPage(data.content, allEntries);
        }

        this.syncProgress = { page: endPage, totalPages, count: allEntries.length };
        if (onProgress) onProgress(endPage, totalPages, allEntries.length);
      }

      // Ενημέρωση in-memory cache
      this.catalog.clear();
      for (const entry of allEntries) {
        this.catalog.set(entry.loincCode, entry);
      }
      this.totalEntries = allEntries.length;

      // Αποθήκευση τοπικά
      this.saveToDisk(allEntries);

      // Αποθήκευση στο PostgreSQL
      await this.saveToPostgres(allEntries);

      console.log(`✅ Exam LOINC sync complete: ${allEntries.length} entries`);
      return { total: totalEntries, pages: totalPages, startPage: effectiveStartPage, endPage: totalPages };
    } finally {
      this.syncing = false;
    }
  }

  private processPage(content: any[], accumulator: ExamLoincEntry[]): void {
    for (const item of content) {
      const loincCode = item.loincCode as string;
      if (!loincCode) continue;

      const entry: ExamLoincEntry = {
        loincCode,
        loincComponent: (item.loincComponent || '').trim(),
        loincProperty: item.loincProperty || '',
        loincTimeAspect: item.loincTimeAspect || '',
        loincSystem: (item.loincSystem || '').trim(),
        loincScale: item.loincScale || '',
        loincMethod: (item.loincMethod || '').trim(),
        loincClass: item.loincClass || '',
        loincRelatedNames: (item.loincRelatedNames || '').trim(),
        longName: item.longName || '',
        loincComponentEn: item.loincComponentEn || '',
        loincUnits: item.loincUnits || null,
        loincDescription: item.loincDescription || '',
        examCode: item.examCode || null,
        examDescription: (item.examDescription || '').trim() || null,
        edapyCode: item.edapyCode || null,
        loincsExaminations: (item.loincsExaminations || []).map((le: any) => ({
          id: le.id || 0,
          examinationId: le.examinationId || 0,
          examinationDescription: le.examinationDescription || null,
          examinationGroup: le.examinationGroup || null,
          edapyCode: le.edapyCode || null,
        })),
      };

      accumulator.push(entry);
    }
  }

  // ── Search ──

  /**
   * Αναζήτηση LOINC entries στην τοπική cache.
   * Υποστηρίζει multi-word Greek queries.
   */
  searchExams(query: string, limit: number = 20): ExamLoincSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q || q.length < 2) return [];

    const words = q.split(/\s+/).filter(w => w.length > 0);
    const results: Array<{ result: ExamLoincSearchResult; score: number }> = [];

    for (const [loincCode, entry] of this.catalog) {
      const compLower = entry.loincComponent.toLowerCase();
      const sysLower = entry.loincSystem.toLowerCase();
      const methLower = entry.loincMethod.toLowerCase();
      const relatedLower = (entry.loincRelatedNames || '').toLowerCase();
      const examDescLower = (entry.examDescription || '').toLowerCase();
      // Προσθέτουμε και τα loincsExaminations για αναζήτηση με όνομα εξέτασης-γονέα
      const examLinksLower = (entry.loincsExaminations || [])
        .map(le => (le.examinationDescription || '').toLowerCase())
        .join(' ');
      const combined = `${compLower} ${sysLower} ${methLower} ${examDescLower} ${examLinksLower} ${relatedLower}`;
      let score = 0;

      // Exact LOINC code match
      if (loincCode === query) {
        score = 100;
      }
      // Single word
      else if (words.length === 1) {
        if (compLower.startsWith(q)) score = 80;
        else if (compLower.includes(q)) score = 60;
        else if (combined.includes(q)) score = 40;
        else continue;
      }
      // Multi-word
      else {
        let allWordsMatch = true;
        let matchScore = 0;
        for (const word of words) {
          if (compLower.startsWith(word)) matchScore += 30;
          else if (compLower.includes(word)) matchScore += 20;
          else if (combined.includes(word)) matchScore += 10;
          else { allWordsMatch = false; break; }
        }
        if (!allWordsMatch) continue;
        if (compLower.includes(q)) matchScore += 25;
        score = matchScore;
      }

      // Build Greek display name
      const parts: string[] = [];
      if (entry.loincComponent) parts.push(entry.loincComponent);
      const details: string[] = [];
      if (entry.loincSystem) details.push(entry.loincSystem);
      if (entry.loincMethod) details.push(entry.loincMethod);
      const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
      const greekName = (parts.join(' ') + (suffix ? ` ${suffix}` : '')).trim();

      results.push({
        result: {
          loincCode: entry.loincCode,
          loincComponent: entry.loincComponent,
          loincSystem: entry.loincSystem,
          loincMethod: entry.loincMethod,
          loincScale: entry.loincScale,
          loincClass: entry.loincClass,
          longName: entry.longName,
          greekName,
          examCode: entry.examCode,
          examDescription: entry.examDescription,
        },
        score,
      });
    }

    // ── Post-process: ομαδοποίηση παραμέτρων ανά examinationDescription ──
    // Όταν ένα entry έχει loincsExaminations (είναι παράμετρος εξέτασης),
    // το ομαδοποιούμε ανά examinationId ώστε να εμφανίζεται ΜΟΝΟ το όνομα της εξέτασης.
    const grouped = new Map<number, { result: ExamLoincSearchResult; bestScore: number; bestLoincCode: string }>();
    const standalone: Array<{ result: ExamLoincSearchResult; score: number }> = [];

    for (const r of results) {
      const entry = this.catalog.get(r.result.loincCode);
      const examLinks = entry?.loincsExaminations;
      if (examLinks && examLinks.length > 0) {
        for (const le of examLinks) {
          if (!le.examinationId || !le.examinationDescription) continue;
          const existing = grouped.get(le.examinationId);
          if (!existing || r.score > existing.bestScore) {
            grouped.set(le.examinationId, {
              result: {
                loincCode: `exam:${le.examinationId}`,
                loincComponent: le.examinationDescription,
                loincSystem: le.examinationGroup || '',
                loincMethod: '',
                loincScale: '',
                loincClass: '',
                longName: le.examinationDescription,
                greekName: le.examinationDescription,
                examCode: String(le.examinationId),
                examDescription: le.examinationDescription,
              },
              bestScore: r.score,
              bestLoincCode: r.result.loincCode,
            });
          }
        }
      } else {
        standalone.push(r);
      }
    }

    const finalResults = [
      ...Array.from(grouped.values()).map(g => ({ result: g.result, score: g.bestScore })),
      ...standalone,
    ];
    finalResults.sort((a, b) => b.score - a.score);
    return finalResults.slice(0, limit).map(r => r.result);
  }

  /**
   * Λήψη ενός LOINC entry με βάση τον κωδικό.
   */
  getEntry(loincCode: string): ExamLoincEntry | null {
    return this.catalog.get(loincCode) || null;
  }

  /**
   * Βρες τον τίτλο μιας εξέτασης με βάση το examinationId.
   */
  getExaminationTitle(examId: number): string | null {
    for (const [, entry] of this.catalog) {
      if (!entry.loincsExaminations) continue;
      for (const le of entry.loincsExaminations) {
        if (le.examinationId === examId && le.examinationDescription) {
          return le.examinationDescription;
        }
      }
    }
    return null;
  }

  /**
   * Βρες όλες τις παραμέτρους (LOINC entries) που ανήκουν σε μια εξέταση
   * με βάση το examinationId (από τα loincsExaminations).
   */
  getParametersByExamId(examId: number): ExamLoincEntry[] {
    const parameters: ExamLoincEntry[] = [];
    for (const [, entry] of this.catalog) {
      if (!entry.loincsExaminations || entry.loincsExaminations.length === 0) continue;
      for (const le of entry.loincsExaminations) {
        if (le.examinationId === examId) {
          parameters.push(entry);
          break;
        }
      }
    }
    return parameters;
  }

  /**
   * Βρες όλες τις παραμέτρους (άλλα LOINC entries) που ανήκουν
   * στην ίδια εξέταση με το δοθέν LOINC, μέσω του loincsExaminations.
   * Επιστρέφει κενό array αν το LOINC δεν έχει loincsExaminations.
   */
  getParameters(loincCode: string): ExamLoincEntry[] {
    const entry = this.catalog.get(loincCode);
    if (!entry || !entry.loincsExaminations || entry.loincsExaminations.length === 0) {
      return [];
    }

    // Μάζεψε όλα τα examinationIds από το loincsExaminations
    const examIds = new Set<number>();
    for (const le of entry.loincsExaminations) {
      if (le.examinationId > 0) examIds.add(le.examinationId);
    }

    if (examIds.size === 0) return [];

    // Βρες όλα τα LOINC entries που ανήκουν στα ίδια examinations
    // (συμπεριλαμβανομένου του επιλεγμένου entry ως παράμετρο)
    const parameters: ExamLoincEntry[] = [];
    for (const [, other] of this.catalog) {
      if (!other.loincsExaminations || other.loincsExaminations.length === 0) continue;
      for (const le of other.loincsExaminations) {
        if (examIds.has(le.examinationId)) {
          parameters.push(other);
          break;
        }
      }
    }

    return parameters;
  }

  // ── Helpers ──

  /** Αποθήκευση όλων των entries στο δίσκο */
  private saveToDisk(entries: ExamLoincEntry[]): void {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(EXAM_LOINC_CACHE_FILE, JSON.stringify(entries), 'utf-8');
    console.log(`💾 Exam LOINC catalog saved to disk: ${entries.length} entries`);
  }
}

export const examLoinc = new ExamLoincService();
