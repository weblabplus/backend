// ============================================================
// LOINC Cache Service
// Αντλεί κωδικούς LOINC από το Lab Data Repository API και
// τους αποθηκεύει τοπικά για γρήγορη αναζήτηση.
// ============================================================

import * as fs from 'fs';
import { labRepoAuthHeaders, type LabRepoCredentials } from './lab-repo-config';
import * as path from 'path';
import { DATA_DIR } from '../config/data-dir';

export interface LoincRecord {
  loincCode: string;
  component: string;       // Greek component name
  system: string;           // Greek system
  method: string;           // Greek method
  property: string;
  timeAspect: string;
  scale: string;
  loincClass: string;
  longName: string;         // English long common name
  componentEn: string;      // English component
  description: string;      // English description
};

/** Compact cache: Map<loincCode, displayName> for O(1) lookups */
type LoincNameCache = Record<string, string>;

/** Full records cache for search */
type LoincSearchCache = Record<string, LoincRecord>;

const CACHE_DIR = DATA_DIR;
const NAMES_CACHE_FILE = path.join(CACHE_DIR, 'loinc-names.json');
const SEARCH_CACHE_FILE = path.join(CACHE_DIR, 'loinc-search.json');

const API_BASE = 'https://testeps.e-prescription.gr/labdatarepository';
const API_USERNAME = 'dontpointapi';
const API_PASSWORD = 'Ipatnioptnod!111';

function getAuthHeaders(credentials?: LabRepoCredentials): Record<string, string> {
  return labRepoAuthHeaders(credentials);
}

export class LoincCacheService {
  private nameCache: LoincNameCache = {};
  private searchCache: LoincSearchCache = {};
  private loaded = false;

  /** Φόρτωση της cache από το δίσκο κατά την εκκίνηση */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      if (fs.existsSync(NAMES_CACHE_FILE)) {
        const raw = fs.readFileSync(NAMES_CACHE_FILE, 'utf-8');
        this.nameCache = JSON.parse(raw);
        console.log(`📦 LOINC name cache loaded: ${Object.keys(this.nameCache).length} codes`);
      }

      if (fs.existsSync(SEARCH_CACHE_FILE)) {
        const raw = fs.readFileSync(SEARCH_CACHE_FILE, 'utf-8');
        this.searchCache = JSON.parse(raw);
        console.log(`📦 LOINC search cache loaded: ${Object.keys(this.searchCache).length} records`);
      }

