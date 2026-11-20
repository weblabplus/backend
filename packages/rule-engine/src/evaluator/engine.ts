import {
  LabResult,
  AnalysisResult,
  Patient,
  SeverityLevel,
  DiagnosticReport,
  LabResultSummary,
  TestCategory,
} from '@medilab/core';
import { referenceRangeManager, calculateEGFR, getEGFRStage, calculateBMI } from '@medilab/reference-ranges';
import { calculateAge } from '@medilab/core';
import { Rule, RuleEvaluationResult } from '../rules/types';
import { MEDICAL_RULES, findRulesForTests } from '../rules/medical.rules';

/**
 * Rule Engine - Αξιολογεί εργαστηριακά αποτελέσματα βάσει ιατρικών κανόνων
 *
 * Χρησιμοποιεί:
 *  - Reference ranges για βασική αξιολόγηση (φυσιολογικό/παθολογικό)
 *  - Medical rules για σύνθετη ανάλυση (συνδυασμοί, κρίσιμες καταστάσεις)
 */
export class RuleEngine {
  private customRules: Rule[] = [];

  /**
   * Προσθήκη custom κανόνα
   */
  addRule(rule: Rule): void {
    this.customRules.push(rule);
  }

  /**
   * Αφαίρεση custom κανόνα
   */
  removeRule(ruleId: string): void {
    this.customRules = this.customRules.filter(r => r.id !== ruleId);
  }

  /**
   * Ανάλυση ενός LabResult για έναν ασθενή
   */
  analyzeResult(result: LabResult, patient: Patient): AnalysisResult {
    const range = referenceRangeManager.getRangeForPatient(result.test.code, patient)
      || result.referenceRange;

    let severity = result.severity;
    if (range && !result.severity) {
      severity = this.evaluateSeverity(result.value, range);
    }

    // Generate interpretation
    const interpretation = this.generateInterpretation(result, severity, range, patient);

    // Generate recommendations
    const recommendations = this.generateRecommendations(result, severity);

    return {
      labResult: result,
      severity,
      interpretation,
      recommendations,
      relatedTests: this.suggestRelatedTests(result),
    };
  }

  /**
   * Ανάλυση πολλαπλών αποτελεσμάτων με χρήση ιατρικών κανόνων
   */
  analyzeMultiple(results: LabResult[], patient: Patient): AnalysisResult[] {
    const analyses: AnalysisResult[] = [];

    // Step 1: Individual analysis for each result
    for (const result of results) {
      analyses.push(this.analyzeResult(result, patient));
    }

    // Step 2: Rule-based combined analysis
    const allRules = [...MEDICAL_RULES, ...this.customRules];
    const relevantRules = this.filterRelevantRules(allRules, results);

    for (const rule of relevantRules.sort((a, b) => a.priority - b.priority)) {
      try {
        if (rule.condition(results, patient)) {
          const affectedResults = analyses.filter(a =>
            rule.testCodes?.some(tc =>
              tc.toUpperCase() === a.labResult.test.code.toUpperCase()
            )
          );

          for (const a of affectedResults) {
            if (rule.action.interpretation) {
              a.interpretation = rule.action.interpretation;
            }
            if (rule.action.recommendations) {
              a.recommendations = [...new Set([...a.recommendations, ...rule.action.recommendations])];
            }
            if (rule.action.relatedTests) {
              a.relatedTests = [...new Set([...a.relatedTests || [], ...rule.action.relatedTests])];
            }
            if (rule.action.differentialDiagnosis) {
              a.differentialDiagnosis = rule.action.differentialDiagnosis;
            }
            // Update severity if rule is critical
            if (rule.priority <= 2 && a.severity !== SeverityLevel.CRITICAL_HIGH) {
              a.severity = SeverityLevel.CRITICAL_HIGH;
            }
          }
        }
      } catch (err) {
        console.error(`Error evaluating rule ${rule.id}:`, err);
      }
    }

    return analyses;
  }

  /**
   * Δημιουργία διαγνωστικής αναφοράς
   */
  generateReport(
    patient: Patient,
    labResults: LabResult[],
    analyses: AnalysisResult[]
  ): DiagnosticReport {
    const criticalFindings = analyses.filter(a =>
      a.severity === SeverityLevel.CRITICAL_LOW || a.severity === SeverityLevel.CRITICAL_HIGH
    );

    const summary = this.generateSummary(analyses);

    return {
      id: `report_${Date.now()}`,
      patient,
      labResults,
      analyses,
      summary,
      criticalFindings,
      generatedDate: new Date().toISOString(),
      generatedBy: 'rule-engine',
      reviewed: false,
    };
  }

  /**
   * Δημιουργία σύνοψης αποτελεσμάτων
   */
  generateSummary(analyses: AnalysisResult[]): string {
    const criticalCount = analyses.filter(a =>
      a.severity === SeverityLevel.CRITICAL_LOW || a.severity === SeverityLevel.CRITICAL_HIGH
    ).length;
    const abnormalCount = analyses.filter(a => a.severity !== SeverityLevel.NORMAL).length;
    const normalCount = analyses.length - abnormalCount;

    const parts: string[] = [];
    parts.push(`Ανάλυση ${analyses.length} εργαστηριακών εξετάσεων.`);

    if (criticalCount > 0) {
      parts.push(`⚠️ Βρέθηκαν ${criticalCount} κρίσιμα ευρήματα που απαιτούν άμεση προσοχή.`);
    }
    if (abnormalCount > 0) {
      parts.push(`${abnormalCount} εξετάσεις είναι εκτός φυσιολογικών ορίων.`);
    }
    if (normalCount > 0) {
      parts.push(`${normalCount} εξετάσεις είναι εντός φυσιολογικών ορίων.`);
    }

    return parts.join(' ');
  }

