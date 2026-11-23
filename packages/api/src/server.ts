// ΠΡΕΠΕΙ να είναι το πρώτο import: φορτώνει το .env.local πριν από
// οποιοδήποτε άλλο module διαβάσει μεταβλητές περιβάλλοντος.
import { BOOT_LAB_REPO_API_KEY } from './env';

import app from './routes';
import { dbService } from './db/db.service';
import { createAuth, migrateLegacyUsers, ensureAuthSchema, isAuthConfigured } from './services/auth.service';
import { loincCache } from './services/loinc-cache.service';
import { examCatalog } from './services/exam-catalog.service';
import { examLoinc } from './services/exam-loinc.service';
import { resolveLabRepoCredentials, setLabRepoCredentials, loadLabRepoApiKeyFromDb } from './services/lab-repo-config';
import { getAllowedOrigins, hasPublicOrigin, isDeployed } from './config/cors';
import { DATA_DIR } from './config/data-dir';
import {
  listStaleUsers,
  syncUser,
  isEfulfillmentConfigured,
  REFRESH_INTERVAL_MS,
  CONNECTION_TTL_MS,
} from './services/efulfillment.service';

const PORT = process.env.PORT || 3001;
/** Πόσο συχνά ελέγχουμε για ληγμένες συνδέσεις φορέα */
const EFULFILLMENT_TICK_MS = Number(process.env.EFULFILLMENT_TICK_MINUTES || 30) * 60 * 1000;

/**
 * Ελέγχει/προετοιμάζει το schema `neon_auth` (Better Auth + Neon Auth dashboard)
 * και μεταφέρει τυχόν legacy χρήστες από το public schema.
 */
async function migrateUsers(pool: import('pg').Pool): Promise<void> {
  const ready = await ensureAuthSchema(pool);
  if (!ready) {
    throw new Error(
      'Το schema neon_auth δεν υπάρχει. Εκτελέστε τη migration ή ενεργοποιήστε το Neon Auth.'
    );
  }

  const result = await migrateLegacyUsers(pool);

  if (result.created.length > 0) {
    console.warn(
      `⚠️  Δημιουργήθηκαν credentials για ${result.created.length} λογαριασμό(ύς): ${result.created.join(', ')}. ` +
        `Προσωρινός κωδικός: AUTH_DEFAULT_PASSWORD. Αλλάξτε τον από τις Ρυθμίσεις.`
    );
  }

  if (result.errors.length > 0) {
    console.warn(`⚠️  Αποτυχίες migration: ${result.errors.join(' | ')}`);
  }

  if (result.droppedLegacyTables.length > 0) {
    console.log(
      `🧹 Μεταφέρθηκαν οι χρήστες στο neon_auth και διαγράφηκαν: ${result.droppedLegacyTables.join(', ')}`
    );
  }
}

