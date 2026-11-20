import { LabResult, SeverityLevel, TestCategory } from '@medilab/core';
import { ILabParser, ParseResult, ParseError, ParseOptions } from './types';

/**
 * HL7 Parser για μηνύματα HL7 v2.x (ORU^R01)
 *
 * Υποστηρίζει βασικό parsing OBX segments από HL7 μηνύματα.
 * Για production use, προτείνεται η χρήση εξειδικευμένης βιβλιοθήκης.
 */
export class Hl7LabParser implements ILabParser {
  async parse(data: string, options?: ParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const errors: ParseError[] = [];
    const results: LabResult[] = [];

    try {
      const segments = data.split(/\r?\n/).filter(s => s.trim());

      let currentPatientId = options?.patientId || '';
      let collectionDate = new Date().toISOString();

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const fields = segment.split('|');

        const segmentType = fields[0];

        switch (segmentType) {
          case 'PID':
            // Extract patient ID from PID segment
            if (!options?.patientId && fields[3]) {
              currentPatientId = fields[3].split('^')[0] || '';
            }
            break;

          case 'OBR':
            // Observation Request - extract collection date
            if (fields[7]) {
              collectionDate = this.parseHl7Date(fields[7]);
            }
            break;

          case 'OBX':
            // Observation/Result
            try {
              const result = this.parseObxSegment(fields, currentPatientId, collectionDate);
              if (result) {
                const validationErrors = this.validate(result);
                if (validationErrors.length > 0) {
                  errors.push(...validationErrors.map(e => ({ ...e, line: i + 1 })));
                } else {
                  results.push(result);
                }
              }
            } catch (err: any) {
              errors.push({
                line: i + 1,
                message: `Σφάλμα parsing OBX segment: ${err.message}`,
                severity: 'error',
              });
            }
            break;
        }
      }
    } catch (err: any) {
      errors.push({
        message: `Σφάλμα κατά το parsing HL7: ${err.message}`,
        severity: 'error',
      });
    }

    return {
      success: errors.filter(e => e.severity === 'error').length === 0,
      results,
      errors,
      metadata: {
        format: 'hl7',
        totalLines: data.split(/\r?\n/).filter(s => s.trim() && s.startsWith('OBX')).length,
        parsedLines: results.length,
        errorLines: errors.length,
        parseDuration: Date.now() - startTime,
      },
    };
  }

  validate(result: LabResult): ParseError[] {
    const errors: ParseError[] = [];
    if (!result.testId) errors.push({ field: 'testId', message: 'Απαιτείται testId', severity: 'error' });
    if (!result.test?.name) errors.push({ field: 'testName', message: 'Απαιτείται όνομα εξέτασης', severity: 'error' });
    if (result.value === undefined || isNaN(result.value)) {
      errors.push({ field: 'value', message: 'Μη έγκυρη τιμή εξέτασης', severity: 'error' });
    }
    return errors;
  }

  getSupportedFormats(): string[] {
    return ['hl7'];
  }

  private parseObxSegment(fields: string[], patientId: string, collectionDate: string): LabResult | null {
    // OBX|1|NM|12345^Γλυκόζη^LOINC||120|mg/dL|70-110|N|||F
    const setId = fields[1];
    const valueType = fields[2];
    const observationId = fields[3]; // ^ component separated
    const observationSubId = fields[4];
    const observationValue = fields[5];
    const units = fields[6];
    const referenceRange = fields[7];
    const abnormalFlags = fields[8];

    // Skip if no value
    if (!observationValue || observationValue === '') return null;

    // Parse test identifier (code^name^codingSystem)
    const testParts = observationId.split('^');
    const testCode = testParts[0] || '';
    const testName = testParts[1] || `Test ${testCode}`;

    // Parse reference range (low-high)
    let refLow: number | undefined;
    let refHigh: number | undefined;
    if (referenceRange) {
      const rangeParts = referenceRange.split('-');
      refLow = parseFloat(rangeParts[0]);
      refHigh = parseFloat(rangeParts[1]);
    }

    // Parse value
    const numericValue = valueType === 'NM' ? parseFloat(observationValue) : NaN;
    if (isNaN(numericValue)) return null;

    let severity: SeverityLevel = SeverityLevel.NORMAL;
    if (abnormalFlags) {
      switch (abnormalFlags.toUpperCase()) {
        case 'L':
        case 'LL': severity = SeverityLevel.LOW; break;
        case 'H':
        case 'HH': severity = SeverityLevel.HIGH; break;
        case 'A': severity = SeverityLevel.ABNORMAL; break;
        case 'CRIT': severity = SeverityLevel.CRITICAL_HIGH; break;
      }
    }

    const result: LabResult = {
      id: `hl7_${setId}_${Date.now()}`,
      testId: testCode,
      test: {
        id: testCode,
        code: testCode,
        name: testName,
        category: TestCategory.OTHER,
        unit: units || '',
      },
      patientId,
      value: numericValue,
      unit: units || '',
      collectionDate,
      receivedDate: collectionDate,
      reportedDate: new Date().toISOString(),
      referenceRange: !isNaN(refLow!) && !isNaN(refHigh!)
        ? { low: refLow!, high: refHigh!, unit: units || '' }
        : undefined,
      severity,
      isAbnormal: severity !== SeverityLevel.NORMAL,
      isCritical: (severity as SeverityLevel) === SeverityLevel.CRITICAL_LOW || (severity as SeverityLevel) === SeverityLevel.CRITICAL_HIGH,
    };

    return result;
  }

  private parseHl7Date(hl7Date: string): string {
    // HL7 date format: YYYYMMDD[HHMM[SS]]
    if (hl7Date.length >= 8) {
      const year = hl7Date.substring(0, 4);
      const month = hl7Date.substring(4, 6);
      const day = hl7Date.substring(6, 8);
      const hour = hl7Date.length >= 10 ? hl7Date.substring(8, 10) : '00';
      const min = hl7Date.length >= 12 ? hl7Date.substring(10, 12) : '00';
      const sec = hl7Date.length >= 14 ? hl7Date.substring(12, 14) : '00';
      return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
    }
    return new Date().toISOString();
  }
}
