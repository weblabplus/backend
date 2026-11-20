import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import { toNodeHandler } from 'better-auth/node';
import { labParserFactory } from '@medilab/lab-parser';
import { ruleEngine } from '@medilab/rule-engine';
import { MLEngine } from '@medilab/ml-engine';
import { reportGenerator } from '@medilab/report-generator';
import { SeverityLevel, Patient, Visit, Referral, Exam, Appointment, AppointmentStatus } from '@medilab/core';
import { referenceRangeManager } from '@medilab/reference-ranges';
import { authMiddleware, requireRole, requestLogger, rateLimiter } from '../middleware';
import { dbService, financeStatusFromAmounts, type FinanceEntry, type FinancePayment, type FinanceEntryStatus } from '../db/db.service';
import {
  getAuth,
  getAuthSession,
  deleteAuthUser,
  isAuthConfigured,
} from '../services/auth.service';
import {
  ensureFreshConnection,
  isEfulfillmentConfigured,
  syncUser,
  testApiKey,
  searchReferralsByAmka,
  importReferralsAsVisit,
  searchReferralByBarcode,
  importReferralAsVisit,
  executeAndImportReferral,
  cancelImportedReferral,
  IMPORT_VISIT_REASON,
  REFRESH_INTERVAL_MS,
  CONNECTION_TTL_MS,
} from '../services/efulfillment.service';
import { encryptSecret } from '../services/crypto.service';
import {
  sendReferralToCenter,
  previewCenterSend,
  fetchResultsFromCenter,
  ReferenceCenterError,
} from '../services/reference-center.service';
import {
  submitReferralResults,
  maybeAutoSubmitResults,
  getLabProfile,
  saveLabProfile,
  resolveLabIdentity,
  describeLabRepoCredentials,
  saveLabRepoApiKey,
  maskedLabRepoApiKey,
  labRepoApiKeySource,
  getActiveRepoLock,
  clearRepoLock,
  lockRemainingMs,
  syncReferralResultsFromProvider,
  cancelReferralResultsFromProvider,
  LabResultsError,
  type LabProfile,
} from '../services/lab-results.service';
import {
  syncCenterDocuments,
  isDocumentsApiConfigured,
} from '../services/documents-sync.service';

// ============================================================
// Express API Server
// ============================================================

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const mlEngine = new MLEngine();

/** Πραγματική εξωτερική IP του χρήστη (για το header X-DOCTOR-IP του φορέα) */
function clientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  const ip = (raw || req.ip || '').trim().replace(/^::ffff:/, '');
  if (!ip || ip === '::1' || ip === '127.0.0.1') return undefined;
  return ip;
}

/**
 * Άντληση στοιχείων χρήστη από τον φορέα κατά το login.
 * Δεν ρίχνει ποτέ το login — επιστρέφει μόνο την κατάσταση συγχρονισμού.
 */
async function syncOnLogin(userId: string, doctorIp?: string) {
  try {
    const state = await dbService.getEfulfillmentState(userId);
    if (!state.hasCredentials) {
      return { configured: isEfulfillmentConfigured(), hasCredentials: false };
    }

    // Καταγραφή της τρέχουσας IP ώστε να χρησιμοποιείται στο X-DOCTOR-IP
    if (doctorIp) {
      const creds = await dbService.getEfulfillmentCredentials(userId);
      if (creds) {
        await dbService.saveEfulfillmentCredentials(userId, {
          username: creds.username,
          passwordEnc: encryptSecret(creds.password),
          doctorIp,
        });
      }
    }

    const result = await ensureFreshConnection(userId);
    return {
      configured: isEfulfillmentConfigured(),
      hasCredentials: true,
      synced: Boolean(result?.ok),
      error: result && !result.ok ? result.error : undefined,
      code: result && !result.ok ? result.code : undefined,
    };
  } catch (err: any) {
    console.warn('E-fulfillment sync on login failed:', err?.message || err);
    return { configured: isEfulfillmentConfigured(), hasCredentials: true, error: String(err?.message || err) };
  }
}

// Middleware
app.use(cors());

// Better Auth native endpoints (π.χ. /api/better-auth/ok)
// Πρέπει να μπει πριν το express.json() ώστε να μη καταναλώνεται το raw body.
app.all('/api/better-auth/*', (req: Request, res: Response) => {
  toNodeHandler(getAuth())(req, res);
});

app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
app.use(rateLimiter(200, 60000)); // 200 requests per minute

// ============================================================
// AUTH ROUTES (public)
// ============================================================

/** Εγγραφή νέου χρήστη */
app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, password, displayName, role } = req.body;

    if (!email || !password || !displayName) {
      res.status(400).json({
        error: 'Απαιτούνται email, password και displayName',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({
        error: 'Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες',
        code: 'WEAK_PASSWORD',
      });
      return;
    }

    const assignedRole = (['doctor', 'lab_technician', 'admin'].includes(role)
      ? role
      : 'doctor') as 'doctor' | 'lab_technician' | 'admin';

    // Δημιουργία χρήστη στο Better Auth (πίνακας "user" στη Neon)
    // Το role δεν περνά από το body για λόγους ασφαλείας — ορίζεται server-side.
    const { headers, response } = await getAuth().api.signUpEmail({
      body: { email, password, name: displayName },
      returnHeaders: true,
    });

    const userProfile =
      (await dbService.updateUserProfile(response.user.id, { role: assignedRole })) || {
        uid: response.user.id,
        id: response.user.id,
        email,
        displayName,
        role: assignedRole,
        createdAt: new Date().toISOString(),
      };

    // Το bearer plugin επιστρέφει το session token σε αυτό το header
    const token = headers.get('set-auth-token') || '';

    res.status(201).json({
      user: userProfile,
      token,
      message: 'Επιτυχής εγγραφή',
    });
  } catch (error: any) {
    const message =
      error?.body?.code === 'USER_ALREADY_EXISTS' || error?.status === 'UNPROCESSABLE_ENTITY'
        ? 'Το email χρησιμοποιείται ήδη'
        : error?.body?.message || error?.message || 'Σφάλμα εγγραφής';

    res.status(400).json({
      error: message,
      code: error?.body?.code || 'REGISTRATION_ERROR',
    });
  }
});

/** Login μέσω Better Auth (Neon PostgreSQL) — επιστρέφει bearer session token */
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        error: 'Απαιτούνται email και password',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { headers, response } = await getAuth().api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });

    // Προφίλ από τον πίνακα "user" (ρόλος, όνομα)
    let profile = await dbService.getUserProfileByEmail(email);

    if (!profile) {
      profile = await dbService.saveUserProfile({
        uid: response.user.id,
        id: response.user.id,
        email: response.user.email,
        displayName: response.user.name,
        role: 'doctor',
        createdAt: new Date().toISOString(),
      });
    }

    const token = headers.get('set-auth-token') || '';

    // Άντληση στοιχείων χρήστη από τον φορέα (e-Prescription) σε κάθε είσοδο.
    // Δεν μπλοκάρει/χαλάει το login — τα σφάλματα καταγράφονται στο state.
    const efulfillment = await syncOnLogin(profile.id || profile.uid, clientIp(req));

    res.json({
      user: profile,
      token,
      efulfillment,
      message: 'Επιτυχής σύνδεση',
    });
  } catch (error: any) {
    res.status(401).json({
      error: 'Λάθος email ή κωδικός',
      code: 'LOGIN_ERROR',
    });
  }
});

