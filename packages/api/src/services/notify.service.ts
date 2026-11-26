// ============================================================
// Notify service — email & SMS μέσω Brevo
//
// Χρησιμοποιείται από τις υπενθυμίσεις ραντεβού (και ό,τι άλλο χρειάζεται
// αποστολή). Όλα τα credentials διαβάζονται από το περιβάλλον του API.
//
//   BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, SMS_SENDER, SMS_ENABLED
// ============================================================

const BREVO_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_SMS_URL = 'https://api.brevo.com/v3/transactionalSMS/sms';

function env(key: string, fallback = ''): string {
  return (process.env[key] || fallback).trim();
}

export function isEmailConfigured(): boolean {
  return Boolean(env('BREVO_API_KEY') && env('SENDER_EMAIL'));
}

export function isSmsConfigured(): boolean {
  return isEmailConfigured() && env('SMS_ENABLED', 'true').toLowerCase() !== 'false';
}

/** Κανονικοποίηση ελληνικού τηλεφώνου σε E.164. */
export function normalizePhone(raw?: string | null): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;

  let digits = value.replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (digits.startsWith('+')) {
    return /^\+\d{8,15}$/.test(digits) ? digits : null;
  }

  const d = digits.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) return `+30${d.slice(1)}`;
  if (d.length === 10) return `+30${d}`;
  if (d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

export async function sendEmail(input: {
  to: string;
  toName?: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = env('BREVO_API_KEY');
  const senderEmail = env('SENDER_EMAIL');
  if (!apiKey || !senderEmail) {
    throw new Error('Το email δεν είναι ρυθμισμένο (BREVO_API_KEY / SENDER_EMAIL)');
  }

  const response = await fetch(BREVO_EMAIL_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: env('SENDER_NAME', 'Medisend') },
      to: [{ email: input.to, name: input.toName || input.to }],
      subject: input.subject,
      htmlContent: input.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo email ${response.status}: ${body.slice(0, 200)}`);
  }
}

export async function sendSms(recipient: string, content: string): Promise<void> {
  const apiKey = env('BREVO_API_KEY');
  const sender = env('SMS_SENDER', 'Medisend').slice(0, 11);
  if (!apiKey) {
    throw new Error('Το SMS δεν είναι ρυθμισμένο (BREVO_API_KEY)');
  }

  const response = await fetch(BREVO_SMS_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender,
      recipient,
      content: content.slice(0, 160),
      type: 'transactional',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo SMS ${response.status}: ${body.slice(0, 200)}`);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function wrapEmail(title: string, body: string): string {
  return `<!doctype html><html lang="el"><body style="margin:0;background:#f1f5f9;padding:24px;font-family:'Helvetica Neue',Arial,sans-serif">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden">
    <tr><td style="background:#0072ce;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:700">Medisend</td></tr>
    <tr><td style="padding:22px">
      <h1 style="margin:0 0 14px;font-size:19px;color:#0f172a">${escapeHtml(title)}</h1>
      ${body}
    </td></tr>
    <tr><td style="padding:14px 24px;background:#f8fafc;color:#94a3b8;font-size:12px">
      Αυτό το email στάλθηκε αυτόματα για το ραντεβού σας.
    </td></tr>
  </table>
</body></html>`;
}
