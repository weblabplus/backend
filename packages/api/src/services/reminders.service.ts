// ============================================================
// Υπενθυμίσεις ραντεβού
//
//  • ~24 ώρες πριν  → email + SMS
//  • ~3 ώρες πριν   → email
//
// Η εκτέλεση γίνεται από εξωτερικό scheduler (GitHub Actions / Render Cron)
// μέσω του POST /api/reminders/run. Είναι idempotent: κάθε αποστολή
// σημαδεύεται στο appointment.reminders ώστε να μην ξανασταλεί.
// ============================================================

import type { Appointment, Patient } from '@medilab/core';
import { dbService } from '../db/db.service';
import {
  escapeHtml,
  isEmailConfigured,
  isSmsConfigured,
  normalizePhone,
  sendEmail,
  sendSms,
  wrapEmail,
} from './notify.service';

const DAY_BEFORE_LABEL = 'Αύριο έχετε ραντεβού';
const THREE_HOURS_LABEL = 'Το ραντεβού σας σε λίγες ώρες';

export interface ReminderRunResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  details: Array<{ appointmentId: string; window: 'day' | 'hours'; email?: boolean; sms?: boolean; error?: string }>;
}

const DATE_TIME = new Intl.DateTimeFormat('el-GR', {
  timeZone: 'Europe/Athens',
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const SHORT_DATE_TIME = new Intl.DateTimeFormat('el-GR', {
  timeZone: 'Europe/Athens',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATE_TIME.format(date);
}

function formatShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return SHORT_DATE_TIME.format(date);
}

function detailsHtml(appointment: Appointment): string {
  const rows: Array<[string, string | undefined]> = [
    ['Ημερομηνία & ώρα', formatWhen(appointment.scheduledAt)],
    ['Λόγος', appointment.reason],
    ['Διάρκεια', appointment.durationMinutes ? `${appointment.durationMinutes} λεπτά` : undefined],
  ];

  return rows
    .filter(([, value]) => Boolean(value))
    .map(
      ([label, value]) =>
        `<tr><td style="padding:5px 14px 5px 0;color:#64748b;white-space:nowrap">${escapeHtml(
          label
        )}</td><td style="padding:5px 0;color:#0f172a;font-weight:600">${escapeHtml(
          String(value)
        )}</td></tr>`
    )
    .join('');
}

function buildEmail(appointment: Appointment, window: 'day' | 'hours'): { subject: string; html: string } {
  const when = formatWhen(appointment.scheduledAt);
  const name = appointment.patientName || 'σας';
  const rows = detailsHtml(appointment);

  if (window === 'day') {
    return {
      subject: `Υπενθύμιση ραντεβού — ${when}`,
      html: wrapEmail(
        DAY_BEFORE_LABEL,
        `<p style="margin:0 0 14px;color:#334155;line-height:1.6">Γεια σας ${escapeHtml(
          name
        )}, σας υπενθυμίζουμε το ραντεβού σας για αύριο.</p>
         <table role="presentation" style="font-size:14px">${rows}</table>
         <p style="margin:16px 0 0;color:#64748b;font-size:13px">Αν δεν μπορείτε να έρθετε, επικοινωνήστε μαζί μας.</p>`
      ),
    };
  }

  return {
    subject: `Το ραντεβού σας σε 3 ώρες — ${when}`,
    html: wrapEmail(
      THREE_HOURS_LABEL,
      `<p style="margin:0 0 14px;color:#334155;line-height:1.6">Γεια σας ${escapeHtml(
        name
      )}, το ραντεβού σας είναι σε περίπου 3 ώρες.</p>
       <table role="presentation" style="font-size:14px">${rows}</table>
       <p style="margin:16px 0 0;color:#64748b;font-size:13px">Σας περιμένουμε.</p>`
    ),
  };
}

function buildSms(appointment: Appointment): string {
  const first = (appointment.patientName || '').split(/\s+/)[0] || '';
  return `Medisend: ${first ? first + ', ' : ''}υπενθύμιση ραντεβού αύριο ${formatShort(
    appointment.scheduledAt
  )}.`.slice(0, 160);
}

async function resolveContact(appointment: Appointment): Promise<{ email?: string; phone?: string }> {
  if (!appointment.patientId) return {};
  const patient: Patient | null = await dbService.getPatient(appointment.patientId);
  if (!patient) return {};
  return { email: patient.email, phone: patient.phone };
}

/**
 * Εκτελεί όλες τις υπενθυμίσεις που «πέφτουν» στο τρέχον παράθυρο.
 * Τα παράθυρα είναι ±30′ ώστε να αντέχουν σε cron κάθε 15-30 λεπτά.
 */
export async function runAppointmentReminders(now = new Date()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { scanned: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  if (!isEmailConfigured() && !isSmsConfigured()) {
    throw new Error(
      'Οι υπενθυμίσεις δεν είναι ρυθμισμένες (λείπουν BREVO_API_KEY / SENDER_EMAIL)'
    );
  }

  const windowMs = 30 * 60 * 1000;
  const dayFrom = new Date(now.getTime() + 24 * 3600 * 1000 - windowMs);
  const dayTo = new Date(now.getTime() + 24 * 3600 * 1000 + windowMs);
  const hoursFrom = new Date(now.getTime() + 3 * 3600 * 1000 - windowMs);
  const hoursTo = new Date(now.getTime() + 3 * 3600 * 1000 + windowMs);

  const [dayCandidates, hoursCandidates] = await Promise.all([
    dbService.listAppointments({
      from: dayFrom.toISOString(),
      to: dayTo.toISOString(),
      status: 'scheduled',
    }),
    dbService.listAppointments({
      from: hoursFrom.toISOString(),
      to: hoursTo.toISOString(),
      status: 'scheduled',
    }),
  ]);

  result.scanned = dayCandidates.length + hoursCandidates.length;

  for (const appointment of dayCandidates) {
    if (appointment.reminders?.dayBeforeAt) {
      result.skipped += 1;
      continue;
    }

    const contact = await resolveContact(appointment);
    const entry: ReminderRunResult['details'][number] = {
      appointmentId: appointment.id,
      window: 'day',
    };
    let anySent = false;

    if (contact.email && isEmailConfigured()) {
      try {
        const mail = buildEmail(appointment, 'day');
        await sendEmail({ to: contact.email, toName: appointment.patientName, ...mail });
        entry.email = true;
        anySent = true;
      } catch (error: any) {
        entry.error = error?.message || 'email error';
      }
    }

    const phone = normalizePhone(contact.phone);
    if (phone && isSmsConfigured()) {
      try {
        await sendSms(phone, buildSms(appointment));
        entry.sms = true;
        anySent = true;
      } catch (error: any) {
        entry.error = `${entry.error ? entry.error + ' · ' : ''}${error?.message || 'sms error'}`;
      }
    }

    if (anySent) {
      await dbService.updateAppointment(appointment.id, {
        reminders: { ...appointment.reminders, dayBeforeAt: now.toISOString() },
      });
      result.sent += 1;
    } else {
      result.failed += 1;
    }
    result.details.push(entry);
  }

  for (const appointment of hoursCandidates) {
    if (appointment.reminders?.threeHoursBeforeAt) {
      result.skipped += 1;
      continue;
    }

    const contact = await resolveContact(appointment);
    const entry: ReminderRunResult['details'][number] = {
      appointmentId: appointment.id,
      window: 'hours',
    };
    let sent = false;

    if (contact.email && isEmailConfigured()) {
      try {
        const mail = buildEmail(appointment, 'hours');
        await sendEmail({ to: contact.email, toName: appointment.patientName, ...mail });
        entry.email = true;
        sent = true;
      } catch (error: any) {
        entry.error = error?.message || 'email error';
      }
    }

    if (sent) {
      await dbService.updateAppointment(appointment.id, {
        reminders: { ...appointment.reminders, threeHoursBeforeAt: now.toISOString() },
      });
      result.sent += 1;
    } else {
      result.failed += 1;
    }
    result.details.push(entry);
  }

  return result;
}
