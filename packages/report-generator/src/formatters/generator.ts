import {
  DiagnosticReport,
  AnalysisResult,
  LabResult,
  SeverityLevel,
  TestCategory,
  Patient,
} from '@medilab/core';
import { calculateAge, formatDateEl, roundValue } from '@medilab/core';
import { CATEGORY_LABELS_EL } from '@medilab/core';
import {
  ReportOptions,
  ReportSection,
  GeneratedReport,
  DEFAULT_REPORT_OPTIONS,
  ReportFormat,
} from '../templates/types';

/**
 * Report Generator - Δημιουργεί διαγνωστικές αναφορές σε πολλαπλά formats
 */
export class ReportGenerator {
  private options: ReportOptions;

  constructor(options?: Partial<ReportOptions>) {
    this.options = { ...DEFAULT_REPORT_OPTIONS, ...options };
  }

  /**
   * Δημιουργία αναφοράς
   */
  generate(report: DiagnosticReport, format?: ReportFormat): GeneratedReport {
    const fmt = format || this.options.format;
    let content: string;

    switch (fmt) {
      case 'json':
        content = this.generateJson(report);
        break;
      case 'html':
        content = this.generateHtml(report);
        break;
      case 'csv':
        content = this.generateCsv(report);
        break;
      default:
        content = this.generateJson(report);
    }

    return {
      id: `report_${Date.now()}`,
      format: fmt,
      content,
      mimeType: this.getMimeType(fmt),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Δημιουργία HTML αναφοράς
   */
  generateHtml(report: DiagnosticReport): string {
    const sections = this.buildSections(report);
    const patient = report.patient;
    const age = calculateAge(patient.dateOfBirth);

    return `<!DOCTYPE html>
<html lang="${this.options.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Διαγνωστική Αναφορά - ${patient.lastName} ${patient.firstName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .header .meta { font-size: 14px; opacity: 0.9; }
    .patient-info { background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px; border-left: 4px solid #667eea; }
    .patient-info h2 { color: #667eea; font-size: 18px; margin-bottom: 10px; }
    .patient-info .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .patient-info .label { font-weight: 600; color: #666; }
    .summary { background: #fff3cd; padding: 15px 20px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #ffc107; }
    .summary.warning { background: #fff3cd; border-color: #ffc107; }
    .summary.critical { background: #f8d7da; border-color: #dc3545; }
    .section { margin-bottom: 25px; }
    .section h2 { color: #1a1a2e; font-size: 20px; border-bottom: 2px solid #667eea; padding-bottom: 8px; margin-bottom: 15px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    th { background: #667eea; color: white; padding: 12px; text-align: left; font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #e0e0e0; }
    tr:hover { background: #f5f5f5; }
    .severity-normal { color: #28a745; font-weight: 600; }
    .severity-low { color: #ffc107; font-weight: 600; }
    .severity-high { color: #fd7e14; font-weight: 600; }
    .severity-critical { color: #dc3545; font-weight: 600; animation: pulse 1s infinite; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge-normal { background: #d4edda; color: #155724; }
    .badge-abnormal { background: #fff3cd; color: #856404; }
    .badge-critical { background: #f8d7da; color: #721c24; }
    .item-card { background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 15px; margin-bottom: 10px; }
    .item-card h3 { color: #1a1a2e; margin-bottom: 5px; }
    .item-card .value { font-size: 20px; font-weight: 700; }
    .item-card .range { color: #666; font-size: 14px; }
    .item-card .interpretation { margin-top: 8px; padding: 8px 12px; background: #f8f9fa; border-radius: 6px; }
    .recommendations { list-style: none; padding: 0; }
    .recommendations li { padding: 5px 0; padding-left: 20px; position: relative; }
    .recommendations li::before { content: '→'; position: absolute; left: 0; color: #667eea; }
    .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @media print { body { background: white; } .header { background: #667eea !important; -webkit-print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🏥 Διαγνωστική Αναφορά Εργαστηριακών Εξετάσεων</h1>
      <div class="meta">
        Ημερομηνία Έκδοσης: ${formatDateEl(report.generatedDate)} |
        Αναφορά #${report.id} |
        Μέθοδος: ${report.generatedBy}
      </div>
    </div>

    ${this.options.includePatientInfo ? this.buildPatientHtml(patient, age) : ''}

    ${this.options.includeSummary ? this.buildSummaryHtml(report) : ''}

    ${this.options.includeCriticalFindings ? this.buildCriticalHtml(report.criticalFindings) : ''}

    ${this.options.includeAllResults ? this.buildResultsHtml(report.analyses) : ''}

    <div class="footer">
      <p>⚠️ Αποποίηση: Αυτή η αναφορά δημιουργήθηκε αυτόματα και δεν υποκαθιστά την ιατρική γνωμάτευση.</p>
      <p>MediLab v1.0 | ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Δημιουργία JSON αναφοράς
   */
  generateJson(report: DiagnosticReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Δημιουργία CSV αναφοράς (μόνο τα αποτελέσματα)
   */
  generateCsv(report: DiagnosticReport): string {
    const headers = [
      'Test Code', 'Test Name', 'Value', 'Unit', 'Category',
      'Reference Low', 'Reference High', 'Severity', 'Is Critical',
      'Collection Date', 'Interpretation',
    ];

    const rows = report.analyses.map(a => [
      a.labResult.test.code,
      a.labResult.test.name,
      a.labResult.value.toString(),
      a.labResult.unit,
      a.labResult.test.category,
      a.labResult.referenceRange?.low?.toString() || '',
      a.labResult.referenceRange?.high?.toString() || '',
      a.severity,
      a.labResult.isCritical ? 'Yes' : 'No',
      formatDateEl(a.labResult.collectionDate),
      `"${a.interpretation.replace(/"/g, '""')}"`,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  // === PRIVATE HTML BUILDERS ===

  private buildPatientHtml(patient: Patient, age: number): string {
    return `
    <div class="patient-info">
      <h2>👤 Στοιχεία Ασθενούς</h2>
      <div class="grid">
        <div><span class="label">Ονοματεπώνυμο:</span> ${patient.lastName} ${patient.firstName}</div>
        <div><span class="label">ID:</span> ${patient.id}</div>
        <div><span class="label">Ηλικία:</span> ${age} ετών</div>
        <div><span class="label">Φύλο:</span> ${patient.gender === 'male' ? 'Άνδρας' : patient.gender === 'female' ? 'Γυναίκα' : 'Άλλο'}</div>
        ${patient.medications ? `<div><span class="label">Φάρμακα:</span> ${patient.medications.join(', ')}</div>` : ''}
      </div>
    </div>`;
  }

  private buildSummaryHtml(report: DiagnosticReport): string {
    const criticalCount = report.criticalFindings.length;
    const summaryClass = criticalCount > 0 ? 'critical' : 'warning';

    return `
    <div class="summary ${summaryClass}">
      <p>${report.summary}</p>
    </div>`;
  }

  private buildCriticalHtml(criticalFindings: AnalysisResult[]): string {
    if (criticalFindings.length === 0) return '';

    const items = criticalFindings.map(a => `
      <div class="item-card" style="border-left: 4px solid #dc3545;">
        <h3 style="color: #dc3545;">⚠️ ${a.labResult.test.name}</h3>
        <div class="value severity-critical">${a.labResult.value} ${a.labResult.unit}</div>
        ${a.labResult.referenceRange ? `<div class="range">Φυσιολογικό: ${a.labResult.referenceRange.low} - ${a.labResult.referenceRange.high} ${a.labResult.unit}</div>` : ''}
        <div class="interpretation">${a.interpretation}</div>
        ${this.buildRecommendationsHtml(a)}
      </div>
    `).join('');

    return `
    <div class="section">
      <h2>🔴 Κρίσιμα Ευρήματα (${criticalFindings.length})</h2>
      ${items}
    </div>`;
  }

  private buildResultsHtml(analyses: AnalysisResult[]): string {
    const normalResults = analyses.filter(a => a.severity === SeverityLevel.NORMAL);
    const abnormalResults = analyses.filter(a => a.severity !== SeverityLevel.NORMAL && a.severity !== SeverityLevel.CRITICAL_LOW && a.severity !== SeverityLevel.CRITICAL_HIGH);

    let html = '';

    if (abnormalResults.length > 0) {
      html += `
    <div class="section">
      <h2>🟡 Παθολογικά Αποτελέσματα (${abnormalResults.length})</h2>
      <table>
        <thead>
          <tr><th>Εξέταση</th><th>Τιμή</th><th>Φυσ. Εύρος</th><th>Σοβαρότητα</th><th>Ερμηνεία</th></tr>
        </thead>
        <tbody>
          ${abnormalResults.map(a => this.buildResultRow(a)).join('')}
        </tbody>
      </table>
    </div>`;
    }

    if (normalResults.length > 0) {
      html += `
    <div class="section">
      <h2>🟢 Φυσιολογικά Αποτελέσματα (${normalResults.length})</h2>
      <table>
        <thead>
          <tr><th>Εξέταση</th><th>Τιμή</th><th>Φυσ. Εύρος</th><th>Κατάσταση</th></tr>
        </thead>
        <tbody>
          ${normalResults.map(a => `
          <tr>
            <td>${a.labResult.test.name}</td>
            <td>${roundValue(a.labResult.value)} ${a.labResult.unit}</td>
            <td>${a.labResult.referenceRange ? `${a.labResult.referenceRange.low} - ${a.labResult.referenceRange.high} ${a.labResult.unit}` : '-'}</td>
            <td><span class="badge badge-normal">Φυσιολογικό</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
    }

    return html;
  }

  private buildResultRow(a: AnalysisResult): string {
    const severityClass = a.severity.includes('critical') ? 'severity-critical'
      : a.severity.includes('high') || a.severity.includes('low') ? 'severity-high'
      : 'severity-low';

    const severityLabel = a.severity.includes('critical') ? 'Κρίσιμο'
      : a.severity.includes('high') ? 'Υψηλό'
      : a.severity.includes('low') ? 'Χαμηλό'
      : a.severity.includes('borderline') ? 'Οριακό'
      : 'Παθολογικό';

    return `
          <tr>
            <td>${a.labResult.test.name}</td>
            <td><span class="${severityClass}">${roundValue(a.labResult.value)} ${a.labResult.unit}</span></td>
            <td>${a.labResult.referenceRange ? `${a.labResult.referenceRange.low} - ${a.labResult.referenceRange.high} ${a.labResult.unit}` : '-'}</td>
            <td><span class="badge badge-abnormal">${severityLabel}</span></td>
            <td style="max-width: 300px;">${a.interpretation}</td>
          </tr>`;
  }

  private buildRecommendationsHtml(a: AnalysisResult): string {
    if (!this.options.includeRecommendations || !a.recommendations || a.recommendations.length === 0) {
      return '';
    }
    return `
      <ul class="recommendations" style="margin-top: 8px;">
        ${a.recommendations.map(r => `<li>${r}</li>`).join('')}
      </ul>`;
  }

  private buildSections(report: DiagnosticReport): ReportSection[] {
    const sections: ReportSection[] = [];

    if (this.options.includePatientInfo) {
      sections.push({
        title: 'Στοιχεία Ασθενούς',
        content: `${report.patient.lastName} ${report.patient.firstName}, ID: ${report.patient.id}`,
        priority: 1,
      });
    }

    if (this.options.includeCriticalFindings && report.criticalFindings.length > 0) {
      sections.push({
        title: 'Κρίσιμα Ευρήματα',
        content: `${report.criticalFindings.length} κρίσιμα ευρήματα εντοπίστηκαν`,
        priority: 2,
      });
    }

    return sections;
  }

  private getMimeType(format: ReportFormat): string {
    switch (format) {
      case 'json': return 'application/json';
      case 'html': return 'text/html';
      case 'csv': return 'text/csv';
      case 'pdf': return 'application/pdf';
      default: return 'application/json';
    }
  }
}

// Singleton instance
export const reportGenerator = new ReportGenerator();
