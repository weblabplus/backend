// ============================================================
// Better Auth (Neon PostgreSQL)
// Αντικαθιστά το Firebase/Google Authentication.
// Χρήστες, sessions και credentials ζουν στη Neon.
// ============================================================

import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import type { Request } from 'express';
import { getTrustedOrigins } from '../config/cors';

export type BetterAuth = ReturnType<typeof buildAuth>;

const MIN_SECRET_LENGTH = 32;

let authInstance: BetterAuth | null = null;
let authPool: Pool | null = null;

export function isAuthConfigured(): boolean {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET || '';
  return secret.length >= MIN_SECRET_LENGTH;
}

/**
 * Το Better Auth γράφει στο schema `neon_auth` — εκεί διαβάζει και το
 * Neon Auth dashboard (console.neon.tech → Auth), ώστε οι χρήστες να είναι ορατοί.
 */
export const AUTH_SCHEMA = 'neon_auth';

/**
 * Δημιουργεί (μία φορά) το Better Auth instance. Χρησιμοποιεί ξεχωριστό pool
 * με search_path = neon_auth, ώστε το Better Auth να βλέπει τους δικούς του πίνακες
 * χωρίς να επηρεάζονται τα υπόλοιπα queries της εφαρμογής (public schema).
 */
export function createAuth(_pool?: Pool): BetterAuth {
  if (authInstance) return authInstance;

  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET πρέπει να έχει τουλάχιστον ${MIN_SECRET_LENGTH} χαρακτήρες`
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL δεν έχει οριστεί');

  authPool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${AUTH_SCHEMA},public`,
  });
  authPool.on('error', err => console.warn('Better Auth pool error:', err.message));

  authInstance = buildAuth(authPool, secret);
  return authInstance;
}

function buildAuth(pool: Pool, secret: string) {
  const port = process.env.PORT || 3001;
  const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

  return betterAuth({
    appName: 'MediLab',
    baseURL,
    basePath: '/api/better-auth',
    secret,
    database: pool,
    trustedOrigins: getTrustedOrigins(baseURL),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      autoSignIn: true,
    },
    user: {
      // Πρόσθετα πεδία στον πίνακα neon_auth."user"
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'doctor',
          input: false, // δεν ορίζεται από τον client (αποφυγή privilege escalation)
        },
        legacyUid: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 ημέρες
      updateAge: 60 * 60 * 24, // refresh μία φορά την ημέρα
    },
    plugins: [bearer()],
    advanced: {
      database: {
        // Το neon_auth schema χρησιμοποιεί UUID primary keys
        generateId: 'uuid',
      },
    },
  });
}

/** Το κοινό pool του Better Auth (για admin queries εκτός session) */
export function getAuthPool(): Pool | null {
  return authPool;
}

export function getAuth(): BetterAuth {
  if (!authInstance) {
    throw new Error('Better Auth δεν έχει αρχικοποιηθεί — καλέστε createAuth() πρώτα');
  }
  return authInstance;
}

/** Μετατροπή Express headers σε Web Headers (για το Better Auth) */
export function toWebHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return headers;
}

export interface AuthSessionResult {
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
  session: {
    id: string;
    token: string;
    expiresAt: Date;
  };
}

/** Επιστρέφει το session από το header Authorization: Bearer <token> */
export async function getAuthSession(req: Request): Promise<AuthSessionResult | null> {
  if (!authInstance) return null;
  try {
    const session = await authInstance.api.getSession({ headers: toWebHeaders(req) });
    return (session as AuthSessionResult | null) ?? null;
  } catch {
    return null;
  }
}

// ── Admin helpers (χωρίς ενεργό session) ──
// Όλες οι queries είναι schema-qualified ώστε να μη βασίζονται σε search_path.

export async function findAuthUserByEmail(
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const pool = authPool;
  if (!pool) return null;
  const res = await pool.query(
    'SELECT id, email, name FROM neon_auth."user" WHERE lower(email) = lower($1)',
    [email]
  );
  return res.rows[0] || null;
}

export async function deleteAuthUser(userId: string): Promise<void> {
  const pool = authPool;
  if (!pool) return;
  await pool.query('DELETE FROM neon_auth."session" WHERE "userId" = $1', [userId]);
  await pool.query('DELETE FROM neon_auth.account WHERE "userId" = $1', [userId]);
  await pool.query('DELETE FROM neon_auth."user" WHERE id = $1', [userId]);
}

// ── Migration ──

interface MigrationResult {
  created: string[];
  errors: string[];
  missing: string[];
  droppedLegacyTables: string[];
}

