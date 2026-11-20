// ============================================================
// Reference Center Service — αποστολή εξετάσεων παραπεμπτικού
// σε κέντρο αναφοράς (SLIS / Infomed XML v1.0.8.1)
//
// Το κέντρο δεν απαιτεί HTTP authentication: γίνεται POST με raw XML
// body στο SLISMESSAGE endpoint του.
//
// Αντιστοίχιση εξετάσεων:
//   exam.loincCode → exam_micro.loinc_code_json → exam_micro.examstrcode
//   (το `examstrcode` είναι ο κωδικός TEST του sLis)
// ============================================================

import { dbService, type ReferenceCenter } from '../db/db.service';
import type { Exam, Patient, Referral } from '@medilab/core';

export class ReferenceCenterError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'ReferenceCenterError';
  }
}

// ── Types ──

export interface SlisTest {
  /** sLis TEST code (exam_micro.examstrcode) */
  code: string;
  /** Ονομασία εξέτασης (για εμφάνιση) */
  name: string;
  /** LOINC από το οποίο προέκυψε η αντιστοίχιση */
  loincCode?: string;
  /** Το exam.id της εφαρμογής */
  examId?: string;
  action: number;
}

export interface SendOrderInput {
  centerId: string;
  referralId: string;
  examIds?: string[];
  /** Επιλογές χρήστη για εξετάσεις με πολλαπλές αντιστοιχίσεις: examId → SLIS code */
  choices?: Record<string, string>;
  doctorId?: string;
}

export interface SendOrderOutcome {
  centerId: string;
  centerName: string;
  orderNo: string;
  status: string;
  lisOrderNo?: string;
  tests: Array<{ code: string; barcode?: string }>;
  sentAt: string;
  durationMs: number;
  requestXml: string;
  responseXml: string;
  referral: Referral;
}

export interface UnmappedExam {
  examId: string;
  name: string;
  loincCode?: string | null;
  reason: string;
}

/** Εξέταση που αντιστοιχεί σε >1 εξετάσεις του κέντρου — χρειάζεται επιλογή */
export interface AmbiguousExam {
  examId: string;
  name: string;
  loincCode: string;
  options: Array<{ code: string; name: string }>;
}

// ── Helpers ──

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** SENDERCODE σε 4 ψηφία με leading zeros (π.χ. "1" → "0001") */
function padStart4(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.padStart(4, '0').slice(0, 4);
}

