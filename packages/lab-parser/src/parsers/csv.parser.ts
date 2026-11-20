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
 * CSV Parser για εργαστηριακά αποτελέσματα
 *
 * Αναμενόμενες στήλες:
 *   testCode, testName, value, unit, category,
 *   refLow, refHigh, collectionDate, receivedDate
 */
export class CsvLabParser implements ILabParser {
  private defaultOptions: ParseOptions = {
    separator: ',',
    encoding: 'utf-8',
    hasHeader: true,
    dateFormat: 'YYYY-MM-DD',
  };

  async parse(data: string, options?: ParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const errors: ParseError[] = [];
    const results: LabResult[] = [];

    try {
      const lines = data.split('\n').filter(line => line.trim() !== '');
      const headers = opts.hasHeader
        ? this.parseHeader(lines[0], opts.separator!)
        : this.getDefaultHeaders();
      const startLine = opts.hasHeader ? 1 : 0;

      for (let i = startLine; i < lines.length; i++) {
        try {
          const values = this.parseLine(lines[i], opts.separator!);
          const row = this.mapRow(headers, values);
          const result = this.buildLabResult(row, opts.patientId || '');
          const validationErrors = this.validate(result);

          if (validationErrors.length > 0) {
            errors.push(...validationErrors.map(e => ({ ...e, line: i + 1 })));
          } else {
            results.push(result);
          }
        } catch (err: any) {
          errors.push({
            line: i + 1,
            message: `Σφάλμα parsing στη γραμμή ${i + 1}: ${err.message}`,
            severity: 'error',
          });
        }
      }
    } catch (err: any) {
      errors.push({
        message: `Σφάλμα κατά το parsing: ${err.message}`,
        severity: 'error',
      });
    }

    const metadata: ParseMetadata = {
      format: 'csv',
      totalLines: data.split('\n').filter(l => l.trim()).length - (opts.hasHeader ? 1 : 0),
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
    return ['csv', 'tsv', 'txt'];
  }

  private parseHeader(line: string, separator: string): string[] {
    return line.split(separator).map(h => h.trim().toLowerCase().replace(/"/g, ''));
  }

  private getDefaultHeaders(): string[] {
    return ['testCode', 'testName', 'value', 'unit', 'category', 'refLow', 'refHigh', 'collectionDate', 'receivedDate'];
  }

  private parseLine(line: string, separator: string): string[] {
    // Handle quoted fields
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === separator && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  private mapRow(headers: string[], values: string[]): Record<string, string> {
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = values[i] || '';
    });
    return row;
  }

  private buildLabResult(row: Record<string, string>, patientId: string): LabResult {
    const category = this.mapCategory(row['category']);
    const value = parseFloat(row['value']);
    const refLow = parseFloat(row['reflow']);
    const refHigh = parseFloat(row['refhigh']);
    const test: LabTest = {
      id: row['testcode'] || `test_${Date.now()}`,
      code: row['testcode'] || '',
      name: row['testname'] || 'Άγνωστη εξέταση',
      category,
      unit: (row['unit'] as LabUnit) || '',
    };

    const referenceRange: ReferenceRange | undefined = !isNaN(refLow) && !isNaN(refHigh)
      ? { low: refLow, high: refHigh, unit: test.unit }
      : undefined;

    // Determine severity
    let severity = SeverityLevel.NORMAL;
    if (referenceRange) {
      severity = this.evaluateSeverity(value, referenceRange);
    }

    const now = new Date().toISOString();
    return {
      id: `result_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      testId: test.id,
      test,
      patientId,
      value,
      unit: test.unit,
      collectionDate: row['collectiondate'] || now,
      receivedDate: row['receiveddate'] || now,
      reportedDate: now,
      referenceRange,
      severity,
      isAbnormal: severity !== SeverityLevel.NORMAL,
      isCritical: severity === SeverityLevel.CRITICAL_LOW || severity === SeverityLevel.CRITICAL_HIGH,
    };
  }

  private mapCategory(categoryStr: string): TestCategory {
    const mapping: Record<string, TestCategory> = {
      'αιματολογία': TestCategory.HEMATOLOGY,
      'hematology': TestCategory.HEMATOLOGY,
      'βιοχημεία': TestCategory.BIOCHEMISTRY,
      'biochemistry': TestCategory.BIOCHEMISTRY,
      'ορμόνες': TestCategory.HORMONES,
      'hormones': TestCategory.HORMONES,
      'ανοσολογία': TestCategory.IMMUNOLOGY,
      'immunology': TestCategory.IMMUNOLOGY,
      'μικροβιολογία': TestCategory.MICROBIOLOGY,
      'microbiology': TestCategory.MICROBIOLOGY,
      'ούρων': TestCategory.URINALYSIS,
      'urinalysis': TestCategory.URINALYSIS,
      'πηκτικότητα': TestCategory.COAGULATION,
      'coagulation': TestCategory.COAGULATION,
      'καρδιολογικοί': TestCategory.CARDIAC,
      'cardiac': TestCategory.CARDIAC,
      'θυρεοειδής': TestCategory.THYROID,
      'thyroid': TestCategory.THYROID,
      'λιπίδια': TestCategory.LIPID_PROFILE,
      'lipid': TestCategory.LIPID_PROFILE,
    };

    const lower = (categoryStr || '').toLowerCase();
    for (const [key, value] of Object.entries(mapping)) {
      if (lower.includes(key)) return value;
    }
    return TestCategory.OTHER;
  }

  private evaluateSeverity(value: number, range: ReferenceRange): SeverityLevel {
    if (range.criticalLow !== undefined && value <= range.criticalLow) return SeverityLevel.CRITICAL_LOW;
    if (range.criticalHigh !== undefined && value >= range.criticalHigh) return SeverityLevel.CRITICAL_HIGH;
    if (value < range.low) return SeverityLevel.LOW;
    if (value > range.high) return SeverityLevel.HIGH;
    return SeverityLevel.NORMAL;
  }
}
