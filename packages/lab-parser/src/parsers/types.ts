import {
  LabResult,
  LabTest,
  LabUnit,
  TestCategory,
  SeverityLevel,
  Patient,
} from '@medilab/core';

export { LabResult, LabTest, LabUnit, TestCategory, SeverityLevel, Patient };

/** Αποτέλεσμα parsing */
export interface ParseResult {
  success: boolean;
  results: LabResult[];
  errors: ParseError[];
  metadata?: ParseMetadata;
}

export interface ParseError {
  line?: number;
  field?: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface ParseMetadata {
  format: string;
  totalLines: number;
  parsedLines: number;
  errorLines: number;
  fileName?: string;
  parseDuration: number; // ms
}

/** Interface για όλους τους parsers */
export interface ILabParser {
  parse(data: string | Buffer, options?: ParseOptions): Promise<ParseResult>;
  validate(result: LabResult): ParseError[];
  getSupportedFormats(): string[];
}

/** Options για το parsing */
export interface ParseOptions {
  patientId?: string;
  referenceDate?: Date;
  separator?: string;
  encoding?: string;
  hasHeader?: boolean;
  dateFormat?: string;
}

/** Γεγονός parsing */
export interface ParseEvent {
  type: 'progress' | 'error' | 'complete';
  data?: any;
}
