import {
  LabResult,
  LabTest,
  LabUnit,
  TestCategory,
  SeverityLevel,
  ReferenceRange,
} from '@medilab/core';
import { ILabParser, ParseResult, ParseError, ParseOptions, ParseMetadata } from './types';

/**
 * JSON Parser για εργαστηριακά αποτελέσματα
 *
 * Υποστηρίζει δύο μορφές:
 * 1. Array από LabResult αντικείμενα
 * 2. Αντικείμενο με property `results` που περιέχει τον πίνακα
 */
export class JsonLabParser implements ILabParser {
  async parse(data: string, options?: ParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const errors: ParseError[] = [];
    const results: LabResult[] = [];

    try {
      const parsed = JSON.parse(data);
      const items = Array.isArray(parsed) ? parsed : parsed.results || [];

      for (let i = 0; i < items.length; i++) {
        try {
          const result = this.normalizeResult(items[i], options?.patientId || '');
          const validationErrors = this.validate(result);

          if (validationErrors.length > 0) {
            errors.push(...validationErrors.map(e => ({ ...e, line: i + 1 })));
          } else {
            results.push(result);
          }
        } catch (err: any) {
          errors.push({
            line: i + 1,
            message: `Σφάλμα στο αντικείμενο #${i + 1}: ${err.message}`,
            severity: 'error',
          });
        }
      }
    } catch (err: any) {
      errors.push({
        message: `Μη έγκυρο JSON: ${err.message}`,
        severity: 'error',
      });
    }

    const metadata: ParseMetadata = {
      format: 'json',
      totalLines: Array.isArray(JSON.parse(data))
        ? (JSON.parse(data) as any[]).length
        : (JSON.parse(data).results || []).length,
      parsedLines: results.length,
      errorLines: errors.length,
      parseDuration: Date.now() - startTime,
    };

    return {
      success: errors.filter(e => e.severity === 'error').length === 0,
      results,
      errors,
      metadata,
    };
  }

  validate(result: LabResult): ParseError[] {
    const errors: ParseError[] = [];
    if (!result.testId) errors.push({ field: 'testId', message: 'Απαιτείται testId', severity: 'error' });
    if (!result.test?.name) errors.push({ field: 'testName', message: 'Απαιτείται όνομα εξέτασης', severity: 'error' });
    if (result.value === undefined || result.value === null || isNaN(result.value)) {
      errors.push({ field: 'value', message: 'Μη έγκυρη τιμή εξέτασης', severity: 'error' });
    }
    if (!result.patientId) errors.push({ field: 'patientId', message: 'Απαιτείται patientId', severity: 'error' });
    return errors;
  }

  getSupportedFormats(): string[] {
    return ['json'];
  }

  private normalizeResult(raw: any, patientId: string): LabResult {
    const category = this.mapCategory(raw.category || raw.testCategory);
    const referenceRange: ReferenceRange | undefined = raw.referenceRange
      ? {
          low: raw.referenceRange.low,
          high: raw.referenceRange.high,
          criticalLow: raw.referenceRange.criticalLow,
          criticalHigh: raw.referenceRange.criticalHigh,
          unit: raw.unit,
        }
      : (raw.refLow !== undefined && raw.refHigh !== undefined)
        ? { low: raw.refLow, high: raw.refHigh, unit: raw.unit }
        : undefined;

    let severity = raw.severity || SeverityLevel.NORMAL;
    if (!raw.severity && referenceRange) {
      severity = this.evaluateSeverity(raw.value, referenceRange);
    }

    const now = new Date().toISOString();

    return {
      id: raw.id || `result_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      testId: raw.testId || raw.test?.id || '',
      test: {
        id: raw.test?.id || raw.testId || '',
        code: raw.test?.code || raw.testCode || '',
        name: raw.test?.name || raw.testName || 'Άγνωστη εξέταση',
        nameEn: raw.test?.nameEn,
        category,
        unit: raw.unit || raw.test?.unit || '',
      },
      patientId: raw.patientId || patientId,
      value: parseFloat(raw.value),
      unit: raw.unit || '',
      collectionDate: raw.collectionDate || now,
      receivedDate: raw.receivedDate || now,
      reportedDate: raw.reportedDate || now,
      referenceRange,
      severity,
      notes: raw.notes,
      isAbnormal: severity !== SeverityLevel.NORMAL,
      isCritical: severity === SeverityLevel.CRITICAL_LOW || severity === SeverityLevel.CRITICAL_HIGH,
    };
  }

  private mapCategory(categoryStr: string): TestCategory {
    if (!categoryStr) return TestCategory.OTHER;
    const lower = categoryStr.toLowerCase();
    const mapping: Record<string, TestCategory> = {
      'hematology': TestCategory.HEMATOLOGY,
      'biochemistry': TestCategory.BIOCHEMISTRY,
      'hormones': TestCategory.HORMONES,
      'tumor_markers': TestCategory.TUMOR_MARKERS,
      'immunology': TestCategory.IMMUNOLOGY,
      'microbiology': TestCategory.MICROBIOLOGY,
      'urinalysis': TestCategory.URINALYSIS,
      'coagulation': TestCategory.COAGULATION,
      'cardiac': TestCategory.CARDIAC,
      'thyroid': TestCategory.THYROID,
      'lipid_profile': TestCategory.LIPID_PROFILE,
    };
    return mapping[lower] || TestCategory.OTHER;
  }

  private evaluateSeverity(value: number, range: ReferenceRange): SeverityLevel {
    if (range.criticalLow !== undefined && value <= range.criticalLow) return SeverityLevel.CRITICAL_LOW;
    if (range.criticalHigh !== undefined && value >= range.criticalHigh) return SeverityLevel.CRITICAL_HIGH;
    if (value < range.low) return SeverityLevel.LOW;
    if (value > range.high) return SeverityLevel.HIGH;
    return SeverityLevel.NORMAL;
  }
}
