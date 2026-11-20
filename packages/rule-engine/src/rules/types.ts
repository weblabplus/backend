import {
  LabResult,
  AnalysisResult,
  SeverityLevel,
  TestCategory,
} from '@medilab/core';

/** Ορισμός ενός κανόνα */
export interface Rule {
  id: string;
  name: string;
  description: string;
  priority: number; // 1 (highest) - 5 (lowest)
  category: 'critical' | 'warning' | 'info' | 'suggestion';
  condition: (results: LabResult[], patientData?: any) => boolean;
  action: RuleAction;
  /** Related test codes */
  testCodes?: string[];
}

export interface RuleAction {
  interpretation: string;
  recommendations: string[];
  relatedTests?: string[];
  differentialDiagnosis?: string[];
}

/** Αποτέλεσμα αξιολόγησης κανόνων */
export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  action?: RuleAction;
  severity: SeverityLevel;
}