  /**
   * Δημιουργία LabResultSummary για dashboard
   */
  createLabResultSummary(analyses: AnalysisResult[]): LabResultSummary {
    const byCategory: Record<string, { total: number; abnormal: number; critical: number }> = {};

    for (const a of analyses) {
      const cat = a.labResult.test.category;
      if (!byCategory[cat]) {
        byCategory[cat] = { total: 0, abnormal: 0, critical: 0 };
      }
      byCategory[cat].total++;
      if (a.severity !== SeverityLevel.NORMAL) byCategory[cat].abnormal++;
      if (a.severity === SeverityLevel.CRITICAL_LOW || a.severity === SeverityLevel.CRITICAL_HIGH) {
        byCategory[cat].critical++;
      }
    }

    return {
      totalTests: analyses.length,
      normalCount: analyses.filter(a => a.severity === SeverityLevel.NORMAL).length,
      abnormalCount: analyses.filter(a => a.severity !== SeverityLevel.NORMAL).length,
      criticalCount: analyses.filter(a =>
        a.severity === SeverityLevel.CRITICAL_LOW || a.severity === SeverityLevel.CRITICAL_HIGH
      ).length,
      byCategory: byCategory as any,
    };
  }

  // ===== PRIVATE METHODS =====

  private evaluateSeverity(value: number, range: { low: number; high: number }): SeverityLevel {
    if (value < range.low) return SeverityLevel.LOW;
    if (value > range.high) return SeverityLevel.HIGH;
    return SeverityLevel.NORMAL;
  }

  private generateInterpretation(
    result: LabResult,
    severity: SeverityLevel,
    range: { low: number; high: number } | undefined,
    patient: Patient
  ): string {
    const testName = result.test.name;
    const valueStr = `${result.value} ${result.unit}`;

    switch (severity) {
      case SeverityLevel.NORMAL:
        return `${testName}: Φυσιολογική τιμή (${valueStr}).`;
      case SeverityLevel.BORDERLINE_LOW:
        return `${testName}: Τιμή στο κατώτερο όριο (${valueStr}), εντός φυσιολογικού εύρους. Συνιστάται παρακολούθηση.`;
      case SeverityLevel.BORDERLINE_HIGH:
        return `${testName}: Τιμή στο ανώτερο όριο (${valueStr}), εντός φυσιολογικού εύρους. Συνιστάται παρακολούθηση.`;
      case SeverityLevel.LOW:
        return `${testName}: Χαμηλή τιμή (${valueStr}). Φυσιολογικό εύρος: ${range?.low}-${range?.high} ${result.unit}.`;
      case SeverityLevel.HIGH:
        return `${testName}: Υψηλή τιμή (${valueStr}). Φυσιολογικό εύρος: ${range?.low}-${range?.high} ${result.unit}.`;
      case SeverityLevel.CRITICAL_LOW:
        return `⚠️ ΚΡΙΣΙΜΟ: ${testName} πολύ χαμηλή (${valueStr}). Άμεση ιατρική εκτίμηση απαιτείται.`;
      case SeverityLevel.CRITICAL_HIGH:
        return `⚠️ ΚΡΙΣΙΜΟ: ${testName} πολύ υψηλή (${valueStr}). Άμεση ιατρική εκτίμηση απαιτείται.`;
      default:
        return `${testName}: Μη φυσιολογική τιμή (${valueStr}).`;
    }
  }

  private generateRecommendations(result: LabResult, severity: SeverityLevel): string[] {
    const recommendations: string[] = [];

    if (severity === SeverityLevel.CRITICAL_LOW || severity === SeverityLevel.CRITICAL_HIGH) {
      recommendations.push('Επείγουσα ειδοποίηση ιατρού');
      recommendations.push('Άμεση κλινική εκτίμηση');
    }

    if (severity !== SeverityLevel.NORMAL) {
      if (result.test.category === TestCategory.BIOCHEMISTRY) {
        recommendations.push('Επανάληψη εξέτασης για επιβεβαίωση');
      }
    }

    return recommendations;
  }

  private suggestRelatedTests(result: LabResult): string[] {
    // Αντιστοίχιση test code -> related tests
    const relatedMap: Record<string, string[]> = {
      'CREATININE': ['UREA', 'POTASSIUM', 'SODIUM'],
      'UREA': ['CREATININE', 'URIC_ACID'],
      'SGOT_AST': ['SGPT_ALT', 'GGT', 'ALP', 'TOTAL_BILIRUBIN'],
      'SGPT_ALT': ['SGOT_AST', 'GGT', 'ALP', 'TOTAL_BILIRUBIN'],
      'GLUCOSE': ['HBA1C', 'TRIGLYCERIDES'],
      'GLUCOSE_FASTING': ['HBA1C', 'TRIGLYCERIDES'],
    };

    return relatedMap[result.test.code.toUpperCase()] || [];
  }

  private filterRelevantRules(rules: Rule[], results: LabResult[]): Rule[] {
    const resultCodes = results.map(r => r.test.code.toUpperCase());
    return rules.filter(rule => {
      // If rule has test codes, check if any match
      if (rule.testCodes && rule.testCodes.length > 0) {
        return rule.testCodes.some(tc => resultCodes.includes(tc.toUpperCase()));
      }
      return true;
    });
  }
}

// Singleton instance
export const ruleEngine = new RuleEngine();
