import { ExamTemplate, TestCategory } from '../types';

// ============================================================
// Κατάλογος Προκαθορισμένων Εξετάσεων (LOINC + ICD-10-CM)
// ============================================================

/**
 * 10 βασικές εργαστηριακές εξετάσεις με:
 * - LOINC κωδικό (Logical Observation Identifiers Names and Codes)
 * - ICD-10-CM κωδικούς για διαγνωστική κάλυψη
 * - Προκαθορισμένες παραμέτρους με μονάδες & εύρη αναφοράς
 *
 * Πηγές: LOINC.org, ICD10data.com, εργαστηριακά πρότυπα
 */
export const EXAM_CATALOG: ExamTemplate[] = [
  // ── 1. Γενική Αίματος (CBC) ──
  {
    id: 'cbc',
    name: 'Γενική Αίματος (CBC)',
    nameEn: 'Complete Blood Count (CBC)',
    category: TestCategory.HEMATOLOGY,
    loincCode: '58410-2',
    icd10Codes: ['Z01.89', 'D72.829'],
    hasParameters: true,
    defaultParameters: [
      { name: 'WBC (Λευκά Αιμοσφαίρια)', unit: 'x10³/µL', referenceRange: '4.5 - 11.0' },
      { name: 'RBC (Ερυθρά Αιμοσφαίρια)', unit: 'x10⁶/µL', referenceRange: '4.5 - 5.9 (♂), 4.1 - 5.1 (♀)' },
      { name: 'HGB (Αιμοσφαιρίνη)', unit: 'g/dL', referenceRange: '13.5 - 17.5 (♂), 12.0 - 15.5 (♀)' },
      { name: 'HCT (Αιματοκρίτης)', unit: '%', referenceRange: '41 - 50 (♂), 36 - 44 (♀)' },
      { name: 'MCV (Μέσος Όγκος Ερυθρών)', unit: 'fL', referenceRange: '80 - 100' },
      { name: 'MCH (Μέση Περιεκτικότητα Hb)', unit: 'pg', referenceRange: '27 - 33' },
      { name: 'MCHC (Μέση Πυκνότητα Hb)', unit: 'g/dL', referenceRange: '32 - 36' },
      { name: 'PLT (Αιμοπετάλια)', unit: 'x10³/µL', referenceRange: '150 - 400' },
      { name: 'RDW (Εύρος Κατανομής Ερυθρών)', unit: '%', referenceRange: '11.5 - 14.5' },
      { name: 'NEUT% (Ουδετερόφιλα %)', unit: '%', referenceRange: '40 - 75' },
      { name: 'LYMPH% (Λεμφοκύτταρα %)', unit: '%', referenceRange: '20 - 45' },
    ],
  },

  // ── 2. Βασικός Μεταβολικός Έλεγχος (BMP) ──
  {
    id: 'bmp',
    name: 'Βασικός Μεταβολικός Έλεγχος (BMP)',
    nameEn: 'Basic Metabolic Panel (BMP)',
    category: TestCategory.BIOCHEMISTRY,
    loincCode: '24321-2',
    icd10Codes: ['Z01.89', 'E87.8'],
    hasParameters: true,
    defaultParameters: [
      { name: 'Γλυκόζη (GLU)', unit: 'mg/dL', referenceRange: '70 - 100 (νηστεία)' },
      { name: 'Νάτριο (Na⁺)', unit: 'mmol/L', referenceRange: '136 - 145' },
      { name: 'Κάλιο (K⁺)', unit: 'mmol/L', referenceRange: '3.5 - 5.1' },
      { name: 'Χλώριο (Cl⁻)', unit: 'mmol/L', referenceRange: '98 - 107' },
      { name: 'CO₂ (Διοξείδιο Άνθρακα)', unit: 'mmol/L', referenceRange: '23 - 29' },
      { name: 'Ασβέστιο (Ca²⁺)', unit: 'mg/dL', referenceRange: '8.5 - 10.5' },
      { name: 'BUN (Άζωτο Ουρίας)', unit: 'mg/dL', referenceRange: '7 - 20' },
      { name: 'Κρεατινίνη (Cr)', unit: 'mg/dL', referenceRange: '0.6 - 1.2 (♂), 0.5 - 1.1 (♀)' },
    ],
  },

  // ── 3. Πλήρης Μεταβολικός Έλεγχος (CMP) ──
  {
    id: 'cmp',
    name: 'Πλήρης Μεταβολικός Έλεγχος (CMP)',
    nameEn: 'Comprehensive Metabolic Panel (CMP)',
    category: TestCategory.BIOCHEMISTRY,
    loincCode: '24323-8',
    icd10Codes: ['Z01.89', 'E87.8'],
    hasParameters: true,
    defaultParameters: [
      { name: 'Γλυκόζη (GLU)', unit: 'mg/dL', referenceRange: '70 - 100 (νηστεία)' },
      { name: 'Νάτριο (Na⁺)', unit: 'mmol/L', referenceRange: '136 - 145' },
      { name: 'Κάλιο (K⁺)', unit: 'mmol/L', referenceRange: '3.5 - 5.1' },
      { name: 'Χλώριο (Cl⁻)', unit: 'mmol/L', referenceRange: '98 - 107' },
      { name: 'CO₂ (Διοξείδιο Άνθρακα)', unit: 'mmol/L', referenceRange: '23 - 29' },
      { name: 'Ασβέστιο (Ca²⁺)', unit: 'mg/dL', referenceRange: '8.5 - 10.5' },
      { name: 'BUN (Άζωτο Ουρίας)', unit: 'mg/dL', referenceRange: '7 - 20' },
      { name: 'Κρεατινίνη (Cr)', unit: 'mg/dL', referenceRange: '0.6 - 1.2 (♂), 0.5 - 1.1 (♀)' },
      { name: 'ALT (SGPT)', unit: 'U/L', referenceRange: '7 - 56' },
      { name: 'AST (SGOT)', unit: 'U/L', referenceRange: '10 - 40' },
      { name: 'ALP (Αλκαλική Φωσφατάση)', unit: 'U/L', referenceRange: '44 - 147' },
      { name: 'Ολική Χολερυθρίνη (TBil)', unit: 'mg/dL', referenceRange: '0.1 - 1.2' },
      { name: 'Λευκωματίνη (ALB)', unit: 'g/dL', referenceRange: '3.5 - 5.0' },
      { name: 'Ολικές Πρωτεΐνες (TP)', unit: 'g/dL', referenceRange: '6.0 - 8.3' },
    ],
  },

  // ── 4. Λιπιδαιμικό Προφίλ ──
  {
    id: 'lipid',
    name: 'Λιπιδαιμικό Προφίλ',
    nameEn: 'Lipid Panel',
    category: TestCategory.LIPID_PROFILE,
    loincCode: '24331-1',
    icd10Codes: ['Z13.220', 'E78.5'],
    hasParameters: true,
    defaultParameters: [
      { name: 'Ολική Χοληστερόλη (TC)', unit: 'mg/dL', referenceRange: '< 200 (επιθυμητή)' },
      { name: 'HDL Χοληστερόλη', unit: 'mg/dL', referenceRange: '> 40 (♂), > 50 (♀)' },
      { name: 'LDL Χοληστερόλη', unit: 'mg/dL', referenceRange: '< 100 (βέλτιστη)' },
      { name: 'Τριγλυκερίδια (TG)', unit: 'mg/dL', referenceRange: '< 150 (φυσιολογικά)' },
    ],
  },

  // ── 5. Έλεγχος Ηπατικής Λειτουργίας ──
  {
    id: 'liver',
    name: 'Έλεγχος Ηπατικής Λειτουργίας',
    nameEn: 'Liver Function Panel',
    category: TestCategory.BIOCHEMISTRY,
    loincCode: '24324-6',
    icd10Codes: ['R94.5', 'K76.9'],
    hasParameters: true,
    defaultParameters: [
      { name: 'ALT (SGPT)', unit: 'U/L', referenceRange: '7 - 56' },
      { name: 'AST (SGOT)', unit: 'U/L', referenceRange: '10 - 40' },
      { name: 'ALP (Αλκαλική Φωσφατάση)', unit: 'U/L', referenceRange: '44 - 147' },
      { name: 'GGT (γ-Γλουταμυλτρανσφεράση)', unit: 'U/L', referenceRange: '9 - 48' },
      { name: 'Ολική Χολερυθρίνη (TBil)', unit: 'mg/dL', referenceRange: '0.1 - 1.2' },
      { name: 'Άμεση Χολερυθρίνη (DBil)', unit: 'mg/dL', referenceRange: '< 0.3' },
      { name: 'Λευκωματίνη (ALB)', unit: 'g/dL', referenceRange: '3.5 - 5.0' },
      { name: 'Ολικές Πρωτεΐνες (TP)', unit: 'g/dL', referenceRange: '6.0 - 8.3' },
    ],
  },

  // ── 6. TSH (Θυρεοειδοτρόπος Ορμόνη) ──
  {
    id: 'tsh',
    name: 'TSH (Θυρεοειδοτρόπος Ορμόνη)',
    nameEn: 'TSH (Thyroid Stimulating Hormone)',
    category: TestCategory.THYROID,
    loincCode: '3016-3',
    icd10Codes: ['Z13.29', 'E03.9'],
    hasParameters: false,
    defaultUnit: 'mIU/L',
    defaultRefRange: '0.4 - 4.0',
  },

  // ── 7. Γενική Ούρων (Urinalysis) ──
  {
    id: 'urinalysis',
    name: 'Γενική Ούρων',
    nameEn: 'Urinalysis (Dipstick)',
    category: TestCategory.URINALYSIS,
    loincCode: '24356-8',
    icd10Codes: ['Z01.89', 'R82.90'],
    hasParameters: true,
    defaultParameters: [
      { name: 'Ειδικό Βάρος (SG)', unit: '', referenceRange: '1.005 - 1.030' },
      { name: 'pH', unit: '', referenceRange: '5.0 - 8.0' },
      { name: 'Πρωτεΐνη (PRO)', unit: 'mg/dL', referenceRange: 'Αρνητική (< 10)' },
      { name: 'Γλυκόζη (GLU)', unit: 'mg/dL', referenceRange: 'Αρνητική' },
      { name: 'Κετόνες (KET)', unit: 'mg/dL', referenceRange: 'Αρνητικές' },
      { name: 'Χολερυθρίνη (BIL)', unit: '', referenceRange: 'Αρνητική' },
      { name: 'Ουροχολινογόνο (URO)', unit: 'mg/dL', referenceRange: '0.1 - 1.0' },
      { name: 'Νιτρώδη (NIT)', unit: '', referenceRange: 'Αρνητικά' },
      { name: 'Λευκοκυτταρική Εστεράση (LEU)', unit: '', referenceRange: 'Αρνητική' },
      { name: 'Αίμα (BLD)', unit: '', referenceRange: 'Αρνητικό' },
    ],
  },

  // ── 8. CRP (C-Αντιδρώσα Πρωτεΐνη) ──
  {
    id: 'crp',
    name: 'CRP (C-Αντιδρώσα Πρωτεΐνη)',
    nameEn: 'CRP (C-Reactive Protein)',
    category: TestCategory.IMMUNOLOGY,
    loincCode: '1988-5',
    icd10Codes: ['R70.0', 'Z01.89'],
    hasParameters: false,
    defaultUnit: 'mg/L',
    defaultRefRange: '< 5.0',
  },

  // ── 9. HbA1c (Γλυκοζυλιωμένη Αιμοσφαιρίνη) ──
  {
    id: 'hba1c',
    name: 'HbA1c (Γλυκοζυλιωμένη Αιμοσφαιρίνη)',
    nameEn: 'HbA1c (Glycated Hemoglobin)',
    category: TestCategory.BIOCHEMISTRY,
    loincCode: '4548-4',
    icd10Codes: ['Z13.1', 'E11.9'],
    hasParameters: false,
    defaultUnit: '%',
    defaultRefRange: '< 5.7 (φυσιολογικό), 5.7 - 6.4 (προδιαβήτης), ≥ 6.5 (διαβήτης)',
  },

  // ── 10. Έλεγχος Σιδήρου (Iron Panel) ──
  {
    id: 'iron',
    name: 'Έλεγχος Σιδήρου (Iron Panel)',
    nameEn: 'Iron Panel',
    category: TestCategory.BIOCHEMISTRY,
    loincCode: '50190-3',
    icd10Codes: ['D50.9', 'R71.8'],
    hasParameters: true,
    defaultParameters: [
      { name: 'Σίδηρος Ορού (Fe)', unit: 'µg/dL', referenceRange: '65 - 175 (♂), 50 - 170 (♀)' },
      { name: 'Φερριτίνη (Ferritin)', unit: 'ng/mL', referenceRange: '30 - 400 (♂), 13 - 150 (♀)' },
      { name: 'TIBC (Ολική Σιδηροδεσμευτική Ικανότητα)', unit: 'µg/dL', referenceRange: '250 - 450' },
      { name: 'Κορεσμός Τρανσφερρίνης (TSAT)', unit: '%', referenceRange: '15 - 50' },
    ],
  },
];

