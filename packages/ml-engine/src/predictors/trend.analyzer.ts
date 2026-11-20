import { LabResult, SeverityLevel } from '@medilab/core';
import { TrendAnalysis } from '../models/types';

/**
 * Trend Analyzer - Αναλύει τις τάσεις των εργαστηριακών τιμών διαχρονικά.
 *
 * Συγκρίνει τρέχουσες τιμές με προηγούμενες για να εντοπίσει
 * σημαντικές αλλαγές που μπορεί να υποδεικνύουν επιδείνωση ή βελτίωση.
 */
export class TrendAnalyzer {
  private significantChangeThreshold: number = 20; // 20% change is significant

  /**
   * Ανάλυση τάσης για ένα test
   */
  analyzeSingleTrend(current: LabResult, historical: LabResult[]): TrendAnalysis {
    const sorted = [...historical].sort(
      (a, b) => new Date(b.collectionDate).getTime() - new Date(a.collectionDate).getTime()
    );

    const previous = sorted.length > 0 ? sorted[0] : undefined;
    let changePercent: number | undefined;
    let direction: TrendAnalysis['direction'] = 'stable';

    if (previous) {
      changePercent = ((current.value - previous.value) / previous.value) * 100;

      if (Math.abs(changePercent) >= this.significantChangeThreshold) {
        direction = changePercent > 0 ? 'increasing' : 'decreasing';
      } else if (Math.abs(changePercent) >= 5) {
        direction = changePercent > 0 ? 'increasing' : 'decreasing';
      } else {
        direction = 'stable';
      }
    }

    const isSignificant = previous
      ? Math.abs(changePercent!) >= this.significantChangeThreshold
      : false;

    const interpretation = this.generateTrendInterpretation(
      current.test.name,
      current.value,
      previous?.value,
      changePercent,
      direction,
      isSignificant
    );

    return {
      testCode: current.test.code,
      testName: current.test.name,
      currentValue: current.value,
      previousValue: previous?.value,
      changePercent: changePercent !== undefined ? +(changePercent.toFixed(1)) : undefined,
      direction,
      isSignificant,
      interpretation,
      recommendation: isSignificant
        ? `Συνιστάται στενή παρακολούθηση της ${current.test.name}.`
        : undefined,
    };
  }

  /**
   * Ανάλυση τάσεων για πολλαπλά tests
   */
  analyzeTrends(currentResults: LabResult[], historicalResults: Record<string, LabResult[]>): TrendAnalysis[] {
    const trends: TrendAnalysis[] = [];

    for (const result of currentResults) {
      const history = historicalResults[result.test.code] || [];
      trends.push(this.analyzeSingleTrend(result, history));
    }

    return trends;
  }

  /**
   * Εντοπισμός "silent" trends - μικρές αλλαγές που μπορεί να γίνουν σημαντικές
   */
  detectSilentTrends(trends: TrendAnalysis[]): TrendAnalysis[] {
    return trends.filter(t =>
      t.direction !== 'stable' &&
      !t.isSignificant &&
      t.changePercent !== undefined &&
      Math.abs(t.changePercent) >= 10
    );
  }

  private generateTrendInterpretation(
    testName: string,
    current: number,
    previous: number | undefined,
    changePercent: number | undefined,
    direction: string,
    isSignificant: boolean
  ): string {
    if (!previous) {
      return `Δεν υπάρχουν προηγούμενες τιμές για σύγκριση της ${testName}.`;
    }

    const changeStr = changePercent !== undefined
      ? `(${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%)`
      : '';

    if (direction === 'stable') {
      return `Η τιμή της ${testName} παραμένει σταθερή ${changeStr}.`;
    }

    if (isSignificant) {
      return `⚠️ Σημαντική ${direction === 'increasing' ? 'αύξηση' : 'μείωση'} της ${testName} ${changeStr} σε σχέση με την προηγούμενη μέτρηση.`;
    }

    return `Μικρή ${direction === 'increasing' ? 'αύξηση' : 'μείωση'} της ${testName} ${changeStr}.`;
  }
}