/** Λήψη προφίλ τρέχοντος χρήστη */
app.get('/api/auth/me', authMiddleware(), async (req: Request, res: Response) => {
  try {
    let profile = await dbService.getUserProfileByEmail(req.user!.email);

    // Χρήστης του Better Auth χωρίς προφίλ (π.χ. εγγραφή από native endpoint)
    if (!profile) {
      profile = await dbService.saveUserProfile({
        uid: req.user!.uid,
        id: req.user!.authUserId,
        email: req.user!.email,
        displayName: req.user!.displayName,
        role: (req.user!.role as 'doctor' | 'lab_technician' | 'admin') || 'doctor',
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ user: profile });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Ανανέωση session token */
app.post('/api/auth/refresh', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const session = await getAuthSession(req);
    if (!session) {
      res.status(401).json({ error: 'Μη έγκυρο session', code: 'AUTH_INVALID' });
      return;
    }
    res.json({ token: session.session.token });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Ενημέρωση προφίλ χρήστη */
app.put('/api/auth/profile', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { displayName } = req.body;

    if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 2) {
      res.status(400).json({
        error: 'Το όνομα πρέπει να έχει τουλάχιστον 2 χαρακτήρες',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Ενημέρωση ονόματος στον πίνακα "user" (κοινό πεδίο με το Better Auth)
    const updated = await dbService.updateUserProfile(
      req.user!.authUserId || req.user!.uid,
      { displayName: displayName.trim() }
    );

    res.json({
      message: 'Το προφίλ ενημερώθηκε επιτυχώς',
      user: updated,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// E-FULFILLMENT ROUTES (e-Prescription / ΗΔΙΚΑ)
// ============================================================

/**
 * Κατάσταση σύνδεσης με τον φορέα + αποθηκευμένα στοιχεία χρήστη.
 * Ανανεώνει αυτόματα αν πέρασαν 20 ώρες από την τελευταία επιτυχή άντληση.
 */
app.get('/api/efulfillment/me', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.authUserId || req.user!.uid;

    if (!isEfulfillmentConfigured()) {
      res.status(503).json({
        error: 'Το E-Fulfillment API δεν έχει ρυθμιστεί (λείπει EFULFILLMENT_API_KEY)',
        code: 'NOT_CONFIGURED',
      });
      return;
    }

    const state = await dbService.getEfulfillmentState(userId);
    if (!state.hasCredentials) {
      res.json({
        hasCredentials: false,
        profile: null,
        lastSyncAt: null,
        message: 'Δεν έχουν αποθηκευτεί στοιχεία σύνδεσης φορέα',
      });
      return;
    }

    // Ανανέωση αν χρειάζεται (24ωρο όριο φορέα — ανανεώνουμε στις 20 ώρες)
    const result = await ensureFreshConnection(userId);
    const fresh = await dbService.getEfulfillmentState(userId);

    const lastSync = fresh.lastSyncAt ? new Date(fresh.lastSyncAt) : null;
    res.json({
      hasCredentials: true,
      username: fresh.username,
      lastSyncAt: fresh.lastSyncAt,
      lastAttemptAt: fresh.lastAttemptAt,
      lastError: fresh.lastError,
      expiresAt: lastSync ? new Date(lastSync.getTime() + CONNECTION_TTL_MS).toISOString() : null,
      nextRefreshAt: lastSync
        ? new Date(lastSync.getTime() + REFRESH_INTERVAL_MS).toISOString()
        : null,
      profile: fresh.profile,
      synced: Boolean(result?.ok),
      refreshError: result && !result.ok ? result.error : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Αποθήκευση στοιχείων σύνδεσης φορέα + άμεση άντληση */
app.put('/api/efulfillment/credentials', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.authUserId || req.user!.uid;
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      res.status(400).json({ error: 'Απαιτείται username φορέα', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 4) {
      res.status(400).json({ error: 'Απαιτείται password φορέα', code: 'VALIDATION_ERROR' });
      return;
    }

    await dbService.saveEfulfillmentCredentials(userId, {
      username: username.trim(),
      passwordEnc: encryptSecret(password),
      doctorIp: clientIp(req),
    });

    const result = await syncUser(userId, { force: true });

    if (!result.ok) {
      res.status(502).json({
        error: result.error || 'Αποτυχία σύνδεσης με τον φορέα',
        code: result.code || 'EFULFILLMENT_ERROR',
      });
      return;
    }

    res.json({
      message: 'Τα στοιχεία αποθηκεύτηκαν και η σύνδεση με τον φορέα ολοκληρώθηκε',
      profile: result.data,
      syncedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Χειροκίνητη ανανέωση (force) */
app.post('/api/efulfillment/refresh', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.authUserId || req.user!.uid;
    const result = await syncUser(userId, { force: true });

    if (!result.ok) {
      res.status(502).json({
        error: result.error || 'Αποτυχία ανανέωσης σύνδεσης',
        code: result.code || 'EFULFILLMENT_ERROR',
      });
      return;
    }

    res.json({
      message: 'Η σύνδεση με τον φορέα ανανεώθηκε',
      profile: result.data,
      syncedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Διαγραφή αποθηκευμένων στοιχείων φορέα */
app.delete('/api/efulfillment/credentials', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.authUserId || req.user!.uid;
    await dbService.deleteEfulfillmentCredentials(userId);
    res.json({ message: 'Τα στοιχεία σύνδεσης φορέα διαγράφηκαν' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Αναζήτηση παραπεμπτικών ασθενή με ΑΜΚΑ (GET /api/me/referrals/nopaper).
 * Χρησιμοποιεί τα αποθηκευμένα credentials και το unitId από τα στοιχεία χρήστη.
 */
app.get(
  '/api/efulfillment/patients/:amka/referrals',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const amkaParam = String(req.params.amka || '').trim();

      if (!/^\d{11}$/.test(amkaParam)) {
        res.status(400).json({
          error: 'Το ΑΜΚΑ πρέπει να αποτελείται από 11 ψηφία',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const result = await searchReferralsByAmka(userId, amkaParam, {
        pin: typeof req.query.pin === 'string' ? req.query.pin : undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        size: req.query.size ? Number(req.query.size) : undefined,
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
        unitId: req.query.unitId ? Number(req.query.unitId) : undefined,
      });

      if (!result.ok) {
        res.status(result.code === 'AUTH' ? 401 : 502).json({
          error: result.error,
          code: result.code || 'EFULFILLMENT_ERROR',
        });
        return;
      }

      // Υπάρχων ασθενής στη βάση για αυτό το ΑΜΚΑ;
      const existing = await dbService.findPatientByAmka(amkaParam);

      // Φιλτράρισμα παραπεμπτικών που έχουν ήδη εισαχθεί (έλεγχος με barcode)
      const all = result.data!.referrals;
      const imported = await dbService.listImportedReferralBarcodes(
        all.map(r => r.barcode)
      );
      const referrals = all.filter(r => !imported.has(r.barcode));

      res.json({
        ...result.data,
        referrals,
        total: referrals.length,
        alreadyImportedCount: all.length - referrals.length,
        amka: amkaParam,
        existingPatient: existing
          ? {
              id: existing.id,
              firstName: existing.firstName,
              lastName: existing.lastName,
              dateOfBirth: existing.dateOfBirth,
              gender: existing.gender,
            }
          : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Εισαγωγή επιλεγμένων παραπεμπτικών: δημιουργεί (ή βρίσκει) τον ασθενή,
 * ανοίγει επίσκεψη «Άυλη συνταγογράφηση» για σήμερα και καταχωρεί τα παραπεμπτικά.
 */
app.post(
  '/api/efulfillment/import-referrals',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const { amka, referrals, patient } = req.body;

      if (!amka || !/^\d{11}$/.test(String(amka).trim())) {
        res.status(400).json({
          error: 'Απαιτείται έγκυρο ΑΜΚΑ (11 ψηφία)',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      if (!Array.isArray(referrals) || referrals.length === 0) {
        res.status(400).json({
          error: 'Δεν επιλέχθηκαν παραπεμπτικά',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Βεβαιώσου ότι η σύνδεση με τον φορέα είναι ενεργή
      await ensureFreshConnection(userId);

      const result = await importReferralsAsVisit({
        amka: String(amka).trim(),
        referrals,
        patient,
        doctorId: req.user!.uid,
        userId,
      });

      const messages = [
        result.patientCreated
          ? 'Δημιουργήθηκε ο ασθενής, η επίσκεψη και τα παραπεμπτικά'
          : 'Δημιουργήθηκε η επίσκεψη και καταχωρήθηκαν τα παραπεμπτικά',
      ];
      if (result.expired.length > 0) {
        messages.push(
          `Παραλείφθηκαν ${result.expired.length} ληγμένα παραπεμπτικά (${result.expired.join(', ')})`
        );
      }

      res.status(201).json({
        message: messages.join(' · '),
        patient: result.patient,
        patientCreated: result.patientCreated,
        visit: result.visit,
        referrals: result.referrals,
        skipped: result.skipped,
        expired: result.expired,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ── Admin: ρύθμιση E-Fulfillment (Api-Key / Base URL) ──

/** Κατάσταση ρύθμισης (το Api-Key εμφανίζεται μασκαρισμένο) */
app.get(
  '/api/admin/efulfillment/config',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const dbApiKey = await dbService.getSetting('EFULFILLMENT_API_KEY');
      const dbBaseUrl = await dbService.getSetting('EFULFILLMENT_BASE_URL');
      const apiKey = dbApiKey || process.env.EFULFILLMENT_API_KEY || '';
      const baseUrl = dbBaseUrl || process.env.EFULFILLMENT_BASE_URL || '';

      res.json({
        baseUrl,
        apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : null,
        apiKeySource: dbApiKey ? 'database' : process.env.EFULFILLMENT_API_KEY ? 'env' : 'none',
        refreshHours: REFRESH_INTERVAL_MS / 3600000,
        ttlHours: CONNECTION_TTL_MS / 3600000,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Ενημέρωση Api-Key / Base URL (αποθηκεύεται στη βάση, υπερισχύει του env) */
app.put(
  '/api/admin/efulfillment/config',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { apiKey, baseUrl } = req.body;

      if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
        if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
          res.status(400).json({ error: 'Μη έγκυρο Api-Key', code: 'VALIDATION_ERROR' });
          return;
        }
        await dbService.setSetting('EFULFILLMENT_API_KEY', apiKey.trim());
        process.env.EFULFILLMENT_API_KEY = apiKey.trim();
      }

      if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
        if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
          res.status(400).json({ error: 'Μη έγκυρο Base URL', code: 'VALIDATION_ERROR' });
          return;
        }
        await dbService.setSetting('EFULFILLMENT_BASE_URL', baseUrl.trim().replace(/\/+$/, ''));
        process.env.EFULFILLMENT_BASE_URL = baseUrl.trim().replace(/\/+$/, '');
      }

      res.json({ message: 'Οι ρυθμίσεις αποθηκεύτηκαν' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Δοκιμή του Api-Key με τα αποθηκευμένα credentials του admin */
app.post(
  '/api/admin/efulfillment/test',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const creds = await dbService.getEfulfillmentCredentials(userId);
      const result = await testApiKey(creds || undefined);

      if (!result.ok) {
        res.status(result.code === 'NO_CREDENTIALS' ? 400 : 502).json({
          ok: false,
          error: result.error,
          code: result.code,
          inconclusive: result.inconclusive ?? false,
        });
        return;
      }
      res.json({ ok: true, message: 'Το Api-Key είναι έγκυρο' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Άντληση παραπεμπτικού προς εκτέλεση με barcode
 * (GET /api/referrals/{barcode}/unit/{unitId}/dispense).
 * Επιστρέφει το παραπεμπτικό, τις εξετάσεις του και αν έχει ήδη καταχωρηθεί.
 */
app.get(
  '/api/efulfillment/referrals/:barcode',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const barcode = String(req.params.barcode || '').trim();

      if (barcode.length < 4) {
        res.status(400).json({ error: 'Μη έγκυρο barcode', code: 'VALIDATION_ERROR' });
        return;
      }

      const result = await searchReferralByBarcode(userId, barcode, {
        unitId: typeof req.query.unitId === 'string' ? req.query.unitId : undefined,
      });

      if (!result.ok) {
        const status = result.code === 'AUTH' ? 401 : result.code === 'NO_REFERRAL' ? 404 : 502;
        res.status(status).json({
          error: result.error,
          code: result.code || 'EFULFILLMENT_ERROR',
        });
        return;
      }

      res.json(result.data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Καταχώρηση παραπεμπτικού από barcode: εκτελεί στον φορέα τις επιλεγμένες
 * εξετάσεις (POST /api/referrals/{barcode}/dispense) και δημιουργεί νέα
 * επίσκεψη «Άυλη συνταγογράφηση».
 *
 * Body: { barcode, referral, selectedLineIds: string[] }
 */
app.post(
  '/api/efulfillment/import-referral',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const { barcode, referral, selectedLineIds } = req.body;

      if (!barcode || String(barcode).trim().length < 4) {
        res.status(400).json({ error: 'Απαιτείται έγκυρο barcode', code: 'VALIDATION_ERROR' });
        return;
      }
      if (!referral || typeof referral !== 'object') {
        res.status(400).json({
          error: 'Απαιτούνται τα στοιχεία του παραπεμπτικού',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      if (!Array.isArray(selectedLineIds) || selectedLineIds.length === 0) {
        res.status(400).json({
          error: 'Επιλέξτε τουλάχιστον μία εξέταση προς εκτέλεση',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const result = await executeAndImportReferral(userId, {
        barcode: String(barcode).trim(),
        referral,
        selectedLineIds: selectedLineIds.map(String),
        doctorId: req.user!.uid,
      });

      if (!result.ok) {
        const status =
          result.code === 'ALREADY_IMPORTED' || result.code === 'ALREADY_EXECUTED'
            ? 409
            : result.code === 'EXPIRED' || result.code === 'FULL_ONLY' || result.code === '2018'
            ? 422
            : result.code === 'NO_REFERRAL'
            ? 404
            : result.code === 'AUTH'
            ? 401
            : 502;
        res.status(status).json({
          error: result.error,
          code: result.code || 'IMPORT_ERROR',
        });
        return;
      }

      const { data } = result;
      const exec = data.execution;

      res.status(201).json({
        message:
          `Δημιουργήθηκε νέα επίσκεψη «${IMPORT_VISIT_REASON}» με το παραπεμπτικό ` +
          `${String(barcode).trim()}` +
          (exec?.alreadyExecuted
            ? ` · Το παραπεμπτικό ήταν ήδη εκτελεσμένο στον φορέα (2019) — ` +
              `καταχωρήθηκαν ${data.exams.length} εξέταση(εις) ως εκτελεσμένες`
            : exec
            ? ` · Εκτελέστηκαν ${exec.executedLineIds.length} εξετάσεις ` +
              `(${exec.fullExecution ? 'ολική' : 'μερική'} εκτέλεση)`
            : data.exams.length > 0
            ? ` και ${data.exams.length} εξέταση(εις)`
            : '') +
          (data.patientShare
            ? ` · Συμμετοχή ασθενούς ${data.patientShare.amount.toFixed(2)} € καταχωρήθηκε στο Ταμείο`
            : '') +
          (data.payerShare
            ? ` · Αποζημίωση φορέα ${data.payerShare.amount.toFixed(2)} € καταχωρήθηκε στο Ταμείο`
            : ''),
        patient: data.patient,
        patientCreated: data.patientCreated,
        visit: data.visit,
        referral: data.referral,
        exams: data.exams,
        execution: exec ?? null,
        patientShare: data.patientShare ?? null,
        payerShare: data.payerShare ?? null,
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      const isDuplicate = message.includes('έχει ήδη καταχωρηθεί');
      const isExpired = message.includes('έχει λήξει');
      res.status(isDuplicate ? 409 : isExpired ? 422 : 500).json({
        error: message,
        code: isDuplicate ? 'ALREADY_IMPORTED' : isExpired ? 'EXPIRED' : 'IMPORT_ERROR',
      });
    }
  }
);

/**
 * Αποχαρακτηρισμός εκτέλεσης παραπεμπτικού.
 *
 * `POST /api/efulfillment/referrals/:id/cancel`
 * - Ολική εκτέλεση → `…/dispense/cancel`
 * - Μερική εκτέλεση → `…/dispense/cancel-part/{executionNo}`
 *
 * Δεν επιτρέπεται όταν έχουν καταχωρηθεί αποτελέσματα σε εξετάσεις.
 */
app.post(
  '/api/efulfillment/referrals/:id/cancel',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const referralId = String(req.params.id || '').trim();

      if (!referralId) {
        res.status(400).json({ error: 'Απαιτείται αναγνωριστικό παραπεμπτικού', code: 'VALIDATION_ERROR' });
        return;
      }

      const outcome = await cancelImportedReferral(userId, referralId);

      res.json({
        message: outcome.cancellation.fullCancellation
          ? `Η ολική εκτέλεση του παραπεμπτικού ${outcome.cancellation.barcode} ακυρώθηκε`
          : `Η μερική εκτέλεση του παραπεμπτικού ${outcome.cancellation.barcode} ακυρώθηκε`,
        referral: outcome.referral,
        exams: outcome.exams,
        cancellation: outcome.cancellation,
      });
    } catch (error: any) {
      const code = error?.code as string | undefined;
      const status =
        code === 'RESULTS_ENTERED'
          ? 409
          : code === 'NOT_EXECUTED' || code === 'NO_EXECUTION_NO'
          ? 422
          : code === 'NOT_FOUND'
          ? 404
          : code === 'AUTH' || code === '601' || code === '603'
          ? 401
          : 502;
      res.status(status).json({
        error: error?.message || 'Σφάλμα ακύρωσης εκτέλεσης',
        code: code || 'CANCEL_FAILED',
      });
    }
  }
);

// ============================================================
// ADMIN ROUTES (admin only)
// ============================================================

/** Λίστα χρηστών */
app.get(
  '/api/admin/users',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const users = await dbService.listUsers();
      res.json({ users, total: users.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Αλλαγή ρόλου χρήστη */
app.put(
  '/api/admin/users/:uid/role',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { role } = req.body;
      if (!role || !['doctor', 'lab_technician', 'admin'].includes(role)) {
        res.status(400).json({ error: 'Μη έγκυρος ρόλος' });
        return;
      }
      await dbService.updateUserProfile(req.params.uid, { role }).catch(() => {});
      res.json({ message: 'Ο ρόλος ενημερώθηκε επιτυχώς', uid: req.params.uid, role });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Διαγραφή χρήστη */
app.delete(
  '/api/admin/users/:uid',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      // uid = Better Auth user id ή legacy uid
      const profile = await dbService.getUserProfile(req.params.uid);
      if (!profile) {
        res.status(404).json({ error: 'Ο χρήστης δεν βρέθηκε' });
        return;
      }
      await deleteAuthUser(profile.id || profile.uid);
      await dbService.deleteUser(req.params.uid).catch(() => {});
      res.json({ message: 'Ο χρήστης διαγράφηκε επιτυχώς' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      parsers: labParserFactory.getSupportedFormats(),
      rulesLoaded: true,
      mlEngine: true,
    },
  });
});

// ========== PATIENTS (protected) ==========

app.get('/api/patients', authMiddleware(true), async (req: Request, res: Response) => {
  try {
    const patients = await dbService.listPatients(req.user?.uid);
    res.json({ patients, total: patients.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/patients/:id', authMiddleware(true), async (req: Request, res: Response) => {
  try {
    const patient = await dbService.getPatient(req.params.id);
    if (!patient) {
      res.status(404).json({ error: 'Ο ασθενής δεν βρέθηκε' });
      return;
    }
    res.json({ patient });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/patients', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const patient = await dbService.savePatient({
      id: req.body.id || `patient_${Date.now()}`,
      ...req.body,
      doctorId: req.user?.uid,
    });
    res.status(201).json({ patient });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/patients/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const patient = await dbService.updatePatient(req.params.id, req.body);
    if (!patient) {
      res.status(404).json({ error: 'Ο ασθενής δεν βρέθηκε' });
      return;
    }
    res.json({ patient });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/patients/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    await dbService.deletePatient(req.params.id);
    res.json({ message: 'Ο ασθενής διαγράφηκε επιτυχώς' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== VISITS (protected) ==========

/** Λίστα επισκέψεων (προαιρετικό φιλτράρισμα ανά ασθενή ή εύρος ημερομηνιών) */
app.get('/api/visits', authMiddleware(true), async (req: Request, res: Response) => {
  try {
    const patientId = req.query.patientId as string | undefined;
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    const visits = await dbService.listVisits(patientId, req.user?.uid, { from, to });
    res.json({ visits, total: visits.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Λήψη μίας επίσκεψης */
app.get('/api/visits/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const visit = await dbService.getVisit(req.params.id);
    if (!visit) {
      res.status(404).json({ error: 'Η επίσκεψη δεν βρέθηκε' });
      return;
    }
    res.json({ visit });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Δημιουργία νέας επίσκεψης */
app.post('/api/visits', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { patientId, visitDate, reason, diagnosis, notes, status, patientName } = req.body;

    if (!patientId || !visitDate || !reason) {
      res.status(400).json({ error: 'Απαιτούνται patientId, visitDate και reason' });
      return;
    }

    const now = new Date().toISOString();
    const visit: Visit = {
      id: req.body.id || `visit_${Date.now()}`,
      patientId,
      patientName: patientName || '',
      visitDate,
      reason,
      diagnosis: diagnosis || '',
      notes: notes || '',
      doctorId: req.user?.uid,
      status: status || 'scheduled',
      createdAt: now,
      updatedAt: now,
    };

    const saved = await dbService.saveVisit(visit);
    res.status(201).json({ visit: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Ενημέρωση επίσκεψης */
app.put('/api/visits/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const visit = await dbService.updateVisit(req.params.id, req.body);
    if (!visit) {
      res.status(404).json({ error: 'Η επίσκεψη δεν βρέθηκε' });
      return;
    }
    res.json({ visit });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Διαγραφή επίσκεψης */
app.delete('/api/visits/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    // Δεν επιτρέπεται διαγραφή επίσκεψης που περιέχει εκτελεσμένα παραπεμπτικά
    const referrals = await dbService.listReferrals(req.params.id);
    const executed = referrals.filter(
      r => r.status === 'partially_executed' || r.status === 'fully_executed'
    );
    if (executed.length > 0) {
      res.status(409).json({
        error:
          `Η επίσκεψη περιέχει ${executed.length} εκτελεσμένο(α) παραπεμπτικό(ά) και δεν μπορεί ` +
          'να διαγραφεί. Ακυρώστε πρώτα την εκτέλεση από τον φορέα.',
        code: 'REFERRAL_EXECUTED',
        blockedReferrals: executed.map(r => ({ id: r.id, barcode: (r as any).barcode, status: r.status })),
      });
      return;
    }

    await dbService.deleteVisit(req.params.id);
    res.json({ message: 'Η επίσκεψη διαγράφηκε επιτυχώς' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== APPOINTMENTS (Ημερολόγιο) ==========

const APPOINTMENT_STATUSES = Object.values(AppointmentStatus) as string[];

/** Λίστα ραντεβού (φίλτρα: patientId, from, to, status) */
app.get('/api/appointments', authMiddleware(true), async (req: Request, res: Response) => {
  try {
    const appointments = await dbService.listAppointments({
      patientId: (req.query.patientId as string) || undefined,
      from: (req.query.from as string) || undefined,
      to: (req.query.to as string) || undefined,
      status: (req.query.status as string) || undefined,
    });
    res.json({ appointments, total: appointments.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Λήψη ενός ραντεβού */
app.get('/api/appointments/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const appointment = await dbService.getAppointment(req.params.id);
    if (!appointment) {
      res.status(404).json({ error: 'Το ραντεβού δεν βρέθηκε' });
      return;
    }
    res.json({ appointment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Δημιουργία νέου ραντεβού */
app.post('/api/appointments', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { patientId, patientName, scheduledAt, reason, notes, durationMinutes, status } = req.body;

    if (!patientId || !scheduledAt || !reason) {
      res.status(400).json({ error: 'Απαιτούνται patientId, scheduledAt και reason' });
      return;
    }
    if (Number.isNaN(new Date(scheduledAt).getTime())) {
      res.status(400).json({ error: 'Μη έγκυρη ημερομηνία/ώρα ραντεβού' });
      return;
    }
    if (status && !APPOINTMENT_STATUSES.includes(status)) {
      res.status(400).json({ error: `Μη έγκυρη κατάσταση ραντεβού: ${status}` });
      return;
    }

    const now = new Date().toISOString();
    const appointment: Appointment = {
      id: req.body.id || `appointment_${Date.now()}`,
      patientId,
      patientName: patientName || '',
      doctorId: req.user?.uid,
      scheduledAt: new Date(scheduledAt).toISOString(),
      durationMinutes: Number(durationMinutes) > 0 ? Number(durationMinutes) : undefined,
      reason,
      notes: notes || '',
      status: status || AppointmentStatus.SCHEDULED,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await dbService.saveAppointment(appointment);
    res.status(201).json({ appointment: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Ενημέρωση ραντεβού */
app.put('/api/appointments/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { status, scheduledAt } = req.body;
    if (status && !APPOINTMENT_STATUSES.includes(status)) {
      res.status(400).json({ error: `Μη έγκυρη κατάσταση ραντεβού: ${status}` });
      return;
    }
    if (scheduledAt && Number.isNaN(new Date(scheduledAt).getTime())) {
      res.status(400).json({ error: 'Μη έγκυρη ημερομηνία/ώρα ραντεβού' });
      return;
    }

    const updates: Partial<Appointment> = { ...req.body };
    delete updates.id;
    delete updates.createdAt;
    if (scheduledAt) updates.scheduledAt = new Date(scheduledAt).toISOString();
    if (updates.durationMinutes !== undefined) {
      updates.durationMinutes = Number(updates.durationMinutes) > 0
        ? Number(updates.durationMinutes)
        : undefined;
    }

    const current = await dbService.getAppointment(req.params.id);
    if (!current) {
      res.status(404).json({ error: 'Το ραντεβού δεν βρέθηκε' });
      return;
    }

    const appointment = await dbService.updateAppointment(req.params.id, updates);
    res.json({ appointment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Διαγραφή ραντεβού (η τυχόν επίσκεψη που δημιουργήθηκε παραμένει) */
app.delete('/api/appointments/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    await dbService.deleteAppointment(req.params.id);
    res.json({ message: 'Το ραντεβού διαγράφηκε επιτυχώς' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Μετατροπή ραντεβού σε επίσκεψη.
 * Δημιουργεί επίσκεψη με τα στοιχεία του ραντεβού και συνδέει το ραντεβού
 * με αυτήν (status = completed, visitId).
 */
app.post(
  '/api/appointments/:id/convert-to-visit',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const appointment = await dbService.getAppointment(req.params.id);
      if (!appointment) {
        res.status(404).json({ error: 'Το ραντεβού δεν βρέθηκε' });
        return;
      }

      if (appointment.visitId) {
        const existing = await dbService.getVisit(appointment.visitId);
        res.status(409).json({
          error: 'Το ραντεβού έχει ήδη μετατραπεί σε επίσκεψη',
          code: 'ALREADY_CONVERTED',
          visit: existing,
        });
        return;
      }

      const scheduled = new Date(appointment.scheduledAt);
      const fallbackDate = `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}`;
      const visitDate =
        typeof req.body?.visitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.visitDate)
          ? req.body.visitDate
          : fallbackDate;

      const now = new Date().toISOString();
      const visit: Visit = {
        id: `visit_${Date.now()}`,
        patientId: appointment.patientId,
        patientName: appointment.patientName || '',
        visitDate,
        reason: appointment.reason || 'Ραντεβού',
        diagnosis: '',
        notes: appointment.notes || '',
        doctorId: req.user?.uid,
        status: 'scheduled' as Visit['status'],
        createdAt: now,
        updatedAt: now,
      };

      const savedVisit = await dbService.saveVisit(visit);
      const updated = await dbService.updateAppointment(appointment.id, {
        status: AppointmentStatus.COMPLETED,
        visitId: savedVisit.id,
      });

      res.status(201).json({ appointment: updated, visit: savedVisit });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ========== REFERRALS (protected) ==========

/** Λίστα παραπεμπτικών (φιλτράρισμα ανά επίσκεψη ή ασθενή) */
app.get('/api/referrals', authMiddleware(true), async (req: Request, res: Response) => {
  try {
    const visitId = req.query.visitId as string | undefined;
    const patientId = req.query.patientId as string | undefined;
    const referrals = await dbService.listReferrals(visitId, patientId, req.user?.uid);
    res.json({ referrals, total: referrals.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Λήψη ενός παραπεμπτικού */
app.get('/api/referrals/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const referral = await dbService.getReferral(req.params.id);
    if (!referral) {
      res.status(404).json({ error: 'Το παραπεμπτικό δεν βρέθηκε' });
      return;
    }
    res.json({ referral });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Δημιουργία νέου παραπεμπτικού (απαιτεί visitId) */
app.post('/api/referrals', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { visitId, patientId, specialty, reason, hospital, referralDate, notes, status, patientName, visitReason } = req.body;

    if (!visitId || !patientId || !specialty || !reason || !referralDate) {
      res.status(400).json({ error: 'Απαιτούνται visitId, patientId, specialty, reason και referralDate' });
      return;
    }

    // Επαλήθευση ότι η επίσκεψη υπάρχει
    const visit = await dbService.getVisit(visitId);
    if (!visit) {
      res.status(400).json({ error: 'Η επίσκεψη δεν βρέθηκε. Πρέπει πρώτα να καταχωρηθεί επίσκεψη.' });
      return;
    }

    const now = new Date().toISOString();
    const referral: Referral = {
      id: req.body.id || `referral_${Date.now()}`,
      visitId,
      patientId,
      patientName: patientName || visit.patientName || '',
      visitReason: visitReason || visit.reason || '',
      specialty,
      reason,
      hospital: hospital || '',
      referralDate,
      status: status || 'pending',
      notes: notes || '',
      reportUrl: '',
      doctorId: req.user?.uid,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await dbService.saveReferral(referral);
    res.status(201).json({ referral: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Ενημέρωση παραπεμπτικού */
app.put('/api/referrals/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const before = await dbService.getReferral(req.params.id);
    if (!before) {
      res.status(404).json({ error: 'Το παραπεμπτικό δεν βρέθηκε' });
      return;
    }

    const referral = await dbService.updateReferral(req.params.id, req.body);

    // Μετάβαση σε «Ολοκληρώθηκε» → αυτόματη αποστολή αποτελεσμάτων στον φορέα
    let resultsSubmission: Awaited<ReturnType<typeof maybeAutoSubmitResults>> | undefined;
    if (before.status !== 'completed' && referral.status === 'completed') {
      const userId = req.user!.authUserId || req.user!.uid;
      resultsSubmission = await maybeAutoSubmitResults(userId, referral.id);
    }

    res.json({ referral, resultsSubmission });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LAB RESULTS — «Καταχώρηση Εργαστηριακών Αποτελεσμάτων» (ΗΔΙΚΑ)
// ============================================================

/**
 * POST /api/efulfillment/referrals/:id/submit-results
 * Αποστολή αποτελεσμάτων παραπεμπτικού στον φορέα.
 * Body: { force?: boolean } — επαν-αποστολή αν έχει ήδη σταλεί.
 */
app.post(
  '/api/efulfillment/referrals/:id/submit-results',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const outcome = await submitReferralResults(userId, req.params.id, {
        force: Boolean(req.body?.force),
      });

      res.json({
        message: `Τα αποτελέσματα στάλθηκαν στον φορέα (${outcome.indicatorCount} δείκτες, ${outcome.examCount} εξετάσεις)`,
        referral: outcome.referral,
        sentAt: outcome.sentAt,
        examCount: outcome.examCount,
        indicatorCount: outcome.indicatorCount,
        response: outcome.response,
      });
    } catch (error: any) {
      const code = error?.code as string | undefined;
      const status =
        code === 'NOT_FOUND'
          ? 404
          : code === 'ALREADY_SUBMITTED'
          ? 409
          : code === 'NOTHING_NEW'
          ? 409
          : code === 'REPO_LOCKED'
          ? 429
          : code === 'INVALID_API_KEY'
          ? 502
          : code === 'NO_RESULTS' ||
            code === 'NO_BARCODE' ||
            code === 'NO_PATIENT_AMKA' ||
            code === 'NO_DOCTOR_AMKA' ||
            code === 'NO_LAB_PROFILE' ||
            code === 'NO_LAB_VAT' ||
            code === 'NO_LAB_LICENSE' ||
            code === 'NO_LAB_NAME' ||
            code === 'NO_PATIENT'
          ? 422
          : code === 'AUTH' || code === '601' || code === '603'
          ? 401
          : code === 'PROVIDER_OPERATION'
          ? 502
          : 502;

      res.status(status).json({
        error: error?.message || 'Σφάλμα αποστολής αποτελεσμάτων',
        code: code || 'SUBMIT_FAILED',
      });
    }
  }
);

/** GET /api/lab-profile — στοιχεία εργαστηρίου (επωνυμία/ΑΦΜ από φορέα + κωδικός ΕΟΠΥΥ) */
app.get('/api/lab-profile', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.authUserId || req.user!.uid;
    const [saved, identity, lock] = await Promise.all([
      getLabProfile(),
      resolveLabIdentity(userId),
      getActiveRepoLock(),
    ]);
    res.json({
      profile: saved,
      identity,
      /** Διαγνωστικά: ποιο username/api-key χρησιμοποιεί το Lab Data Repository */
      credentials: await describeLabRepoCredentials(userId),
      /** Ενεργό κλείδωμα λογαριασμού φορέα (30λεπτο cooldown) */
      lock: lock
        ? { ...lock, remainingMs: lockRemainingMs(lock) }
        : null,
      /** Ποια πεδία προέρχονται από τα Στοιχεία Φορέα */
      source: {
        labName: identity?.labName ? 'efulfillment' : null,
        vatNumber: identity?.vatNumber ? 'efulfillment' : null,
        licenseNumber: saved?.licenseNumber ? 'manual' : null,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** DELETE /api/lab-profile/lock — χειροκίνητη άρση του cooldown (admin) */
app.delete(
  '/api/lab-profile/lock',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      await clearRepoLock();
      res.json({ message: 'Το κλείδωμα λογαριασμού φορέα αφαιρέθηκε' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** PUT /api/lab-profile — αποθήκευση/παράκαμψη στοιχείων εργαστηρίου */
app.put('/api/lab-profile', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { labName, vatNumber, licenseNumber, doctorSpecialty } = req.body || {};
    const cleanVat = String(vatNumber ?? '').replace(/\D/g, '');

    if (cleanVat && cleanVat.length !== 9) {
      res.status(400).json({ error: 'Το ΑΦΜ πρέπει να έχει 9 ψηφία', code: 'VALIDATION_ERROR' });
      return;
    }

    if (!String(labName ?? '').trim() && !cleanVat && !String(licenseNumber ?? '').trim()) {
      res.status(400).json({
        error: 'Συμπληρώστε τουλάχιστον επωνυμία, ΑΦΜ ή κωδικό εγκατάστασης ΕΟΠΥΥ',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const profile: LabProfile = {
      ...(String(labName ?? '').trim() ? { labName: String(labName).trim() } : {}),
      ...(cleanVat ? { vatNumber: cleanVat } : {}),
      ...(String(licenseNumber ?? '').trim()
        ? { licenseNumber: String(licenseNumber).trim() }
        : {}),
      ...(doctorSpecialty ? { doctorSpecialty: String(doctorSpecialty).trim() } : {}),
    };
    await saveLabProfile(profile);

    const userId = req.user!.authUserId || req.user!.uid;
    res.json({
      message: 'Τα στοιχεία εργαστηρίου αποθηκεύτηκαν',
      profile,
      identity: await resolveLabIdentity(userId),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/admin/lab-repo/config — ενεργό Api-Key Lab Data Repository (μασκαρισμένο) */
app.get(
  '/api/admin/lab-repo/config',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    res.json({
      apiKeyMasked: maskedLabRepoApiKey(),
      apiKeySource: labRepoApiKeySource(),
    });
  }
);

/** PUT /api/admin/lab-repo/config — ορισμός Api-Key Lab Data Repository */
app.put(
  '/api/admin/lab-repo/config',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const apiKey = String(req.body?.apiKey || '').trim();
      if (apiKey.length < 8) {
        res.status(400).json({ error: 'Μη έγκυρο Api-Key', code: 'VALIDATION_ERROR' });
        return;
      }
      await saveLabRepoApiKey(apiKey);
      res.json({
        message: 'Το Api-Key του Lab Data Repository αποθηκεύτηκε',
        apiKeyMasked: maskedLabRepoApiKey(),
        apiKeySource: labRepoApiKeySource(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** GET /api/efulfillment/referrals/:id/fetch-results — άντληση αποτελεσμάτων από φορέα */
app.get(
  '/api/efulfillment/referrals/:id/fetch-results',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const outcome = await syncReferralResultsFromProvider(userId, req.params.id);
      const exams = await dbService.listExams(req.params.id);
      res.json({ ...outcome, exams });
    } catch (error: any) {
      const code = error?.code as string | undefined;
      const status =
        code === 'NOT_FOUND'
          ? 404
          : code === 'REPO_LOCKED'
          ? 429
          : code === 'NO_BARCODE' || code === 'NO_CREDENTIALS'
          ? 422
          : code === 'INVALID_API_KEY'
          ? 502
          : 502;
      res.status(status).json({
        error: error?.message || 'Σφάλμα άντλησης αποτελεσμάτων',
        code: code || 'FETCH_FAILED',
      });
    }
  }
);

/** DELETE /api/efulfillment/referrals/:id/fetch-results — ακύρωση αντληθέντων αποτελεσμάτων */
app.delete(
  '/api/efulfillment/referrals/:id/fetch-results',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.authUserId || req.user!.uid;
      const outcome = await cancelReferralResultsFromProvider(userId, req.params.id);
      const [referral, exams] = await Promise.all([
        dbService.getReferral(req.params.id),
        dbService.listExams(req.params.id),
      ]);
      res.json({ ...outcome, referral, exams });
    } catch (error: any) {
      const code = error?.code as string | undefined;
      const status =
        code === 'NOT_FOUND'
          ? 404
          : code === 'NO_FETCHED_RESULTS' || code === 'NO_CREDENTIALS'
          ? 422
          : 502;
      res.status(status).json({
        error: error?.message || 'Σφάλμα ακύρωσης αποτελεσμάτων',
        code: code || 'CANCEL_FAILED',
      });
    }
  }
);

/** Διαγραφή παραπεμπτικού */
app.delete('/api/referrals/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    // Δεν επιτρέπεται διαγραφή μερικώς/ολικώς εκτελεσμένου παραπεμπτικού
    const referral = await dbService.getReferral(req.params.id);
    if (!referral) {
      res.status(404).json({ error: 'Το παραπεμπτικό δεν βρέθηκε', code: 'NOT_FOUND' });
      return;
    }
    if (
      referral.status === 'partially_executed' ||
      referral.status === 'fully_executed'
    ) {
      res.status(409).json({
        error:
          'Το παραπεμπτικό είναι εκτελεσμένο στον φορέα και δεν μπορεί να διαγραφεί. ' +
          'Ακυρώστε πρώτα την εκτέλεση από τον φορέα.',
        code: 'REFERRAL_EXECUTED',
        referral: { id: referral.id, status: referral.status, barcode: (referral as any).barcode },
      });
      return;
    }

    await dbService.deleteReferral(req.params.id);
    res.json({ message: 'Το παραπεμπτικό διαγράφηκε επιτυχώς' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== EXAMS (protected) ==========

/** Λίστα εξετάσεων (φιλτράρισμα ανά παραπεμπτικό, επίσκεψη ή ασθενή) */
app.get('/api/exams', authMiddleware(true), async (req: Request, res: Response) => {
    try {
      const referralId = req.query.referralId as string | undefined;
      const visitId = req.query.visitId as string | undefined;
      const patientId = req.query.patientId as string | undefined;
      const exams = await dbService.listExams(referralId, visitId, patientId, req.user?.uid);
      res.json({ exams, total: exams.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
});

/** Λήψη μίας εξέτασης */
app.get('/api/exams/:id', authMiddleware(), async (req: Request, res: Response) => {
    try {
      const exam = await dbService.getExam(req.params.id);
      if (!exam) {
        res.status(404).json({ error: 'Η εξέταση δεν βρέθηκε' });
        return;
      }
      res.json({ exam });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
});

/** Δημιουργία νέας εξέτασης (απαιτεί referralId) */
app.post('/api/exams', authMiddleware(), async (req: Request, res: Response) => {
    try {
      const { referralId, visitId, patientId, name, category, status, examDate, result, unit, referenceRange, parameters, notes, patientName, loincCode, examCode } = req.body;

      if (!referralId || !name) {
        res.status(400).json({ error: 'Απαιτούνται referralId και name' });
        return;
      }

      // Επαλήθευση ότι το παραπεμπτικό υπάρχει
      const referral = await dbService.getReferral(referralId);
      if (!referral) {
        res.status(400).json({ error: 'Το παραπεμπτικό δεν βρέθηκε.' });
        return;
      }

      const now = new Date().toISOString();
      let exam: Exam = {
        id: req.body.id || `exam_${Date.now()}`,
        referralId,
        visitId: visitId || referral.visitId,
        patientId: patientId || referral.patientId,
        patientName: patientName || referral.patientName || '',
        name,
        category: category || '',
        status: status || 'ordered',
        result: result || '',
        unit: unit || '',
        referenceRange: referenceRange || '',
        parameters: parameters || [],
        loincCode: loincCode || undefined,
        examCode: examCode || undefined,
        notes: notes || '',
        examDate: examDate || '',
        doctorId: req.user?.uid,
        createdAt: now,
        updatedAt: now,
      };

      // Συμπλήρωση παραμέτρων από το Master Data (μόνο για νέες εξετάσεις
      // χωρίς παραμέτρους — δεν αγγίζει υπάρχουσες καταχωρήσεις)
      if (exam.parameters && exam.parameters.length === 0) {
        try {
          exam = await examParameters.prefillExam(exam);
        } catch (err) {
          console.warn('Exam parameter prefill failed (συνεχίζουμε χωρίς):', err);
        }
      }

      const saved = await dbService.saveExam(exam);
      res.status(201).json({ exam: saved });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
});

/** Ενημέρωση εξέτασης */
app.put('/api/exams/:id', authMiddleware(), async (req: Request, res: Response) => {
    try {
      const exam = await dbService.updateExam(req.params.id, req.body);
      if (!exam) {
        res.status(404).json({ error: 'Η εξέταση δεν βρέθηκε' });
        return;
      }
      res.json({ exam });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
});

/** Διαγραφή εξέτασης */
app.delete('/api/exams/:id', authMiddleware(), async (req: Request, res: Response) => {
    try {
      // Απεσταλμένη εξέταση σε κέντρο αναφοράς δεν διαγράφεται
      const exam = await dbService.getExam(req.params.id);
      if (!exam) {
        res.status(404).json({ error: 'Η εξέταση δεν βρέθηκε', code: 'NOT_FOUND' });
        return;
      }
      if (String(exam.status) === 'sent') {
        res.status(409).json({
          error:
            'Η εξέταση έχει αποσταλεί σε κέντρο αναφοράς και δεν μπορεί να διαγραφεί.',
          code: 'EXAM_SENT',
          exam: { id: exam.id, status: exam.status, sentToCenter: (exam as any).sentToCenter },
        });
        return;
      }

      await dbService.deleteExam(req.params.id);
      res.json({ message: 'Η εξέταση διαγράφηκε επιτυχώς' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
});

// ========== LAB RESULTS (protected) ==========

app.post('/api/upload', authMiddleware(), upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Δεν βρέθηκε αρχείο' });
    }

    const format = req.body.format || 'csv';
    const patientId = req.body.patientId;

    const parseResult = await labParserFactory.parse(
      req.file.buffer.toString('utf-8'),
      format,
      { patientId }
    );

    res.json(parseResult);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/lab-results/parse', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { data, format, patientId } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Δεν βρέθηκαν δεδομένα' });
    }

    const parseResult = await labParserFactory.parse(data, format || 'json', { patientId });
    res.json(parseResult);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ANALYSIS (protected) ==========

app.post('/api/analyze', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { results, patient, historicalResults } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({ error: 'Απαιτούνται results (array)' });
    }
    if (!patient) {
      return res.status(400).json({ error: 'Απαιτούνται στοιχεία ασθενούς' });
    }

    // Rule-based analysis
    const analyses = ruleEngine.analyzeMultiple(results, patient);

    // ML analysis (if historical data available)
    const mlAnalysis = mlEngine.analyze(results, historicalResults || {});

    // Generate report
    const diagnosticReport = ruleEngine.generateReport(patient, results, analyses);
    const summary = ruleEngine.createLabResultSummary(analyses);

    res.json({
      analyses,
      mlAnalysis,
      diagnosticReport,
      summary,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/rule-based', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { results, patient } = req.body;

    if (!results || !patient) {
      return res.status(400).json({ error: 'Απαιτούνται results και patient' });
    }

    const analyses = ruleEngine.analyzeMultiple(results, patient);
    const summary = ruleEngine.createLabResultSummary(analyses);

    res.json({ analyses, summary });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/ml', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { results, historicalResults } = req.body;

    if (!results) {
      return res.status(400).json({ error: 'Απαιτούνται results' });
    }

    const mlAnalysis = mlEngine.analyze(results, historicalResults || {});
    res.json(mlAnalysis);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== REPORTS (protected) ==========

app.post('/api/reports/generate', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const { report, format } = req.body;

    if (!report) {
      return res.status(400).json({ error: 'Απαιτείται diagnosticReport' });
    }

    const generated = reportGenerator.generate(report, format || 'html');
    res.json(generated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== REFERENCE RANGES ==========

app.get('/api/reference-ranges', (_req: Request, res: Response) => {
  const ranges = Object.fromEntries(referenceRangeManager.getAllRanges());
  res.json({ ranges, count: referenceRangeManager.count });
});

app.get('/api/reference-ranges/:testCode', (req: Request, res: Response) => {
  const range = referenceRangeManager.getRange(req.params.testCode);
  if (!range) {
    return res.status(404).json({ error: 'Δεν βρέθηκε reference range' });
  }
  res.json(range);
});

app.get('/api/reference-ranges/:testCode/patient/:patientId', (req: Request, res: Response) => {
  // TODO: Fetch patient from Firebase, for now return base range
  const range = referenceRangeManager.getRange(req.params.testCode);
  if (!range) {
    return res.status(404).json({ error: 'Δεν βρέθηκε reference range' });
  }
  res.json(range);
});

app.post('/api/reference-ranges', authMiddleware(), requireRole('admin', 'lab_technician'), (req: Request, res: Response) => {
  const { testCode, range } = req.body;
  if (!testCode || !range) {
    return res.status(400).json({ error: 'Απαιτούνται testCode και range' });
  }
  referenceRangeManager.setRange(testCode, range);
  res.status(201).json({ message: 'Επιτυχής ενημέρωση', testCode });
});

// ========== SUPPORTED FORMATS ==========

app.get('/api/formats', (_req: Request, res: Response) => {
  res.json({
    supportedFormats: labParserFactory.getSupportedFormats(),
    supportedReportFormats: ['json', 'html', 'csv'],
  });
});

// ============================================================
// ============================================================
// LOINC SEARCH – από το Exam Catalog (Firebase + τοπική cache)
// Τα δεδομένα προέρχονται από το ΗΔΙΚΑ Lab Data Repository API
// ============================================================

import { loincCache } from '../services/loinc-cache.service';
import { examCatalog } from '../services/exam-catalog.service';
import { examLoinc } from '../services/exam-loinc.service';
import { examParameters } from '../services/exam-parameters.service';

interface LoincResult {
  loincNum: string;
  component: string;
  property: string;
  timeAspect: string;
  system: string;
  scaleType: string;
  methodType: string;
  class: string;
  longCommonName: string;
  greekName: string;
}

app.get('/api/loinc/search', (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    const source = (req.query.source as string || 'exam-catalog').trim();

    if (!q || q.length < 2) {
      res.json({ results: [], total: 0 });
      return;
    }

    // ── Source: exam-loinc (απευθείας από το masterdata LOINC endpoint) ──
    if (source === 'exam-loinc') {
      if (!examLoinc.isLoaded) {
        res.json({ results: [], total: 0, recordsFound: 0, message: 'Exam LOINC catalog not loaded — run sync first' });
        return;
      }

      const loincResults = examLoinc.searchExams(q, 20);

      if (loincResults.length === 0) {
        // Fallback to local LOINC cache
        const localResults = loincCache.searchLocal(q, 20);
        res.json({
          results: localResults.map(r => ({
            loincNum: r.loincCode,
            component: r.component,
            property: r.property || '',
            timeAspect: r.timeAspect || '',
            system: r.system,
            scaleType: r.scale || '',
            methodType: r.method || '',
            class: r.loincClass || '',
            longCommonName: r.longName || r.description || '',
            greekName: `${r.component}${r.system ? ` (${r.system})` : ''}`,
            examCode: '',
          })),
          total: localResults.length,
          recordsFound: localResults.length,
          source: 'exam-loinc',
        });
        return;
      }

      const results = loincResults.map(r => ({
        loincNum: r.loincCode,
        component: r.loincComponent,
        property: '',
        timeAspect: '',
        system: r.loincSystem,
        scaleType: r.loincScale,
        methodType: r.loincMethod,
        class: r.loincClass,
        longCommonName: r.longName,
        greekName: r.greekName,
        examCode: r.examCode || '',
      }));

      res.json({ results, total: results.length, recordsFound: results.length, source: 'exam-loinc' });
      return;
    }

    // ── Source: exam-catalog (default – εξετάσεις με LOINC από ΗΔΙΚΑ) ──
    const examResults = examCatalog.searchExams(q, 20);

    // Αν δεν βρέθηκαν αποτελέσματα, δοκιμάζουμε και την LOINC cache
    if (examResults.length === 0) {
      const localResults = loincCache.searchLocal(q, 20);
      res.json({
        results: localResults.map(r => ({
          loincNum: r.loincCode,
          component: r.component,
          property: r.property || '',
          timeAspect: r.timeAspect || '',
          system: r.system,
          scaleType: r.scale || '',
          methodType: r.method || '',
          class: r.loincClass || '',
          longCommonName: r.longName || r.description || '',
          greekName: `${r.component}${r.system ? ` (${r.system})` : ''}`,
          examCode: '', // δεν έχουμε examCode για LOINC cache entries
        })),
        total: localResults.length,
        recordsFound: localResults.length,
        source: 'exam-catalog',
      });
      return;
    }

    // Μετατροπή των exam results σε LoincResult (με examCode για τα parameters)
    const results = examResults.map(er => {
      const entry = examCatalog.getExam(er.examCode);
      const primaryLoinc = entry?.suggestedLoincs?.[0];

      return {
        loincNum: er.loincCode,
        component: primaryLoinc?.loincComponent || er.examDescription,
        property: primaryLoinc?.loincScale || '',
        timeAspect: '',
        system: primaryLoinc?.loincSystem || '',
        scaleType: primaryLoinc?.loincScale || '',
        methodType: primaryLoinc?.loincMethod || '',
        class: primaryLoinc?.loincClass || '',
        longCommonName: primaryLoinc?.longName || er.examDescription,
        greekName: er.examDescription,
        examCode: er.examCode, // κωδικός εξέτασης για lookup παραμέτρων
      };
    });

    res.json({ results, total: results.length, recordsFound: results.length, source: 'exam-catalog' });
  } catch (err: any) {
    console.error('LOINC search error:', err);
    res.status(500).json({ error: 'Σφάλμα αναζήτησης LOINC' });
  }
});

// ============================================================
// LOINC PARAMETERS – από το Exam Catalog (suggested LOINCs)
// Τα ονόματα των παραμέτρων επιλύονται από την LOINC cache
// ============================================================

app.get('/api/loinc/parameters', (req: Request, res: Response) => {
  try {
    const loincNum = (req.query.loincNum as string || '').trim();
    const examCode = (req.query.examCode as string || '').trim();
    const source = (req.query.source as string || 'exam-catalog').trim();

    if (!loincNum && !examCode) {
      res.json({ loincNum: '', parameters: [], title: '' });
      return;
    }

    // Get Greek name from local LOINC cache
    const cachedName = loincNum ? loincCache.getGreekName(loincNum) : '';
    let greekTitle = cachedName ? cachedName.replace(/\s*\(.*?\)\s*$/, '').trim() : '';

    // Αναζήτηση παραμέτρων
    let suggestedLoincs: any[] = [];
    let effectiveExamCode = examCode;

    // ── exam-loinc source: παράμετροι από loincsExaminations ──
    if (source === 'exam-loinc' && loincNum) {
      // Synthetic key "exam:NNN" για ομαδοποιημένα αποτελέσματα
      if (loincNum.startsWith('exam:')) {
        const examId = parseInt(loincNum.replace('exam:', ''), 10);
        if (!isNaN(examId)) {
          const examTitle = examLoinc.getExaminationTitle(examId);
          greekTitle = examTitle || greekTitle;
          const elParams = examLoinc.getParametersByExamId(examId);
          if (elParams.length > 0) {
            const params = elParams.map((p: any) => ({
              loincNum: p.loincCode || '',
              name: p.loincComponent
                ? `${p.loincComponent}${p.loincSystem ? ` (${p.loincSystem})` : ''}`
                : p.longName || p.loincCode || '',
              type: 'decimal',
            }));
            res.json({ loincNum, title: greekTitle, parameters: params, source: 'exam-loinc' });
            return;
          }
        }
        res.json({ loincNum, title: greekTitle, parameters: [], source: 'exam-loinc' });
        return;
      }

      const loincEntry = examLoinc.getEntry(loincNum);
      const elParams = examLoinc.getParameters(loincNum);

      // Το title είναι το examinationDescription (η εξέταση-γονέας), όχι το loincComponent
      if (loincEntry && loincEntry.loincsExaminations && loincEntry.loincsExaminations.length > 0) {
        greekTitle = loincEntry.loincsExaminations[0].examinationDescription || loincEntry.loincComponent;
      } else if (loincEntry) {
        greekTitle = greekTitle || loincEntry.loincComponent;
      }

      if (elParams.length > 0) {
        const parameters = elParams.map((p: any) => ({
          loincNum: p.loincCode || '',
          name: p.loincComponent
            ? `${p.loincComponent}${p.loincSystem ? ` (${p.loincSystem})` : ''}`
            : p.longName || p.loincCode || '',
          type: 'decimal',
        }));

        res.json({ loincNum, title: greekTitle, parameters, source: 'exam-loinc' });
        return;
      }
      // Κανένα loincsExaminations → κενές παράμετροι
      res.json({ loincNum, title: greekTitle, parameters: [], source: 'exam-loinc' });
      return;
    }

    // ── exam-catalog source: παράμετροι από suggestedLoincs ──
    if (effectiveExamCode) {
      // Απευθείας lookup με examCode — το πιο αξιόπιστο
      const entry = examCatalog.getExam(effectiveExamCode);
      if (entry) {
        greekTitle = greekTitle || entry.examDescription;
        // Επιστρέφουμε ΟΛΑ τα suggested LOINCs ως παραμέτρους
        suggestedLoincs = entry.suggestedLoincs;
      }
    } else if (loincNum) {
      // Fallback: αναζήτηση με loincNum
      suggestedLoincs = examCatalog.getParameters(loincNum);
    }

    // Manual Greek fallback for common CBC parameters
    const manualGreekNames: Record<string, string> = {
      '32623-1': 'Μέσος όγκος αιμοπεταλίων MPV (Αίμα, Αυτόματη καταμέτρηση)',
      '4544-3': 'Αιματοκρίτης HCT (Αίμα, Αυτόματη καταμέτρηση)',
      '786-4': 'Μέση πυκνότητα αιμοσφαιρίνης MCHC (Ερυθρά, Αυτόματη καταμέτρηση)',
      '787-2': 'Μέσος όγκος ερυθροκυττάρων MCV (Ερυθρά, Αυτόματη καταμέτρηση)',
      '788-0': 'Εύρος κατανομής ερυθροκυττάρων RDW (Ερυθρά, Αυτόματη καταμέτρηση)',
    };

    const parameters = suggestedLoincs.map((sl: any) => {
      let name = '';
      // 1. Manual Greek fallback
      if (sl.loincCode && manualGreekNames[sl.loincCode]) {
        name = manualGreekNames[sl.loincCode];
      }
      // 2. LOINC name cache
      if (!name && sl.loincCode) {
        const gn = loincCache.getGreekName(sl.loincCode);
        if (gn && !/^[A-Za-z]/.test(gn)) { // πρέπει να ξεκινάει με ελληνικό χαρακτήρα
          name = gn;
        }
      }
      // 3. Fallback: loincComponent + loincSystem από τα δεδομένα ΗΔΙΚΑ
      if (!name) {
        name = sl.loincComponent
          ? `${sl.loincComponent}${sl.loincSystem ? ` (${sl.loincSystem})` : ''}`
          : sl.longName || sl.loincCode || '';
      }

      return {
        loincNum: sl.loincCode || '',
        name,
        type: 'decimal',
      };
    });

    res.json({ loincNum: loincNum || suggestedLoincs[0]?.loincCode || '', title: greekTitle, parameters });
  } catch (err: any) {
    console.error('LOINC parameters error:', err);
    const loincNum = (req.query.loincNum as string || '').trim();
    const cachedName = loincNum ? loincCache.getGreekName(loincNum) : '';
    res.json({
      loincNum,
      title: cachedName ? cachedName.replace(/\s*\(.*?\)\s*$/, '').trim() : '',
      parameters: [],
    });
  }
});

// ============================================================
// LOINC LOCAL SEARCH – search cached Lab Data Repository codes
// ============================================================

app.get('/api/loinc/local-search', (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  if (!q || q.length < 2) {
    res.json({ results: [], total: 0 });
    return;
  }

  const results = loincCache.searchLocal(q, limit);
  res.json({ results, total: results.length });
});

// ============================================================
// LOINC SYNC – sync all LOINC codes from Lab Data Repository
// ============================================================

app.post('/api/loinc/sync', async (_req: Request, res: Response) => {
  try {
    res.json({ status: 'started', message: 'Ο συγχρονισμός ξεκίνησε στο παρασκήνιο.' });

    loincCache.syncFromApi((page, totalPages, count) => {
      console.log(`🔄 LOINC sync progress: page ${page}/${totalPages} (${count} codes cached)`);
    }).then(result => {
      console.log(`✅ LOINC sync completed: ${result.total} codes in ${result.pages} pages`);
    }).catch(err => {
      console.error('❌ LOINC sync failed:', err);
    });
  } catch (err: any) {
    console.error('LOINC sync error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Σφάλμα συγχρονισμού LOINC' });
    }
  }
});

// ============================================================
// LOINC SYNC STATUS
// ============================================================

app.get('/api/loinc/sync-status', (_req: Request, res: Response) => {
  res.json({
    loaded: loincCache.isLoaded,
    cacheSize: loincCache.cacheSize,
  });
});

// ============================================================
// EXAM CATALOG – συγχρονισμός εξετάσεων από ΗΔΙΚΑ → Firebase
// ============================================================

app.post('/api/exam-catalog/sync', async (_req: Request, res: Response) => {
  try {
    res.json({ status: 'started', message: 'Ο συγχρονισμός του καταλόγου εξετάσεων ξεκίνησε.' });

    examCatalog.syncFromApi((page, totalPages, count) => {
      console.log(`📋 Exam catalog sync: page ${page}/${totalPages} (${count} entries)`);
    }).then(result => {
      console.log(`✅ Exam catalog sync complete: ${result.total} exams`);
    }).catch(err => {
      console.error('❌ Exam catalog sync failed:', err);
    });
  } catch (err: any) {
    console.error('Exam catalog sync error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Σφάλμα συγχρονισμού καταλόγου εξετάσεων' });
    }
  }
});

app.get('/api/exam-catalog/status', (_req: Request, res: Response) => {
  res.json({
    loaded: examCatalog.isLoaded,
    size: examCatalog.size,
  });
});

// ============================================================
// EXAM LOINC – συγχρονισμός LOINC masterdata → Firestore exam_loinc
// ============================================================

app.post('/api/exam-loinc/sync', async (_req: Request, res: Response) => {
  try {
    if (examLoinc.isSyncing) {
      res.json({ status: 'busy', message: 'Ο συγχρονισμός είναι ήδη σε εξέλιξη.', progress: examLoinc.progress });
      return;
    }

    res.json({ status: 'started', message: 'Ο συγχρονισμός του exam LOINC ξεκίνησε.' });

    examLoinc.syncFromApi((page, totalPages, count) => {
      console.log(`📋 Exam LOINC sync: page ${page}/${totalPages} (${count} entries)`);
    }).then(result => {
      console.log(`✅ Exam LOINC sync complete: ${result.total} entries`);
    }).catch(err => {
      console.error('❌ Exam LOINC sync failed:', err);
    });
  } catch (err: any) {
    console.error('Exam LOINC sync error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Σφάλμα συγχρονισμού exam LOINC' });
    }
  }
});

app.get('/api/exam-loinc/status', (_req: Request, res: Response) => {
  res.json({
    loaded: examLoinc.isLoaded,
    size: examLoinc.size,
    syncing: examLoinc.isSyncing,
    progress: examLoinc.progress,
  });
});

// ============================================================
// ADMIN SYNC – προστατευμένοι endpoints για διαχειριστές
// ============================================================

/**
 * GET /api/admin/sync/status
 * Επιστρέφει την κατάσταση και για τους δύο πίνακες.
 */
app.get('/api/admin/sync/status', authMiddleware(), requireRole('admin'), async (_req: Request, res: Response) => {
  let parameterStats: Record<string, any> = {
    examCount: 0,
    parameterCount: 0,
    examsWithParameters: 0,
    lastSyncedAt: null,
    syncing: examParameters.isSyncing,
    progress: examParameters.currentProgress,
  };
  try {
    parameterStats = await examParameters.getStats();
  } catch (err) {
    console.warn('Exam parameter stats unavailable:', err);
  }

  res.json({
    examCatalog: {
      loaded: examCatalog.isLoaded,
      size: examCatalog.size,
      syncing: examCatalog.isSyncing,
      progress: examCatalog.syncProgress,
    },
    examLoinc: {
      loaded: examLoinc.isLoaded,
      size: examLoinc.size,
      syncing: examLoinc.isSyncing,
      progress: examLoinc.progress,
    },
    examParameters: parameterStats,
  });
});

/**
 * POST /api/admin/sync/exam-catalog
 * Συγχρονισμός του exam_catalog από το ΗΔΙΚΑ API → PostgreSQL.
 * Body: { offset?: number } — προαιρετικό, σελίδα έναρξης (1-based).
 */
app.post('/api/admin/sync/exam-catalog', authMiddleware(), requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { offset } = req.body || {};
    const startPage = offset ? Math.max(1, parseInt(String(offset), 10)) : 1;

    res.json({
      status: 'started',
      message: startPage > 1
        ? `Ο συγχρονισμός του καταλόγου εξετάσεων ξεκίνησε από τη σελίδα ${startPage}.`
        : 'Ο συγχρονισμός του καταλόγου εξετάσεων ξεκίνησε.',
      startPage,
    });

    examCatalog.syncFromApi(
      (page, totalPages, count) => {
        console.log(`📋 [Admin] Exam catalog sync: page ${page}/${totalPages} (${count} entries)`);
      },
      startPage,
    ).then(result => {
      console.log(`✅ [Admin] Exam catalog sync complete: ${result.total} exams (pages ${result.startPage}–${result.endPage})`);
    }).catch(err => {
      console.error('❌ [Admin] Exam catalog sync failed:', err);
    });
  } catch (err: any) {
    console.error('[Admin] Exam catalog sync error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Σφάλμα συγχρονισμού καταλόγου εξετάσεων' });
    }
  }
});

/**
 * POST /api/admin/sync/exam-loinc
 * Συγχρονισμός του exam_loinc από το ΗΔΙΚΑ masterdata → τοπικός δίσκος.
 * Πάντα ολοκληρωτική μεταφορά (χωρίς offset).
 */
app.post('/api/admin/sync/exam-loinc', authMiddleware(), requireRole('admin'), async (req: Request, res: Response) => {
  try {
    if (examLoinc.isSyncing) {
      res.json({
        status: 'busy',
        message: 'Ο συγχρονισμός είναι ήδη σε εξέλιξη.',
        progress: examLoinc.progress,
      });
      return;
    }

    res.json({
      status: 'started',
      message: 'Ο συγχρονισμός του exam LOINC ξεκίνησε (ολοκληρωτική μεταφορά).',
      startPage: 1,
    });

    examLoinc.syncFromApi(
      (page, totalPages, count) => {
        console.log(`📋 [Admin] Exam LOINC sync: page ${page}/${totalPages} (${count} entries)`);
      },
      1, // Πάντα από την αρχή, χωρίς offset
    ).then(result => {
      console.log(`✅ [Admin] Exam LOINC sync complete: ${result.total} entries (pages ${result.startPage}–${result.endPage})`);
    }).catch(err => {
      console.error('❌ [Admin] Exam LOINC sync failed:', err);
    });
  } catch (err: any) {
    console.error('[Admin] Exam LOINC sync error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Σφάλμα συγχρονισμού exam LOINC' });
    }
  }
});

// ============================================================
// EXAM PARAMETERS – συγχρονισμός παραμέτρων εξετάσεων από Master Data
// ============================================================

/**
 * POST /api/admin/sync/exam-parameters
 * Χτίζει τον πίνακα `exam_parameters` + εμπλουτίζει το `exam_catalog`
 * (examinationId / examinationGroup / parameterCount) από τις δύο πηγές
 * Master Data του ΗΔΙΚΑ. Εκτελείται στο παρασκήνιο.
 */
app.post(
  '/api/admin/sync/exam-parameters',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    if (examParameters.isSyncing) {
      res.status(409).json({
        status: 'busy',
        message: 'Ο συγχρονισμός παραμέτρων είναι ήδη σε εξέλιξη.',
        progress: examParameters.currentProgress,
      });
      return;
    }

    res.json({
      status: 'started',
      message: 'Ο συγχρονισμός των παραμέτρων εξετάσεων ξεκίνησε.',
    });

    examParameters
      .syncFromApi(p => {
        if (p.count > 0) {
          console.log(
            `📋 [Admin] Exam parameters sync (${p.phase}): σελίδα ${p.page}/${p.totalPages} (${p.count})`
          );
        }
      })
      .catch(err => {
        console.error('❌ [Admin] Exam parameters sync failed:', err?.message || err);
      });
  }
);

/** GET /api/admin/sync/exam-parameters/status – πρόοδος + στατιστικά */
app.get(
  '/api/admin/sync/exam-parameters/status',
  authMiddleware(),
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      res.json(await examParameters.getStats());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Σφάλμα ανάγνωσης κατάστασης' });
    }
  }
);

/**
 * GET /api/exam-parameters/:examCode
 * Παράμετροι εξέτασης από το Master Data (για prefill στη φόρμα εξέτασης).
 */
app.get('/api/exam-parameters/:examCode', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const examCode = String(req.params.examCode || '').trim();
    if (!examCode) {
      res.status(400).json({ error: 'Απαιτείται examCode', code: 'VALIDATION_ERROR' });
      return;
    }

    const [parameters, meta] = await Promise.all([
      examParameters.getExamParameters(examCode),
      dbService.getExamMasterMeta(examCode),
    ]);

    res.json({
      examCode,
      examDescription: meta?.examDescription ?? null,
      edapyCode: meta?.edapyCode ?? null,
      examinationId: meta?.examinationId ?? null,
      examinationGroup: meta?.examinationGroup ?? null,
      parameters,
      total: parameters.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Σφάλμα ανάγνωσης παραμέτρων εξέτασης' });
  }
});

// ============================================================
// REFERENCE CENTERS — αποστολή εξετάσεων σε κέντρο αναφοράς (SLIS)
// ============================================================

/** GET /api/reference-centers — λίστα κέντρων */
app.get('/api/reference-centers', authMiddleware(), async (_req: Request, res: Response) => {
  try {
    res.json({ centers: await dbService.listReferenceCenters() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reference-centers/:id/worklist?date=YYYY-MM-DD
 * Λίστα εργασίας: παραπεμπτικά & εξετάσεις που στάλθηκαν στο κέντρο τη συγκεκριμένη ημέρα.
 */
app.get(
  '/api/reference-centers/:id/worklist',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const center = await dbService.getReferenceCenter(req.params.id);
      if (!center) {
        res.status(404).json({ error: 'Το κέντρο αναφοράς δεν βρέθηκε' });
        return;
      }

      const dateParam = String(req.query.date || '').trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam);
      if (!match) {
        res.status(400).json({ error: 'Απαιτείται παράμετρος date (YYYY-MM-DD)' });
        return;
      }

      const [, year, month, day] = match;
      const fromIso = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0).toISOString();
      const toIso = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999).toISOString();

      const doctorId = req.user?.role === 'admin' ? undefined : req.user?.uid;
      const exams = await dbService.listExamsSentToCenter(center.id, fromIso, toIso, doctorId);

      const examIds = exams.map(exam => exam.referralId).filter(Boolean);
      const referralIds = Array.from(new Set(examIds));
      const referrals = await Promise.all(referralIds.map(id => dbService.getReferral(id)));

      const grouped = new Map<string, typeof exams>();
      for (const exam of exams) {
        const key = exam.referralId || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(exam);
      }

      const withinRange = (value?: string) => {
        if (!value) return false;
        const time = new Date(value).getTime();
        return (
          !Number.isNaN(time) &&
          time >= new Date(fromIso).getTime() &&
          time <= new Date(toIso).getTime()
        );
      };

      const items = Array.from(grouped.entries()).map(([referralId, referralExams]) => {
        const referral = referrals.find(item => item?.id === referralId) || null;
        const orders: Array<{
          centerId: string;
          centerName: string;
          orderNo: string;
          lisOrderNo?: string;
          status: string;
          sentAt: string;
          tests: Array<{ code: string; barcode?: string }>;
        }> = Array.isArray((referral as any)?.referenceOrders)
          ? (referral as any).referenceOrders.filter(
              (order: any) =>
                order.centerId === center.id && withinRange(order.sentAt)
            )
          : [];

        const testBarcodes = new Map<string, string>();
        for (const order of orders) {
          for (const test of order.tests || []) {
            if (test.barcode) testBarcodes.set(test.code, test.barcode);
          }
        }

        const sentAt =
          referralExams
            .map(exam => (exam as any).sentToCenter?.sentAt as string | undefined)
            .filter((value): value is string => Boolean(value))
            .sort()[0] || orders[0]?.sentAt;

        return {
          referralId,
          barcode: referral?.barcode,
          patientId: referral?.patientId || referralExams[0]?.patientId,
          patientName: referral?.patientName || referralExams[0]?.patientName || '',
          orderNo: orders.map(order => order.orderNo).filter(Boolean).join(', ') || undefined,
          lisOrderNo: orders.map(order => order.lisOrderNo).filter(Boolean).join(', ') || undefined,
          status: referral?.status,
          sentAt,
          exams: referralExams.map(exam => {
            const sent = (exam as any).sentToCenter || {};
            return {
              id: exam.id,
              name: exam.name,
              code: sent.code,
              loincCode: sent.loincCode || exam.loincCode,
              barcode: testBarcodes.get(sent.code),
              status: exam.status,
            };
          }),
        };
      });

      items.sort((a, b) => {
        const timeDiff = new Date(a.sentAt || 0).getTime() - new Date(b.sentAt || 0).getTime();
        return timeDiff !== 0 ? timeDiff : a.patientName.localeCompare(b.patientName, 'el');
      });

      res.json({
        center: { id: center.id, name: center.name },
        date: dateParam,
        referrals: items,
        totals: {
          referrals: items.length,
          exams: items.reduce((sum, item) => sum + item.exams.length, 0),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** PUT /api/reference-centers/:id — ενημέρωση κέντρου (admin) */
app.put(
  '/api/reference-centers/:id',
  authMiddleware(),
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const existing = await dbService.getReferenceCenter(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Το κέντρο δεν βρέθηκε', code: 'CENTER_NOT_FOUND' });
        return;
      }
      const { name, url, active, config } = req.body || {};
      if (url !== undefined && !String(url).trim()) {
        res.status(400).json({ error: 'Απαιτείται διεύθυνση (URL)', code: 'VALIDATION_ERROR' });
        return;
      }
      const saved = await dbService.saveReferenceCenter({
        ...existing,
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(url !== undefined ? { url: String(url).trim() } : {}),
        ...(active !== undefined ? { active: Boolean(active) } : {}),
        ...(config !== undefined ? { config: { ...existing.config, ...config } } : {}),
      });
      res.json({ message: 'Το κέντρο αναφοράς αποθηκεύτηκε', center: saved });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** GET /api/efulfillment… no — GET /api/referrals/:id/reference-center/preview */
app.get('/api/referrals/:id/reference-center/preview', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const centerId = String(req.query.centerId || '').trim();
    if (!centerId) {
      res.status(400).json({ error: 'Απαιτείται centerId', code: 'VALIDATION_ERROR' });
      return;
    }
    const examIds = req.query.examIds
      ? String(req.query.examIds).split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    // choices: JSON σε query (π.χ. {"exam_x":"ΓΕΝΙΚΗ ΑΙΜ"} )
    let choices: Record<string, string> | undefined;
    if (req.query.choices) {
      try {
        const parsed = JSON.parse(String(req.query.choices));
        if (parsed && typeof parsed === 'object') choices = parsed as Record<string, string>;
      } catch {
        /* ignore malformed */
      }
    }
    res.json(await previewCenterSend(centerId, req.params.id, examIds, choices));
  } catch (error: any) {
    const code = error?.code as string | undefined;
    const status = code === 'CENTER_NOT_FOUND' || code === 'REFERRAL_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ error: error?.message || 'Σφάλμα προεπισκόπησης', code });
  }
});

/** POST /api/referrals/:id/reference-center/send — αποστολή στο κέντρο */
app.post('/api/referrals/:id/reference-center/send', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const centerId = String(req.body?.centerId || '').trim();
    const examIds: string[] | undefined = Array.isArray(req.body?.examIds)
      ? req.body.examIds.map(String)
      : undefined;
    const choices: Record<string, string> | undefined =
      req.body?.choices && typeof req.body.choices === 'object'
        ? (req.body.choices as Record<string, string>)
        : undefined;

    if (!centerId) {
      res.status(400).json({ error: 'Απαιτείται centerId', code: 'VALIDATION_ERROR' });
      return;
    }

    const outcome = await sendReferralToCenter({
      centerId,
      referralId: req.params.id,
      examIds,
      choices,
      doctorId: req.user!.uid,
    });

    res.status(201).json({
      message:
        `Η παραγγελία στάλθηκε στο «${outcome.centerName}» ` +
        `(${outcome.tests.length} εξετάσεις, ORDERNO ${outcome.orderNo})`,
      ...outcome,
    });
  } catch (error: any) {
    const code = error?.code as string | undefined;
    const status =
      code === 'CENTER_NOT_FOUND' || code === 'REFERRAL_NOT_FOUND'
        ? 404
        : code === 'CENTER_INACTIVE' ||
          code === 'NO_CENTER_URL' ||
          code === 'NO_SENDER_CODE' ||
          code === 'NO_TESTS' ||
          code === 'AMBIGUOUS_MAPPING' ||
          code === 'PATIENT_NOT_FOUND'
        ? 422
        : 502;
    res.status(status).json({
      error: error?.message || 'Σφάλμα αποστολής στο κέντρο αναφοράς',
      code: code || 'SEND_FAILED',
    });
  }
});

/** POST /api/referrals/:id/reference-center/fetch-results — άντληση αποτελεσμάτων από το κέντρο */
app.post('/api/referrals/:id/reference-center/fetch-results', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const centerId = String(req.body?.centerId || '').trim();
    if (!centerId) {
      res.status(400).json({ error: 'Απαιτείται centerId', code: 'VALIDATION_ERROR' });
      return;
    }
    const outcome = await fetchResultsFromCenter(centerId, req.params.id);
    res.json(outcome);
  } catch (error: any) {
    const code = error?.code as string | undefined;
    const status =
      code === 'CENTER_NOT_FOUND' || code === 'REFERRAL_NOT_FOUND'
        ? 404
        : code === 'NO_SENT_ORDER' || code === 'NO_RESULTS_URL'
        ? 422
        : 502;
    res.status(status).json({
      error: error?.message || 'Σφάλμα άντλησης αποτελεσμάτων από το κέντρο',
      code: code || 'FETCH_FAILED',
    });
  }
});

// ============================================================
// FINANCE / ΤΑΜΕΙΟ — οφειλές σε κέντρα αναφοράς & φορείς,
// απαιτήσεις από ασθενείς.
// ============================================================

const FINANCE_DIRECTIONS = ['debt', 'receivable'] as const;
const FINANCE_PARTY_TYPES = ['reference_center', 'payer', 'patient'] as const;
const FINANCE_STATUSES = ['pending', 'partial', 'settled', 'cancelled'] as const;

/** Αυτόματος συγχρονισμός (1η επίσκεψη της ημέρας): τελευταίο 6μηνο */
const AUTO_SYNC_MONTHS = 6;
/** Χειροκίνητος συγχρονισμός (κουμπί «Ανανέωση»): 30ετία */
const MANUAL_SYNC_MONTHS = 360;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function parseFinanceAmount(value: any): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num =
    typeof value === 'number'
      ? value
      : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  return roundMoney(num);
}

/** GET /api/finance/entries — λίστα κινήσεων ταμείου */
app.get('/api/finance/entries', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const doctorId = req.user?.role === 'admin' ? undefined : req.user?.uid;
    const direction = String(req.query.direction || '').trim();
    const partyType = String(req.query.partyType || '').trim();
    const status = String(req.query.status || '').trim();

    const entries = await dbService.listFinanceEntries({
      doctorId,
      direction: (FINANCE_DIRECTIONS as readonly string[]).includes(direction) ? direction : undefined,
      partyType: (FINANCE_PARTY_TYPES as readonly string[]).includes(partyType) ? partyType : undefined,
      status: (FINANCE_STATUSES as readonly string[]).includes(status) ? status : undefined,
      patientId: (req.query.patientId as string) || undefined,
      referralId: (req.query.referralId as string) || undefined,
      dueFrom: (req.query.dueFrom as string) || undefined,
      dueTo: (req.query.dueTo as string) || undefined,
    });

    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
      ? entries.filter(entry =>
          [entry.partyName, entry.patientName, entry.description, entry.referralBarcode, entry.notes]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(q))
        )
      : entries;

    res.json({ entries: filtered, total: filtered.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/finance/summary — σύνολα οφειλών/απαιτήσεων */
app.get('/api/finance/summary', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const doctorId = req.user?.role === 'admin' ? undefined : req.user?.uid;
    const entries = await dbService.listFinanceEntries({ doctorId });
    const todayDate = new Date().toISOString().slice(0, 10);

    const totals = {
      debts: 0,
      debtsPaid: 0,
      debtsOutstanding: 0,
      receivables: 0,
      receivablesPaid: 0,
      receivablesOutstanding: 0,
      overdueAmount: 0,
      overdueCount: 0,
      openCount: 0,
      settledCount: 0,
      cancelledCount: 0,
      /** Σύνολο οφειλών προς κέντρα όπως το δίνει το API (άθροισμα DeductedAmount) */
      centerOutstandingFromApi: 0,
    };

    const byPartyTypeMap = new Map<
      string,
      {
        direction: string;
        partyType: string;
        count: number;
        amount: number;
        paidAmount: number;
        outstanding: number;
      }
    >();
    const byPartyMap = new Map<
      string,
      {
        direction: string;
        partyType: string;
        partyId?: string;
        partyName: string;
        count: number;
        amount: number;
        paidAmount: number;
        outstanding: number;
      }
    >();

    for (const entry of entries) {
      if (entry.status === 'cancelled') {
        totals.cancelledCount++;
        continue;
      }

      const amount = roundMoney(Number(entry.amount) || 0);
      const paid = roundMoney(Number(entry.paidAmount) || 0);
      const outstanding = roundMoney(Math.max(0, amount - paid));

      if (entry.direction === 'debt') {
        totals.debts = roundMoney(totals.debts + amount);
        totals.debtsPaid = roundMoney(totals.debtsPaid + paid);
        totals.debtsOutstanding = roundMoney(totals.debtsOutstanding + outstanding);
      } else {
        totals.receivables = roundMoney(totals.receivables + amount);
        totals.receivablesPaid = roundMoney(totals.receivablesPaid + paid);
        totals.receivablesOutstanding = roundMoney(totals.receivablesOutstanding + outstanding);
      }

      if (entry.status === 'settled') totals.settledCount++;
      else totals.openCount++;

      const isOverdue =
        Boolean(entry.dueDate) && entry.status !== 'settled' && entry.dueDate! < todayDate && outstanding > 0;
      if (isOverdue) {
        totals.overdueAmount = roundMoney(totals.overdueAmount + outstanding);
        totals.overdueCount++;
      }

      // Άθροισμα DeductedAmount από το κέντρο (πιστωτικά μειώνουν το σύνολο)
      if (entry.source?.deductedAmount !== undefined) {
        totals.centerOutstandingFromApi = roundMoney(
          totals.centerOutstandingFromApi + Number(entry.source.deductedAmount)
        );
      }

      const typeKey = `${entry.direction}|${entry.partyType}`;
      const typeAgg =
        byPartyTypeMap.get(typeKey) ||
        { direction: entry.direction, partyType: entry.partyType, count: 0, amount: 0, paidAmount: 0, outstanding: 0 };
      typeAgg.count++;
      typeAgg.amount = roundMoney(typeAgg.amount + amount);
      typeAgg.paidAmount = roundMoney(typeAgg.paidAmount + paid);
      typeAgg.outstanding = roundMoney(typeAgg.outstanding + outstanding);
      byPartyTypeMap.set(typeKey, typeAgg);

      const partyKey = `${entry.direction}|${entry.partyType}|${entry.partyId || entry.partyName}`;
      const partyAgg =
        byPartyMap.get(partyKey) ||
        {
          direction: entry.direction,
          partyType: entry.partyType,
          partyId: entry.partyId,
          partyName: entry.partyName,
          count: 0,
          amount: 0,
          paidAmount: 0,
          outstanding: 0,
        };
      partyAgg.count++;
      partyAgg.amount = roundMoney(partyAgg.amount + amount);
      partyAgg.paidAmount = roundMoney(partyAgg.paidAmount + paid);
      partyAgg.outstanding = roundMoney(partyAgg.outstanding + outstanding);
      byPartyMap.set(partyKey, partyAgg);
    }

    res.json({
      totals,
      byPartyType: Array.from(byPartyTypeMap.values()),
      byParty: Array.from(byPartyMap.values()).sort((a, b) => b.outstanding - a.outstanding),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/finance/entries — δημιουργία κίνησης */
app.post('/api/finance/entries', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const direction = String(req.body?.direction || 'debt');
    const partyType = String(req.body?.partyType || '');
    if (!(FINANCE_DIRECTIONS as readonly string[]).includes(direction)) {
      res.status(400).json({ error: 'Μη έγκυρος τύπος κίνησης', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!(FINANCE_PARTY_TYPES as readonly string[]).includes(partyType)) {
      res.status(400).json({ error: 'Μη έγκυρος αντισυμβαλλόμενος', code: 'VALIDATION_ERROR' });
      return;
    }

    const amount = parseFinanceAmount(req.body?.amount);
    if (amount === null || amount <= 0) {
      res.status(400).json({ error: 'Συμπληρώστε έγκυρο ποσό μεγαλύτερο από μηδέν', code: 'VALIDATION_ERROR' });
      return;
    }

    const paidAmount = Math.min(Math.max(0, parseFinanceAmount(req.body?.paidAmount) ?? 0), amount);
    const partyId = req.body?.partyId ? String(req.body.partyId) : undefined;
    const patientId = req.body?.patientId ? String(req.body.patientId) : undefined;
    const referralId = req.body?.referralId ? String(req.body.referralId) : undefined;

    let partyName = String(req.body?.partyName || '').trim();
    if (partyType === 'reference_center' && partyId) {
      const center = await dbService.getReferenceCenter(partyId);
      if (!center) {
        res.status(400).json({ error: 'Το κέντρο αναφοράς δεν βρέθηκε', code: 'CENTER_NOT_FOUND' });
        return;
      }
      partyName = partyName || center.name;
    }

    let patientName = String(req.body?.patientName || '').trim() || undefined;
    if (partyType === 'patient' && patientId) {
      const patient = await dbService.getPatient(patientId);
      if (!patient) {
        res.status(400).json({ error: 'Ο ασθενής δεν βρέθηκε', code: 'PATIENT_NOT_FOUND' });
        return;
      }
      patientName = patientName || `${patient.firstName} ${patient.lastName}`.trim();
      partyName = partyName || patientName;
    }

    let referralBarcode = String(req.body?.referralBarcode || '').trim() || undefined;
    if (referralId) {
      const referral = await dbService.getReferral(referralId);
      if (!referral) {
        res.status(400).json({ error: 'Το παραπεμπτικό δεν βρέθηκε', code: 'REFERRAL_NOT_FOUND' });
        return;
      }
      patientName = patientName || referral.patientName;
      referralBarcode = referralBarcode || referral.barcode;
    }

    if (!partyName) {
      res.status(400).json({
        error: 'Συμπληρώστε τον αντισυμβαλλόμενο (κέντρο, φορέα ή ασθενή)',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const now = new Date().toISOString();
    const issueDate = String(req.body?.issueDate || '').trim() || now.slice(0, 10);
    const dueDate = String(req.body?.dueDate || '').trim() || undefined;
    const description = String(req.body?.description || '').trim() || undefined;
    const notes = String(req.body?.notes || '').trim() || undefined;

    const entry: FinanceEntry = {
      id: `finance_${Date.now()}`,
      direction: direction as FinanceEntry['direction'],
      partyType: partyType as FinanceEntry['partyType'],
      partyId,
      partyName,
      patientId: patientId || (partyType === 'patient' ? partyId : undefined),
      patientName,
      referralId,
      referralBarcode,
      description,
      amount,
      paidAmount,
      status: financeStatusFromAmounts({ amount, paidAmount }),
      issueDate,
      dueDate,
      notes,
      payments: [],
      doctorId: req.user?.uid,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await dbService.saveFinanceEntry(entry);
    res.status(201).json({ entry: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** PUT /api/finance/entries/:id — ενημέρωση κίνησης */
app.put('/api/finance/entries/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const existing = await dbService.getFinanceEntry(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Η κίνηση ταμείου δεν βρέθηκε', code: 'ENTRY_NOT_FOUND' });
      return;
    }
    if (req.user?.role !== 'admin' && existing.doctorId && existing.doctorId !== req.user?.uid) {
      res.status(403).json({ error: 'Δεν έχετε πρόσβαση σε αυτή την κίνηση', code: 'FORBIDDEN' });
      return;
    }

    const body = req.body || {};
    const updates: Partial<FinanceEntry> = {};

    if (body.partyType !== undefined) {
      if (!(FINANCE_PARTY_TYPES as readonly string[]).includes(String(body.partyType))) {
        res.status(400).json({ error: 'Μη έγκυρος αντισυμβαλλόμενος', code: 'VALIDATION_ERROR' });
        return;
      }
      updates.partyType = body.partyType;
    }
    if (body.partyId !== undefined) updates.partyId = body.partyId ? String(body.partyId) : undefined;
    if (body.partyName !== undefined) updates.partyName = String(body.partyName).trim();
    if (body.patientId !== undefined) updates.patientId = body.patientId ? String(body.patientId) : undefined;
    if (body.patientName !== undefined) updates.patientName = String(body.patientName).trim() || undefined;
    if (body.referralId !== undefined) updates.referralId = body.referralId ? String(body.referralId) : undefined;
    if (body.referralBarcode !== undefined) {
      updates.referralBarcode = String(body.referralBarcode).trim() || undefined;
    }
    if (body.description !== undefined) updates.description = String(body.description).trim() || undefined;
    if (body.issueDate !== undefined) updates.issueDate = String(body.issueDate).trim() || existing.issueDate;
    if (body.dueDate !== undefined) updates.dueDate = String(body.dueDate).trim() || undefined;
    if (body.notes !== undefined) updates.notes = String(body.notes).trim() || undefined;
    if (body.status !== undefined) {
      if (!(FINANCE_STATUSES as readonly string[]).includes(String(body.status))) {
        res.status(400).json({ error: 'Μη έγκυρη κατάσταση', code: 'VALIDATION_ERROR' });
        return;
      }
      updates.status = body.status as FinanceEntryStatus;
    }

    if (body.amount !== undefined) {
      const amount = parseFinanceAmount(body.amount);
      if (amount === null || amount <= 0) {
        res.status(400).json({ error: 'Συμπληρώστε έγκυρο ποσό', code: 'VALIDATION_ERROR' });
        return;
      }
      updates.amount = amount;
    }
    if (body.paidAmount !== undefined) {
      const paidAmount = parseFinanceAmount(body.paidAmount);
      if (paidAmount === null || paidAmount < 0) {
        res.status(400).json({ error: 'Μη έγκυρο εξοφλημένο ποσό', code: 'VALIDATION_ERROR' });
        return;
      }
      updates.paidAmount = paidAmount;
    }

    const finalAmount = updates.amount ?? existing.amount;
    const finalPaid = updates.paidAmount ?? existing.paidAmount;
    if (finalPaid > finalAmount + 0.005) {
      res.status(400).json({
        error: 'Το εξοφλημένο ποσό δεν μπορεί να υπερβαίνει το συνολικό ποσό',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const saved = await dbService.updateFinanceEntry(req.params.id, updates);
    res.json({ entry: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/finance/entries/:id/payments — καταχώρηση εξόφλησης/είσπραξης */
app.post('/api/finance/entries/:id/payments', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const entry = await dbService.getFinanceEntry(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Η κίνηση ταμείου δεν βρέθηκε', code: 'ENTRY_NOT_FOUND' });
      return;
    }
    if (entry.status === 'cancelled') {
      res.status(409).json({ error: 'Η κίνηση είναι ακυρωμένη', code: 'ENTRY_CANCELLED' });
      return;
    }

    const amount = parseFinanceAmount(req.body?.amount);
    if (amount === null || amount <= 0) {
      res.status(400).json({ error: 'Συμπληρώστε έγκυρο ποσό', code: 'VALIDATION_ERROR' });
      return;
    }

    const balance = roundMoney(Math.max(0, entry.amount - entry.paidAmount));
    if (amount > balance + 0.005) {
      res.status(400).json({
        error: `Το ποσό υπερβαίνει το υπόλοιπο (${balance.toFixed(2)} €)`,
        code: 'AMOUNT_EXCEEDS_BALANCE',
        balance,
      });
      return;
    }

    const now = new Date().toISOString();
    const payment: FinancePayment = {
      id: `payment_${Date.now()}`,
      amount,
      paidAt: String(req.body?.paidAt || '').trim() || now.slice(0, 10),
      method: String(req.body?.method || '').trim() || undefined,
      notes: String(req.body?.notes || '').trim() || undefined,
      createdAt: now,
    };

    const saved = await dbService.updateFinanceEntry(entry.id, {
      paidAmount: roundMoney(entry.paidAmount + amount),
      payments: [...(entry.payments || []), payment],
      status: entry.status === 'settled' ? 'settled' : entry.status,
    });

    res.status(201).json({ entry: saved, payment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** DELETE /api/finance/entries/:id/payments/:paymentId — ακύρωση καταχώρησης */
app.delete(
  '/api/finance/entries/:id/payments/:paymentId',
  authMiddleware(),
  async (req: Request, res: Response) => {
    try {
      const entry = await dbService.getFinanceEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'Η κίνηση ταμείου δεν βρέθηκε', code: 'ENTRY_NOT_FOUND' });
        return;
      }

      const payments = entry.payments || [];
      const payment = payments.find(p => p.id === req.params.paymentId);
      if (!payment) {
        res.status(404).json({ error: 'Η καταχώρηση δεν βρέθηκε', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      const remaining = payments.filter(p => p.id !== payment.id);
      const paidAmount = roundMoney(remaining.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));

      const saved = await dbService.updateFinanceEntry(entry.id, { payments: remaining, paidAmount });
      res.json({ entry: saved });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** DELETE /api/finance/entries/:id — διαγραφή κίνησης */
app.delete('/api/finance/entries/:id', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const existing = await dbService.getFinanceEntry(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Η κίνηση ταμείου δεν βρέθηκε', code: 'ENTRY_NOT_FOUND' });
      return;
    }
    if (req.user?.role !== 'admin' && existing.doctorId && existing.doctorId !== req.user?.uid) {
      res.status(403).json({ error: 'Δεν έχετε πρόσβαση σε αυτή την κίνηση', code: 'FORBIDDEN' });
      return;
    }

    await dbService.deleteFinanceEntry(req.params.id);
    res.json({ message: 'Η κίνηση ταμείου διαγράφηκε' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/finance/sync — συγχρονισμός παραστατικών από κέντρα αναφοράς */
app.post('/api/finance/sync', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const requestedCenterId = String(req.body?.centerId || '').trim();
    // auto: μία φορά την ημέρα, τελευταίο 6μηνο — manual: 30ετία από το κουμπί «Ανανέωση»
    const mode = String(req.body?.mode || 'manual') === 'auto' ? 'auto' : 'manual';
    const today = new Date().toISOString().slice(0, 10);
    const AUTO_SYNC_KEY = 'FINANCE_AUTO_SYNC_DATE';

    if (mode === 'auto') {
      const lastAutoSync = await dbService.getSetting(AUTO_SYNC_KEY);
      if (lastAutoSync === today) {
        res.json({
          skipped: true,
          mode,
          lastSyncAt: lastAutoSync,
          monthsBack: AUTO_SYNC_MONTHS,
          message: 'Ο αυτόματος συγχρονισμός έχει ήδη εκτελεστεί σήμερα',
          results: [],
        });
        return;
      }
    }

    const centers = await dbService.listReferenceCenters();

    const targets = requestedCenterId
      ? centers.filter(center => center.id === requestedCenterId)
      : centers.filter(center => isDocumentsApiConfigured(center));

    if (targets.length === 0) {
      res.status(422).json({
        error: requestedCenterId
          ? 'Το κέντρο δεν βρέθηκε ή δεν έχει ρυθμισμένο Documents API'
          : 'Δεν υπάρχει ρυθμισμένο κέντρο για συγχρονισμό παραστατικών',
        code: 'DOCUMENTS_NOT_CONFIGURED',
      });
      return;
    }

    const monthsBack = mode === 'auto' ? AUTO_SYNC_MONTHS : MANUAL_SYNC_MONTHS;

    const results: any[] = [];
    for (const center of targets) {
      try {
        results.push(await syncCenterDocuments(center.id, { monthsBack }));
      } catch (err: any) {
        results.push({
          centerId: center.id,
          centerName: center.name,
          from: '',
          to: '',
          fetched: 0,
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [],
          error: err?.message || String(err),
        });
      }
    }

    const failed = results.filter(result => result.error);
    if (failed.length === results.length) {
      const error = failed[0].error || 'Ο συγχρονισμός απέτυχε';
      res.status(error.includes('δεν βρέθηκε') ? 404 : 502).json({
        error,
        code: 'DOCUMENTS_SYNC_FAILED',
        results,
      });
      return;
    }

    const summary = results
      .map(result =>
        result.error
          ? `${result.centerName}: ${result.error}`
          : `${result.centerName}: ${result.fetched} παραστατικά (${result.created} νέα, ${result.updated} ενημερώσεις)`
      )
      .join(' · ');

    // Σημειώνουμε τον αυτόματο συγχρονισμό της ημέρας μόνο αν πέτυχε
    if (mode === 'auto' && failed.length === 0) {
      try {
        await dbService.setSetting(AUTO_SYNC_KEY, today);
      } catch (err: any) {
        console.warn('Finance auto sync date save failed:', err?.message || err);
      }
    }

    res.json({
      message: `Συγχρονισμός: ${summary}`,
      results,
      mode,
      monthsBack,
      skipped: false,
      lastSyncAt: mode === 'auto' ? today : undefined,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Εσωτερικό σφάλμα διακομιστή',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

export default app;
