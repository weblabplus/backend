// ============================================================
// Core Types for MediLab - Medical Diagnostic Lab Analyzer
// ============================================================

/** Μονάδες μέτρησης εργαστηριακών εξετάσεων */
export type LabUnit =
  | 'mg/dL' | 'g/dL' | 'mmol/L' | 'μmol/L' | 'nmol/L' | 'pmol/L'
  | 'mEq/L' | 'U/L' | 'IU/L' | 'ng/mL' | 'pg/mL' | 'μg/dL'
  | '%' | 'fL' | 'pg' | 'g' | 'cells/μL' | 'cells/mm³'
  | 'mm/h' | 'sec' | 'min' | 'ratio' | 'mg/24h' | string;

/** Επίπεδο σοβαρότητας αποτελέσματος */
export enum SeverityLevel {
  NORMAL = 'normal',
  BORDERLINE_LOW = 'borderline_low',
  BORDERLINE_HIGH = 'borderline_high',
  LOW = 'low',
  HIGH = 'high',
  CRITICAL_LOW = 'critical_low',
  CRITICAL_HIGH = 'critical_high',
  ABNORMAL = 'abnormal', // Παθολογικό χωρίς συγκεκριμένη κατεύθυνση
}

/** Κατηγορία εξέτασης */
export enum TestCategory {
  HEMATOLOGY = 'hematology',
  BIOCHEMISTRY = 'biochemistry',
  HORMONES = 'hormones',
  TUMOR_MARKERS = 'tumor_markers',
  IMMUNOLOGY = 'immunology',
  MICROBIOLOGY = 'microbiology',
  URINALYSIS = 'urinalysis',
  COAGULATION = 'coagulation',
  CARDIAC = 'cardiac',
  THYROID = 'thyroid',
  LIPID_PROFILE = 'lipid_profile',
  OTHER = 'other',
}

/** Φύλο ασθενούς */
export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
}

/** Κατάσταση ασθενούς */
export enum PatientStatus {
  FASTING = 'fasting',
  NON_FASTING = 'non_fasting',
  PREGNANT = 'pregnant',
  POST_MENOPAUSAL = 'post_menopausal',
  PEDIATRIC = 'pediatric',
  GERIATRIC = 'geriatric',
  UNKNOWN = 'unknown',
}

/** Μοντέλο ασθενούς */
export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO 8601
  gender: Gender;
  status?: PatientStatus;
  medicalHistory?: string[];
  medications?: string[];
  height?: number;  // cm
  weight?: number;  // kg
  amka?: string;    // Αριθμός Μητρώου Κοινωνικής Ασφάλισης (AMKA)
}

/** Μία εργαστηριακή εξέταση */
export interface LabTest {
  id: string;
  code: string;        // LOINC ή τοπικός κωδικός
  name: string;        // Π.χ. "Γλυκόζη", "Αιμοσφαιρίνη"
  nameEn?: string;     // English name
  category: TestCategory;
  unit: LabUnit;
}

/** Αποτέλεσμα μίας εξέτασης */
export interface LabResult {
  id: string;
  testId: string;
  test: LabTest;
  patientId: string;
  value: number;
  unit: LabUnit;
  collectionDate: string;     // Ημερομηνία λήψης δείγματος
  receivedDate: string;       // Ημερομηνία παραλαβής
  reportedDate: string;       // Ημερομηνία έκδοσης
  referenceRange?: ReferenceRange;
  severity: SeverityLevel;
  notes?: string;
  isAbnormal: boolean;
  isCritical: boolean;
}

/** Εύρος τιμών αναφοράς */
export interface ReferenceRange {
  low: number;
  high: number;
  criticalLow?: number;
  criticalHigh?: number;
  unit: LabUnit;
  /** Προσαρμογές ανά δημογραφικά */
  adjustments?: DemographicAdjustment[];
}

/** Δημογραφική προσαρμογή εύρους αναφοράς */
export interface DemographicAdjustment {
  gender?: Gender;
  ageRange?: { min: number; max: number; unit: 'years' | 'months' | 'days' };
  status?: PatientStatus;
  low: number;
  high: number;
}

