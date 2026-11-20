// ============================================================
// Exam Catalog Service
// Αντλεί κωδικούς εξετάσεων από το Lab Data Repository API
// και τους αποθηκεύει στο PostgreSQL + τοπική cache.
// Αναζήτηση γίνεται από την τοπική cache για ταχύτητα.
// ============================================================

import * as fs from 'fs';
import { labRepoAuthHeaders, type LabRepoCredentials } from './lab-repo-config';
import * as path from 'path';
import { dbService } from '../db/db.service';

// ── Types ──

export interface SuggestedLoinc {
  loincCode: string;
  loincComponent: string;   // Greek component name
  loincSystem: string;       // Greek system
  loincScale: string;
  loincMethod: string | null;
  loincClass: string;
  loincUnits: string | null;
  longName: string;
}

export interface ExamCatalogEntry {
  examCode: string;
  examDescription: string;  // Greek exam name
  edapyCode: string | null;
  suggestedLoincs: SuggestedLoinc[];
}

export interface ExamSearchResult {
  examCode: string;
  examDescription: string;
  edapyCode: string | null;
  /** Primary LOINC code (first suggested) */
  loincCode: string;
  /** Greek display name for the exam */
  greekName: string;
  /** Number of suggested LOINC parameters */
  parameterCount: number;
}

// ── Constants ──

const CACHE_DIR = path.resolve(process.cwd(), 'data');
const EXAM_CACHE_FILE = path.join(CACHE_DIR, 'exam-catalog.json');

const API_BASE = 'https://testeps.e-prescription.gr/labdatarepository';
const API_USERNAME = 'dontpointapi';
const API_PASSWORD = 'Ipatnioptnod!111';

function getAuthHeaders(credentials?: LabRepoCredentials): Record<string, string> {
  return labRepoAuthHeaders(credentials);
}

// ── Service ──

export class ExamCatalogService {
  /** In-memory cache: examCode → ExamCatalogEntry */
  private catalog: Map<string, ExamCatalogEntry> = new Map();
  private loaded = false;
  private totalEntries = 0;
  
  /** Sync state tracking */
  private syncing = false;
  syncProgress: { page: number; totalPages: number; count: number } = { page: 0, totalPages: 0, count: 0 };

