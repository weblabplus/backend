import {
  ReferenceRange,
  DemographicAdjustment,
  LabUnit,
  Gender,
  PatientStatus,
} from '@medilab/core';

// ============================================================
// Default Reference Ranges Database
// Πηγή: Κοινές τιμές αναφοράς ενηλίκων
// ============================================================

/** Default reference ranges για κοινές εξετάσεις (ενήλικες) */
export const DEFAULT_REFERENCE_RANGES: Record<string, ReferenceRange> = {
  // ========== ΑΙΜΑΤΟΛΟΓΙΑ ==========
  'WBC': {
    low: 4000, high: 11000, unit: 'cells/μL',
    criticalLow: 2000, criticalHigh: 30000,
  },
  'RBC_MALE': {
    low: 4.5, high: 5.9, unit: 'cells/μL',
    criticalLow: 3.0, criticalHigh: 7.0,
  },
  'RBC_FEMALE': {
    low: 4.0, high: 5.2, unit: 'cells/μL',
    criticalLow: 2.8, criticalHigh: 6.5,
  },
  'HGB_MALE': {
    low: 13.5, high: 17.5, unit: 'g/dL',
    criticalLow: 7.0, criticalHigh: 20.0,
  },
  'HGB_FEMALE': {
    low: 12.0, high: 15.5, unit: 'g/dL',
    criticalLow: 6.5, criticalHigh: 19.0,
  },
  'HCT_MALE': {
    low: 41, high: 50, unit: '%',
    criticalLow: 21, criticalHigh: 60,
  },
  'HCT_FEMALE': {
    low: 36, high: 44, unit: '%',
    criticalLow: 19, criticalHigh: 55,
  },
  'PLT': {
    low: 150000, high: 400000, unit: 'cells/μL',
    criticalLow: 30000, criticalHigh: 1000000,
  },
  'MCV': {
    low: 80, high: 100, unit: 'fL',
    criticalLow: 65, criticalHigh: 110,
  },
  'MCH': {
    low: 27, high: 33, unit: 'pg',
    criticalLow: 20, criticalHigh: 38,
  },

  // ========== ΒΙΟΧΗΜΕΙΑ ==========
  'GLUCOSE_FASTING': {
    low: 70, high: 100, unit: 'mg/dL',
    criticalLow: 40, criticalHigh: 400,
  },
  'GLUCOSE_RANDOM': {
    low: 70, high: 140, unit: 'mg/dL',
    criticalLow: 50, criticalHigh: 500,
  },
  'CREATININE_MALE': {
    low: 0.7, high: 1.3, unit: 'mg/dL',
    criticalLow: 0.3, criticalHigh: 5.0,
  },
  'CREATININE_FEMALE': {
    low: 0.5, high: 1.1, unit: 'mg/dL',
    criticalLow: 0.3, criticalHigh: 4.0,
  },
  'UREA': {
    low: 15, high: 45, unit: 'mg/dL',
    criticalHigh: 100,
  },
  'URIC_ACID_MALE': {
    low: 3.4, high: 7.0, unit: 'mg/dL',
    criticalHigh: 10.0,
  },
  'URIC_ACID_FEMALE': {
    low: 2.4, high: 6.0, unit: 'mg/dL',
    criticalHigh: 9.0,
  },
  'TOTAL_PROTEIN': {
    low: 6.0, high: 8.3, unit: 'g/dL',
    criticalLow: 4.5, criticalHigh: 9.5,
  },
  'ALBUMIN': {
    low: 3.5, high: 5.0, unit: 'g/dL',
    criticalLow: 2.0, criticalHigh: 6.0,
  },
  'TOTAL_BILIRUBIN': {
    low: 0.2, high: 1.2, unit: 'mg/dL',
    criticalHigh: 5.0,
  },
  'DIRECT_BILIRUBIN': {
    low: 0, high: 0.3, unit: 'mg/dL',
    criticalHigh: 1.0,
  },
  'SGOT_AST': {
    low: 10, high: 40, unit: 'U/L',
    criticalHigh: 200,
  },
  'SGPT_ALT': {
    low: 10, high: 40, unit: 'U/L',
    criticalHigh: 200,
  },
  'ALP': {
    low: 40, high: 130, unit: 'U/L',
    criticalHigh: 400,
  },
  'GGT': {
    low: 10, high: 50, unit: 'U/L',
    criticalHigh: 200,
  },
  'LDH': {
    low: 100, high: 250, unit: 'U/L',
    criticalHigh: 500,
  },
  'CK': {
    low: 30, high: 200, unit: 'U/L',
    criticalHigh: 1000,
  },
  'AMYLASE': {
    low: 25, high: 125, unit: 'U/L',
    criticalHigh: 400,
  },
  'LIPASE': {
    low: 10, high: 60, unit: 'U/L',
    criticalHigh: 200,
  },

  // ========== ΗΛΕΚΤΡΟΛΥΤΕΣ ==========
  'SODIUM': {
    low: 135, high: 145, unit: 'mEq/L',
    criticalLow: 120, criticalHigh: 160,
  },
  'POTASSIUM': {
    low: 3.5, high: 5.1, unit: 'mEq/L',
    criticalLow: 2.5, criticalHigh: 6.5,
  },
  'CHLORIDE': {
    low: 96, high: 106, unit: 'mEq/L',
    criticalLow: 85, criticalHigh: 115,
  },
  'CALCIUM': {
    low: 8.5, high: 10.5, unit: 'mg/dL',
    criticalLow: 6.5, criticalHigh: 13.0,
  },
  'MAGNESIUM': {
    low: 1.7, high: 2.3, unit: 'mg/dL',
    criticalLow: 1.0, criticalHigh: 5.0,
  },
  'PHOSPHORUS': {
    low: 2.5, high: 4.5, unit: 'mg/dL',
    criticalLow: 1.5, criticalHigh: 7.0,
  },

  // ========== ΛΙΠΙΔΙΑ ==========
  'TOTAL_CHOLESTEROL': {
    low: 0, high: 200, unit: 'mg/dL',
    criticalHigh: 300,
  },
  'HDL': {
    low: 40, high: 999, unit: 'mg/dL',
    criticalLow: 25,
  },
  'LDL': {
    low: 0, high: 130, unit: 'mg/dL',
    criticalHigh: 250,
  },
  'TRIGLYCERIDES': {
    low: 0, high: 150, unit: 'mg/dL',
    criticalHigh: 500,
  },

  // ========== ΘΥΡΕΟΕΙΔΗΣ ==========
  'TSH': {
    low: 0.4, high: 4.0, unit: 'μIU/mL',
    criticalLow: 0.01, criticalHigh: 50,
  },
  'FT4': {
    low: 0.8, high: 1.8, unit: 'ng/dL',
    criticalLow: 0.3, criticalHigh: 4.0,
  },
  'FT3': {
    low: 2.3, high: 4.2, unit: 'pg/mL',
    criticalLow: 0.5, criticalHigh: 10,
  },

  // ========== ΚΑΡΔΙΟΛΟΓΙΚΟΙ ΔΕΙΚΤΕΣ ==========
  'TROPONIN_I': {
    low: 0, high: 0.04, unit: 'ng/mL',
    criticalHigh: 0.5,
  },
  'CK_MB': {
    low: 0, high: 5.0, unit: 'ng/mL',
    criticalHigh: 20,
  },
  'BNP': {
    low: 0, high: 100, unit: 'pg/mL',
    criticalHigh: 500,
  },

  // ========== ΠΗΚΤΙΚΟΤΗΤΑ ==========
  'PT': {
    low: 11, high: 13.5, unit: 'sec',
    criticalHigh: 25,
  },
  'PTT': {
    low: 25, high: 35, unit: 'sec',
    criticalHigh: 60,
  },
  'INR': {
    low: 0.9, high: 1.2, unit: 'ratio',
    criticalHigh: 5.0,
  },
  'FIBRINOGEN': {
    low: 200, high: 400, unit: 'mg/dL',
    criticalLow: 100, criticalHigh: 700,
  },

  // ========== ΓΕΝΙΚΗ ΟΥΡΩΝ ==========
  'URINE_PH': {
    low: 5.0, high: 8.0, unit: '',
  },
  'URINE_SPECIFIC_GRAVITY': {
    low: 1.005, high: 1.030, unit: '',
  },

  // ========== ΦΛΕΓΜΟΝΩΔΕΙΣ ΔΕΙΚΤΕΣ ==========
  'CRP': {
    low: 0, high: 5, unit: 'mg/L',
    criticalHigh: 100,
  },
  'ESR_MALE': {
    low: 0, high: 15, unit: 'mm/h',
    criticalHigh: 50,
  },
  'ESR_FEMALE': {
    low: 0, high: 20, unit: 'mm/h',
    criticalHigh: 60,
  },
};

/** Δημογραφικές προσαρμογές */
export const DEMOGRAPHIC_ADJUSTMENTS: Record<string, DemographicAdjustment[]> = {
  'HGB': [
    {
      gender: Gender.MALE,
      ageRange: { min: 0, max: 14, unit: 'years' },
      low: 11, high: 14.5,
    },
    {
      gender: Gender.FEMALE,
      ageRange: { min: 0, max: 14, unit: 'years' },
      low: 10.5, high: 14,
    },
    {
      status: PatientStatus.PREGNANT,
      low: 11, high: 14,
    },
    {
      status: PatientStatus.GERIATRIC,
      low: 12, high: 16,
    },
  ],
  'CREATININE': [
    {
      status: PatientStatus.PEDIATRIC,
      low: 0.2, high: 0.7,
    },
    {
      status: PatientStatus.PREGNANT,
      low: 0.4, high: 0.9,
    },
  ],
  'GLUCOSE_FASTING': [
    {
      status: PatientStatus.PREGNANT,
      low: 65, high: 92,
    },
  ],
  'ALP': [
    {
      status: PatientStatus.PEDIATRIC,
      ageRange: { min: 0, max: 12, unit: 'years' },
      low: 100, high: 400,
    },
  ],
};
