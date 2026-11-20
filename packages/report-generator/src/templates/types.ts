import {
  DiagnosticReport,
  AnalysisResult,
  LabResult,
  Patient,
  SeverityLevel,
  TestCategory,
  LabResultSummary,
} from '@medilab/core';
import { calculateAge, formatDateEl, roundValue, formatResult } from '@medilab/core';
import { CATEGORY_LABELS_EL } from '@medilab/core';

/** Report format options */
export type ReportFormat = 'json' | 'html' | 'pdf' | 'csv';

/** Report sections to include */
export interface ReportOptions {
  format: ReportFormat;
  includePatientInfo: boolean;
  includeSummary: boolean;
  includeCriticalFindings: boolean;
  includeAllResults: boolean;
  includeCharts: boolean;
  includeRecommendations: boolean;
  language: 'el' | 'en';
}

/** Default report options */
export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  format: 'html',
  includePatientInfo: true,
  includeSummary: true,
  includeCriticalFindings: true,
  includeAllResults: true,
  includeCharts: true,
  includeRecommendations: true,
  language: 'el',
};

/** Section of a report */
export interface ReportSection {
  title: string;
  content: string;
  priority: number;
}

/** Generated report */
export interface GeneratedReport {
  id: string;
  format: ReportFormat;
  content: string;
  mimeType: string;
  generatedAt: string;
}
