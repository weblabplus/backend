import { LabResult, SeverityLevel, TestCategory, AnalysisResult } from '@medilab/core';
import { PatternResult } from '../models/types';

/**
 * Pattern Detector - Εντοπίζει μοτίβα σε συνδυασμούς εργαστηριακών αποτελεσμάτων.
 *
 * Αναγνωρίζει γνωστά ιατρικά patterns:
 * - Ηπατική βλάβη (AST/ALT αυξημένα)
 * - Νεφρική δυσλειτουργία
 * - Σιδηροπενική αναιμία (↓HGB, ↓MCV, ↓φερριτίνη)
 * - Μεταβολικό σύνδρομο
 * - Θυρεοειδική δυσλειτουργία
 * κ.α.
 */
export class PatternDetector {
  private patterns: PatternDefinition[] = [];

  constructor() {
    this.initializePatterns();
  }

  /**
   * Εντοπισμός patterns σε αποτελέσματα
   */
  detectPatterns(results: LabResult[]): PatternResult[] {
    const detected: PatternResult[] = [];
    const resultMap = this.buildResultMap(results);

    for (const pattern of this.patterns) {
      const confidence = this.evaluatePattern(pattern, resultMap, results);
      if (confidence > 0) {
        detected.push({
          type: pattern.type,
          description: pattern.description,
          confidence,
          affectedTests: pattern.requiredTests,
          possibleConditions: pattern.possibleConditions,
          recommendations: pattern.recommendations,
        });
      }
    }

    // Sort by confidence descending
    return detected.sort((a, b) => b.confidence - a.confidence);
  }

  private buildResultMap(results: LabResult[]): Map<string, LabResult> {
    const map = new Map<string, LabResult>();
    for (const r of results) {
      map.set(r.test.code.toUpperCase(), r);
    }
    return map;
  }

  private evaluatePattern(pattern: PatternDefinition, resultMap: Map<string, LabResult>, allResults: LabResult[]): number {
    let totalWeight = 0;
    let matchedWeight = 0;

    for (const testCode of pattern.requiredTests) {
      const result = resultMap.get(testCode.toUpperCase());
      totalWeight += 1;
      if (result && result.severity !== SeverityLevel.NORMAL) {
        matchedWeight += 1;
      }
    }

    // Check optional tests as bonus
    for (const optCode of pattern.optionalTests || []) {
      const result = resultMap.get(optCode.toUpperCase());
      if (result && result.severity !== SeverityLevel.NORMAL) {
        matchedWeight += 0.5;
        totalWeight += 0.5;
      }
    }

    if (totalWeight === 0) return 0;

    // Need at least 60% of required tests and 2+ abnormal for confidence
    const requiredRatio = matchedWeight / totalWeight;
    if (requiredRatio < 0.5) return 0;

    return Math.min(requiredRatio, 0.95);
  }

  private initializePatterns(): void {
    this.patterns = [
      {
        type: 'LIVER_DAMAGE',
        description: 'Ενδείξεις ηπατοκυτταρικής βλάβης με αυξημένα τρανσαμινασών και χολοστατικών ενζύμων.',
        requiredTests: ['SGOT_AST', 'SGPT_ALT'],
        optionalTests: ['GGT', 'ALP', 'TOTAL_BILIRUBIN'],
        possibleConditions: ['Λιπώδες ήπαρ', 'Ιογενής ηπατίτιδα', 'Αλκοολική ηπατοπάθεια', 'Φαρμακευτική ηπατοτοξικότητα'],
        recommendations: ['Υπέρηχος ήπατος', 'Έλεγχος για ηπατίτιδες', 'Διακοπή αλκοόλ'],
      },
      {
        type: 'IRON_DEFICIENCY_ANEMIA',
        description: 'Μοτίβο σιδηροπενικής αναιμίας με χαμηλή αιμοσφαιρίνη και μικροκυττάρωση.',
        requiredTests: ['HGB', 'MCV'],
        optionalTests: ['FERRITIN', 'IRON', 'TIBC', 'MCH'],
        possibleConditions: ['Σιδηροπενική αναιμία', 'Χρόνια νόσος', 'Θαλασσαιμία'],
        recommendations: ['Μέτρηση φερριτίνης', 'Έλεγχος σιδήρου', 'Διατροφική αξιολόγηση'],
      },
      {
        type: 'METABOLIC_SYNDROME',
        description: 'Μοτίβο μεταβολικού συνδρόμου με διαταραχές γλυκόζης και λιπιδίων.',
        requiredTests: ['GLUCOSE', 'TRIGLYCERIDES', 'HDL'],
        optionalTests: ['HBA1C', 'LDL'],
        possibleConditions: ['Μεταβολικό σύνδρομο', 'Σακχαρώδης διαβήτης τύπου 2', 'Παχυσαρκία'],
        recommendations: ['Μέτρηση HbA1c', 'Διατροφική παρέμβαση', 'Εκτίμηση καρδιαγγειακού κινδύνου', 'Αύξηση φυσικής δραστηριότητας'],
      },
      {
        type: 'RENAL_IMPAIRMENT',
        description: 'Ενδείξεις νεφρικής δυσλειτουργίας με αυξημένη κρεατινίνη και ηλεκτρολυτικές διαταραχές.',
        requiredTests: ['CREATININE'],
        optionalTests: ['UREA', 'POTASSIUM', 'SODIUM', 'PHOSPHORUS'],
        possibleConditions: ['Χρόνια νεφρική νόσος', 'Οξεία νεφρική βλάβη', 'Αφυδάτωση'],
        recommendations: ['Υπολογισμός eGFR', '24ωρη συλλογή ούρων', 'Παραπομπή σε νεφρολόγο'],
      },
      {
        type: 'THYROID_PATTERN',
        description: 'Ενδείξεις θυρεοειδικής δυσλειτουργίας.',
        requiredTests: ['TSH'],
        optionalTests: ['FT3', 'FT4'],
        possibleConditions: ['Υποθυρεοειδισμός', 'Υπερθυρεοειδισμός', 'Θυρεοειδίτιδα'],
        recommendations: ['FT3, FT4', 'Αντιθυρεοειδικά αντισώματα', 'Υπέρηχος θυρεοειδούς'],
      },
      {
        type: 'INFLAMMATORY_RESPONSE',
        description: 'Ενδείξεις συστηματικής φλεγμονώδους απάντησης.',
        requiredTests: ['CRP', 'ESR'],
        optionalTests: ['WBC', 'FIBRINOGEN', 'PLT'],
        possibleConditions: ['Λοίμωξη', 'Αυτοάνοσο νόσημα', 'Κακοήθεια'],
        recommendations: ['Διερεύνηση εστίας φλεγμονής/λοίμωξης', 'Αιματολογική εκτίμηση'],
      },
    ];
  }
}

interface PatternDefinition {
  type: string;
  description: string;
  requiredTests: string[];
  optionalTests?: string[];
  possibleConditions: string[];
  recommendations: string[];
}
