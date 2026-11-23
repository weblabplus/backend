import type { CorsOptions } from 'cors';

/**
 * Έλεγχος επιτρεπόμενων browser origins (CORS + Better Auth trustedOrigins).
 *
 * Διαβάζεται από `CORS_ORIGIN` ή `WEB_ORIGIN` (comma-separated), π.χ.
 *   CORS_ORIGIN=https://frontend-woad-xi-87.vercel.app,https://*.vercel.app
 * Υποστηρίζονται wildcards (`*`) για Vercel preview deployments.
 * Αν δεν έχει οριστεί τίποτα, επιτρέπονται όλα (συμπεριφορά παλιάς `cors()`).
 */

const LOCAL_HOST = /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/;
const PRIVATE_HOST =
  /^(https?:\/\/)(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

function parseOrigins(value?: string): string[] {
  return (value || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** Τα ρυθμισμένα origins/patterns (χωρίς το baseURL του API). */
export function getAllowedOrigins(): string[] {
  return [...parseOrigins(process.env.CORS_ORIGIN), ...parseOrigins(process.env.WEB_ORIGIN)];
}

/**
 * Υπάρχει τουλάχιστον ένα origin που δεν είναι localhost;
 * Αν όχι, το deployment δεν έχει ρυθμιστεί για production (π.χ. έμεινε η τιμή του
 * .env.example) και ένα allowlist με σκέτο localhost θα έσπαγε το site.
 */
export function hasPublicOrigin(): boolean {
  return getAllowedOrigins().some(pattern => pattern !== '*' && !LOCAL_HOST.test(pattern));
}

/** Τρέχει σε deployed περιβάλλον (Render ή production build); */
export function isDeployed(): boolean {
  return Boolean(process.env.RENDER || process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

export function isLocalConfigLeaked(): boolean {
  return isDeployed() && looksLikeLeftoverLocalConfig();
}

/**
 * Χρησιμοποιήθηκε η τιμή του `.env.local` αντί για τις Environment Variables;
 * Το Render δέχεται `http://192.168.x.x` / `http://<public-ip>` ως valid URL, οπότε ένα
 * τυχαίο localhost/LAN origin από το αρχείο είναι ύποπτο για σε deployed instance.
 */
function looksLikeLeftoverLocalConfig(): boolean {
  if (!isDeployed()) return false;
  const origins = getAllowedOrigins();
  const authUrl = (process.env.BETTER_AUTH_URL || '').trim();

  if (authUrl && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(authUrl)) {
    return true;
  }

  return origins.length > 0 && origins.every(origin => LOCAL_HOST.test(origin) || PRIVATE_HOST.test(origin));
}

function matchesPattern(origin: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return origin === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

export function isOriginAllowed(origin?: string): boolean {
  // Χωρίς Origin header (curl, server-to-server, health checks) → επιτρέπεται.
  if (!origin) return true;

  const allowed = getAllowedOrigins();
  if (allowed.length === 0) return true; // χωρίς ρύθμιση → όπως πριν
  if (allowed.some(pattern => matchesPattern(origin, pattern))) return true;

  // Τοπική ανάπτυξη από LAN IP (π.χ. δοκιμή από κινητό).
  if (process.env.NODE_ENV !== 'production' && (LOCAL_HOST.test(origin) || PRIVATE_HOST.test(origin))) {
    return true;
  }

  // Deployed instance με ρυθμίσεις που μυρίζουν localhost (.env.local) → επιτρέπουμε
  // (με warning) όπως η παλιά `cors()`, ώστε να μη σπάει το site.
  if (isDeployed() && (looksLikeLeftoverLocalConfig() || !hasPublicOrigin())) {
    return true;
  }

  return false;
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    const allowed = isOriginAllowed(origin);
    if (!allowed) {
      console.warn(`⚠️  CORS blocked origin: ${origin}`);
    }
    callback(null, allowed);
  },
  credentials: true,
};

/** Για το `trustedOrigins` του Better Auth (origin του frontend + previews). */
export function getTrustedOrigins(baseURL: string): string[] {
  const configured = getAllowedOrigins();

  // Τοπική ανάπτυξη: το frontend μπορεί να ανοίξει από localhost, 127.0.0.1 ή LAN IP.
  if (!isDeployed()) {
    return [
      ...new Set([
        ...configured,
        baseURL,
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
      ]),
    ];
  }

  // Deployed instance με ρυθμίσεις που μυρίζουν localhost (.env.local) → επιτρέπουμε
  // τα Vercel deployments ώστε να μη σπάει το login/logout.
  if (looksLikeLeftoverLocalConfig() || !hasPublicOrigin()) {
    return [...new Set([...configured, baseURL, 'https://*.vercel.app'])];
  }

  return [...new Set([...configured, baseURL])];
}