async function startServer() {
  // Initialize PostgreSQL (auth + data)
  await dbService.initialize();

  const pool = dbService.getPool();

  if (!isAuthConfigured()) {
    throw new Error(
      'BETTER_AUTH_SECRET (ή JWT_SECRET) δεν έχει οριστεί ή είναι μικρότερο από 32 χαρακτήρες'
    );
  }

  if (pool) {
    createAuth(pool);
    console.log('✅ Better Auth initialized (Neon PostgreSQL)');
    await migrateUsers(pool);
  } else {
    console.warn('⚠️  Χωρίς DATABASE_URL δεν είναι δυνατή η αρχικοποίηση του Better Auth');
  }

  if (dbService.isInitialized) {
    const loaded = await dbService.loadSettingsIntoEnv('EFULFILLMENT_');
    if (loaded > 0) {
      console.log(`⚙️  Φορτώθηκαν ${loaded} ρυθμίσεις E-Fulfillment από τη βάση`);
    }

    // Api-Key Lab Data Repository από τη βάση (υπερισχύει του .env)
    try {
      const storedKey = await loadLabRepoApiKeyFromDb();
      if (storedKey) console.log('⚙️  Lab Data Repository Api-Key φορτώθηκε από τη βάση');
    } catch (err: any) {
      console.warn('Lab repo api-key warning:', err?.message || err);
    }

    // Διαπιστευτήρια Lab Data Repository = ίδια με του φορέα (από τη βάση).
    // Χωρίς αυτό, ο master data sync θα χρησιμοποιούσε λάθος/κενά credentials.
    try {
      const users = await dbService.listEfulfillmentStaleUsers(0);
      for (const uid of users) {
        const creds = await resolveLabRepoCredentials(uid);
        if (creds) {
          setLabRepoCredentials(creds);
          break;
        }
      }
    } catch (err: any) {
      console.warn('Lab repo credentials warning:', err?.message || err);
    }

    // Καθαρισμός ορφανών (παραπεμπτικά/εξετάσεις χωρίς επίσκεψη)
    try {
      const cleaned = await dbService.cleanupOrphans();
      if (cleaned.referrals > 0 || cleaned.exams > 0) {
        console.log(
          `🧹 Καθαρίστηκαν ορφανά: ${cleaned.referrals} παραπεμπτικά, ${cleaned.exams} εξετάσεις`
        );
      }
    } catch (err: any) {
      console.warn('Orphan cleanup warning:', err?.message || err);
    }
  }

  // Load LOINC cache from disk (non-blocking)
  loincCache.load().catch(err => console.warn('LOINC cache load warning:', err));
  examCatalog.load().catch(err => console.warn('Exam catalog load warning:', err));
  examLoinc.load().catch(err => console.warn('Exam LOINC load warning:', err));

  // 0.0.0.0 ώστε να είναι προσβάσιμο και από άλλες συσκευές στο τοπικό δίκτυο
// (δοκιμή από κινητό). Το default θα ήταν localhost μόνο.
const HOST = process.env.API_HOST || '0.0.0.0';

app.listen(Number(PORT), HOST, () => {
    console.log(`🏥 MediLab API Server running on http://localhost:${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔐 Auth (Better Auth): http://localhost:${PORT}/api/auth/login`);
    console.log(`🩺 E-Fulfillment: http://localhost:${PORT}/api/efulfillment/me`);
    console.log(`📤 Upload endpoint: http://localhost:${PORT}/api/upload`);
    console.log(`🔬 Analysis endpoint: http://localhost:${PORT}/api/analyze`);
    console.log(`🗄️  PostgreSQL: ${dbService.isInitialized ? 'Connected' : 'Not connected'}`);
    console.log(`📦 LOINC cache: ${loincCache.isLoaded ? `${loincCache.cacheSize} codes loaded` : 'Not loaded (run sync)'}`);
    console.log(`📋 Exam catalog: ${examCatalog.isLoaded ? `${examCatalog.size} exams loaded` : 'Not loaded (run sync)'}`);
    console.log(`📋 Exam LOINC: ${examLoinc.isLoaded ? `${examLoinc.size} entries loaded` : 'Not loaded (run sync)'}`);
    const origins = getAllowedOrigins();
    console.log(
      `🌐 CORS/Better Auth origins: ${origins.length ? origins.join(', ') : '(κανένα — επιτρέπονται όλα)'}`
    );
    if (isDeployed() && !hasPublicOrigin()) {
      console.warn(
        '⚠️  CORS/Better Auth: δεν έχει οριστεί origin του frontend (CORS_ORIGIN / WEB_ORIGIN). ' +
          'Επιτρέπονται προσωρινά όλα ώστε να μη σπάσει το deployment — όρισε π.χ. ' +
          'CORS_ORIGIN=https://<frontend>.vercel.app,https://*.vercel.app και κάνε redeploy.'
      );
    }
    console.log(`🗂️  Data dir: ${DATA_DIR}`);
  });

  startEfulfillmentScheduler();
}

/**
 * Προληπτική ανανέωση της σύνδεσης με τον φορέα.
 * Ο φορέας ακυρώνει τη σύνδεση μετά από 24 ώρες χωρίς κλήση /api/me,
 * οπότε ανανεώνουμε κάθε EFULFILLMENT_REFRESH_HOURS (default 20).
 */
function startEfulfillmentScheduler(): void {
  if (!isEfulfillmentConfigured()) {
    console.warn('⚠️  E-Fulfillment: λείπει EFULFILLMENT_API_KEY — ο scheduler δεν ξεκίνησε');
    return;
  }

  const tick = async () => {
    try {
      const userIds = await listStaleUsers(REFRESH_INTERVAL_MS);
      if (userIds.length === 0) return;

      console.log(
        `🔄 E-Fulfillment: ανανέωση σύνδεσης για ${userIds.length} χρήστη(ς) ` +
          `(όριο φορέα ${CONNECTION_TTL_MS / 3600000}h)`
      );

      for (const userId of userIds) {
        const result = await syncUser(userId, { force: true });
        if (!result.ok) {
          console.warn(`   ⚠️  ${userId}: ${result.code || 'ERROR'} — ${result.error}`);
        }
      }
    } catch (err: any) {
      console.warn('E-Fulfillment scheduler error:', err?.message || err);
    }
  };

  // Πρώτος έλεγχος μετά από 1 λεπτό (να μη μπλοκάρει το startup)
  setTimeout(tick, 60_000);
  const timer = setInterval(tick, EFULFILLMENT_TICK_MS);
  timer.unref();

  console.log(
    `🩺 E-Fulfillment scheduler: έλεγχος κάθε ${EFULFILLMENT_TICK_MS / 60000} λεπτά, ` +
      `ανανέωση στις ${REFRESH_INTERVAL_MS / 3600000}h (όριο φορέα ${CONNECTION_TTL_MS / 3600000}h)`
  );
}

startServer().catch(err => {
  console.error('❌ Server startup failed:', err?.message || err);
  process.exit(1);
});
