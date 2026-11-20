import { SeverityLevel, LabResult, ReferenceRange, Gender, Patient } from '../types';
import { CRITICAL_SEVERITIES, ABNORMAL_SEVERITIES } from '../constants';

// ============================================================
// Utility Functions - Shared across all modules
// ============================================================

/**
 * Υπολογισμός ηλικίας από ημερομηνία γέννησης
 */
export function calculateAge(dateOfBirth: string, referenceDate?: Date): number {
  const birth = new Date(dateOfBirth);
  const ref = referenceDate || new Date();
  let age = ref.getFullYear() - birth.getFullYear();
  const monthDiff = ref.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && ref.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * Προσδιορισμός σοβαρότητας με βάση την τιμή και το εύρος αναφοράς
 */
export function determineSeverity(value: number, range: ReferenceRange): SeverityLevel {
  if (range.criticalLow !== undefined && value <= range.criticalLow) {
    return SeverityLevel.CRITICAL_LOW;
  }
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) {
    return SeverityLevel.CRITICAL_HIGH;
  }
  if (value < range.low) {
    // Borderline: within 10% of the boundary
    const borderlineThreshold = range.low + (range.high - range.low) * 0.05;
    if (value >= borderlineThreshold) {
      return SeverityLevel.BORDERLINE_LOW;
    }
    return SeverityLevel.LOW;
  }
  if (value > range.high) {
    const borderlineThreshold = range.high - (range.high - range.low) * 0.05;
    if (value <= borderlineThreshold) {
      return SeverityLevel.BORDERLINE_HIGH;
    }
    return SeverityLevel.HIGH;
  }
  return SeverityLevel.NORMAL;
}

/**
 * Εύρεση κατάλληλου reference range για τον ασθενή
 */
export function findApplicableRange(
  baseRange: ReferenceRange,
  patient: Patient,
): { low: number; high: number } {
  const age = calculateAge(patient.dateOfBirth);

  if (baseRange.adjustments && baseRange.adjustments.length > 0) {
    for (const adj of baseRange.adjustments) {
      // Check gender match
      if (adj.gender && adj.gender !== patient.gender) continue;
      // Check age match
      if (adj.ageRange) {
        const ageInUnit = adj.ageRange.unit === 'months'
          ? age * 12
          : adj.ageRange.unit === 'days'
            ? age * 365
            : age;
        if (ageInUnit < adj.ageRange.min || ageInUnit > adj.ageRange.max) continue;
      }
      // Check status match
      if (adj.status && adj.status !== patient.status) continue;

      return { low: adj.low, high: adj.high };
    }
  }

  return { low: baseRange.low, high: baseRange.high };
}

/**
 * Ελέγχει αν μια τιμή είναι κρίσιμη
 */
export function isCritical(severity: SeverityLevel): boolean {
  return CRITICAL_SEVERITIES.includes(severity);
}

/**
 * Ελέγχει αν μια τιμή είναι παθολογική
 */
export function isAbnormal(severity: SeverityLevel): boolean {
  return ABNORMAL_SEVERITIES.includes(severity);
}

/**
 * Deep clone ενός αντικειμένου
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Format ημερομηνίας σε ελληνικό format
 */
export function formatDateEl(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('el-GR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Στρογγυλοποίηση τιμής με βάση τα significant digits
 */
export function roundValue(value: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Format τιμής με τη μονάδα της
 */
export function formatResult(result: LabResult): string {
  return `${roundValue(result.value)} ${result.unit}`;
}

/**
 * Generate a unique ID (simple implementation)
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
