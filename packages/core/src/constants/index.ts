import { SeverityLevel, TestCategory, LabUnit } from '../types';

// Re-export exam catalog
export { EXAM_CATALOG, getExamTemplate, findExamTemplateByName, EXAM_CATEGORY_LABELS_EL } from './examCatalog';
export type { ExamTemplate } from '../types';

// Re-export Greek medical terms
export { GREEK_TO_ENGLISH_MEDICAL, ENGLISH_TO_GREEK_MEDICAL, containsGreek, translateGreekToEnglish, translateEnglishToGreek, makeGreekLoincName } from './greekMedicalTerms';

// ============================================================
// Medical Constants & Default Values
// ============================================================

/** Ελληνικές ονομασίες κατηγοριών εξετάσεων */
export const CATEGORY_LABELS_EL: Record<TestCategory, string> = {
  [TestCategory.HEMATOLOGY]: 'Αιματολογία',
  [TestCategory.BIOCHEMISTRY]: 'Βιοχημεία',
  [TestCategory.HORMONES]: 'Ορμόνες',
  [TestCategory.TUMOR_MARKERS]: 'Καρκινικοί Δείκτες',
  [TestCategory.IMMUNOLOGY]: 'Ανοσολογία',
  [TestCategory.MICROBIOLOGY]: 'Μικροβιολογία',
  [TestCategory.URINALYSIS]: 'Γενική Ούρων',
  [TestCategory.COAGULATION]: 'Πηκτικότητα',
  [TestCategory.CARDIAC]: 'Καρδιολογικοί Δείκτες',
  [TestCategory.THYROID]: 'Θυρεοειδής',
  [TestCategory.LIPID_PROFILE]: 'Λιπίδια',
  [TestCategory.OTHER]: 'Άλλες',
};

/** Σοβαρότητα ανά επίπεδο (για ταξινόμηση) */
export const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  [SeverityLevel.NORMAL]: 0,
  [SeverityLevel.BORDERLINE_LOW]: 1,
  [SeverityLevel.BORDERLINE_HIGH]: 1,
  [SeverityLevel.LOW]: 2,
  [SeverityLevel.HIGH]: 2,
  [SeverityLevel.ABNORMAL]: 2,
  [SeverityLevel.CRITICAL_LOW]: 3,
  [SeverityLevel.CRITICAL_HIGH]: 3,
};

/** Επίπεδα για flagging */
export const CRITICAL_SEVERITIES: SeverityLevel[] = [
  SeverityLevel.CRITICAL_LOW,
  SeverityLevel.CRITICAL_HIGH,
];

export const ABNORMAL_SEVERITIES: SeverityLevel[] = [
  SeverityLevel.LOW,
  SeverityLevel.HIGH,
  SeverityLevel.ABNORMAL,
  SeverityLevel.BORDERLINE_LOW,
  SeverityLevel.BORDERLINE_HIGH,
  SeverityLevel.CRITICAL_LOW,
  SeverityLevel.CRITICAL_HIGH,
];

/** Firestore collection names */
export const COLLECTIONS = {
  PATIENTS: 'patients',
  LAB_RESULTS: 'labResults',
  LAB_TESTS: 'labTests',
  LAB_PANELS: 'labPanels',
  REFERENCE_RANGES: 'referenceRanges',
  ANALYSIS_RESULTS: 'analysisResults',
  DIAGNOSTIC_REPORTS: 'diagnosticReports',
  AUDIT_LOGS: 'auditLogs',
  USERS: 'users',
} as const;

/** API Routes */
export const API_ROUTES = {
  PATIENTS: '/api/patients',
  LAB_RESULTS: '/api/lab-results',
  UPLOAD: '/api/upload',
  ANALYZE: '/api/analyze',
  REPORTS: '/api/reports',
  REFERENCE_RANGES: '/api/reference-ranges',
} as const;

/** Supported upload file formats */
export const SUPPORTED_FORMATS = ['csv', 'json', 'xlsx', 'hl7', 'pdf'] as const;
export type SupportedFormat = typeof SUPPORTED_FORMATS[number];

/** Default pagination */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Μονάδες και τα conversion factors τους (προς βασική μονάδα) */
export const UNIT_CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  'mg/dL': { 'mmol/L': (v: number) => v * 0.0555, 'g/L': (v: number) => v * 0.01 },
  'mmol/L': { 'mg/dL': (v: number) => v * 18.0182 },
  'ng/mL': { 'μg/L': (v: number) => v * 1, 'μg/dL': (v: number) => v * 0.1 },
  'μg/dL': { 'ng/mL': (v: number) => v * 10 },
};