/** Ελέγχει αν ένας πίνακας υπάρχει σε δεδομένο schema */
async function tableExists(pool: Pool, schema: string, table: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT to_regclass($1) AS t`,
    [`${schema}."${table}"`]
  );
  return res.rows[0].t !== null;
}

/**
 * Μεταφέρει χρήστες από τους παλιούς πίνακες (`users` από την εποχή Firestore
 * και `user`/`session`/`account`/`verification` από το public schema)
 * στο schema `neon_auth` που διαβάζει το Neon Auth dashboard.
 *
 * Το Better Auth πλέον γράφει απευθείας στο neon_auth, οπότε εδώ απλώς
 * δημιουργούνται οι λογαριασμοί με τον προσωρινό κωδικό και μεταφέρονται
 * role + legacyUid (το παλιό uid, για συμβατότητα με τα doctor_id).
 */
export async function migrateLegacyUsers(pool: Pool): Promise<MigrationResult> {
  const auth = getAuth();
  const defaultPassword = process.env.AUTH_DEFAULT_PASSWORD || '123456';
  const created: string[] = [];
  const errors: string[] = [];
  const droppedLegacyTables: string[] = [];

  // Πηγές: public.users (Firestore era) και public."user" (πρώτη έκδοση Better Auth)
  const hasLegacyUsers = await tableExists(pool, 'public', 'users');
  const hasLegacyUser = await tableExists(pool, 'public', 'user');

  const sources: string[] = [];
  if (hasLegacyUsers) {
    sources.push(
      `SELECT uid, email, display_name, role FROM public.users`
    );
  }
  if (hasLegacyUser) {
    sources.push(
      `SELECT COALESCE("legacyUid", id) AS uid, email, name AS display_name,
              COALESCE(role, 'doctor') AS role FROM public."user"`
    );
  }

  const legacy = sources.length > 0
    ? await pool.query(sources.join(' UNION ALL '))
    : { rows: [] as any[] };

  for (const row of legacy.rows) {
    if (!row.email) continue;

    const existing = await pool.query(
      'SELECT id FROM neon_auth."user" WHERE lower(email) = lower($1)',
      [row.email]
    );

    if (existing.rows.length === 0) {
      try {
        const res = await auth.api.signUpEmail({
          body: {
            email: row.email,
            password: defaultPassword,
            name: row.display_name || row.email.split('@')[0],
          },
        });
        // Το autoSignIn δημιουργεί session — δεν χρειάζεται για migrated λογαριασμούς
        await pool.query('DELETE FROM neon_auth."session" WHERE "userId" = $1', [res.user.id]);
        created.push(row.email);
      } catch (err: any) {
        errors.push(`${row.email}: ${err?.body?.message || err?.message || err}`);
        continue;
      }
    }

    await pool.query(
      `UPDATE neon_auth."user"
       SET role = COALESCE($2, 'doctor'),
           "legacyUid" = COALESCE("legacyUid", $3)
       WHERE lower(email) = lower($1)`,
      [row.email, row.role || 'doctor', row.uid]
    );
  }

  // Ασφάλεια: μην αγγίξεις τους legacy πίνακες αν δεν έχει επιβεβαιωθεί
  // ότι ΟΛΟΙ οι χρήστες υπάρχουν στο neon_auth.
  const expected = legacy.rows.map((r: any) => r.email).filter(Boolean);
  const missing: string[] = [];

  for (const email of expected) {
    const found = await pool.query(
      'SELECT 1 FROM neon_auth."user" WHERE lower(email) = lower($1)',
      [email]
    );
    if (found.rows.length === 0) missing.push(email);
  }

  if (missing.length > 0) {
    errors.push(`Δεν μεταφέρθηκαν: ${missing.join(', ')} — οι παλιοί πίνακες διατηρήθηκαν`);
    return { created, errors, missing, droppedLegacyTables };
  }

  // Οι παλιές πίνακες του public δεν χρειάζονται πλέον
  for (const table of ['session', 'account', 'verification', 'user']) {
    if (await tableExists(pool, 'public', table)) {
      await pool.query(`DROP TABLE public."${table}" CASCADE`);
      droppedLegacyTables.push(`public."${table}"`);
    }
  }  if (await tableExists(pool, 'public', 'users')) {
    await pool.query('DROP TABLE public.users CASCADE');
    droppedLegacyTables.push('public.users');
  }

  return { created, errors, missing: [], droppedLegacyTables };
}

/** Οι πίνακες του Better Auth στο schema neon_auth (για το startup check) */
export async function ensureAuthSchema(pool: Pool): Promise<boolean> {
  const res = await pool.query(`SELECT to_regclass('neon_auth."user"') AS t`);
  if (!res.rows[0].t) return false;

  await pool.query(
    `ALTER TABLE neon_auth."user" ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'doctor'`
  );
  await pool.query(
    `ALTER TABLE neon_auth."user" ADD COLUMN IF NOT EXISTS "legacyUid" TEXT`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "user_legacyUid_idx" ON neon_auth."user" ("legacyUid")`
  );
  return true;
}