/** dd/MM/yyyy */
function slisDate(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/** HH:mm:ss */
function slisTime(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

/** Αφαίρεση μη έγκυρων χαρακτήρων XML 1.0 */
function sanitizeXml(xml: string): string {
  return xml.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * SENDERCODE + XXXXXXXX (4+8 ψηφία) — κανόνας του φορέα για CODE/ORDERNO.
 * Το XXXXXXXX προκύπτει από αριθμητικό hash του id, ώστε να είναι σταθερό.
 */
function numericSuffix(seed: string, length = 8): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100000000;
  }
  return String(hash).padStart(length, '0');
}

// ── XML κατασκευή ──

export interface BuildOrderContext {
  center: ReferenceCenter;
  referral: Referral;
  patient: Patient;
  tests: SlisTest[];
  orderNo: string;
  patientCode: string;
  orderDate?: string;
  orderTime?: string;
}

/**
 * Κατασκευάζει το XML της παραγγελίας (create-order).
 * Δομή σύμφωνα με SLISXMLv1.0.8.1, σελίδα 2.
 */
export function buildSlisOrderXml(ctx: BuildOrderContext): string {
  const { center, patient, tests, orderNo, patientCode } = ctx;
  const cfg = center.config || {};
  const requestType = cfg.requestType || 'create-order';
  // SENDERCODE πάντα 4 ψηφία (π.χ. "0001")
  const senderCode = padStart4(cfg.senderCode);
  const action = Number.isFinite(Number(cfg.action)) ? Number(cfg.action) : 1;

  const password = String(cfg.password || '').trim();
  // Unidirectional: <USER> sibling του <ORDER>, σειρά REQUESTOR / USERNAME / PASSWORD
  // όπου REQUESTOR = USERNAME = SENDERCODE.
  const userBlock = password
    ? `  <USER>
    <REQUESTOR>${escapeXml(cfg.requestor || senderCode)}</REQUESTOR>
    <USERNAME>${escapeXml(cfg.username || senderCode)}</USERNAME>
    <PASSWORD>${escapeXml(password)}</PASSWORD>
  </USER>
`
    : '';

  // Πραγματική μορφή κέντρου: <TESTS><test>CODE</test>…</TESTS>
  const testsXml = tests
    .map(t => `    <test>${escapeXml(t.code)}</test>`)
    .join('\n');

  // Προαιρετικά πεδία ORDER της unidirectional (LMD, URINEVOLUME)
  const lmd = String(cfg.lmd || '00/00/0000');
  const urineVolume =
    cfg.urineVolume !== undefined && cfg.urineVolume !== null && String(cfg.urineVolume) !== ''
      ? `    <URINEVOLUME>${escapeXml(cfg.urineVolume)}</URINEVOLUME>\n`
      : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<request type="${escapeXml(requestType)}">
${userBlock}  <PATIENT>
    <CODE>${escapeXml(patientCode)}</CODE>
    <LASTNAME>${escapeXml(patient.lastName)}</LASTNAME>
    <FIRSTNAME>${escapeXml(patient.firstName)}</FIRSTNAME>
    <FATHERNAME>${escapeXml(cfg.fatherName || '')}</FATHERNAME>
    <BIRTHDAY>${escapeXml(slisDate(patient.dateOfBirth))}</BIRTHDAY>
    <SEX>${escapeXml(
      String(patient.gender).toLowerCase() === 'female'
        ? 'female'
        : String(patient.gender).toLowerCase() === 'male'
        ? 'male'
        : ''
    )}</SEX>
  </PATIENT>
  <ORDER>
    <ORDERNO>${escapeXml(orderNo)}</ORDERNO>
    <ORDERDATE>${escapeXml(ctx.orderDate || slisDate())}</ORDERDATE>
    <ORDERTIME>${escapeXml(ctx.orderTime || slisTime())}</ORDERTIME>
    ${senderCode ? `<SENDERCODE>${escapeXml(senderCode)}</SENDERCODE>\n    ` : ''}<LMD>${escapeXml(lmd)}</LMD>
${urineVolume}    <COMMENTS>${escapeXml(
    (ctx.referral.specialty || ctx.referral.reason || '').slice(0, 255)
  )}</COMMENTS>
  </ORDER>
  <TESTS>
${testsXml}
  </TESTS>
</request>`;

  return sanitizeXml(xml);
}

/** Εξαγωγή τιμών από την απάντηση XML (χωρίς εξωτερικό parser) */
export function parseSlisReply(xml: string): {
  status?: string;
  orderNo?: string;
  lisOrderNo?: string;
  tests: Array<{ code: string; barcode?: string }>;
  message?: string;
} {
  const pick = (tag: string): string | undefined => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return m ? m[1].trim() : undefined;
  };

  const tests: Array<{ code: string; barcode?: string }> = [];
  // Υποστηρίζονται και οι δύο μορφές: <test>CODE</test> και <TEST><CODE>…</CODE></TEST>
  const simpleTests = xml.match(/<test>\s*([^<]+?)\s*<\/test>/gi) || [];
  for (const block of simpleTests) {
    const code = /<test>\s*([^<]+?)\s*<\/test>/i.exec(block)?.[1]?.trim();
    if (code) tests.push({ code });
  }
  if (tests.length === 0) {
    const testBlocks = xml.match(/<TEST>[\s\S]*?<\/TEST>/gi) || [];
    for (const block of testBlocks) {
      const code = /<CODE>([\s\S]*?)<\/CODE>/i.exec(block)?.[1]?.trim();
      const barcode = /<BARCODE>([\s\S]*?)<\/BARCODE>/i.exec(block)?.[1]?.trim();
      if (code) tests.push({ code, ...(barcode ? { barcode } : {}) });
    }
  }

  return {
    status: pick('STATUS'),
    orderNo: pick('ORDERNO'),
    lisOrderNo: pick('LISORDERNO'),
    tests,
    message: pick('MESSAGE') || pick('ERROR') || undefined,
  };
}

// ── HTTP ──

async function postSlisXml(
  center: ReferenceCenter,
  xml: string
): Promise<{ ok: true; text: string } | { ok: false; code: string; error: string; text?: string }> {
  const timeout = Number(process.env.REFERENCE_CENTER_TIMEOUT_MS) || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(center.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml,application/xml' },
      body: xml,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        code: `HTTP_${res.status}`,
        error: `Το κέντρο απάντησε με HTTP ${res.status}`,
        text: text.slice(0, 500),
      };
    }
    return { ok: true, text };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted
        ? `Το κέντρο δεν απάντησε εντός ${timeout / 1000}s`
        : `Σφάλμα δικτύου: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Αντιστοίχιση εξετάσεων ──

/** Όλοι οι υποψήφιοι κωδικοί LOINC μιας εξέτασης (exam.loincCode πρώτα, μετά οι παράμετροι) */
export function examLoincCandidates(exam: Exam): string[] {
  const list: string[] = [];
  const direct = String(exam.loincCode || '').trim();
  if (direct) list.push(direct);

  // Κρατείται κατά την αποστολή σε κέντρο (επιβιώνει της αντικατάστασης παραμέτρων)
  const saved = String((exam as any).sentToCenter?.loincCode || '').trim();
  if (saved && !list.includes(saved)) list.push(saved);

  // Εξετάσεις από e-Prescription φέρουν το LOINC στις παραμέτρους (loincNum)
  for (const p of Array.isArray(exam.parameters) ? exam.parameters : []) {
    const code = String(p.loincNum || '').trim();
    if (code && !list.includes(code)) list.push(code);
  }
  return list;
}

/**
 * Επιλέγει τις εξετάσεις και τις μετατρέπει σε SLIS tests.
 *
 * - 1 αντιστοίχιση → αυτόματη επιλογή
 * - >1 αντιστοιχίσεις → χρειάζεται `choices[examId]` από τον χρήστη, αλλιώς
 *   η εξέταση επιστρέφεται στα `ambiguous`
 */
export async function resolveSlisTests(
  exams: Exam[],
  selectedIds?: string[],
  choices?: Record<string, string>
): Promise<{ tests: SlisTest[]; unmapped: UnmappedExam[]; ambiguous: AmbiguousExam[] }> {
  const selected =
    selectedIds && selectedIds.length > 0
      ? exams.filter(e => selectedIds.includes(e.id))
      : exams;

  // Συλλογή όλων των υποψήφιων LOINC (exam.loincCode + parameters[].loincNum)
  const candidatesByExam = new Map<string, string[]>();
  const allCodes: string[] = [];
  for (const exam of selected) {
    const codes = examLoincCandidates(exam);
    candidatesByExam.set(exam.id, codes);
    for (const c of codes) if (!allCodes.includes(c)) allCodes.push(c);
  }

  const mapping = await dbService.findMicroTestsByLoinc(allCodes);

  const tests: SlisTest[] = [];
  const unmapped: UnmappedExam[] = [];
  const ambiguous: AmbiguousExam[] = [];
  const seen = new Set<string>();

  for (const exam of selected) {
    // Ήδη απεσταλμένες σε κέντρο ή ολοκληρωμένες → δεν προτείνονται για αποστολή
    const st = String(exam.status);
    if (st === 'sent' || st === 'completed') continue;

    const candidates = candidatesByExam.get(exam.id) || [];
    if (candidates.length === 0) {
      unmapped.push({
        examId: exam.id,
        name: exam.name,
        loincCode: null,
        reason: 'Η εξέταση δεν έχει κωδικό LOINC (ούτε στις παραμέτρους)',
      });
      continue;
    }

    // Συλλογή όλων των επιλογών από όλα τα υποψήφια LOINC (dedupe ανά code)
    const options: Array<{ code: string; name: string }> = [];
    let matchedLoinc: string | undefined;
    for (const candidate of candidates) {
      const found = mapping.get(candidate);
      if (!found || found.length === 0) continue;
      matchedLoinc = matchedLoinc || candidate;
      for (const opt of found) {
        if (!options.some(o => o.code === opt.code)) options.push(opt);
      }
    }

    if (options.length === 0) {
      unmapped.push({
        examId: exam.id,
        name: exam.name,
        loincCode: candidates[0],
        reason: `Δεν βρέθηκε αντιστοίχιση στον πίνακα exam_micro για LOINC ${candidates[0]}`,
      });
      continue;
    }

    // Πολλαπλές επιλογές → απαιτείται απόφαση χρήστη
    if (options.length > 1) {
      const chosen = choices?.[exam.id];
      if (!chosen || !options.some(o => o.code === chosen)) {
        ambiguous.push({
          examId: exam.id,
          name: exam.name,
          loincCode: matchedLoinc || candidates[0],
          options,
        });
        continue;
      }
      if (seen.has(chosen)) continue;
      seen.add(chosen);
      tests.push({
        code: chosen,
        name: exam.name,
        loincCode: matchedLoinc,
        examId: exam.id,
        action: 1,
      });
      continue;
    }

    const only = options[0];
    if (seen.has(only.code)) continue;
    seen.add(only.code);
    tests.push({
      code: only.code,
      name: exam.name,
      loincCode: matchedLoinc,
      examId: exam.id,
      action: 1,
    });
  }

  return { tests, unmapped, ambiguous };
}

// ── Orchestration ──

const SENT_ORDERS_KEY = 'referenceOrders';

/** Αποστολή εξετάσεων παραπεμπτικού σε κέντρο αναφοράς */
export async function sendReferralToCenter(
  input: SendOrderInput
): Promise<SendOrderOutcome> {
  const center = await dbService.getReferenceCenter(input.centerId);
  if (!center) {
    throw new ReferenceCenterError('Το κέντρο αναφοράς δεν βρέθηκε', 'CENTER_NOT_FOUND');
  }
  if (!center.active) {
    throw new ReferenceCenterError('Το κέντρο αναφοράς είναι ανενεργό', 'CENTER_INACTIVE');
  }
  if (!center.url || /xxx\.xxx\.xxx\.xxx/.test(center.url)) {
    throw new ReferenceCenterError(
      'Δεν έχει ρυθμιστεί έγκυρη διεύθυνση (URL) για το κέντρο — Ρυθμίσεις → Κέντρα Αναφοράς',
      'NO_CENTER_URL'
    );
  }

  const referral = await dbService.getReferral(input.referralId);
  if (!referral) {
    throw new ReferenceCenterError('Το παραπεμπτικό δεν βρέθηκε', 'REFERRAL_NOT_FOUND');
  }

  const [allExams, patient] = await Promise.all([
    dbService.listExams(input.referralId),
    dbService.getPatient(referral.patientId),
  ]);

  if (!patient) {
    throw new ReferenceCenterError('Ο ασθενής δεν βρέθηκε', 'PATIENT_NOT_FOUND');
  }

  const { tests, unmapped, ambiguous } = await resolveSlisTests(allExams, input.examIds, input.choices);

  // Αν υπάρχουν εξετάσεις με πολλαπλές αντιστοιχίσεις, ο χρήστης πρέπει να επιλέξει
  if (ambiguous.length > 0) {
    throw new ReferenceCenterError(
      `Χρειάζεται επιλογή για ${ambiguous.length} εξέταση(εις) που αντιστοιχίζονται σε ` +
        `περισσότερες από μία εξετάσεις του κέντρου: ${ambiguous.map(a => a.name).join(', ')}`,
      'AMBIGUOUS_MAPPING'
    );
  }

  if (tests.length === 0) {
    throw new ReferenceCenterError(
      unmapped.length > 0
        ? `Καμία εξέταση δεν αντιστοιχίστηκε σε κωδικό sLis: ${unmapped
            .map(u => `${u.name}${u.loincCode ? ` (${u.loincCode})` : ''}`)
            .join(', ')}`
        : 'Δεν υπάρχουν εξετάσεις προς αποστολή',
      'NO_TESTS'
    );
  }

  const senderCodeRaw = padStart4(center.config?.senderCode);
  if (!senderCodeRaw) {
    throw new ReferenceCenterError(
      'Δεν έχει ρυθμιστεί SENDERCODE (4 ψηφία) για το κέντρο — Ρυθμίσεις → Κέντρα Αναφοράς',
      'NO_SENDER_CODE'
    );
  }

  // Αν το κέντρο απαιτεί <USER>, χρειάζεται password από τις Ρυθμίσεις
  const requiresUser = Boolean(center.config?.requiresUser);
  const password = String(center.config?.password || '').trim();
  if (requiresUser && !password) {
    throw new ReferenceCenterError(
      'Το κέντρο απαιτεί PASSWORD — συμπληρώστε το στις Ρυθμίσεις → Κέντρα Αναφοράς',
      'NO_PASSWORD'
    );
  }

  // Κανόνας φορέα: CODE = SENDERCODE-XXXXXXXX, ORDERNO = SENDERCODE + 8ψήφιος αύξων
  const patientSuffix = numericSuffix(patient.id, 8);
  const patientCode = `${senderCodeRaw}-${patientSuffix}`;
  const counter = await dbService.nextOrderCounter(center.id);
  const orderNo = `${senderCodeRaw}${String(counter).padStart(8, '0')}`;

  const started = Date.now();
  const requestXml = buildSlisOrderXml({
    center,
    referral,
    patient,
    tests,
    orderNo,
    patientCode,
  });

  const res = await postSlisXml(center, requestXml);
  if (!res.ok) {
    throw new ReferenceCenterError(
      `${res.error}${res.text ? ` — ${res.text}` : ''}`,
      res.code
    );
  }

  // Οι απεσταλμένες εξετάσεις γίνονται «Απεσταλμένη» (sent): δεν διαγράφονται
  // και δεν ξαναστέλνονται.
  const sentAtIso = new Date().toISOString();
  for (const test of tests) {
    if (!test.examId) continue;
    try {
      await dbService.updateExam(test.examId, {
        status: 'sent' as any,
        sentToCenter: {
          centerId: center.id,
          centerName: center.name,
          code: test.code,
          /** Κρατάμε το LOINC ώστε να μη χάνεται όταν αντικατασταθούν οι παράμετροι */
          loincCode: test.loincCode,
          sentAt: sentAtIso,
        },
      } as any);
    } catch {
      /* ignore individual failures */
    }
  }

  const reply = parseSlisReply(res.text);
  const sentAt = new Date().toISOString();
  const status = (reply.status || 'UNKNOWN').toUpperCase();

  if (status === 'ERROR' || status === 'FAIL' || status === 'FAILED') {
    throw new ReferenceCenterError(
      `Το κέντρο απέρριψε την παραγγελία: ${reply.message || reply.status}`,
      'CENTER_REJECTED'
    );
  }

  // Καταγραφή στο παραπεμπτικό
  const orders = Array.isArray((referral as any)[SENT_ORDERS_KEY])
    ? (referral as any)[SENT_ORDERS_KEY]
    : [];
  orders.push({
    centerId: center.id,
    centerName: center.name,
    orderNo: reply.orderNo || orderNo,
    lisOrderNo: reply.lisOrderNo,
    status,
    sentAt,
    tests: reply.tests.length > 0 ? reply.tests : tests.map(t => ({ code: t.code })),
  });

  const updated = await dbService.updateReferral(referral.id, {
    [SENT_ORDERS_KEY]: orders,
  } as any);

  return {
    centerId: center.id,
    centerName: center.name,
    orderNo: reply.orderNo || orderNo,
    status,
    lisOrderNo: reply.lisOrderNo,
    tests: reply.tests.length > 0 ? reply.tests : tests.map(t => ({ code: t.code })),
    sentAt,
    durationMs: Date.now() - started,
    requestXml,
    responseXml: res.text,
    referral: updated,
  };
}

// ── Άντληση αποτελεσμάτων (Infomed xml Web service — results) ──

export interface CenterResultField {
  name: string;
  result?: string;
  unit?: string;
  referenceRange?: string;
  abnormalStatus?: string;
  comment?: string;
  /** ResultType του XML (15 = LOINC) */
  resultType?: number;
  /** LOINC του πεδίου (αν το στέλνει το κέντρο με ResultType=15) */
  loincCode?: string;
}

export interface CenterResultTest {
  /** Κωδικός εξέτασης στο κέντρο (αντιστοιχεί στο <test> που στείλαμε) */
  code: string;
  fullName?: string;
  pageName?: string;
  fields: CenterResultField[];
  /** LOINC κωδικοί που έστειλε το κέντρο (ResultType=15) για αυτή την εξέταση */
  loincCodes?: string[];
}

export interface CenterResultsReply {
  orderId?: string;
  orderDate?: string;
  orderTime?: string;
  remarks?: string;
  tests: CenterResultTest[];
}

/** Αποκωδικοποίηση XML entities */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return undefined;
  const raw = decodeXml(m[1]).trim();
  return raw === '' ? undefined : raw;
}

/**
 * Parsing της απάντησης `<Results>`.
 * Κάθε `<Test>` είναι ένα πεδίο αποτελέσματος· ομαδοποιείται κατά `Name`
 * (κωδικός εξέτασης στο κέντρο).
 */
export function parseSlisResults(xml: string): CenterResultsReply {
  const tests: CenterResultTest[] = [];
  const byCode = new Map<string, CenterResultTest>();

  const blocks = xml.match(/<Test>[\s\S]*?<\/Test>/gi) || [];
  for (const block of blocks) {
    const code = tagText(block, 'Name');
    if (!code) continue;

    const rawResultType = Number(tagText(block, 'ResultType') || '1');
    // ResultType 15 = LOINC: η τιμή είναι ο κωδικός LOINC του πεδίου
    const loincValue =
      rawResultType === 15
        ? tagText(block, 'Result')
        : tagText(block, 'LoincCode') || tagText(block, 'LOINC');

    const field: CenterResultField = {
      name: tagText(block, 'FieldName') || tagText(block, 'FieldFullName') || code,
      result: rawResultType === 15 ? undefined : tagText(block, 'Result'),
      unit: tagText(block, 'Units'),
      referenceRange: tagText(block, 'NormalValues'),
      abnormalStatus: tagText(block, 'AbnormalStatus'),
      comment: tagText(block, 'Comment'),
      resultType: rawResultType,
      ...(loincValue ? { loincCode: loincValue } : {}),
    };
    let entry = byCode.get(code);
    if (!entry) {
      entry = {
        code,
        fullName: tagText(block, 'FullName'),
        pageName: tagText(block, 'PageName'),
        fields: [],
        loincCodes: [],
      };
      byCode.set(code, entry);
      tests.push(entry);
    }
    // LOINC σε επίπεδο εξέτασης (ResultType=15) → ισχύει για όλα τα πεδία
    if (loincValue && entry.loincCodes && !entry.loincCodes.includes(loincValue)) {
      entry.loincCodes.push(loincValue);
    }
    // Παράλειψη μη-αποτελεσματικών τύπων (μόνο μετά την καταγραφή LOINC)
    if ([7, 8, 9, 11, 12, 15].includes(rawResultType) && !field.result) continue;
    if (field.result !== undefined || field.loincCode) entry.fields.push(field);
  }

  return {
    orderId: tagText(xml, 'OrderID'),
    orderDate: tagText(xml, 'OrderDate'),
    orderTime: tagText(xml, 'OrderTime'),
    remarks: tagText(xml, 'Remarks'),
    tests,
  };
}

/** GET resultsUrl?HISOrder=<orderNo>&Token=<token> — χωρίς authentication */
async function fetchCenterResultsXml(
  center: ReferenceCenter,
  orderNo: string
): Promise<{ ok: true; text: string } | { ok: false; code: string; error: string; text?: string }> {
  const resultsUrl = String(center.config?.resultsUrl || '').trim();
  if (!resultsUrl) {
    return {
      ok: false,
      code: 'NO_RESULTS_URL',
      error:
        'Δεν έχει ρυθμιστεί διεύθυνση αποτελεσμάτων (RESULTS URL) — Ρυθμίσεις → Κέντρα Αναφοράς',
    };
  }
  // Το PASSWORD του <USER> είναι και το Token της κλήσης αποτελεσμάτων.
  const token = String(center.config?.password || center.config?.resultsToken || '').trim();
  const sep = resultsUrl.includes('?') ? '&' : '?';
  const url =
    `${resultsUrl}${sep}HISOrder=${encodeURIComponent(orderNo)}` +
    (token ? `&Token=${encodeURIComponent(token)}` : '');

  const timeout = Number(process.env.REFERENCE_CENTER_TIMEOUT_MS) || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'text/xml,application/xml' } });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        code: `HTTP_${res.status}`,
        error: `Το κέντρο απάντησε με HTTP ${res.status}`,
        text: text.slice(0, 300),
      };
    }
    return { ok: true, text };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted
        ? `Το κέντρο δεν απάντησε εντός ${timeout / 1000}s`
        : `Σφάλμα δικτύου: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchCenterResultsOutcome {
  centerId: string;
  centerName: string;
  orderNo: string;
  /** Πόσες εξετάσεις του κέντρου επιστράφηκαν */
  resultTests: number;
  /** Πόσες εξετάσεις της εφαρμογής ενημερώθηκαν */
  updatedExams: number;
  /** Πόσοι δείκτες γράφτηκαν */
  indicators: number;
  /** Εξετάσεις κέντρου που δεν αντιστοιχίστηκαν σε εξέταση της εφαρμογής */
  unmatched: string[];
  fetchedAt: string;
  message: string;
  exams: Exam[];
}

/** Κανονικοποίηση ονόματος για αντιστοίχιση (πεζά, χωρίς τόνους/σύμβολα) */
function normalizeName(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9α-ω]/g, '');
}

/**
 * Βρίσκει την υπάρχουσα παράμετρο που αντιστοιχεί σε πεδίο αποτελέσματος.
 * Σειρά: LOINC → ακριβές όνομα → μερική αντιστοίχιση.
 */
function matchParameter(
  params: Array<{ name: string; loincNum?: string }>,
  field: CenterResultField
): number {
  const fieldLoinc = String(field.loincCode || '').trim();
  if (fieldLoinc) {
    const byLoinc = params.findIndex(p => String(p.loincNum || '').trim() === fieldLoinc);
    if (byLoinc !== -1) return byLoinc;
  }

  const target = normalizeName(field.name);
  if (!target) return -1;

  const exact = params.findIndex(p => normalizeName(p.name) === target);
  if (exact !== -1) return exact;

  return params.findIndex(p => {
    const pn = normalizeName(p.name);
    return pn.length >= 3 && (pn.includes(target) || target.includes(pn));
  });
}

/**
 * Άντληση αποτελεσμάτων από το κέντρο που εκτέλεσε την παραγγελία και
 * εγγραφή τους στις εξετάσεις της εφαρμογής (μέσω `exam.sentToCenter.code`).
 */
export async function fetchResultsFromCenter(
  centerId: string,
  referralId: string
): Promise<FetchCenterResultsOutcome> {
  const center = await dbService.getReferenceCenter(centerId);
  if (!center) throw new ReferenceCenterError('Το κέντρο αναφοράς δεν βρέθηκε', 'CENTER_NOT_FOUND');

  const referral = await dbService.getReferral(referralId);
  if (!referral) throw new ReferenceCenterError('Το παραπεμπτικό δεν βρέθηκε', 'REFERRAL_NOT_FOUND');

  const orders: any[] = Array.isArray((referral as any)[SENT_ORDERS_KEY])
    ? (referral as any)[SENT_ORDERS_KEY]
    : [];
  const lastOrder = [...orders].reverse().find(o => o.centerId === centerId);
  if (!lastOrder?.orderNo) {
    throw new ReferenceCenterError(
      'Δεν υπάρχει απεσταλμένη παραγγελία για αυτό το κέντρο',
      'NO_SENT_ORDER'
    );
  }

  const res = await fetchCenterResultsXml(center, String(lastOrder.orderNo));
  if (!res.ok) {
    throw new ReferenceCenterError(
      `${res.error}${res.text ? ` — ${res.text}` : ''}`,
      res.code
    );
  }

  const reply = parseSlisResults(res.text);
  if (reply.tests.length === 0) {
    return {
      centerId: center.id,
      centerName: center.name,
      orderNo: String(lastOrder.orderNo),
      resultTests: 0,
      updatedExams: 0,
      indicators: 0,
      unmatched: [],
      fetchedAt: new Date().toISOString(),
      message: 'Το κέντρο δεν έχει επιστρέψει ακόμη αποτελέσματα',
      exams: await dbService.listExams(referralId),
    };
  }

  const exams = await dbService.listExams(referralId);
  const unmatched: string[] = [];
  let updatedExams = 0;
  let indicators = 0;
  let skippedCompleted = 0;

  // Reverse LOINC mapping για τα αποτελέσματα που δεν έχουν sentToCenter.code
  const microLoincs = await dbService.findLoincsByMicroCodes(reply.tests.map(t => t.code));

  /** Εύρεση εξέτασης: πρώτα sentToCenter.code, μετά μέσω LOINC */
  const resolveTarget = (testCode: string): Exam | undefined => {
    const byCode = exams.find(
      e => String((e as any).sentToCenter?.code || '').toLowerCase() === testCode.toLowerCase()
    );
    if (byCode) return byCode;

    const loincs = microLoincs.get(testCode) || [];
    if (loincs.length === 0) return undefined;

    // Εξέταση της εφαρμογής που μοιράζεται κάποιο από αυτά τα LOINC
    return exams.find(e => {
      const candidates = examLoincCandidates(e).map(c => c.toLowerCase());
      return loincs.some(l => candidates.includes(l.toLowerCase()));
    });
  };

  for (const test of reply.tests) {
    const target = resolveTarget(test.code);
    if (!target) {
      unmatched.push(test.code);
      continue;
    }

    // Ολοκληρωμένες εξετάσεις δεν ξαναενημερώνονται
    if (String(target.status) === 'completed') {
      skippedCompleted++;
      continue;
    }

    const existing = Array.isArray(target.parameters) ? target.parameters : [];
    const valueFields = test.fields.filter(f => (f.result ?? '').trim() !== '');
    // LOINC σε επίπεδο εξέτασης — εφαρμόζεται σε πεδία χωρίς δικό τους LOINC
    const testLoinc =
      test.loincCodes && test.loincCodes.length === 1 ? test.loincCodes[0] : undefined;
    // LOINC ανά πεδίο από το exam_micro (name_field → loinc)
    const fieldLoincs = await dbService.findMicroFieldLoincs(test.code);

    if (existing.length > 0) {
      // Διατήρηση των ήδη καταχωρημένων παραμέτρων· συμπλήρωση μόνο της τιμής
      // στη παράμετρο που αντιστοιχεί (LOINC → όνομα). Ό,τι δεν αντιστοιχεί,
      // αγνοείται.
      let filled = 0;
      const mergedParams = existing.map(p => ({ ...p }));

      for (const field of valueFields) {
        // 1) LOINC από το κέντρο (πεδίο ή επίπεδο εξέτασης)
        let idx = -1;
        const explicitLoinc = field.loincCode || testLoinc;
        if (explicitLoinc) {
          idx = matchParameter(mergedParams, { ...field, loincCode: explicitLoinc });
        }

        // 2) LOINC από τον πίνακα exam_micro για το πεδίο (name_field)
        if (idx === -1) {
          const mapped = fieldLoincs.find(
            fl =>
              normalizeName(fl.field) === normalizeName(field.name) ||
              normalizeName(fl.field) === normalizeName(test.code)
          );
          if (mapped) idx = matchParameter(mergedParams, { ...field, loincCode: mapped.loinc });
        }

        // 3) Αντιστοίχιση με βάση το όνομα
        if (idx === -1) idx = matchParameter(mergedParams, field);

        if (idx === -1) continue; // μη αντιστοιχισμένη παράμετρος → εξαιρείται

        const p = mergedParams[idx];
        mergedParams[idx] = {
          ...p,
          result: field.result!,
          ...(p.unit ? {} : field.unit ? { unit: field.unit } : {}),
          ...(p.referenceRange ? {} : field.referenceRange ? { referenceRange: field.referenceRange } : {}),
        };
        filled++;
      }

      if (filled === 0) continue;

      await dbService.updateExam(target.id, {
        parameters: mergedParams,
        // Διατήρηση LOINC
        ...((target as any).loincCode
          ? {}
          : (target as any).sentToCenter?.loincCode
          ? { loincCode: (target as any).sentToCenter.loincCode }
          : {}),
        status: 'completed' as any,
        examDate: reply.orderDate || target.examDate,
        notes: [
          (target.notes || '').split(' · ').filter(p => p && !p.startsWith('Αποτέλεσμα κέντρου:')).join(' · '),
          `Αποτέλεσμα κέντρου: ${center.name} (${reply.orderDate || ''})`,
        ]
          .filter(Boolean)
          .join(' · '),
      } as any);

      updatedExams++;
      indicators += filled;
      continue;
    }

    // Εξέταση χωρίς παραμέτρους → απλή τιμή από το πρώτο πεδίο
    if (valueFields.length === 0) continue;
    const first = valueFields[0];

    await dbService.updateExam(target.id, {
      result: first.result,
      ...(first.unit ? { unit: first.unit } : {}),
      ...(first.referenceRange ? { referenceRange: first.referenceRange } : {}),
      ...((target as any).loincCode
        ? {}
        : (target as any).sentToCenter?.loincCode
        ? { loincCode: (target as any).sentToCenter.loincCode }
        : {}),
      status: 'completed' as any,
      examDate: reply.orderDate || target.examDate,
      notes: [
        (target.notes || '').split(' · ').filter(p => p && !p.startsWith('Αποτέλεσμα κέντρου:')).join(' · '),
        `Αποτέλεσμα κέντρου: ${center.name} (${reply.orderDate || ''})`,
      ]
        .filter(Boolean)
        .join(' · '),
    } as any);

    updatedExams++;
    indicators += 1;
  }

  return {
    centerId: center.id,
    centerName: center.name,
    orderNo: String(lastOrder.orderNo),
    resultTests: reply.tests.length,
    updatedExams,
    indicators,
    unmatched,
    fetchedAt: new Date().toISOString(),
    message:
      updatedExams > 0
        ? `Αντλήθηκαν αποτελέσματα για ${updatedExams} εξετάσεις (${indicators} δείκτες) από «${center.name}»` +
          (unmatched.length > 0 ? ` · χωρίς αντιστοίχιση: ${unmatched.join(', ')}` : '')
        : skippedCompleted > 0
        ? `Δεν υπάρχουν νέα αποτελέσματα — ${skippedCompleted} εξετάσεις είναι ήδη ολοκληρωμένες`
        : `Βρέθηκαν αποτελέσματα αλλά δεν αντιστοιχίστηκαν σε εξετάσεις της εφαρμογής` +
          (unmatched.length > 0 ? ` (κωδικοί κέντρου: ${unmatched.join(', ')})` : ''),
    exams: await dbService.listExams(referralId),
  };
}

/**
 * Προεπισκόπηση: ποιες εξετάσεις θα σταλθούν και ποιες δεν αντιστοιχίζονται.
 * Χρήσιμο για τη φόρμα παραπεμπτικού πριν την αποστολή.
 */
export async function previewCenterSend(
  centerId: string,
  referralId: string,
  examIds?: string[],
  choices?: Record<string, string>
): Promise<{
  center: ReferenceCenter;
  tests: SlisTest[];
  unmapped: UnmappedExam[];
  ambiguous: AmbiguousExam[];
  alreadySent: any[];
}> {
  const center = await dbService.getReferenceCenter(centerId);
  if (!center) {
    throw new ReferenceCenterError('Το κέντρο αναφοράς δεν βρέθηκε', 'CENTER_NOT_FOUND');
  }
  const referral = await dbService.getReferral(referralId);
  if (!referral) {
    throw new ReferenceCenterError('Το παραπεμπτικό δεν βρέθηκε', 'REFERRAL_NOT_FOUND');
  }

  const exams = await dbService.listExams(referralId);
  const { tests, unmapped, ambiguous } = await resolveSlisTests(exams, examIds, choices);
  const alreadySent = Array.isArray((referral as any)[SENT_ORDERS_KEY])
    ? (referral as any)[SENT_ORDERS_KEY]
    : [];

  return { center, tests, unmapped, ambiguous, alreadySent };
}
