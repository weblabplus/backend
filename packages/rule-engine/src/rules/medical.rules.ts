import {
  LabResult,
  SeverityLevel,
  TestCategory,
  Patient,
} from '@medilab/core';
import { Rule, RuleAction } from './types';

// ============================================================
// Medical Rule Definitions
// ============================================================

/**
 * Κανόνες για εργαστηριακά αποτελέσματα
 *
 * Priority:
 *   1 = Κρίσιμο (άμεση ιατρική παρέμβαση)
 *   2 = Σημαντικό (απαιτεί αξιολόγηση σύντομα)
 *   3 = Μέτριο (παρακολούθηση)
 *   4 = Ήπιο (σύσταση)
 *   5 = Ενημερωτικό
 */

export const MEDICAL_RULES: Rule[] = [

  // ======================= ΚΡΙΣΙΜΟΙ ΚΑΝΟΝΕΣ (Priority 1) =======================

  {
    id: 'CRITICAL_HYPERKALEMIA',
    name: 'Κρίσιμη Υπερκαλιαιμία',
    description: 'Κάλιο > 6.5 mEq/L - Κίνδυνος καρδιακής ανακοπής',
    priority: 1,
    category: 'critical',
    testCodes: ['POTASSIUM', 'K'],
    condition: (results) => {
      const k = results.find(r =>
        r.test.code === 'POTASSIUM' || r.test.code === 'K'
      );
      return k ? k.value >= 6.5 : false;
    },
    action: {
      interpretation: 'Κρίσιμη υπερκαλιαιμία. Άμεσος κίνδυνος καρδιακών αρρυθμιών και καρδιακής ανακοπής.',
      recommendations: [
        'ΑΜΕΣΗ ειδοποίηση ιατρού',
        'ΗΚΓ έλεγχος για σημεία υπερκαλιαιμίας',
        'Επανάληψη μέτρησης για επιβεβαίωση',
        'Έναρξη επείγουσας θεραπείας (γλυκονικό ασβέστιο, ινσουλίνη+γλυκόζη)',
      ],
      relatedTests: ['CREATININE', 'UREA', 'SODIUM'],
      differentialDiagnosis: ['Νεφρική ανεπάρκεια', 'Ραβδομυόλυση', 'Αιμόλυση δείγματος'],
    },
  },

  {
    id: 'CRITICAL_HYPOKALEMIA',
    name: 'Κρίσιμη Υποκαλιαιμία',
    description: 'Κάλιο < 2.5 mEq/L',
    priority: 1,
    category: 'critical',
    testCodes: ['POTASSIUM', 'K'],
    condition: (results) => {
      const k = results.find(r =>
        r.test.code === 'POTASSIUM' || r.test.code === 'K'
      );
      return k ? k.value <= 2.5 : false;
    },
    action: {
      interpretation: 'Κρίσιμη υποκαλιαιμία. Κίνδυνος μυϊκής αδυναμίας και καρδιακών αρρυθμιών.',
      recommendations: [
        'ΑΜΕΣΗ ειδοποίηση ιατρού',
        'ΗΚΓ παρακολούθηση',
        'Έναρξη χορήγησης καλίου IV ή PO',
        'Διερεύνηση αιτίας (διουρητικά, διάρροια, έμετοι)',
      ],
      relatedTests: ['MAGNESIUM', 'CREATININE'],
    },
  },

  {
    id: 'CRITICAL_HYPONATREMIA',
    name: 'Κρίσιμη Υπονατριαιμία',
    description: 'Νάτριο < 120 mEq/L',
    priority: 1,
    category: 'critical',
    testCodes: ['SODIUM', 'NA'],
    condition: (results) => {
      const na = results.find(r =>
        r.test.code === 'SODIUM' || r.test.code === 'NA'
      );
      return na ? na.value <= 120 : false;
    },
    action: {
      interpretation: 'Σοβαρή υπονατριαιμία. Κίνδυνος εγκεφαλικού οιδήματος και νευρολογικών επιπλοκών.',
      recommendations: [
        'ΑΜΕΣΗ ειδοποίηση ιατρού',
        'Νευρολογική εκτίμηση',
        'Σταδιακή διόρθωση νατρίου (όχι >8-10 mEq/24h)',
        'Έλεγχος ωσμωτικότητας πλάσματος και ούρων',
      ],
      relatedTests: ['OSMOLALITY', 'URINE_SODIUM'],
      differentialDiagnosis: ['SIADH', 'Υποθυρεοειδισμός', 'Επινεφριδιακή ανεπάρκεια'],
    },
  },

  {
    id: 'CRITICAL_HYPERNATREMIA',
    name: 'Κρίσιμη Υπερνατριαιμία',
    description: 'Νάτριο > 160 mEq/L',
    priority: 1,
    category: 'critical',
    testCodes: ['SODIUM', 'NA'],
    condition: (results) => {
      const na = results.find(r =>
        r.test.code === 'SODIUM' || r.test.code === 'NA'
      );
      return na ? na.value >= 160 : false;
    },
    action: {
      interpretation: 'Σοβαρή υπερνατριαιμία. Κίνδυνος ενδοεγκεφαλικής αιμορραγίας.',
      recommendations: [
        'ΑΜΕΣΗ ειδοποίηση ιατρού',
        'Αργή διόρθωση με υποτονικά υγρά',
        'Διερεύνηση αιτίας απώλειας ύδατος',
      ],
    },
  },

  // ======================= ΣΗΜΑΝΤΙΚΟΙ ΚΑΝΟΝΕΣ (Priority 2) =======================

  {
    id: 'ACUTE_KIDNEY_INJURY',
    name: 'Οξεία Νεφρική Βλάβη',
    description: 'Κρεατινίνη > 2.0 mg/dL με ταυτόχρονη αύξηση ουρίας',
    priority: 2,
    category: 'critical',
    testCodes: ['CREATININE', 'UREA'],
    condition: (results) => {
      const cr = results.find(r => r.test.code?.startsWith('CREATININE'));
      const ur = results.find(r => r.test.code === 'UREA');
      if (cr && ur) {
        return cr.value >= 2.0 && ur.value >= 60;
      }
      if (cr) return cr.value >= 3.0;
      return false;
    },
    action: {
      interpretation: 'Ενδείξεις οξείας νεφρικής βλάβης. Απαιτείται άμεση εκτίμηση.',
      recommendations: [
        'Εκτίμηση ισοζυγίου υγρών',
        'Έλεγχος φαρμακευτικής αγωγής για νεφροτοξικά',
        'Υπέρηχος νεφρών',
        'Επανάληψη κρεατινίνης σε 24-48 ώρες',
      ],
      relatedTests: ['POTASSIUM', 'SODIUM', 'CALCIUM', 'PHOSPHORUS', 'ALBUMIN'],
      differentialDiagnosis: ['Προνεφρική αζωθαιμία', 'Οξεία σωληναριακή νέκρωση', 'Απόφραξη'],
    },
  },

  {
    id: 'ELEVATED_TROPONIN',
    name: 'Αυξημένη Τροπονίνη',
    description: 'Τροπονίνη > 0.04 ng/mL - Πιθανή μυοκαρδιακή βλάβη',
    priority: 2,
    category: 'critical',
    testCodes: ['TROPONIN_I', 'cTnI'],
    condition: (results) => {
      const trop = results.find(r =>
        r.test.code === 'TROPONIN_I' || r.test.code === 'cTnI'
      );
      return trop ? trop.value > 0.04 : false;
    },
    action: {
      interpretation: 'Αυξημένα επίπεδα τροπονίνης υποδεικνύουν μυοκαρδιακή βλάβη.',
      recommendations: [
        'Άμεση καρδιολογική εκτίμηση',
        'ΗΚΓ εντός 10 λεπτών',
        'Σειριακές μετρήσεις τροπονίνης (0, 3, 6 ώρες)',
        'Εκτίμηση για στεφανιαία νόσο',
      ],
      relatedTests: ['CK_MB', 'BNP', 'CK', 'MYOGLOBIN'],
      differentialDiagnosis: ['Οξύ έμφραγμα μυοκαρδίου', 'Μυοκαρδίτιδα', 'Πνευμονική εμβολή'],
    },
  },

  // ======================= ΜΕΤΡΙΟΙ ΚΑΝΟΝΕΣ (Priority 3) =======================

  {
    id: 'IMPAIRED_FASTING_GLUCOSE',
    name: 'Διαταραγμένη Γλυκόζη Νηστείας',
    description: 'Γλυκόζη νηστείας 100-125 mg/dL',
    priority: 3,
    category: 'warning',
    testCodes: ['GLUCOSE_FASTING', 'GLUCOSE'],
    condition: (results) => {
      const glu = results.find(r =>
        r.test.code === 'GLUCOSE_FASTING' || r.test.code === 'GLUCOSE'
      );
      return glu ? glu.value >= 100 && glu.value <= 125 : false;
    },
    action: {
      interpretation: 'Προδιαβήτης. Αυξημένος κίνδυνος ανάπτυξης σακχαρώδη διαβήτη τύπου 2.',
      recommendations: [
        'Δοκιμασία ανοχής γλυκόζης (OGTT)',
        'Μέτρηση HbA1c',
        'Διατροφική παρέμβαση και αύξηση φυσικής δραστηριότητας',
        'Επανέλεγχος σε 3-6 μήνες',
      ],
      relatedTests: ['HBA1C', 'TRIGLYCERIDES', 'HDL'],
    },
  },

  {
    id: 'DIABETES_FASTING',
    name: 'Σακχαρώδης Διαβήτης',
    description: 'Γλυκόζη νηστείας >= 126 mg/dL',
    priority: 3,
    category: 'warning',
    testCodes: ['GLUCOSE_FASTING', 'GLUCOSE'],
    condition: (results) => {
      const glu = results.find(r =>
        r.test.code === 'GLUCOSE_FASTING' || r.test.code === 'GLUCOSE'
      );
      return glu ? glu.value >= 126 : false;
    },
    action: {
      interpretation: 'Τιμή ενδεικτική σακχαρώδη διαβήτη. Απαιτείται επιβεβαίωση με δεύτερη μέτρηση.',
      recommendations: [
        'Επιβεβαίωση με δεύτερη μέτρηση γλυκόζης νηστείας',
        'Μέτρηση HbA1c',
        'Παραπομπή σε ενδοκρινολόγο/διαβητολόγο',
        'Έναρξη διατροφικής παρέμβασης',
      ],
      relatedTests: ['HBA1C', 'TRIGLYCERIDES', 'HDL', 'CREATININE'],
    },
  },

  {
    id: 'DYSLIPIDEMIA',
    name: 'Δυσλιπιδαιμία',
    description: 'LDL > 130 ή/και Τριγλυκερίδια > 150',
    priority: 3,
    category: 'warning',
    testCodes: ['LDL', 'TRIGLYCERIDES', 'TOTAL_CHOLESTEROL'],
    condition: (results) => {
      const ldl = results.find(r => r.test.code === 'LDL');
      const trig = results.find(r => r.test.code === 'TRIGLYCERIDES');
      return (ldl ? ldl.value > 130 : false) || (trig ? trig.value > 150 : false);
    },
    action: {
      interpretation: 'Παθολογικό λιπιδαιμικό προφίλ. Αυξημένος καρδιαγγειακός κίνδυνος.',
      recommendations: [
        'Πλήρες λιπιδαιμικό προφίλ',
        'Εκτίμηση καρδιαγγειακού κινδύνου',
        'Διατροφική παρέμβαση (Μεσογειακή διατροφή)',
        'Επανέλεγχος σε 3 μήνες',
      ],
      relatedTests: ['HDL', 'TOTAL_CHOLESTEROL', 'HBA1C', 'CRP'],
    },
  },

  {
    id: 'ELEVATED_LIVER_ENZYMES',
    name: 'Αυξημένα Ηπατικά Ένζυμα',
    description: 'SGOT/SGPT > 2x ανώτερο φυσιολογικό',
    priority: 3,
    category: 'warning',
    testCodes: ['SGOT_AST', 'SGPT_ALT'],
    condition: (results) => {
      const ast = results.find(r => r.test.code === 'SGOT_AST');
      const alt = results.find(r => r.test.code === 'SGPT_ALT');
      return (ast ? ast.value > 80 : false) || (alt ? alt.value > 80 : false);
    },
    action: {
      interpretation: 'Αυξημένα ηπατικά ένζυμα. Ενδείξεις ηπατοκυτταρικής βλάβης.',
      recommendations: [
        'Πλήρες ηπατικό προφίλ',
        'Υπέρηχος ήπατος',
        'Έλεγχος για ιογενείς ηπατίτιδες',
        'Διερεύνηση φαρμακευτικής ηπατοτοξικότητας',
      ],
      relatedTests: ['GGT', 'ALP', 'TOTAL_BILIRUBIN', 'ALBUMIN', 'PT'],
      differentialDiagnosis: ['Λιπώδες ήπαρ', 'Ιογενής ηπατίτιδα', 'Αλκοολική ηπατοπάθεια'],
    },
  },

  {
    id: 'THYROID_DYSFUNCTION',
    name: 'Δυσλειτουργία Θυρεοειδούς',
    description: 'TSH εκτός φυσιολογικών ορίων',
    priority: 3,
    category: 'warning',
    testCodes: ['TSH'],
    condition: (results) => {
      const tsh = results.find(r => r.test.code === 'TSH');
      return tsh ? tsh.value < 0.4 || tsh.value > 4.0 : false;
    },
    action: {
      interpretation: 'Διαταραχή θυρεοειδικής λειτουργίας.',
      recommendations: [
        'Μέτρηση FT3, FT4',
        'Έλεγχος αντιθυρεοειδικών αντισωμάτων',
        'Υπέρηχος θυρεοειδούς',
        'Παραπομπή σε ενδοκρινολόγο',
      ],
      relatedTests: ['FT3', 'FT4', 'ANTI_TPO', 'ANTI_TG'],
      differentialDiagnosis: ['Υποθυρεοειδισμός', 'Υπερθυρεοειδισμός', 'Θυρεοειδίτιδα Hashimoto'],
    },
  },

  // ======================= ΗΠΙΟΙ ΚΑΝΟΝΕΣ (Priority 4) =======================

  {
    id: 'MILD_ANEMIA',
    name: 'Ήπια Αναιμία',
    description: 'HGB ελαφρώς κάτω φυσιολογικού',
    priority: 4,
    category: 'warning',
    testCodes: ['HGB_MALE', 'HGB_FEMALE', 'HGB'],
    condition: (results) => {
      const hgb = results.find(r =>
        r.test.code?.startsWith('HGB')
      );
      if (!hgb) return false;
      // Mild anemia: 1-2 g/dL below normal
      const normalLow = hgb.test.code.includes('FEMALE') ? 12.0 : 13.5;
      return hgb.value < normalLow && hgb.value >= normalLow - 2;
    },
    action: {
      interpretation: 'Ήπια αναιμία. Συνιστάται διερεύνηση.',
      recommendations: [
        'Μέτρηση φερριτίνης, σιδήρου, B12, φυλλικού',
        'Έλεγχος MCV για ταξινόμηση αναιμίας',
        'Διατροφική αξιολόγηση',
        'Επανέλεγχος σε 1-2 μήνες',
      ],
      relatedTests: ['FERRITIN', 'IRON', 'B12', 'FOLATE', 'MCV', 'RETICULOCYTES'],
    },
  },

  {
    id: 'BORDERLINE_RENAL',
    name: 'Οριακή Νεφρική Λειτουργία',
    description: 'Κρεατινίνη στο ανώτερο φυσιολογικό όριο',
    priority: 4,
    category: 'info',
    testCodes: ['CREATININE'],
    condition: (results) => {
      const cr = results.find(r => r.test.code?.startsWith('CREATININE'));
      if (!cr) return false;
      const upperLimit = cr.test.code.includes('FEMALE') ? 1.1 : 1.3;
      return cr.value >= upperLimit && cr.value < upperLimit + 0.3;
    },
    action: {
      interpretation: 'Οριακά αυξημένη κρεατινίνη. Συνιστάται παρακολούθηση.',
      recommendations: [
        'Υπολογισμός eGFR',
        'Ενυδάτωση και επανέλεγχος',
        'Αποφυγή νεφροτοξικών φαρμάκων',
      ],
      relatedTests: ['UREA', 'URIC_ACID'],
    },
  },
];

/** Εύρεση κανόνων που σχετίζονται με συγκεκριμένα test codes */
export function findRulesForTests(testCodes: string[]): Rule[] {
  const upperCodes = testCodes.map(c => c.toUpperCase());
  return MEDICAL_RULES.filter(rule =>
    rule.testCodes?.some(tc => upperCodes.includes(tc.toUpperCase()))
  );
}

/** Εύρεση κανόνων ανά κατηγορία */
export function findRulesByCategory(category: TestCategory): Rule[] {
  // Mapping test codes to categories can be added here
  return MEDICAL_RULES;
}

/** Λήψη όλων των κανόνων */
export function getAllRules(): Rule[] {
  return [...MEDICAL_RULES];
}

/** Λήψη κρίσιμων κανόνων */
export function getCriticalRules(): Rule[] {
  return MEDICAL_RULES.filter(r => r.priority <= 2);
}
