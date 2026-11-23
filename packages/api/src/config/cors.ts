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

  // Μόνο localhost configured σε production → το allowlist είναι λάθος ρυθμισμένο.
  // Δεν ρίχνουμε το site: επιτρέπουμε (με warning) όπως η παλιά `cors()`.
  if (process.env.NODE_ENV === 'production' && !hasPublicOrigin()) {
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

  // Production με allowlist μόνο για localhost → μάλλον ξεχάστηκε το WEB_ORIGIN.
  // Επιτρέπουμε τα Vercel deployments ώστε να μη σπάει το login/logout.
  if (process.env.NODE_ENV === 'production' && !hasPublicOrigin()) {
    return [...new Set([...configured, baseURL, 'https://*.vercel.app'])];
  }

  return [...new Set([...configured, baseURL])];
}