      this.loaded = true;
    } catch (err) {
      console.warn('⚠️ Failed to load LOINC cache:', err);
      this.loaded = true; // Continue without cache
    }
  }

  get isLoaded(): boolean {
    return this.loaded && Object.keys(this.nameCache).length > 0;
  }

  get cacheSize(): number {
    return Object.keys(this.nameCache).length;
  }

  /** O(1) lookup: πάρε το ελληνικό όνομα για έναν κωδικό LOINC */
  getGreekName(loincCode: string): string | null {
    return this.nameCache[loincCode] || null;
  }

  /** Αναζήτηση στους cached LOINC κωδικούς – υποστηρίζει multi-word Greek queries */
  searchLocal(query: string, limit: number = 20): LoincRecord[] {
    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/).filter(w => w.length > 0);
    const results: Array<{ record: LoincRecord; score: number }> = [];

    for (const code of Object.keys(this.searchCache)) {
      const r = this.searchCache[code];
      const compLower = r.component.toLowerCase();
      const sysLower = r.system.toLowerCase();
      const methLower = r.method.toLowerCase();
      const descLower = r.description.toLowerCase();
      const combined = `${compLower} ${sysLower} ${methLower} ${descLower}`;
      let score = 0;

      // Exact LOINC code match
      if (r.loincCode === query) {
        score = 100;
      }
      // Check each word
      else if (words.length === 1) {
        // Single word query
        if (compLower.startsWith(q)) score = 80;
        else if (compLower.includes(q)) score = 60;
        else if (combined.includes(q)) score = 40;
        else continue;
      } else {
        // Multi-word query: all words must match somewhere in the combined fields
        let allWordsMatch = true;
        let matchScore = 0;
        for (const word of words) {
          if (compLower.startsWith(word)) matchScore += 30;
          else if (compLower.includes(word)) matchScore += 20;
          else if (combined.includes(word)) matchScore += 10;
          else { allWordsMatch = false; break; }
        }
        if (!allWordsMatch) continue;
        // Bonus for contiguous match
        if (compLower.includes(q)) matchScore += 25;
        score = matchScore;
      }

      results.push({ record: r, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map(r => r.record);
  }

  /** Συγχρονισμός όλων των LOINC κωδικών από το Lab Data Repository */
  async syncFromApi(
    onProgress?: (page: number, totalPages: number, count: number) => void
  ): Promise<{ total: number; pages: number }> {
    const headers = getAuthHeaders();

    // Πρώτη κλήση για να μάθουμε το σύνολο
    const firstUrl = `${API_BASE}/api/masterdata/loinc?page=1&pageSize=1000`;
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
    console.log(`🔄 Starting LOINC sync: ${totalEntries} entries, ${totalPages} pages`);

    // Process first page
    this.processPage(firstData.content);

    if (onProgress) onProgress(1, totalPages, Object.keys(this.nameCache).length);

    // Fetch remaining pages
    const batchSize = 5; // Fetch 5 pages concurrently
    for (let startPage = 2; startPage <= totalPages; startPage += batchSize) {
      const endPage = Math.min(startPage + batchSize - 1, totalPages);
      const promises: Promise<any>[] = [];

      for (let p = startPage; p <= endPage; p++) {
        const url = `${API_BASE}/api/masterdata/loinc?page=${p}&pageSize=1000`;
        promises.push(
          fetch(url, { headers }).then(async resp => {
            if (!resp.ok) throw new Error(`Page ${p} failed: ${resp.status}`);
            return resp.json();
          })
        );
      }

      const results = await Promise.all(promises);
      for (const data of results) {
        this.processPage(data.content);
      }

      if (onProgress) onProgress(endPage, totalPages, Object.keys(this.nameCache).length);
    }

    // Save to disk
    this.saveToDisk();

    console.log(`✅ LOINC sync complete: ${Object.keys(this.nameCache).length} codes cached`);
    return { total: totalEntries, pages: totalPages };
  }

  /** Επεξεργασία μιας σελίδας δεδομένων */
  private processPage(content: any[]): void {
    for (const item of content) {
      const loincCode = item.loincCode as string;
      if (!loincCode) continue;

      const component = (item.loincComponent || '').trim();
      const system = (item.loincSystem || '').trim();
      const method = (item.loincMethod || '').trim();

      // Build Greek display name: "COMPONENT (SYSTEM, METHOD)"
      const parts: string[] = [];
      if (component) parts.push(component);
      const details: string[] = [];
      if (system) details.push(system);
      if (method) details.push(method);
      const suffix = details.length > 0 ? `(${details.join(', ')})` : '';

      this.nameCache[loincCode] = (parts.join(' ') + (suffix ? ` ${suffix}` : '')).trim();

      this.searchCache[loincCode] = {
        loincCode,
        component,
        system,
        method,
        property: item.loincProperty || '',
        timeAspect: item.loincTimeAspect || '',
        scale: item.loincScale || '',
        loincClass: item.loincClass || '',
        longName: item.longName || '',
        componentEn: item.loincComponentEn || '',
        description: item.loincDescription || item.loincComponentEn || '',
      };
    }
  }

  /** Αποθήκευση της cache στο δίσκο */
  private saveToDisk(): void {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(NAMES_CACHE_FILE, JSON.stringify(this.nameCache), 'utf-8');
    fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(this.searchCache), 'utf-8');
    console.log(`💾 LOINC cache saved to disk`);
  }
}

export const loincCache = new LoincCacheService();
