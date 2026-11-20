import { LabResult, AnalysisResult, SeverityLevel } from '@medilab/core';
import { MLEngineConfig, MLAnalysisResult, TrendAnalysis, AnomalyResult, PatternResult } from '../models/types';
import { TrendAnalyzer } from '../predictors/trend.analyzer';
import { AnomalyDetector } from '../predictors/anomaly.detector';
import { PatternDetector } from '../predictors/pattern.detector';

/**
 * ML Engine - Κύρια κλάση που συντονίζει όλους τους ML predictors.
 *
 * Παρέχει:
 * - Trend Analysis (διαχρονική ανάλυση)
 * - Anomaly Detection (εντοπισμός ασυνήθιστων τιμών)
 * - Pattern Detection (ιατρικά μοτίβα)
 * - Risk Scoring (συνολική βαθμολογία κινδύνου)
 */
export class MLEngine {
  private config: MLEngineConfig;
  private trendAnalyzer: TrendAnalyzer;
  private anomalyDetector: AnomalyDetector;
  private patternDetector: PatternDetector;

  constructor(config?: Partial<MLEngineConfig>) {
    this.config = {
      confidenceThreshold: 0.6,
      enableTrendAnalysis: true,
      enableAnomalyDetection: true,
      ...config,
    };

    this.trendAnalyzer = new TrendAnalyzer();
    this.anomalyDetector = new AnomalyDetector();
    this.patternDetector = new PatternDetector();
  }

  /**
   * Πλήρης ML ανάλυση εργαστηριακών αποτελεσμάτων
   */
  analyze(
    currentResults: LabResult[],
    historicalResults: Record<string, LabResult[]> = {}
  ): MLAnalysisResult {
    let trends: TrendAnalysis[] = [];
    let anomalies: AnomalyResult[] = [];
    let patterns: PatternResult[] = [];

    // Trend Analysis (διαχρονική σύγκριση)
    if (this.config.enableTrendAnalysis) {
      trends = this.trendAnalyzer.analyzeTrends(currentResults, historicalResults);
    }

    // Anomaly Detection
    if (this.config.enableAnomalyDetection) {
      anomalies = this.anomalyDetector.detectAnomalies(currentResults);
    }

    // Pattern Detection
    patterns = this.patternDetector.detectPatterns(currentResults);

    // Risk Score Calculation
    const riskScore = this.calculateRiskScore(currentResults, trends, anomalies, patterns);
    const riskCategory = this.categorizeRisk(riskScore);

    // Generate summary
    const summary = this.generateSummary(currentResults, trends, anomalies, patterns, riskScore, riskCategory);

    return {
      trends,
      anomalies,
      patterns,
      riskScore,
      riskCategory,
      summary,
    };
  }

  /**
   * Αξιολόγηση confidence για analysis results
   */
  evaluateConfidence(analyses: AnalysisResult[]): number[] {
    return analyses.map(a => {
      if (a.confidence !== undefined) return a.confidence;

      // Simple heuristic: more extreme = lower confidence needed
      switch (a.severity) {
        case SeverityLevel.CRITICAL_LOW:
        case SeverityLevel.CRITICAL_HIGH:
          return 0.95;
        case SeverityLevel.HIGH:
        case SeverityLevel.LOW:
          return 0.85;
        case SeverityLevel.BORDERLINE_HIGH:
        case SeverityLevel.BORDERLINE_LOW:
          return 0.7;
        default:
          return 0.95;
      }
    });
  }

  /**
   * Υπολογισμός risk score (0-100)
   */
  private calculateRiskScore(
    results: LabResult[],
    trends: TrendAnalysis[],
    anomalies: AnomalyResult[],
    patterns: PatternResult[]
  ): number {
    let score = 0;

    // Critical/abnormal results contribute heavily
    for (const result of results) {
      switch (result.severity) {
        case SeverityLevel.CRITICAL_LOW:
        case SeverityLevel.CRITICAL_HIGH:
          score += 20;
          break;
        case SeverityLevel.HIGH:
        case SeverityLevel.LOW:
          score += 8;
          break;
        case SeverityLevel.BORDERLINE_HIGH:
        case SeverityLevel.BORDERLINE_LOW:
          score += 3;
          break;
        default: break;
      }
    }

    // Significant trends
    score += trends.filter(t => t.isSignificant).length * 5;

    // Anomalies
    score += anomalies.length * 4;

    // Patterns found
    score += patterns.filter(p => p.confidence > 0.7).length * 10;

    return Math.min(100, score);
  }

  private categorizeRisk(score: number): MLAnalysisResult['riskCategory'] {
    if (score >= 70) return 'critical';
    if (score >= 40) return 'high';
    if (score >= 15) return 'moderate';
    return 'low';
  }

  private generateSummary(
    results: LabResult[],
    trends: TrendAnalysis[],
    anomalies: AnomalyResult[],
    patterns: PatternResult[],
    riskScore: number,
    riskCategory: string
  ): string {
    const parts: string[] = [];
    const criticalCount = results.filter(
      r => r.severity === SeverityLevel.CRITICAL_LOW || r.severity === SeverityLevel.CRITICAL_HIGH
    ).length;

    parts.push(`ML Ανάλυση: Risk Score ${riskScore}/100 (${riskCategory}).`);

    if (criticalCount > 0) {
      parts.push(`Εντοπίστηκαν ${criticalCount} κρίσιμα ευρήματα.`);
    }

    const sigTrends = trends.filter(t => t.isSignificant);
    if (sigTrends.length > 0) {
      parts.push(`${sigTrends.length} σημαντικές τάσεις εντοπίστηκαν.`);
    }

    if (patterns.length > 0) {
      const highConfPatterns = patterns.filter(p => p.confidence > 0.7);
      if (highConfPatterns.length > 0) {
        parts.push(`Πιθανά μοτίβα: ${highConfPatterns.map(p => p.type).join(', ')}.`);
      }
    }

    if (anomalies.length > 0) {
      parts.push(`${anomalies.length} ασυνήθιστες τιμές εντοπίστηκαν.`);
    }

    return parts.join(' ');
  }
}
