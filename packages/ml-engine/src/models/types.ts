import {
  LabResult,
  AnalysisResult,
  SeverityLevel,
  DiagnosticReport,
} from '@medilab/core';

/** ML Model prediction result */
export interface MLEngineConfig {
  /** Minimum confidence threshold */
  confidenceThreshold: number;
  /** Enable trend analysis */
  enableTrendAnalysis: boolean;
  /** Enable anomaly detection */
  enableAnomalyDetection: boolean;
}

/** Trend analysis result */
export interface TrendAnalysis {
  testCode: string;
  testName: string;
  currentValue: number;
  previousValue?: number;
  changePercent?: number;
  direction: 'increasing' | 'decreasing' | 'stable';
  isSignificant: boolean;
  interpretation: string;
  recommendation?: string;
}

/** Anomaly result */
export interface AnomalyResult {
  testCode: string;
  testName: string;
  value: number;
  expectedRange: { low: number; high: number };
  deviationPercent: number;
  severity: SeverityLevel;
  explanation: string;
}

/** Pattern detection result */
export interface PatternResult {
  type: string;
  description: string;
  confidence: number; // 0-1
  affectedTests: string[];
  possibleConditions: string[];
  recommendations: string[];
}

/** Full ML Analysis result */
export interface MLAnalysisResult {
  trends: TrendAnalysis[];
  anomalies: AnomalyResult[];
  patterns: PatternResult[];
  riskScore: number; // 0-100
  riskCategory: 'low' | 'moderate' | 'high' | 'critical';
  summary: string;
}