/** Πλήρες πακέτο εξετάσεων */
export interface LabPanel {
  id: string;
  name: string;
  testIds: string[];
  category: TestCategory;
}

/** Ανάλυση αποτελέσματος */
export interface AnalysisResult {
  labResult: LabResult;
  severity: SeverityLevel;
  interpretation: string;
  recommendations: string[];
  relatedTests?: string[];       // Προτεινόμενες επιπλέον εξετάσεις
  differentialDiagnosis?: string[];
  confidence?: number;           // 0-1 confidence score (από ML engine)
}

/** Πλήρης αναφορά ανάλυσης */
export interface DiagnosticReport {
  id: string;
  patient: Patient;
  labResults: LabResult[];
  analyses: AnalysisResult[];
  summary: string;
  criticalFindings: AnalysisResult[];
  generatedDate: string;
  generatedBy: 'rule-engine' | 'ml-engine' | 'hybrid';
  reviewed: boolean;
  reviewedBy?: string;
}

/** Σύνοψη για dashboard */
export interface LabResultSummary {
  totalTests: number;
  normalCount: number;
  abnormalCount: number;
  criticalCount: number;
  byCategory: Record<TestCategory, { total: number; abnormal: number; critical: number }>;
}

/** Events για communication μεταξύ modules (Event-Driven) */
export enum MediLabEvent {
  LAB_RESULTS_UPLOADED = 'lab:results:uploaded',
  PARSING_COMPLETED = 'lab:parsing:completed',
  ANALYSIS_COMPLETED = 'lab:analysis:completed',
  REPORT_GENERATED = 'lab:report:generated',
  CRITICAL_FINDING = 'lab:critical:finding',
  PATIENT_UPDATED = 'patient:updated',
  REFERENCE_RANGES_UPDATED = 'reference:ranges:updated',
}

/** Κατάσταση επίσκεψης */
export enum VisitStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** Μοντέλο επίσκεψης ασθενούς */
export interface Visit {
  id: string;
  patientId: string;
  patientName?: string;  // denormalized for display
  visitDate: string;     // ISO 8601
  reason: string;        // λόγος επίσκεψης
  diagnosis?: string;    // διάγνωση
  notes?: string;        // σημειώσεις
  doctorId?: string;
  status: VisitStatus;
  createdAt: string;
  updatedAt: string;
}

