import { Patient, ReferenceRange, DemographicAdjustment } from '@medilab/core';
import { calculateAge } from '@medilab/core';

/**
 * Δημογραφικοί υπολογισμοί και προσαρμογές
 */

/** Υπολογισμός BMI */
export function calculateBMI(weightKg: number, heightCm: number): number {
  if (!heightCm || heightCm <= 0) return 0;
  const heightM = heightCm / 100;
  return +(weightKg / (heightM * heightM)).toFixed(1);
}

/** Κατηγορία BMI */
export function getBMICategory(bmi: number): string {
  if (bmi < 18.5) return 'Λιποβαρής';
  if (bmi < 25) return 'Φυσιολογικό';
  if (bmi < 30) return 'Υπέρβαρος';
  if (bmi < 35) return 'Παχυσαρκία Ι';
  if (bmi < 40) return 'Παχυσαρκία ΙΙ';
  return 'Παχυσαρκία ΙΙΙ';
}

/** Εκτίμηση eGFR (CKD-EPI formula) */
export function calculateEGFR(
  creatinine: number,
  age: number,
  isFemale: boolean,
  isBlack: boolean = false
): number {
  const k = isFemale ? 0.7 : 0.9;
  const a = isFemale ? -0.329 : -0.411;
  const raceFactor = isBlack ? 1.159 : 1.0;
  const genderFactor = isFemale ? 1.018 : 1.0;

  const ratio = creatinine / k;
  const egfr = 141 * Math.min(ratio, 1) ** a * Math.max(ratio, 1) ** (-1.209) * (0.993 ** age) * genderFactor * raceFactor;

  return +egfr.toFixed(1);
}

/** Στάδιο eGFR */
export function getEGFRStage(egfr: number): { stage: number; description: string } {
  if (egfr >= 90) return { stage: 1, description: 'Φυσιολογική νεφρική λειτουργία' };
  if (egfr >= 60) return { stage: 2, description: 'Ήπια μείωση νεφρικής λειτουργίας' };
  if (egfr >= 45) return { stage: 3, description: 'Μέτρια μείωση νεφρικής λειτουργίας' };
  if (egfr >= 30) return { stage: 3, description: 'Μέτρια-σοβαρή μείωση νεφρικής λειτουργίας' };
  if (egfr >= 15) return { stage: 4, description: 'Σοβαρή μείωση νεφρικής λειτουργίας' };
  return { stage: 5, description: 'Νεφρική ανεπάρκεια' };
}

/** Προσαρμογή reference range με βάση BMI όταν είναι σχετικό */
export function adjustRangeForBMI(
  range: ReferenceRange,
  bmi: number
): ReferenceRange {
  // Ορισμένες εξετάσεις επηρεάζονται από το BMI
  if (bmi > 30) {
    // Στην παχυσαρκία, κάποιες τιμές μπορεί να είναι ελαφρώς αυξημένες
    return {
      ...range,
      high: range.high * 1.05, // 5% ανοχή για υπέρβαρους
    };
  }
  return range;
}
