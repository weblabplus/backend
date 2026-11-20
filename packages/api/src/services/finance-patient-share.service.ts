// ============================================================
// Συμμετοχή ασθενούς → απαίτηση στο Ταμείο
//
// Όταν καταχωρείται/εκτελείται παραπεμπτικό e-Prescription, το ποσό
// συμμετοχής του ασφαλισμένου (participationPercentAmt ανά γραμμή)
// δημιουργεί μία απαίτηση (receivable) από τον ασθενή.
// Idempotent: μία κίνηση ανά παραπεμπτικό.
// ============================================================

import {
  dbService,
  financeStatusFromAmounts,
  type FinanceEntry,
  type FinanceEntrySource,
} from '../db/db.service';

/** Στοιχείο ανάλυσης συμμετοχής ανά εξέταση */
export interface PatientShareLine {
  name: string;
  /** Ποσό συμμετοχής ασθενούς */
  participation?: number;
  /** Τιμή εκτέλεσης/συνταγογράφησης */
  price?: number;
}

export interface PatientShareInput {
  referralId: string;
  referralBarcode?: string;
  patientId: string;
  patientName?: string;
  /** Συνολικό ποσό συμμετοχής (αθροίζεται όταν δίνονται lines) */
  amount?: number;
  lines?: PatientShareLine[];
  issueDate?: string;
  doctorId?: string;
  /** Τρόπος εκτέλεσης για το ιστορικό της κίνησης */
  executionNo?: string;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Σταθερό id κίνησης ανά παραπεμπτικό → αποφυγή διπλοεγγραφών */
export function patientShareEntryId(referralId: string): string {
  return `finance_share_${referralId}`;
}

/** Σταθερό id απαίτησης αποζημίωσης από τον φορέα ανά παραπεμπτικό */
export function payerReimbursementEntryId(referralId: string): string {
  return `finance_reimbursement_${referralId}`;
}

/** Προεπιλεγμένη επωνυμία όταν ο φορέας δεν δίνει ονομασία ασφαλιστικού ταμείου */
const DEFAULT_PAYER_NAME = 'Ασφαλιστικός φορέας (ΕΟΠΥΥ)';

/** Άθροισμα συμμετοχής από τις γραμμές εξετάσεων */
export function sumParticipation(lines?: PatientShareLine[]): number {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  return round2(
    lines.reduce((sum, line) => sum + (Number(line.participation) || 0), 0)
  );
}

function buildNotes(input: PatientShareInput, amount: number): string | undefined {
  const lines = (input.lines || []).filter(line => (line.participation || 0) > 0);
  const parts: string[] = [];

  if (input.referralBarcode) parts.push(`Παραπεμπτικό ${input.referralBarcode}`);
  if (lines.length > 0) {
    parts.push(
      'Ανάλυση: ' +
        lines
          .map(line => `${line.name} ${round2(Number(line.participation) || 0).toFixed(2)} €`)
          .join(' · ')
    );
  }
  if ((input.lines || []).length > 0 && lines.length === 0) {
    parts.push('Δεν δίνεται ανάλυση συμμετοχής από τον φορέα');
  }
  if (input.executionNo) parts.push(`executionNo ${input.executionNo}`);
  parts.push(`Σύνολο συμμετοχής ${amount.toFixed(2)} €`);

  return parts.join(' · ');
}

/**
 * Δημιουργεί ή ενημερώνει την απαίτηση συμμετοχής του ασθενούς.
 * Επιστρέφει null όταν δεν υπάρχει ποσό συμμετοχής.
 */
export async function upsertPatientShareReceivable(
  input: PatientShareInput
): Promise<FinanceEntry | null> {
  const linesTotal = sumParticipation(input.lines);
  const amount = round2(linesTotal > 0 ? linesTotal : Number(input.amount) || 0);

  if (!input.referralId || !input.patientId || !(amount > 0)) return null;

  const id = patientShareEntryId(input.referralId);
  const existing = await dbService.getFinanceEntry(id);
  const now = new Date().toISOString();
  const issueDate = input.issueDate || now.slice(0, 10);
  const description = `Συμμετοχή ασθενούς${
    input.referralBarcode ? ` — ${input.referralBarcode}` : ''
  }`;
  const notes = buildNotes(input, amount);

  const source: FinanceEntrySource = {
    system: 'e-prescription',
    documentId: input.referralBarcode,
    totalAmount: amount,
  };

  if (existing) {
    // Δεν μειώνουμε ποσό κάτω από ό,τι έχει ήδη εισπραχθεί
    const nextAmount = Math.max(amount, existing.paidAmount);
    const updated: FinanceEntry = {
      ...existing,
      amount: nextAmount,
      description,
      notes: existing.notes || notes,
      issueDate: existing.issueDate || issueDate,
      source,
      status: financeStatusFromAmounts({
        amount: nextAmount,
        paidAmount: existing.paidAmount,
        status: existing.status,
      }),
      updatedAt: now,
    };
    await dbService.saveFinanceEntry(updated);
    return updated;
  }

  const entry: FinanceEntry = {
    id,
    direction: 'receivable',
    partyType: 'patient',
    partyId: input.patientId,
    partyName: input.patientName || 'Ασθενής',
    patientId: input.patientId,
    patientName: input.patientName,
    referralId: input.referralId,
    referralBarcode: input.referralBarcode,
    description,
    amount,
    paidAmount: 0,
    status: financeStatusFromAmounts({ amount, paidAmount: 0 }),
    issueDate,
    notes,
    payments: [],
    source,
    doctorId: input.doctorId,
    createdAt: now,
    updatedAt: now,
  };

  await dbService.saveFinanceEntry(entry);
  return entry;
}

/**
 * Ακυρώνει την απαίτηση συμμετοχής όταν ακυρώνεται η εκτέλεση.
 * Αν έχει ήδη εισπραχθεί ποσό, η κίνηση παραμένει ως έχει.
 */
export async function cancelPatientShareReceivable(referralId: string): Promise<boolean> {
  return cancelReceivable(patientShareEntryId(referralId));
}

/** Κοινή λογική ακύρωσης απαίτησης (αν δεν έχει εισπραχθεί ποσό) */
async function cancelReceivable(entryId: string): Promise<boolean> {
  const existing = await dbService.getFinanceEntry(entryId);
  if (!existing) return false;
  if ((Number(existing.paidAmount) || 0) > 0) return false;

  await dbService.updateFinanceEntry(entryId, { status: 'cancelled' });
  return true;
}

export interface PayerReimbursementInput {
  referralId: string;
  referralBarcode?: string;
  /** Επωνυμία φορέα (ή προεπιλογή) */
  payerName?: string;
  /** Ασφαλιστικός φορέας από το Coverage (Social Insurance Id) */
  insuranceId?: string;
  /** Γραμμές εξετάσεων — η αποζημίωση υπολογίζεται ως τιμή − συμμετοχή */
  lines?: PatientShareLine[];
  /** Εναλλακτικά, έτοιμο ποσό αποζημίωσης */
  amount?: number;
  issueDate?: string;
  doctorId?: string;
  executionNo?: string;
}

/** Αποζημίωση φορέα ανά γραμμή: τιμή εκτέλεσης − συμμετοχή ασθενούς */
export function sumReimbursement(lines?: PatientShareLine[]): number {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  return round2(
    lines.reduce((sum, line) => {
      const price = Number(line.price) || 0;
      const participation = Number(line.participation) || 0;
      if (price <= 0) return sum;
      return sum + Math.max(0, price - participation);
    }, 0)
  );
}

/**
 * Δημιουργεί ή ενημερώνει την απαίτηση αποζημίωσης από τον ασφαλιστικό φορέα.
 * Idempotent: μία κίνηση ανά παραπεμπτικό.
 */
export async function upsertPayerReimbursementReceivable(
  input: PayerReimbursementInput
): Promise<FinanceEntry | null> {
  const linesTotal = sumReimbursement(input.lines);
  const amount = round2(linesTotal > 0 ? linesTotal : Number(input.amount) || 0);

  if (!input.referralId || !(amount > 0)) return null;

  const id = payerReimbursementEntryId(input.referralId);
  const existing = await dbService.getFinanceEntry(id);
  const now = new Date().toISOString();
  const issueDate = input.issueDate || now.slice(0, 10);
  const payerName = (input.payerName || '').trim() || DEFAULT_PAYER_NAME;
  const description = `Αποζημίωση φορέα${
    input.referralBarcode ? ` — ${input.referralBarcode}` : ''
  }`;

  const coveredLines = (input.lines || []).filter(
    line => (Number(line.price) || 0) > 0
  );
  const noteParts: string[] = [];
  if (input.referralBarcode) noteParts.push(`Παραπεμπτικό ${input.referralBarcode}`);
  if (input.insuranceId) noteParts.push(`Ασφ. φορέας #${input.insuranceId}`);
  if (coveredLines.length > 0) {
    noteParts.push(
      'Ανάλυση: ' +
        coveredLines
          .map(line => {
            const price = Number(line.price) || 0;
            const participation = Number(line.participation) || 0;
            return `${line.name} ${Math.max(0, price - participation).toFixed(2)} €`;
          })
          .join(' · ')
    );
  }
  if (input.executionNo) noteParts.push(`executionNo ${input.executionNo}`);
  noteParts.push(`Σύνολο αποζημίωσης ${amount.toFixed(2)} €`);

  const source: FinanceEntrySource = {
    system: 'e-prescription',
    documentId: input.referralBarcode,
    totalAmount: amount,
  };

  if (existing) {
    const nextAmount = Math.max(amount, existing.paidAmount);
    const updated: FinanceEntry = {
      ...existing,
      partyType: 'payer',
      partyId: input.insuranceId || existing.partyId,
      partyName: payerName,
      amount: nextAmount,
      description,
      notes: existing.notes || noteParts.join(' · '),
      issueDate: existing.issueDate || issueDate,
      source,
      status: financeStatusFromAmounts({
        amount: nextAmount,
        paidAmount: existing.paidAmount,
        status: existing.status,
      }),
      updatedAt: now,
    };
    await dbService.saveFinanceEntry(updated);
    return updated;
  }

  const entry: FinanceEntry = {
    id,
    direction: 'receivable',
    partyType: 'payer',
    partyId: input.insuranceId,
    partyName: payerName,
    referralId: input.referralId,
    referralBarcode: input.referralBarcode,
    description,
    amount,
    paidAmount: 0,
    status: financeStatusFromAmounts({ amount, paidAmount: 0 }),
    issueDate,
    notes: noteParts.join(' · '),
    payments: [],
    source,
    doctorId: input.doctorId,
    createdAt: now,
    updatedAt: now,
  };

  await dbService.saveFinanceEntry(entry);
  return entry;
}

/** Ακυρώνει την απαίτηση αποζημίωσης από τον φορέα */
export async function cancelPayerReimbursementReceivable(referralId: string): Promise<boolean> {
  return cancelReceivable(payerReimbursementEntryId(referralId));
}