  /** Φόρτωση της cache από το δίσκο κατά την εκκίνηση */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      if (fs.existsSync(EXAM_CACHE_FILE)) {
        const raw = fs.readFileSync(EXAM_CACHE_FILE, 'utf-8');
        const entries: ExamCatalogEntry[] = JSON.parse(raw);
        this.catalog.clear();
        for (const entry of entries) {
          this.catalog.set(entry.examCode, entry);
        }
        this.totalEntries = entries.length;
        this.loaded = true;
        console.log(`📋 Exam catalog loaded: ${this.totalEntries} exams from disk cache`);
      } else {
        this.loaded = true;
        console.log('📋 Exam catalog: no disk cache found — run sync to populate');
      }
    } catch (err) {
      console.warn('⚠️ Failed to load exam catalog cache:', err);
      this.loaded = true;
    }
  }

  get isLoaded(): boolean {
    return this.loaded && this.catalog.size > 0;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  get size(): number {
    return this.catalog.size;
  }

  // ── PostgreSQL Sync ──

  /** Αποθήκευση όλων των εξετάσεων στο PostgreSQL */
  private async saveToPostgres(entries: ExamCatalogEntry[]): Promise<void> {
    if (!dbService.isInitialized) {
      console.warn('⚠️ PostgreSQL not available — saving to disk only');
      return;
    }

    const pgEntries = entries.map(entry => ({
      examCode: entry.examCode,
      data: {
        examCode: entry.examCode,
        examDescription: entry.examDescription,
        edapyCode: entry.edapyCode || null,
        suggestedLoincs: entry.suggestedLoincs,
        searchTokens: this.tokenize(entry.examDescription),
      },
    }));

    const BATCH_SIZE = 500;
    for (let i = 0; i < pgEntries.length; i += BATCH_SIZE) {
      const chunk = pgEntries.slice(i, i + BATCH_SIZE);
      await dbService.saveExamCatalogBatch(chunk);
      console.log(`  📤 PostgreSQL batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pgEntries.length / BATCH_SIZE)} (${chunk.length} rows)`);
    }

    console.log(`✅ ${entries.length} exams written to PostgreSQL exam_catalog`);
  }

  // ── ΗΔΙΚΑ API Sync ──

  /**
   * Συγχρονισμός όλων των εξετάσεων από το ΗΔΙΚΑ API.
   * Κατεβάζει → αποθηκεύει σε PostgreSQL → αποθηκεύει τοπικά.
   *
   * @param startPage - Προαιρετική σελίδα έναρξης (offset). Αν > 1,
   *   παραλείπει τις σελίδες 2..startPage-1. Η σελίδα 1 διαβάζεται πάντα
   *   για τα metadata (totalPages).
   */
  async syncFromApi(
    onProgress?: (page: number, totalPages: number, count: number) => void,
    startPage?: number,
  ): Promise<{ total: number; pages: number; startPage: number; endPage: number }> {
    const effectiveStartPage = Math.max(1, startPage || 1);
    const headers = getAuthHeaders();

    this.syncing = true;
    this.syncProgress = { page: 0, totalPages: 0, count: 0 };

    try {
      // Πρώτη σελίδα για να μάθουμε το σύνολο
    const firstUrl = `${API_BASE}/api/masterdata/exam-codes/loinc?page=1&pageSize=1000&onlyWithLoincs=false`;
    console.log(`🔄 Starting exam catalog sync from ΗΔΙΚΑ (startPage=${effectiveStartPage})...`);
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
    console.log(`🔄 Exam catalog: ${totalEntries} entries, ${totalPages} pages`);

    // Process first page (always included)
    const allEntries: ExamCatalogEntry[] = [];
    this.processPage(firstData.content, allEntries);

    if (onProgress) onProgress(1, totalPages, allEntries.length);
    this.syncProgress = { page: 1, totalPages, count: allEntries.length };

    // Fetch remaining pages (respecting offset)
    const fetchStartPage = Math.max(2, effectiveStartPage);
    const batchSize = 5;
    for (let p = fetchStartPage; p <= totalPages; p += batchSize) {
      const endPage = Math.min(p + batchSize - 1, totalPages);
      const promises: Promise<any>[] = [];

      for (let pageNum = p; pageNum <= endPage; pageNum++) {
        const url = `${API_BASE}/api/masterdata/exam-codes/loinc?page=${pageNum}&pageSize=1000&onlyWithLoincs=false`;
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

      if (onProgress) onProgress(endPage, totalPages, allEntries.length);
      this.syncProgress = { page: endPage, totalPages, count: allEntries.length };
    }

    // Ενημέρωση in-memory cache
    this.catalog.clear();
    for (const entry of allEntries) {
      this.catalog.set(entry.examCode, entry);
    }
    this.totalEntries = allEntries.length;

    // Αποθήκευση τοπικά
    this.saveToDisk(allEntries);

    // Αποθήκευση στο PostgreSQL
    await this.saveToPostgres(allEntries);

    console.log(`✅ Exam catalog sync complete: ${allEntries.length} exams`);
    return { total: totalEntries, pages: totalPages, startPage: effectiveStartPage, endPage: totalPages };
    } finally {
      this.syncing = false;
    }
  }

  private processPage(content: any[], accumulator: ExamCatalogEntry[]): void {
    for (const item of content) {
      const examCode = item.examCode as string;
      const examDescription = (item.examDescription || '').trim();
      if (!examCode || !examDescription) continue;

      // Filter out test/garbage entries (very short descriptions with numbers)
      if (examDescription.length < 3 && /^\d/.test(examDescription)) continue;

      const entry: ExamCatalogEntry = {
        examCode,
        examDescription,
        edapyCode: item.edapyCode || null,
        suggestedLoincs: (item.suggestedLoincs || []).map((sl: any) => ({
          loincCode: sl.loincCode || '',
          loincComponent: (sl.loincComponent || '').trim(),
          loincSystem: (sl.loincSystem || '').trim(),
          loincScale: sl.loincScale || '',
          loincMethod: sl.loincMethod || null,
          loincClass: sl.loincClass || '',
          loincUnits: sl.loincUnits || null,
          longName: sl.longName || '',
        })),
      };

      accumulator.push(entry);
    }
  }

  // ── Search ──

  /**
   * Αναζήτηση εξετάσεων στην τοπική cache.
   * Υποστηρίζει multi-word Greek queries.
   */
  searchExams(query: string, limit: number = 20): ExamSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q || q.length < 2) return [];

    const words = q.split(/\s+/).filter(w => w.length > 0);
    const results: Array<{ result: ExamSearchResult; score: number }> = [];

    for (const [examCode, entry] of this.catalog) {
      const descLower = entry.examDescription.toLowerCase();
      let score = 0;

      // Exact exam code match
      if (examCode === query) {
        score = 100;
      }
      // Single word
      else if (words.length === 1) {
        if (descLower.startsWith(q)) score = 80;
        else if (descLower.includes(q)) score = 60;
        else continue;
      }
      // Multi-word
      else {
        let allWordsMatch = true;
        let matchScore = 0;
        for (const word of words) {
          if (descLower.startsWith(word)) matchScore += 30;
          else if (descLower.includes(word)) matchScore += 20;
          else { allWordsMatch = false; break; }
        }
        if (!allWordsMatch) continue;
        // Bonus for contiguous match
        if (descLower.includes(q)) matchScore += 25;
        score = matchScore;
      }

      // Get primary LOINC
      const primaryLoinc = entry.suggestedLoincs.length > 0 ? entry.suggestedLoincs[0] : null;
      const greekName = primaryLoinc
        ? `${primaryLoinc.loincComponent}${primaryLoinc.loincSystem ? ` (${primaryLoinc.loincSystem})` : ''}`
        : entry.examDescription;

      results.push({
        result: {
          examCode: entry.examCode,
          examDescription: entry.examDescription,
          edapyCode: entry.edapyCode,
          loincCode: primaryLoinc?.loincCode || '',
          greekName,
          parameterCount: entry.suggestedLoincs.length,
        },
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map(r => r.result);
  }

  /**
   * Λήψη των παραμέτρων (suggested LOINCs) για μια εξέταση
   * με βάση τον κωδικό LOINC.
   */
  getParameters(loincCode: string): SuggestedLoinc[] {
    // Search all exams for one that has this LOINC in suggestedLoincs
    for (const [, entry] of this.catalog) {
      for (const sl of entry.suggestedLoincs) {
        if (sl.loincCode === loincCode) {
          // Return ALL suggested LOINCs for this exam as parameters
          return entry.suggestedLoincs.filter(s => s.loincCode !== loincCode);
        }
      }
    }
    return [];
  }

  /**
   * Λήψη όλων των suggested LOINCs για ένα examCode.
   */
  getSuggestedLoincs(examCode: string): SuggestedLoinc[] {
    const entry = this.catalog.get(examCode);
    return entry?.suggestedLoincs || [];
  }

  /**
   * Λήψη μιας εξέτασης με βάση το examCode.
   */
  getExam(examCode: string): ExamCatalogEntry | null {
    return this.catalog.get(examCode) || null;
  }

  // ── Helpers ──

  /** Σπάσιμο κειμένου σε tokens για αναζήτηση */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,.;:!?()\[\]{}\\/\-–—''""«»]+/)
      .filter(t => t.length > 1)
      .slice(0, 50); // Limit tokens
  }

  /** Αποθήκευση όλων των entries στο δίσκο */
  private saveToDisk(entries: ExamCatalogEntry[]): void {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(EXAM_CACHE_FILE, JSON.stringify(entries), 'utf-8');
    console.log(`💾 Exam catalog saved to disk: ${entries.length} exams`);
  }
}

export const examCatalog = new ExamCatalogService();
