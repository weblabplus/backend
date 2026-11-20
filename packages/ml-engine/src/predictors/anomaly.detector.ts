import { LabResult, SeverityLevel, TestCategory } from '@medilab/core';
import { AnomalyResult } from '../models/types';

/**
 * Anomaly Detector - Εντοπίζει ασυνήθιστα/απρόσμενα αποτελέσματα.
 *
 * Χρησιμοποιεί στατιστικές μεθόδους (z-score, IQR) για τον εντοπισμό
 * αποτελεσμάτων που αποκλίνουν σημαντικά από το αναμενόμενο.
 */
export class AnomalyDetector {
  private zScoreThreshold: number = 2.0; // 2 standard deviations

  /**
   * Εντοπισμός anomalies σε ένα σύνολο αποτελεσμάτων
   */
  detectAnomalies(results: LabResult[]): AnomalyResult[] {
    const anomalies: AnomalyResult[] = [];

    // Group by category for contextual analysis
    const byCategory = this.groupByCategory(results);

    for (const [category, categoryResults] of Object.entries(byCategory)) {
      for (const result of categoryResults) {
        const anomaly = this.evaluateAnomaly(result, categoryResults);
        if (anomaly) {
          anomalies.push(anomaly);
        }
      }
    }

    return anomalies;
  }

  /**
   * Εντοπισμός outlier με IQR method
   */
  detectOutliersIQR(results: LabResult[]): LabResult[] {
    if (results.length < 4) return [];

    const values = results.map(r => r.value).sort((a, b) => a - b);
    const q1Index = Math.floor(values.length * 0.25);
    const q3Index = Math.floor(values.length * 0.75);
    const q1 = values[q1Index];
    const q3 = values[q3Index];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    return results.filter(r => r.value < lowerBound || r.value > upperBound);
  }

  /**
   * Υπολογισμός z-score για μια τιμή σε ένα σύνολο
   */
  calculateZScore(value: number, values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  }

  private evaluateAnomaly(result: LabResult, contextResults: LabResult[]): AnomalyResult | null {
    // Skip normal results for anomaly detection
    if (result.severity === SeverityLevel.NORMAL) return null;

    // Calculate z-score against context
    const contextValues = contextResults.map(r => r.value);
    const zScore = Math.abs(this.calculateZScore(result.value, contextValues));

    if (zScore < this.zScoreThreshold) return null;

    const mean = contextValues.reduce((a, b) => a + b, 0) / contextValues.length;
    const deviationPercent = Math.abs(((result.value - mean) / mean) * 100);

    return {
      testCode: result.test.code,
      testName: result.test.name,
      value: result.value,
      expectedRange: {
        low: mean - this.zScoreThreshold * this.calculateStdDev(contextValues),
        high: mean + this.zScoreThreshold * this.calculateStdDev(contextValues),
      },
      deviationPercent: +(deviationPercent.toFixed(1)),
      severity: result.severity,
      explanation: `Η τιμή της ${result.test.name} (${result.value} ${result.unit}) αποκλίνει σημαντικά (z-score: ${zScore.toFixed(2)}) από το αναμενόμενο εύρος για την κατηγορία.`,
    };
  }

  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  private groupByCategory(results: LabResult[]): Record<string, LabResult[]> {
    const groups: Record<string, LabResult[]> = {};
    for (const result of results) {
      const cat = result.test.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(result);
    }
    return groups;
  }
}