/** Εύρεση προτύπου εξέτασης βάσει ID */
export function getExamTemplate(id: string): ExamTemplate | undefined {
  return EXAM_CATALOG.find(t => t.id === id);
}

/** Εύρεση προτύπου εξέτασης βάσει ονόματος (ασφαλής αναζήτηση) */
export function findExamTemplateByName(name: string): ExamTemplate | undefined {
  const normalized = name.trim().toLowerCase();
  return EXAM_CATALOG.find(
    t => t.name.toLowerCase() === normalized || t.nameEn.toLowerCase() === normalized,
  );
}

/** Ελληνικές ετικέτες κατηγοριών (για UI dropdowns) */
export const EXAM_CATEGORY_LABELS_EL: Record<TestCategory, string> = {
  [TestCategory.HEMATOLOGY]: 'Αιματολογικές',
  [TestCategory.BIOCHEMISTRY]: 'Βιοχημικές',
  [TestCategory.HORMONES]: 'Ορμονολογικές',
  [TestCategory.TUMOR_MARKERS]: 'Καρκινικοί Δείκτες',
  [TestCategory.IMMUNOLOGY]: 'Ανοσολογικές',
  [TestCategory.MICROBIOLOGY]: 'Μικροβιολογικές',
  [TestCategory.URINALYSIS]: 'Ουρολογικές',
  [TestCategory.COAGULATION]: 'Πηκτικότητα',
  [TestCategory.CARDIAC]: 'Καρδιολογικοί Δείκτες',
  [TestCategory.THYROID]: 'Θυρεοειδικές',
  [TestCategory.LIPID_PROFILE]: 'Λιπιδαιμικές',
  [TestCategory.OTHER]: 'Άλλες',
};
