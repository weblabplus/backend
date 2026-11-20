import {
  ReferenceRange,
  Patient,
  Gender,
  PatientStatus,
} from '@medilab/core';
import { calculateAge } from '@medilab/core';
import { DEFAULT_REFERENCE_RANGES, DEMOGRAPHIC_ADJUSTMENTS } from './defaults';

/**
 * Reference Range Manager
 *
 * Διαχειρίζεται τις τιμές αναφοράς και τις προσαρμογές
 * ανάλογα με τα δημογραφικά στοιχεία του ασθενούς.
 */
export class ReferenceRangeManager {
  private ranges: Map<string, ReferenceRange> = new Map();
  private adjustments: Map<string, import('@medilab/core').DemographicAdjustment[]> = new Map();

  constructor() {
    // Load defaults
    this.loadDefaults();
  }

  /** Φόρτωση προκαθορισμένων τιμών */
  private loadDefaults(): void {
    for (const [key, range] of Object.entries(DEFAULT_REFERENCE_RANGES)) {
      this.ranges.set(key, range);
    }
    for (const [key, adjustments] of Object.entries(DEMOGRAPHIC_ADJUSTMENTS)) {
      this.adjustments.set(key, adjustments);
    }
  }

  /**
   * Προσθήκη/Ενημέρωση reference range
   */
  setRange(testCode: string, range: ReferenceRange): void {
    this.ranges.set(testCode.toUpperCase(), range);
  }

  /**
   * Λήψη reference range για συγκεκριμένη εξέταση
   */
  getRange(testCode: string): ReferenceRange | undefined {
    return this.ranges.get(testCode.toUpperCase());
  }

  /**
   * Λήψη reference range προσαρμοσμένο στον ασθενή
   */
  getRangeForPatient(testCode: string, patient: Patient): ReferenceRange | undefined {
    const baseRange = this.ranges.get(testCode.toUpperCase());
    if (!baseRange) return undefined;

    const age = calculateAge(patient.dateOfBirth);
    const adjustments = this.adjustments.get(testCode.toUpperCase()) || [];

    // Look for applicable adjustments
    for (const adj of adjustments) {
      let match = true;

      if (adj.gender && adj.gender !== patient.gender) match = false;
      if (adj.status && adj.status !== patient.status) match = false;
      if (adj.ageRange) {
        const ageInUnit = adj.ageRange.unit === 'months'
          ? age * 12
          : adj.ageRange.unit === 'days'
            ? age * 365
            : age;
        if (ageInUnit < adj.ageRange.min || ageInUnit > adj.ageRange.max) match = false;
      }

      if (match) {
        return {
          ...baseRange,
          low: adj.low,
          high: adj.high,
        };
      }
    }

    return baseRange;
  }

  /**
   * Λήψη reference range με βάση το φύλο (για εξετάσεις όπως HGB, RBC)
   */
  getGenderSpecificRange(testCode: string, gender: Gender): ReferenceRange | undefined {
    const genderKey = `${testCode}_${gender.toUpperCase()}`;
    const genderRange = this.ranges.get(genderKey);
    if (genderRange) return genderRange;

    // Fallback to base range
    return this.ranges.get(testCode.toUpperCase());
  }

  /**
   * Λήψη όλων των αποθηκευμένων ranges
   */
  getAllRanges(): Map<string, ReferenceRange> {
    return new Map(this.ranges);
  }

  /**
   * Αφαίρεση reference range
   */
  removeRange(testCode: string): boolean {
    return this.ranges.delete(testCode.toUpperCase());
  }

  /**
   * Προσθήκη δημογραφικής προσαρμογής
   */
  addDemographicAdjustment(testCode: string, adjustment: import('@medilab/core').DemographicAdjustment): void {
    const key = testCode.toUpperCase();
    const existing = this.adjustments.get(key) || [];
    existing.push(adjustment);
    this.adjustments.set(key, existing);
  }

  /**
   * Λήψη προσαρμογών για εξέταση
   */
  getDemographicAdjustments(testCode: string): import('@medilab/core').DemographicAdjustment[] {
    return this.adjustments.get(testCode.toUpperCase()) || [];
  }

  /**
   * Έλεγχος αν υπάρχει range για εξέταση
   */
  hasRange(testCode: string): boolean {
    return this.ranges.has(testCode.toUpperCase());
  }

  /**
   * Πλήθος αποθηκευμένων ranges
   */
  get count(): number {
    return this.ranges.size;
  }

  /**
   * Επαναφορά στα defaults
   */
  resetToDefaults(): void {
    this.ranges.clear();
    this.adjustments.clear();
    this.loadDefaults();
  }
}

// Singleton instance
export const referenceRangeManager = new ReferenceRangeManager();