/** Κατάσταση ραντεβού */
export enum AppointmentStatus {
  SCHEDULED = 'scheduled',
  CONFIRMED = 'confirmed',
  /** Το ραντεβού μετατράπηκε σε επίσκεψη */
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

/** Μοντέλο ραντεβού (Ημερολόγιο) */
export interface Appointment {
  id: string;
  patientId: string;
  patientName?: string;   // denormalized for display
  doctorId?: string;
  scheduledAt: string;    // ISO 8601 (ημερομηνία + ώρα)
  durationMinutes?: number;
  reason: string;         // λόγος ραντεβού
  notes?: string;         // σημειώσεις
  status: AppointmentStatus;
  visitId?: string;       // Η επίσκεψη στην οποία μετατράπηκε
  createdAt: string;
  updatedAt: string;
}

/** Κατάσταση παραπεμπτικού */
export enum ReferralStatus {
  PENDING = 'pending',
  SENT = 'sent',
  RECEIVED = 'received',
  /** Σε εξέλιξη — εκτελέστηκε μέρος των εξετάσεων στον φορέα */
  PARTIALLY_EXECUTED = 'partially_executed',
  /** Σε εξέλιξη — εκτελέστηκαν όλες οι εξετάσεις στον φορέα */
  FULLY_EXECUTED = 'fully_executed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** Μοντέλο παραπεμπτικού */
export interface Referral {
  id: string;
  visitId: string;         // υποχρεωτική σύνδεση με επίσκεψη
  patientId: string;
  patientName?: string;     // denormalized for display
  visitReason?: string;     // denormalized λόγος επίσκεψης
  specialty: string;        // ειδικότητα (π.χ. Καρδιολόγος, Ακτινολόγος)
  reason: string;           // λόγος παραπομπής
  hospital?: string;        // νοσοκομείο/κλινική προορισμού
  referralDate: string;     // ISO 8601
  status: ReferralStatus;
  notes?: string;
  reportUrl?: string;       // URL αποτελέσματος παραπεμπτικού
  doctorId?: string;
  // ── Στοιχεία εκτέλεσης e-Prescription (ΗΔΙΚΑ) ──
  barcode?: string;                    // barcode παραπεμπτικού φορέα
  executionNo?: string;                // αριθμός εκτέλεσης (για ακύρωση μερικής)
  executionType?: 'full' | 'partial';  // τρόπος εκτέλεσης
  executedLineIds?: string[];          // γραμμές που εκτελέστηκαν
  executedAt?: string;                 // ISO 8601
  // ── Αποστολή αποτελεσμάτων (Lab Data Repository / ΗΔΙΚΑ) ──
  resultsSubmittedAt?: string;         // ISO 8601 — πότε στάλθηκαν
  resultsSubmittedCount?: number;      // πλήθος δεικτών που στάλθηκαν
  createdAt: string;
  updatedAt: string;
}

/** Κατάσταση εξέτασης παραπεμπτικού */
export enum ExamStatus {
  ORDERED = 'ordered',
  IN_PROGRESS = 'in_progress',
  /** Απεσταλμένη σε κέντρο αναφοράς — δεν διαγράφεται και δεν ξαναστέλνεται */
  SENT = 'sent',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** Παράμετρος εξέτασης (π.χ. WBC, RBC, HGB για Γενική Αίματος) */
export interface ExamParameter {
  name: string;             // ονομασία παραμέτρου (π.χ. WBC, Αιμοσφαιρίνη)
  result?: string;          // τιμή
  unit?: string;            // μονάδα μέτρησης
  referenceRange?: string;  // φυσιολογικό εύρος
  loincNum?: string;        // κωδικός LOINC παραμέτρου (από Master Data)
}

/** Πρότυπο εξέτασης (κατάλογος προκαθορισμένων εξετάσεων) */
export interface ExamTemplate {
  id: string;               // μοναδικό αναγνωριστικό προτύπου (π.χ. 'cbc')
  name: string;             // ελληνική ονομασία
  nameEn: string;           // αγγλική ονομασία
  category: TestCategory;
  loincCode: string;        // LOINC code (π.χ. '58410-2')
  icd10Codes: string[];     // ICD-10-CM κωδικοί (π.χ. ['Z01.89'])
  hasParameters: boolean;   // αν έχει υπο-παραμέτρους
  defaultParameters?: ExamParameter[]; // προκαθορισμένες παράμετροι
  defaultUnit?: string;     // προκαθορισμένη μονάδα μέτρησης
  defaultRefRange?: string; // προκαθορισμένο εύρος αναφοράς
}

/** Μοντέλο εξέτασης (κάτω από παραπεμπτικό) */
export interface Exam {
  id: string;
  referralId: string;       // υποχρεωτική σύνδεση με παραπεμπτικό
  visitId: string;          // denormalized για ευκολία
  patientId: string;        // denormalized
  patientName?: string;
  name: string;             // ονομασία εξέτασης (π.χ. Γενική Αίματος, TKE)
  category?: string;        // κατηγορία (π.χ. Αιματολογικές, Βιοχημικές)
  status: ExamStatus;
  result?: string;          // αποτέλεσμα εξέτασης (τιμή) — για απλές εξετάσεις χωρίς παραμέτρους
  unit?: string;            // μονάδα μέτρησης
  referenceRange?: string;  // φυσιολογικό εύρος
  parameters?: ExamParameter[]; // πολλαπλές παράμετροι (π.χ. Γενική Αίματος)
  loincCode?: string;       // LOINC κωδικός εξέτασης (π.χ. '58410-2')
  examCode?: string;        // κωδικός εξέτασης στο Master Data (ΗΔΙΚΑ/exam_catalog)
  icd10Codes?: string[];    // ICD-10-CM κωδικοί (π.χ. ['Z01.89'])
  notes?: string;
  examDate?: string;        // ISO 8601 - ημερομηνία διεξαγωγής
  doctorId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Config για το Firebase */
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}
