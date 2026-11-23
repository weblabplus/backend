// ============================================================
// PostgreSQL Database Service
// Αντικαθιστά το Firestore CRUD με Neon PostgreSQL.
// Το Better Auth (πίνακας "user") είναι η μοναδική πηγή χρηστών.
// ============================================================

import { Pool, PoolClient, QueryResult } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { decryptSecret } from '../services/crypto.service';
import { Patient, LabResult, DiagnosticReport, AnalysisResult, Visit, Referral, Exam, Appointment } from '@medilab/core';

// ── Types ──

export interface AuthUser {
  uid: string;
  /** Better Auth user id (ο πίνακας "user"). Μπορεί να διαφέρει από το uid για legacy χρήστες. */
  id?: string;
  email: string;
  displayName?: string;
  role: 'doctor' | 'lab_technician' | 'admin';
  createdAt: string;
}

// ── Helpers ──

/** Extract queryable indexed fields from entity data */
function extractIndexedFields(table: string, data: Record<string, any>): Record<string, any> {
  const fields: Record<string, any> = {};
  switch (table) {
    case 'patients':
      if (data.doctorId) fields.doctor_id = data.doctorId;
      break;
    case 'visits':
      if (data.patientId) fields.patient_id = data.patientId;
      if (data.doctorId) fields.doctor_id = data.doctorId;
      if (data.visitDate) fields.visit_date = data.visitDate;
      break;
    case 'referrals':
      if (data.visitId) fields.visit_id = data.visitId;
      if (data.patientId) fields.patient_id = data.patientId;
      if (data.doctorId) fields.doctor_id = data.doctorId;
      break;
    case 'appointments':
      if (data.patientId) fields.patient_id = data.patientId;
      if (data.doctorId) fields.doctor_id = data.doctorId;
      if (data.scheduledAt) fields.scheduled_at = data.scheduledAt;
      if (data.status) fields.status = data.status;
      if (data.visitId) fields.visit_id = data.visitId;
      break;
    case 'exams':
      if (data.referralId) fields.referral_id = data.referralId;
      if (data.visitId) fields.visit_id = data.visitId;
      if (data.patientId) fields.patient_id = data.patientId;
      if (data.doctorId) fields.doctor_id = data.doctorId;
      break;
  }
  return fields;
}

/** Build WHERE clause from filter params */
function buildWhereClause(filters: Record<string, any>): { clause: string; values: any[]; paramIndex: number } {
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const [col, val] of Object.entries(filters)) {
    if (val !== undefined && val !== null) {
      conditions.push(`${col} = $${idx}`);
      values.push(val);
      idx++;
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
    paramIndex: idx,
  };
}

// ── Service ──

export class DbService {
  private pool: Pool | null = null;
  private initialized = false;

  async initialize(connectionString?: string): Promise<void> {
    if (this.initialized) return;

    const url = connectionString || process.env.DATABASE_URL;
    if (!url) {
      console.warn('⚠️ No DATABASE_URL found — DB service will run in mock mode');
      this.initialized = false;
      return;
    }

    try {
      this.pool = new Pool({
        connectionString: url,
        max: 10,
        idleTimeoutMillis: 30000,
        // Το Neon (serverless) χρειάζεται περισσότερο χρόνο σε cold start
        connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 20000,
      });

      // Test connection με retry για cold start
      const client = await this.connectWithRetry();
      console.log('✅ PostgreSQL connected');
      client.release();

      // Run migration
      await this.runMigrations();

      this.initialized = true;
      console.log('✅ DB Service initialized');
    } catch (err) {
      console.warn('⚠️ PostgreSQL initialization failed — using mock mode:', err);
      this.initialized = false;
    }
  }

  /** Σύνδεση με έως 3 προσπάθειες (Neon cold start) */
  private async connectWithRetry(attempts = 3): Promise<PoolClient> {
    let lastError: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.pool!.connect();
      } catch (err) {
        lastError = err;
        if (i < attempts) {
          console.warn(`⏳ PostgreSQL connect attempt ${i}/${attempts} failed — retrying...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    throw lastError;
  }

  get isInitialized(): boolean {
    return this.initialized && this.pool !== null;
  }

  /** Το κοινό PostgreSQL pool (χρησιμοποιείται και από το Better Auth) */
  getPool(): Pool | null {
    return this.pool;
  }

  private async runMigrations(): Promise<void> {
    // Το tsc δεν αντιγράφει το .sql στο dist — ψάχνουμε και στο src για τα
    // production builds (π.χ. Render), όπου τρέχει το μεταγλωττισμένο dist.
    const candidates = [
      path.resolve(__dirname, 'migration.sql'),
      path.resolve(__dirname, '..', '..', 'src', 'db', 'migration.sql'),
    ];
    const migrationPath = candidates.find(candidate => fs.existsSync(candidate));

    if (!migrationPath) {
      console.warn('⚠️ Migration file not found. Looked in:', candidates.join(', '));
      return;
    }

    try {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      await this.query(sql);
      console.log('✅ Database migrations applied');
    } catch (err) {
      console.warn('⚠️ Migration error (tables may already exist):', err);
    }
  }

  /** Execute a raw SQL query */
  async query(text: string, params?: any[]): Promise<QueryResult> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.pool.query(text, params);
  }

  /** Get a client for transactions */
  async getClient(): Promise<PoolClient> {
    if (!this.pool) throw new Error('Database not initialized');
    return this.pool.connect();
  }

  // ============================================================
  // USERS
  // ============================================================

  private static mapUserRow(row: any): AuthUser {
    return {
      uid: row.legacyUid || row.id,
      id: row.id,
      email: row.email,
      displayName: row.name,
      role: row.role || 'doctor',
      createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    };
  }

  private static readonly USER_COLUMNS =
    'id, email, name, role, "legacyUid", "createdAt"';

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  async getUserProfile(uid: string): Promise<AuthUser | null> {
    if (!this.pool) return null;
    const res = await this.pool.query(
      `SELECT ${DbService.USER_COLUMNS} FROM neon_auth."user"
       WHERE id::text = $1 OR "legacyUid" = $1 LIMIT 1`,
      [uid]
    );
    return res.rows.length > 0 ? DbService.mapUserRow(res.rows[0]) : null;
  }

  async getUserProfileByEmail(email: string): Promise<AuthUser | null> {
    if (!this.pool) return null;
    const res = await this.pool.query(
      `SELECT ${DbService.USER_COLUMNS} FROM neon_auth."user"
       WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    return res.rows.length > 0 ? DbService.mapUserRow(res.rows[0]) : null;
  }

  async saveUserProfile(user: AuthUser): Promise<AuthUser> {
    if (!this.pool) return user;

    const rawId = user.id || user.uid;
    const id = DbService.isUuid(rawId) ? rawId : crypto.randomUUID();
    const legacyUid = DbService.isUuid(rawId) ? user.uid !== rawId ? user.uid : null : rawId;

    const res = await this.pool.query(
      `INSERT INTO neon_auth."user"
         (id, name, email, "emailVerified", role, "legacyUid", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         role = EXCLUDED.role,
         "legacyUid" = COALESCE(EXCLUDED."legacyUid", neon_auth."user"."legacyUid"),
         "updatedAt" = NOW()
       RETURNING ${DbService.USER_COLUMNS}`,
      [
        id,
        user.displayName || user.email.split('@')[0],
        user.email,
        user.role,
        legacyUid,
        user.createdAt || new Date().toISOString(),
      ]
    );
    return DbService.mapUserRow(res.rows[0]);
  }

  async updateUserProfile(
    uid: string,
    updates: { displayName?: string; role?: string }
  ): Promise<AuthUser | null> {
    if (!this.pool) return null;
    const setClauses: string[] = ['"updatedAt" = NOW()'];
    const values: any[] = [uid];
    let idx = 2;

    if (updates.displayName !== undefined) {
      setClauses.push(`name = $${idx++}`);
      values.push(updates.displayName);
    }
    if (updates.role !== undefined) {
      setClauses.push(`role = $${idx++}`);
      values.push(updates.role);
    }

    const res = await this.pool.query(
      `UPDATE neon_auth."user" SET ${setClauses.join(', ')}
       WHERE id::text = $1 OR "legacyUid" = $1
       RETURNING ${DbService.USER_COLUMNS}`,
      values
    );
    return res.rows.length > 0 ? DbService.mapUserRow(res.rows[0]) : null;
  }

  async deleteUser(uid: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      'DELETE FROM neon_auth."user" WHERE id::text = $1 OR "legacyUid" = $1',
      [uid]
    );
  }

  async listUsers(): Promise<AuthUser[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT ${DbService.USER_COLUMNS} FROM neon_auth."user" ORDER BY "createdAt" DESC`
    );
    return res.rows.map(row => DbService.mapUserRow(row));
  }

  // ============================================================
  // E-FULFILLMENT (e-Prescription)
  // ============================================================

  /** Αποθήκευση/ενημέρωση credentials φορέα (το password έρχεται κρυπτογραφημένο) */
  async saveEfulfillmentCredentials(
    userId: string,
    creds: { username: string; passwordEnc: string; doctorIp?: string }
  ): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `INSERT INTO user_efulfillment (user_id, epres_username, epres_password_enc, doctor_ip, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         epres_username = EXCLUDED.epres_username,
         epres_password_enc = EXCLUDED.epres_password_enc,
         doctor_ip = COALESCE(EXCLUDED.doctor_ip, user_efulfillment.doctor_ip),
         last_error = NULL,
         updated_at = NOW()`,
      [userId, creds.username, creds.passwordEnc, creds.doctorIp || null]
    );
  }

  async getEfulfillmentCredentials(
    userId: string
  ): Promise<{ username: string; password: string; doctorIp?: string } | null> {
    if (!this.pool) return null;
    const res = await this.pool.query(
      'SELECT epres_username, epres_password_enc, doctor_ip FROM user_efulfillment WHERE user_id = $1',
      [userId]
    );
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      username: row.epres_username,
      password: decryptSecret(row.epres_password_enc),
      doctorIp: row.doctor_ip || undefined,
    };
  }

  /** Κατάσταση συγχρονισμού + τελευταία ληφθέντα στοιχεία */
  async getEfulfillmentState(userId: string): Promise<{
    hasCredentials: boolean;
    username?: string;
    lastSyncAt?: string | null;
    lastAttemptAt?: string | null;
    lastError?: string | null;
    profile?: any;
  }> {
    if (!this.pool) return { hasCredentials: false };
    const res = await this.pool.query(
      `SELECT epres_username, data, last_sync_at, last_attempt_at, last_error
       FROM user_efulfillment WHERE user_id = $1`,
      [userId]
    );
    if (res.rows.length === 0) return { hasCredentials: false };

    const row = res.rows[0];
    return {
      hasCredentials: true,
      username: row.epres_username,
      lastSyncAt: row.last_sync_at?.toISOString?.() || row.last_sync_at || null,
      lastAttemptAt: row.last_attempt_at?.toISOString?.() || row.last_attempt_at || null,
      lastError: row.last_error,
      profile: row.data,
    };
  }

  /** Αποθήκευση αποτελέσματος κλήσης /api/me (ή του σφάλματος) */
  async saveEfulfillmentSync(
    userId: string,
    data: any | null,
    syncedAt: Date | null,
    error: string | null,
    attemptedAt: Date = new Date()
  ): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE user_efulfillment SET
         data = COALESCE($2::jsonb, data),
         last_sync_at = COALESCE($3, last_sync_at),
         last_attempt_at = $4,
         last_error = $5,
         updated_at = NOW()
       WHERE user_id = $1`,
      [userId, data ? JSON.stringify(data) : null, syncedAt, attemptedAt, error]
    );
  }

  async deleteEfulfillmentCredentials(userId: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM user_efulfillment WHERE user_id = $1', [userId]);
  }

  /** Χρήστες των οποίων η σύνδεση με τον φορέα χρειάζεται ανανέωση */
  async listEfulfillmentStaleUsers(olderThanMs: number): Promise<string[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT user_id FROM user_efulfillment
       WHERE last_sync_at IS NULL OR last_sync_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
      [olderThanMs]
    );
    return res.rows.map(r => String(r.user_id));
  }

  // ============================================================
  // APP SETTINGS (υπερισχύουν των env vars)
  // ============================================================

  async getSetting(key: string): Promise<string | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return res.rows.length > 0 ? res.rows[0].value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  async deleteSetting(key: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  }

  /** Φορτώνει όλες τις ρυθμίσεις στο process.env (με πρόθεμα επιλογής) */
  async loadSettingsIntoEnv(prefix = 'EFULFILLMENT_'): Promise<number> {
    if (!this.pool) return 0;
    const res = await this.pool.query(
      'SELECT key, value FROM app_settings WHERE key LIKE $1',
      [`${prefix}%`]
    );
    for (const row of res.rows) {
      process.env[row.key] = row.value;
    }
    return res.rows.length;
  }
  // ============================================================
  // PATIENTS
  // ============================================================

  async getPatient(id: string): Promise<Patient | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM patients WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as Patient) : null;
  }

  async listPatients(doctorId?: string): Promise<Patient[]> {
    if (!this.pool) return [];
    let res;
    if (doctorId) {
      res = await this.pool.query(
        'SELECT data FROM patients WHERE doctor_id = $1 ORDER BY created_at DESC',
        [doctorId]
      );
    } else {
      res = await this.pool.query('SELECT data FROM patients ORDER BY created_at DESC');
    }
    return res.rows.map(r => r.data as Patient);
  }

  /**
   * Αναζήτηση ασθενούς με ΑΜΚΑ.
   * Αγνοεί κενά/παύλες και μη ψηφία, ώστε «050 390 019 78» και «05039001978»
   * να θεωρούνται το ίδιο ΑΜΚΑ.
   */
  async findPatientByAmka(amka: string): Promise<Patient | null> {
    if (!this.pool) return null;
    const digits = String(amka || '').replace(/\D/g, '');
    if (!digits) return null;

    const res = await this.pool.query(
      `SELECT data FROM patients
       WHERE regexp_replace(COALESCE(data->>'amka', ''), '\\D', '', 'g') = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [digits]
    );
    return res.rows.length > 0 ? (res.rows[0].data as Patient) : null;
  }

  /**
   * Αναζήτηση ασθενούς με ονοματεπώνυμο + ημερομηνία γέννησης.
   * Χρησιμοποιείται ως fallback όταν ο φορέας δεν δίνει ΑΜΚΑ,
   * ώστε να μην δημιουργούνται διπλότυπα.
   */
  async findPatientByNameAndDob(
    firstName: string,
    lastName: string,
    dateOfBirth?: string
  ): Promise<Patient | null> {
    if (!this.pool) return null;
    const first = String(firstName || '').trim();
    const last = String(lastName || '').trim();
    if (!first || !last || first === 'Άγνωστο' || last === 'Άγνωστο') return null;

    const res = await this.pool.query(
      `SELECT data FROM patients
       WHERE lower(trim(COALESCE(data->>'firstName', ''))) = lower(trim($1))
         AND lower(trim(COALESCE(data->>'lastName', ''))) = lower(trim($2))
         AND ($3::text IS NULL OR COALESCE(data->>'dateOfBirth', '') = $3)
       ORDER BY created_at ASC
       LIMIT 1`,
      [first, last, dateOfBirth || null]
    );
    return res.rows.length > 0 ? (res.rows[0].data as Patient) : null;
  }

  async savePatient(patient: Patient): Promise<Patient> {
    if (!this.pool) return patient;
    const indexed = extractIndexedFields('patients', patient as any);
    await this.pool.query(
      `INSERT INTO patients (id, doctor_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         doctor_id = EXCLUDED.doctor_id,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [patient.id, indexed.doctor_id || null, JSON.stringify(patient)]
    );
    return patient;
  }

  async updatePatient(id: string, updates: Partial<Patient>): Promise<Patient> {
    if (!this.pool) return { id, ...updates } as Patient;
    // Fetch current, merge, save back
    const current = await this.getPatient(id);
    if (!current) throw new Error(`Patient ${id} not found`);
    const merged = { ...current, ...updates };
    await this.savePatient(merged);
    return merged;
  }

  async deletePatient(id: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM patients WHERE id = $1', [id]);
  }

  // ============================================================
  // LAB RESULTS
  // ============================================================

  async saveLabResults(results: LabResult[], patientId: string): Promise<LabResult[]> {
    if (!this.pool) return results;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const result of results) {
        const id = result.id || `${patientId}_${result.test.code}_${Date.now()}`;
        await client.query(
          `INSERT INTO lab_results (id, patient_id, data, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
          [id, patientId, JSON.stringify({ ...result, id, patientId })]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return results;
  }

  async getPatientResults(patientId: string): Promise<LabResult[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      'SELECT data FROM lab_results WHERE patient_id = $1 ORDER BY created_at DESC',
      [patientId]
    );
    return res.rows.map(r => r.data as LabResult);
  }

  // ============================================================
  // REPORTS
  // ============================================================

  async saveReport(report: DiagnosticReport): Promise<DiagnosticReport> {
    if (!this.pool) return report;
    const patientId = report.patient?.id || (report as any).patientId;
    await this.pool.query(
      `INSERT INTO reports (id, patient_id, data, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, patient_id = EXCLUDED.patient_id`,
      [report.id, patientId, JSON.stringify(report)]
    );
    return report;
  }

  async getReport(id: string): Promise<DiagnosticReport | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM reports WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as DiagnosticReport) : null;
  }

  async listReports(patientId?: string): Promise<DiagnosticReport[]> {
    if (!this.pool) return [];
    let res;
    if (patientId) {
      res = await this.pool.query(
        'SELECT data FROM reports WHERE patient_id = $1 ORDER BY created_at DESC',
        [patientId]
      );
    } else {
      res = await this.pool.query('SELECT data FROM reports ORDER BY created_at DESC');
    }
    return res.rows.map(r => r.data as DiagnosticReport);
  }

  async deleteReport(id: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM reports WHERE id = $1', [id]);
  }

  // ============================================================
  // ANALYSES
  // ============================================================

  async saveAnalyses(patientId: string, analyses: AnalysisResult[]): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const analysis of analyses) {
        const id = `${analysis.labResult.id}_${Date.now()}`;
        await client.query(
          `INSERT INTO analyses (id, patient_id, data, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
          [id, patientId, JSON.stringify({ ...analysis, patientId })]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getPatientAnalyses(patientId: string): Promise<AnalysisResult[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      'SELECT data FROM analyses WHERE patient_id = $1 ORDER BY created_at DESC',
      [patientId]
    );
    return res.rows.map(r => r.data as AnalysisResult);
  }

  // ============================================================
  // VISITS
  // ============================================================

  async saveVisit(visit: Visit): Promise<Visit> {
    if (!this.pool) return visit;
    const indexed = extractIndexedFields('visits', visit as any);
    await this.pool.query(
      `INSERT INTO visits (id, patient_id, doctor_id, visit_date, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         patient_id = EXCLUDED.patient_id,
         doctor_id = EXCLUDED.doctor_id,
         visit_date = EXCLUDED.visit_date,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        visit.id,
        indexed.patient_id || null,
        indexed.doctor_id || null,
        indexed.visit_date || null,
        JSON.stringify(visit),
      ]
    );
    return visit;
  }

  async getVisit(id: string): Promise<Visit | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM visits WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as Visit) : null;
  }

  async listVisits(
    patientId?: string,
    doctorId?: string,
    range?: { from?: string; to?: string }
  ): Promise<Visit[]> {
    if (!this.pool) return [];
    const conditions: string[] = [];
    const values: any[] = [];

    if (patientId) {
      values.push(patientId);
      conditions.push(`patient_id = $${values.length}`);
    }
    if (doctorId) {
      values.push(doctorId);
      conditions.push(`doctor_id = $${values.length}`);
    }
    if (range?.from) {
      values.push(range.from);
      conditions.push(`visit_date >= $${values.length}`);
    }
    if (range?.to) {
      values.push(range.to);
      conditions.push(`visit_date <= $${values.length}`);
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT data FROM visits ${clause} ORDER BY visit_date DESC`,
      values
    );
    return res.rows.map(r => r.data as Visit);
  }

  async updateVisit(id: string, updates: Partial<Visit>): Promise<Visit> {
    if (!this.pool) return { id, ...updates } as Visit;
    const current = await this.getVisit(id);
    if (!current) throw new Error(`Visit ${id} not found`);
    const merged: Visit = { ...current, ...updates, updatedAt: new Date().toISOString() };
    await this.saveVisit(merged);
    return merged;
  }

  async deleteVisit(id: string): Promise<void> {
    if (!this.pool) return;
    // Cascade: οι εξετάσεις και τα παραπεμπτικά της επίσκεψης διαγράφονται μαζί,
    // αλλιώς μένουν ορφανά και π.χ. το barcode εμφανίζεται «ήδη καταχωρημένο».
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM exams WHERE visit_id = $1', [id]);
      await client.query('DELETE FROM exams WHERE referral_id IN (SELECT id FROM referrals WHERE visit_id = $1)', [id]);
      await client.query('DELETE FROM referrals WHERE visit_id = $1', [id]);
      await client.query('DELETE FROM visits WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================
  // APPOINTMENTS (Ημερολόγιο)
  // ============================================================

  async saveAppointment(appointment: Appointment): Promise<Appointment> {
    if (!this.pool) return appointment;
    const indexed = extractIndexedFields('appointments', appointment as any);
    await this.pool.query(
      `INSERT INTO appointments (id, patient_id, doctor_id, scheduled_at, status, visit_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         patient_id = EXCLUDED.patient_id,
         doctor_id = EXCLUDED.doctor_id,
         scheduled_at = EXCLUDED.scheduled_at,
         status = EXCLUDED.status,
         visit_id = EXCLUDED.visit_id,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        appointment.id,
        indexed.patient_id || null,
        indexed.doctor_id || null,
        indexed.scheduled_at || null,
        indexed.status || 'scheduled',
        indexed.visit_id || null,
        JSON.stringify(appointment),
      ]
    );
    return appointment;
  }

  async getAppointment(id: string): Promise<Appointment | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM appointments WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as Appointment) : null;
  }

  /** Λίστα ραντεβού με φίλτρα (ασθενής, γιατρός, εύρος ημερομηνιών, κατάσταση) */
  async listAppointments(opts?: {
    patientId?: string;
    doctorId?: string;
    from?: string;
    to?: string;
    status?: string;
  }): Promise<Appointment[]> {
    if (!this.pool) return [];
    const conditions: string[] = [];
    const values: any[] = [];

    if (opts?.patientId) {
      values.push(opts.patientId);
      conditions.push(`patient_id = $${values.length}`);
    }
    if (opts?.doctorId) {
      values.push(opts.doctorId);
      conditions.push(`doctor_id = $${values.length}`);
    }
    if (opts?.status) {
      values.push(opts.status);
      conditions.push(`status = $${values.length}`);
    }
    if (opts?.from) {
      values.push(opts.from);
      conditions.push(`scheduled_at >= $${values.length}`);
    }
    if (opts?.to) {
      values.push(opts.to);
      conditions.push(`scheduled_at <= $${values.length}`);
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT data FROM appointments ${clause} ORDER BY scheduled_at ASC`,
      values
    );
    return res.rows.map(r => r.data as Appointment);
  }

  async updateAppointment(id: string, updates: Partial<Appointment>): Promise<Appointment> {
    if (!this.pool) return { id, ...updates } as Appointment;
    const current = await this.getAppointment(id);
    if (!current) throw new Error(`Appointment ${id} not found`);
    const merged: Appointment = { ...current, ...updates, updatedAt: new Date().toISOString() };
    await this.saveAppointment(merged);
    return merged;
  }

  async deleteAppointment(id: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM appointments WHERE id = $1', [id]);
  }

  // ============================================================
  // REFERRALS
  // ============================================================

  async saveReferral(referral: Referral): Promise<Referral> {
    if (!this.pool) return referral;
    const indexed = extractIndexedFields('referrals', referral as any);
    await this.pool.query(
      `INSERT INTO referrals (id, visit_id, patient_id, doctor_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         visit_id = EXCLUDED.visit_id,
         patient_id = EXCLUDED.patient_id,
         doctor_id = EXCLUDED.doctor_id,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        referral.id,
        indexed.visit_id || null,
        indexed.patient_id || null,
        indexed.doctor_id || null,
        JSON.stringify(referral),
      ]
    );
    return referral;
  }

  async getReferral(id: string): Promise<Referral | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM referrals WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as Referral) : null;
  }

  /**
   * Barcodes παραπεμπτικών e-Prescription που έχουν ήδη εισαχθεί
   * (id = referral_epres_<barcode>). Χρησιμοποιείται για φιλτράρισμα
   * ώστε να μην ξαναεμφανίζονται στην αναζήτηση.
   */
  async listImportedReferralBarcodes(barcodes: string[]): Promise<Set<string>> {
    if (!this.pool || barcodes.length === 0) return new Set();
    const ids = barcodes.map(b => `referral_epres_${b}`);
    const res = await this.pool.query(
      'SELECT id FROM referrals WHERE id = ANY($1::text[])',
      [ids]
    );
    return new Set(
      res.rows
        .map(r => String(r.id))
        .filter((id: string) => id.startsWith('referral_epres_'))
        .map((id: string) => id.slice('referral_epres_'.length))
    );
  }

  async listReferrals(visitId?: string, patientId?: string, doctorId?: string): Promise<Referral[]> {
    if (!this.pool) return [];
    const filters: Record<string, any> = {};
    if (visitId) filters.visit_id = visitId;
    if (patientId) filters.patient_id = patientId;
    if (doctorId) filters.doctor_id = doctorId;

    const { clause, values } = buildWhereClause(filters);
    const res = await this.pool.query(
      `SELECT data FROM referrals ${clause} ORDER BY created_at DESC`,
      values
    );
    return res.rows.map(r => r.data as Referral);
  }

  async updateReferral(id: string, updates: Partial<Referral>): Promise<Referral> {
    if (!this.pool) return { id, ...updates } as Referral;
    const current = await this.getReferral(id);
    if (!current) throw new Error(`Referral ${id} not found`);
    const merged: Referral = { ...current, ...updates, updatedAt: new Date().toISOString() };
    await this.saveReferral(merged);
    return merged;
  }

  /**
   * Καθαρίζει ορφανά παραπεμπτικά/εξετάσεις που δείχνουν σε ανύπαρκτη
   * επίσκεψη ή παραπεμπτικό (π.χ. από παλιές διαγραφές χωρίς cascade).
   */
  async cleanupOrphans(): Promise<{ exams: number; referrals: number }> {
    if (!this.pool) return { exams: 0, referrals: 0 };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let exams = 0;
      const e1 = await client.query(
        `DELETE FROM exams WHERE visit_id IS NOT NULL AND visit_id NOT IN (SELECT id FROM visits)`
      );
      exams += e1.rowCount ?? 0;
      const e2 = await client.query(
        `DELETE FROM exams WHERE referral_id IS NOT NULL AND referral_id NOT IN (SELECT id FROM referrals)`
      );
      exams += e2.rowCount ?? 0;

      const r = await client.query(
        `DELETE FROM referrals WHERE visit_id IS NOT NULL AND visit_id NOT IN (SELECT id FROM visits)`
      );

      await client.query('COMMIT');
      return { exams, referrals: r.rowCount ?? 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteReferral(id: string): Promise<void> {
    if (!this.pool) return;
    // Cascade: διαγραφή των εξετάσεων του παραπεμπτικού
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM exams WHERE referral_id = $1', [id]);
      await client.query('DELETE FROM referrals WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================
  // EXAMS
  // ============================================================

  /**
   * Ονόματα εξετάσεων από τον τοπικό κατάλογο (exam_catalog), με κλειδί το examCode.
   * Χρησιμοποιείται για εμπλουτισμό των γραμμών εξετάσεων που επιστρέφει ο φορέας.
   */
  async getExamCatalogNames(codes: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.pool || codes.length === 0) return map;

    const unique = Array.from(new Set(codes.filter(Boolean)));
    if (unique.length === 0) return map;

    const res = await this.pool.query(
      `SELECT exam_code, data->>'examDescription' AS description
       FROM exam_catalog WHERE exam_code = ANY($1::text[])`,
      [unique]
    );
    for (const row of res.rows) {
      if (row.description) map.set(String(row.exam_code), String(row.description));
    }
    return map;
  }

  async saveExam(exam: Exam): Promise<Exam> {    if (!this.pool) return exam;
    const indexed = extractIndexedFields('exams', exam as any);
    await this.pool.query(
      `INSERT INTO exams (id, referral_id, visit_id, patient_id, doctor_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         referral_id = EXCLUDED.referral_id,
         visit_id = EXCLUDED.visit_id,
         patient_id = EXCLUDED.patient_id,
         doctor_id = EXCLUDED.doctor_id,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        exam.id,
        indexed.referral_id || null,
        indexed.visit_id || null,
        indexed.patient_id || null,
        indexed.doctor_id || null,
        JSON.stringify(exam),
      ]
    );
    return exam;
  }

  async getExam(id: string): Promise<Exam | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM exams WHERE id = $1', [id]);
    return res.rows.length > 0 ? (res.rows[0].data as Exam) : null;
  }

  async listExams(
    referralId?: string,
    visitId?: string,
    patientId?: string,
    doctorId?: string
  ): Promise<Exam[]> {
    if (!this.pool) return [];
    const filters: Record<string, any> = {};
    if (referralId) filters.referral_id = referralId;
    if (visitId) filters.visit_id = visitId;
    if (patientId) filters.patient_id = patientId;
    if (doctorId) filters.doctor_id = doctorId;

    const { clause, values } = buildWhereClause(filters);
    const res = await this.pool.query(
      `SELECT data FROM exams ${clause} ORDER BY created_at DESC`,
      values
    );
    return res.rows.map(r => r.data as Exam);
  }

  /**
   * Εξετάσεις που στάλθηκαν σε κέντρο αναφοράς μέσα σε χρονικό διάστημα.
   * Βασίζεται στο `sentToCenter.sentAt` κάθε εξέτασης.
   */
  async listExamsSentToCenter(
    centerId: string,
    fromIso: string,
    toIso: string,
    doctorId?: string
  ): Promise<Exam[]> {
    if (!this.pool) return [];
    const params: any[] = [centerId, fromIso, toIso];
    let doctorClause = '';
    if (doctorId) {
      params.push(doctorId);
      doctorClause = `AND (doctor_id = $${params.length} OR doctor_id IS NULL)`;
    }
    const res = await this.pool.query(
      `SELECT data FROM exams
       WHERE data->'sentToCenter'->>'centerId' = $1
         AND NULLIF(data->'sentToCenter'->>'sentAt', '') IS NOT NULL
         AND (data->'sentToCenter'->>'sentAt')::timestamptz >= $2::timestamptz
         AND (data->'sentToCenter'->>'sentAt')::timestamptz <= $3::timestamptz
         ${doctorClause}
       ORDER BY (data->'sentToCenter'->>'sentAt')::timestamptz ASC, data->>'name' ASC`,
      params
    );
    return res.rows.map(r => r.data as Exam);
  }

  async updateExam(id: string, updates: Partial<Exam>): Promise<Exam> {    if (!this.pool) return { id, ...updates } as Exam;
    const current = await this.getExam(id);
    if (!current) throw new Error(`Exam ${id} not found`);
    // Strip undefined values
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );
    const merged: Exam = { ...current, ...cleanUpdates, updatedAt: new Date().toISOString() };
    await this.saveExam(merged);
    return merged;
  }

  async deleteExam(id: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM exams WHERE id = $1', [id]);
  }

  // ============================================================
  // EXAM CATALOG (reference data, batch upsert)
  // ============================================================

  async saveExamCatalogBatch(entries: Array<{ examCode: string; data: Record<string, any> }>): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(
          `INSERT INTO exam_catalog (exam_code, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (exam_code) DO UPDATE SET
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [entry.examCode, JSON.stringify(entry.data)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getExamCatalogCount(): Promise<number> {
    if (!this.pool) return 0;
    const res = await this.pool.query('SELECT COUNT(*) FROM exam_catalog');
    return parseInt(res.rows[0].count, 10);
  }

  /**
   * Όλες οι εξετάσεις του τοπικού καταλόγου, μαζί με τα suggested LOINC,
   * στη μορφή που χρησιμοποιεί ο συγχρονισμός παραμέτρων.
   * Χρησιμοποιείται ως fallback όταν το Master Data API δεν είναι διαθέσιμο.
   */
  async listExamCatalogEntries(): Promise<
    Array<{
      examCode: string;
      examDescription: string | null;
      edapyCode: string | null;
      suggestedLoincs: any[];
    }>
  > {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT exam_code,
              data->>'examDescription' AS description,
              data->>'edapyCode'       AS edapy,
              data->'suggestedLoincs'  AS suggested
       FROM exam_catalog
       ORDER BY exam_code`
    );
    return res.rows.map(row => ({
      examCode: String(row.exam_code),
      examDescription: row.description ?? null,
      edapyCode: row.edapy != null ? String(row.edapy).trim() : null,
      suggestedLoincs: Array.isArray(row.suggested) ? row.suggested : [],
    }));
  }

  async clearExamCatalog(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM exam_catalog');
  }

  // ============================================================
  // EXAM LOINC (reference data, batch upsert)
  // ============================================================

  async saveExamLoincBatch(entries: Array<{ loincCode: string; data: Record<string, any> }>): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(
          `INSERT INTO exam_loinc (loinc_code, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (loinc_code) DO UPDATE SET
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [entry.loincCode, JSON.stringify(entry.data)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getExamLoincCount(): Promise<number> {
    if (!this.pool) return 0;
    const res = await this.pool.query('SELECT COUNT(*) FROM exam_loinc');
    return parseInt(res.rows[0].count, 10);
  }

  async clearExamLoinc(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM exam_loinc');
  }

  // ============================================================
  // REFERENCE CENTERS (κέντρα αναφοράς — SLIS/XML)
  // ============================================================

  async listReferenceCenters(): Promise<ReferenceCenter[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      'SELECT * FROM reference_centers ORDER BY name'
    );
    return res.rows.map(rowToReferenceCenter);
  }

  async getReferenceCenter(id: string): Promise<ReferenceCenter | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT * FROM reference_centers WHERE id = $1', [id]);
    return res.rows.length > 0 ? rowToReferenceCenter(res.rows[0]) : null;
  }

  async saveReferenceCenter(center: ReferenceCenter): Promise<ReferenceCenter> {
    if (!this.pool) return center;
    await this.pool.query(
      `INSERT INTO reference_centers (id, name, url, protocol, config, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         protocol = EXCLUDED.protocol,
         config = EXCLUDED.config,
         active = EXCLUDED.active,
         updated_at = NOW()`,
      [center.id, center.name, center.url, center.protocol, JSON.stringify(center.config || {}), center.active]
    );
    return center;
  }

  /**
   * Εύρεση SLIS test codes από LOINC μέσω του πίνακα `exam_micro`.
   * Επιστρέφει Map<loincCode, Array<{code,name}>> με **όλες** τις πιθανές
   * αντιστοιχίσεις (ένα LOINC μπορεί να αντιστοιχεί σε περισσότερες εξετάσεις
   * του κέντρου, π.χ. Γενική Αίματος → ΓΥΝ/ΕΦΗΒ/ΠΑΙΔ/ΓΕΝΙΚΗ).
   */
  async findMicroTestsByLoinc(
    loincCodes: string[]
  ): Promise<Map<string, Array<{ code: string; name: string }>>> {
    const map = new Map<string, Array<{ code: string; name: string }>>();
    if (!this.pool || loincCodes.length === 0) return map;

    const unique = Array.from(new Set(loincCodes.map(c => String(c).trim()).filter(Boolean)));
    if (unique.length === 0) return map;

    const res = await this.pool.query(
      `SELECT DISTINCT loinc_code_json, examstrcode, name
       FROM exam_micro
       WHERE loinc_code_json = ANY($1::text[])
         AND examstrcode IS NOT NULL AND examstrcode <> 'NULL'
       ORDER BY loinc_code_json, examstrcode`,
      [unique]
    );

    for (const row of res.rows) {
      const loinc = String(row.loinc_code_json);
      const code = String(row.examstrcode);
      const list = map.get(loinc) ?? [];
      if (list.some(o => o.code === code)) continue;
      list.push({ code, name: row.name ? String(row.name) : code });
      map.set(loinc, list);
    }
    return map;
  }

  /**
   * Αντίστροφη αντιστοίχιση: examstrcode (κωδικός sLis) → LOINC codes.
   * Χρησιμοποιείται για την αντιστοίχιση αποτελεσμάτων κέντρου σε εξετάσεις
   * της εφαρμογής όταν δεν υπάρχει `sentToCenter.code`.
   */
  async findLoincsByMicroCodes(codes: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!this.pool || codes.length === 0) return map;

    const unique = Array.from(new Set(codes.map(c => String(c).trim()).filter(Boolean)));
    if (unique.length === 0) return map;

    const res = await this.pool.query(
      `SELECT DISTINCT examstrcode, loinc_code_json
       FROM exam_micro
       WHERE examstrcode = ANY($1::text[])
         AND loinc_code_json IS NOT NULL AND loinc_code_json <> 'NULL'
       ORDER BY examstrcode, loinc_code_json`,
      [unique]
    );
    for (const row of res.rows) {
      const code = String(row.examstrcode);
      const list = map.get(code) ?? [];
      const loinc = String(row.loinc_code_json);
      if (!list.includes(loinc)) list.push(loinc);
      map.set(code, list);
    }
    return map;
  }

  /**
   * LOINC ανά πεδίο για έναν κωδικό εξέτασης (examstrcode).
   * Κάθε γραμμή του `exam_micro` είναι πεδίο: name_field → loinc_code_json.
   */
  async findMicroFieldLoincs(
    examCode: string
  ): Promise<Array<{ field: string; loinc: string }>> {
    if (!this.pool || !examCode) return [];
    const res = await this.pool.query(
      `SELECT DISTINCT name_field, loinc_code_json
       FROM exam_micro
       WHERE examstrcode = $1
         AND loinc_code_json IS NOT NULL AND loinc_code_json <> 'NULL'
       ORDER BY name_field`,
      [examCode]
    );
    return res.rows.map(row => ({
      field: row.name_field ? String(row.name_field) : '',
      loinc: String(row.loinc_code_json),
    }));
  }

  /**
   * Αυξών αριθμός παραγγελίας (atomic) — για το ORDERNO του SLIS.
   * Επιστρέφει 1, 2, 3, … ανά κέντρο.
   */
  async nextOrderCounter(centerId: string): Promise<number> {
    if (!this.pool) return 1;
    const res = await this.pool.query(
      `UPDATE reference_centers
       SET config = jsonb_set(
             config,
             '{orderCounter}',
             to_jsonb(COALESCE(NULLIF(config->>'orderCounter', '')::bigint, 0) + 1)
           ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING COALESCE(NULLIF(config->>'orderCounter', '')::bigint, 1) AS counter`,
      [centerId]
    );
    if (res.rows.length === 0) return 1;
    return Number(res.rows[0].counter) || 1;
  }

  // ============================================================
  // RESET (admin)
  // ============================================================

  async resetExamCatalog(): Promise<void> {
    await this.clearExamCatalog();
  }

  async resetExamLoinc(): Promise<void> {
    await this.clearExamLoinc();
  }

  /**
   * Σχέσεις LOINC → εξετάσεις από τα αποθηκευμένα master data.
   * Επιστρέφει μόνο τα LOINC που ανήκουν σε τουλάχιστον μία εξέταση (~3.600
   * από τα ~103.000), ώστε ο συγχρονισμός παραμέτρων να μη μεταφέρει ξανά
   * ολόκληρο το master data.
   */
  async listExamLoincRelations(): Promise<ExamLoincRelation[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT loinc_code,
              data->>'loincComponent' AS component,
              data->>'loincSystem'    AS system,
              data->>'loincScale'     AS scale,
              data->>'loincMethod'    AS method,
              data->>'loincUnits'     AS units,
              data->>'longName'       AS long_name,
              data->'loincsExaminations' AS examinations
       FROM exam_loinc
       WHERE jsonb_typeof(data->'loincsExaminations') = 'array'
         AND jsonb_array_length(data->'loincsExaminations') > 0
       ORDER BY loinc_code`
    );

    return res.rows.map(row => ({
      loincCode: String(row.loinc_code),
      loincComponent: row.component ?? null,
      loincSystem: row.system ?? null,
      loincScale: row.scale ?? null,
      loincMethod: row.method ?? null,
      loincUnits: row.units ?? null,
      longName: row.long_name ?? null,
      examinations: (Array.isArray(row.examinations) ? row.examinations : []).map((x: any) => ({
        examinationId:
          x?.examinationId !== undefined && x?.examinationId !== null
            ? Number(x.examinationId)
            : null,
        examinationDescription: x?.examinationDescription ?? null,
        examinationGroup: x?.examinationGroup ?? null,
        edapyCode: x?.edapyCode != null ? String(x.edapyCode).trim() : null,
      })),
    }));
  }

  // ============================================================
  // EXAM PARAMETERS (Master Data → δικοί μας πίνακες)
  // ============================================================

  /**
   * Αντικαθιστά ολόκληρο τον πίνακα `exam_parameters` μέσα σε transaction
   * (TRUNCATE + batched INSERT). Έτσι ο συγχρονισμός είναι ατομικός: είτε
   * περνάει όλο το νέο σύνολο, είτε μένει το παλιό.
   */
  async replaceExamParameters(rows: ExamParameterRow[]): Promise<void> {
    if (!this.pool) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM exam_parameters');

      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values: any[] = [];
        const placeholders = chunk.map((r, idx) => {
          const base = idx * 15;
          values.push(
            r.id,
            r.examCode,
            r.position,
            r.loincCode ?? null,
            r.loincComponent ?? null,
            r.loincSystem ?? null,
            r.loincScale ?? null,
            r.loincMethod ?? null,
            r.loincUnits ?? null,
            r.longName ?? null,
            r.examinationId ?? null,
            r.examinationDescription ?? null,
            r.examinationGroup ?? null,
            r.edapyCode ?? null,
            r.source
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
        });

        await client.query(
          `INSERT INTO exam_parameters
             (id, exam_code, position, loinc_code, loinc_component, loinc_system,
              loinc_scale, loinc_method, loinc_units, long_name, examination_id,
              examination_description, examination_group, edapy_code, source)
           VALUES ${placeholders.join(', ')}`,
          values
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Ενημερώνει τα στοιχεία εξέτασης (examinationId/group/πλήθος) στο exam_catalog */
  async updateExamCatalogParamMeta(
    entries: Array<{
      examCode: string;
      examinationId: number | null;
      examinationGroup: string | null;
      parameterCount: number;
    }>
  ): Promise<void> {
    if (!this.pool || entries.length === 0) return;

    const ts = new Date().toISOString();
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH);
      const values: any[] = [ts];
      const placeholders = chunk.map((e, idx) => {
        const base = idx * 4;
        values.push(e.examCode, e.examinationId, e.examinationGroup, e.parameterCount);
        return `($${base + 2}::text, $${base + 3}::int, $${base + 4}::text, $${base + 5}::int)`;
      });

      await this.pool.query(
        `UPDATE exam_catalog AS c SET
           examination_id = v.examination_id,
           examination_group = v.examination_group,
           parameter_count = v.parameter_count,
           params_synced_at = $1::timestamptz
         FROM (VALUES ${placeholders.join(', ')})
           AS v(exam_code, examination_id, examination_group, parameter_count)
         WHERE c.exam_code = v.exam_code`,
        values
      );
    }
  }

  /** Παράμετροι εξέτασης από τον τοπικό πίνακα (ταξινομημένες) */
  async listExamParameters(examCode: string): Promise<ExamParameterRow[]> {
    if (!this.pool || !examCode) return [];
    const res = await this.pool.query(
      `SELECT * FROM exam_parameters WHERE exam_code = $1 ORDER BY position, id`,
      [examCode]
    );
    return res.rows.map(rowToExamParameter);
  }

  /** Εξετάσεις των οποίων οι παράμετροι περιλαμβάνουν το δοσμένο LOINC */
  async findExamCodesByLoinc(loincCode: string): Promise<string[]> {
    if (!this.pool || !loincCode) return [];
    const res = await this.pool.query(
      `SELECT DISTINCT exam_code FROM exam_parameters WHERE loinc_code = $1`,
      [loincCode]
    );
    return res.rows.map(r => String(r.exam_code));
  }

  /** Ακριβής (case-insensitive) αντιστοίχιση ονόματος εξέτασης → examCode */
  async findExamCodeByName(name: string): Promise<string | null> {
    if (!this.pool || !name) return null;
    const res = await this.pool.query(
      `SELECT exam_code FROM exam_catalog
       WHERE lower(btrim(data->>'examDescription')) = lower(btrim($1))
       LIMIT 2`,
      [name]
    );
    return res.rows.length === 1 ? String(res.rows[0].exam_code) : null;
  }

  /** Στοιχεία εξέτασης (group / examinationId) από το Master Data */
  async getExamMasterMeta(examCode: string): Promise<{
    examCode: string;
    examDescription: string | null;
    edapyCode: string | null;
    examinationId: number | null;
    examinationGroup: string | null;
    parameterCount: number;
  } | null> {
    if (!this.pool || !examCode) return null;
    const res = await this.pool.query(
      `SELECT exam_code, examination_id, examination_group, parameter_count,
              data->>'examDescription' AS description,
              data->>'edapyCode' AS edapy
       FROM exam_catalog WHERE exam_code = $1`,
      [examCode]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      examCode: String(r.exam_code),
      examDescription: r.description ? String(r.description) : null,
      edapyCode: r.edapy ? String(r.edapy) : null,
      examinationId: r.examination_id === null ? null : Number(r.examination_id),
      examinationGroup: r.examination_group ? String(r.examination_group) : null,
      parameterCount: Number(r.parameter_count || 0),
    };
  }

  /** Στατιστικά του πίνακα exam_parameters */
  async getExamParameterStats(): Promise<{
    examCount: number;
    parameterCount: number;
    lastSyncedAt: string | null;
    examsWithParameters: number;
  }> {
    if (!this.pool) {
      return { examCount: 0, parameterCount: 0, lastSyncedAt: null, examsWithParameters: 0 };
    }
    const params = await this.pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT exam_code)::int AS exams
       FROM exam_parameters`
    );
    const meta = await this.pool.query(
      `SELECT MAX(params_synced_at) AS last,
              COUNT(*) FILTER (WHERE parameter_count > 0)::int AS with_params
       FROM exam_catalog`
    );
    return {
      examCount: Number(params.rows[0]?.exams || 0),
      parameterCount: Number(params.rows[0]?.total || 0),
      lastSyncedAt: meta.rows[0]?.last ? new Date(meta.rows[0].last).toISOString() : null,
      examsWithParameters: Number(meta.rows[0]?.with_params || 0),
    };
  }

  // ============================================================
  // FINANCE / ΤΑΜΕΙΟ (οφειλές & απαιτήσεις)
  // ============================================================

  async listFinanceEntries(
    filters: {
      direction?: string;
      partyType?: string;
      partyId?: string;
      status?: string;
      patientId?: string;
      referralId?: string;
      doctorId?: string;
      /** Φίλτρο ημερομηνίας λήξης (YYYY-MM-DD) */
      dueFrom?: string;
      dueTo?: string;
    } = {}
  ): Promise<FinanceEntry[]> {
    if (!this.pool) return [];

    const conditions: string[] = [];
    const values: any[] = [];

    const addCondition = (sql: (index: number) => string, value: any) => {
      values.push(value);
      conditions.push(sql(values.length));
    };

    if (filters.direction) addCondition(index => `direction = $${index}`, filters.direction);
    if (filters.partyType) addCondition(index => `party_type = $${index}`, filters.partyType);
    if (filters.partyId) addCondition(index => `party_id = $${index}`, filters.partyId);
    if (filters.status) addCondition(index => `status = $${index}`, filters.status);
    if (filters.patientId) addCondition(index => `patient_id = $${index}`, filters.patientId);
    if (filters.referralId) addCondition(index => `referral_id = $${index}`, filters.referralId);
    if (filters.doctorId) {
      // Κινήσεις χωρίς doctor_id (π.χ. συγχρονισμένες από κέντρα) είναι κοινές για το εργαστήριο
      addCondition(index => `(doctor_id = $${index} OR doctor_id IS NULL)`, filters.doctorId);
    }
    if (filters.dueFrom) addCondition(index => `due_date >= $${index}`, filters.dueFrom);
    if (filters.dueTo) addCondition(index => `due_date <= $${index}`, filters.dueTo);

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT data FROM finance_entries ${clause}
       ORDER BY issue_date DESC NULLS LAST, created_at DESC`,
      values
    );
    return res.rows.map(r => normalizeFinanceEntry(r.data as FinanceEntry));
  }

  async getFinanceEntry(id: string): Promise<FinanceEntry | null> {
    if (!this.pool) return null;
    const res = await this.pool.query('SELECT data FROM finance_entries WHERE id = $1', [id]);
    return res.rows.length > 0 ? normalizeFinanceEntry(res.rows[0].data as FinanceEntry) : null;
  }

  async saveFinanceEntry(entry: FinanceEntry): Promise<FinanceEntry> {
    if (!this.pool) return entry;
    await this.pool.query(
      `INSERT INTO finance_entries
         (id, direction, party_type, party_id, party_name, patient_id, referral_id,
          doctor_id, status, amount, paid_amount, issue_date, due_date, data, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET
         direction = EXCLUDED.direction,
         party_type = EXCLUDED.party_type,
         party_id = EXCLUDED.party_id,
         party_name = EXCLUDED.party_name,
         patient_id = EXCLUDED.patient_id,
         referral_id = EXCLUDED.referral_id,
         doctor_id = EXCLUDED.doctor_id,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         paid_amount = EXCLUDED.paid_amount,
         issue_date = EXCLUDED.issue_date,
         due_date = EXCLUDED.due_date,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        entry.id,
        entry.direction,
        entry.partyType,
        entry.partyId || null,
        entry.partyName,
        entry.patientId || null,
        entry.referralId || null,
        entry.doctorId || null,
        entry.status,
        entry.amount,
        entry.paidAmount,
        entry.issueDate || null,
        entry.dueDate || null,
        JSON.stringify(entry),
      ]
    );
    return entry;
  }

  /**
   * Μαζική εγγραφή κινήσεων ταμείου (ένα multi-row upsert).
   * Χρησιμοποιείται από τον συγχρονισμό παραστατικών για ταχύτητα.
   */
  async saveFinanceEntries(entries: FinanceEntry[]): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;

    const columnsPerRow = 14;
    const values: any[] = [];
    const rows: string[] = [];

    entries.forEach((entry, index) => {
      const base = index * columnsPerRow;
      rows.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},` +
          `$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},NOW(),NOW())`
      );
      values.push(
        entry.id,
        entry.direction,
        entry.partyType,
        entry.partyId || null,
        entry.partyName,
        entry.patientId || null,
        entry.referralId || null,
        entry.doctorId || null,
        entry.status,
        entry.amount,
        entry.paidAmount,
        entry.issueDate || null,
        entry.dueDate || null,
        JSON.stringify(entry)
      );
    });

    await this.pool.query(
      `INSERT INTO finance_entries
         (id, direction, party_type, party_id, party_name, patient_id, referral_id,
          doctor_id, status, amount, paid_amount, issue_date, due_date, data, created_at, updated_at)
       VALUES ${rows.join(',')}
       ON CONFLICT (id) DO UPDATE SET
         direction = EXCLUDED.direction,
         party_type = EXCLUDED.party_type,
         party_id = EXCLUDED.party_id,
         party_name = EXCLUDED.party_name,
         patient_id = EXCLUDED.patient_id,
         referral_id = EXCLUDED.referral_id,
         doctor_id = EXCLUDED.doctor_id,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         paid_amount = EXCLUDED.paid_amount,
         issue_date = EXCLUDED.issue_date,
         due_date = EXCLUDED.due_date,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      values
    );

    return entries.length;
  }

  async updateFinanceEntry(id: string, updates: Partial<FinanceEntry>): Promise<FinanceEntry> {
    if (!this.pool) return { id, ...updates } as FinanceEntry;
    const current = await this.getFinanceEntry(id);
    if (!current) throw new Error(`Finance entry ${id} not found`);

    const merged: FinanceEntry = {
      ...current,
      ...updates,
      amount: Math.max(0, Number(updates.amount ?? current.amount) || 0),
      paidAmount: Math.max(0, Number(updates.paidAmount ?? current.paidAmount) || 0),
      updatedAt: new Date().toISOString(),
    };
    merged.status = financeStatusFromAmounts({
      amount: merged.amount,
      paidAmount: merged.paidAmount,
      // Το 'cancelled' διατηρείται μόνο όταν ζητείται ρητά
      status: updates.status ?? current.status,
    });

    await this.saveFinanceEntry(merged);
    return merged;
  }

  async deleteFinanceEntry(id: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM finance_entries WHERE id = $1', [id]);
  }
}

/** Τύπος κίνησης ταμείου */
export type FinanceDirection = 'debt' | 'receivable';

/** Αντισυμβαλλόμενος κίνησης ταμείου */
export type FinancePartyType = 'reference_center' | 'payer' | 'patient';

/** Κατάσταση κίνησης ταμείου */
export type FinanceEntryStatus = 'pending' | 'partial' | 'settled' | 'cancelled';

/** Καταχώρηση εξόφλησης/είσπραξης πάνω σε κίνηση ταμείου */
export interface FinancePayment {
  id: string;
  amount: number;
  paidAt: string;
  method?: string;
  notes?: string;
  createdAt: string;
}

/** Προέλευση κίνησης όταν δημιουργείται από εξωτερικό σύστημα */
export interface FinanceEntrySource {
  system: string;
  centerId?: string;
  documentId?: string;
  /** Είδος παραστατικού κέντρου: τιμολόγιο, απόδειξη είσπραξης, πιστωτικό */
  documentType?: 'invoice' | 'receipt' | 'credit';
  tradeCode?: string;
  series?: string;
  einvoiceId?: string;
  einvoiceUrl?: string;
  netAmount?: number;
  vatAmount?: number;
  totalAmount?: number;
  /** Υπόλοιπο προς εξόφληση όπως το δίνει το κέντρο (0 = εξοφλημένο, <0 = πιστωμένο) */
  deductedAmount?: number;
}

/** Κίνηση ταμείου: οφειλή (debt) ή απαίτηση (receivable) */
export interface FinanceEntry {
  id: string;
  direction: FinanceDirection;
  partyType: FinancePartyType;
  partyId?: string;
  partyName: string;
  patientId?: string;
  patientName?: string;
  referralId?: string;
  referralBarcode?: string;
  description?: string;
  amount: number;
  paidAmount: number;
  status: FinanceEntryStatus;
  issueDate: string;
  dueDate?: string;
  notes?: string;
  payments: FinancePayment[];
  /** Στοιχεία προέλευσης (π.χ. παραστατικό Emporiko) */
  source?: FinanceEntrySource;
  doctorId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Υπολογισμός κατάστασης από ποσό/εξοφλημένο ποσό */
export function financeStatusFromAmounts(entry: {
  amount?: number;
  paidAmount?: number;
  status?: FinanceEntryStatus;
}): FinanceEntryStatus {
  if (entry.status === 'cancelled') return 'cancelled';
  const amount = Number(entry.amount) || 0;
  const paid = Number(entry.paidAmount) || 0;
  if (amount > 0 && paid >= amount - 0.005) return 'settled';
  if (paid > 0) return 'partial';
  return 'pending';
}

function normalizeFinanceEntry(entry: FinanceEntry): FinanceEntry {
  return {
    ...entry,
    amount: Number(entry.amount) || 0,
    paidAmount: Number(entry.paidAmount) || 0,
    payments: Array.isArray(entry.payments) ? entry.payments : [],
  };
}

/** Κέντρο αναφοράς (SLIS/XML) */
export interface ReferenceCenter {
  id: string;
  name: string;
  url: string;
  protocol: string;
  config: {
    requestType?: string;
    senderCode?: string;
    username?: string;
    password?: string;
    requestor?: string;
    action?: number;
    /** Εκτύπωση barcode αριθμού εντολής — ρυθμίσεις ανά κέντρο */
    barcodeType?: string;
    barcodeWidthMm?: number;
    barcodeHeightMm?: number;
    barcodeShowText?: boolean;
    barcodeCopies?: number;
    [key: string]: any;
  };
  active: boolean;
}

function rowToReferenceCenter(row: any): ReferenceCenter {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    protocol: String(row.protocol || 'slis'),
    config: row.config || {},
    active: Boolean(row.active),
  };
}

/** Σχέση LOINC → εξέταση από το Master Data (exam_loinc) */
export interface ExamLoincRelation {
  loincCode: string;
  loincComponent: string | null;
  loincSystem: string | null;
  loincScale: string | null;
  loincMethod: string | null;
  loincUnits: string | null;
  longName: string | null;
  examinations: Array<{
    examinationId: number | null;
    examinationDescription: string | null;
    examinationGroup: string | null;
    edapyCode: string | null;
  }>;
}

/** Γραμμή του πίνακα exam_parameters */
export interface ExamParameterRow {
  id: string;
  examCode: string;
  position: number;
  loincCode: string | null;
  loincComponent: string | null;
  loincSystem: string | null;
  loincScale: string | null;
  loincMethod: string | null;
  loincUnits: string | null;
  longName: string | null;
  examinationId: number | null;
  examinationDescription: string | null;
  examinationGroup: string | null;
  edapyCode: string | null;
  source: string;
}

function rowToExamParameter(row: any): ExamParameterRow {
  return {
    id: String(row.id),
    examCode: String(row.exam_code),
    position: Number(row.position || 0),
    loincCode: row.loinc_code ?? null,
    loincComponent: row.loinc_component ?? null,
    loincSystem: row.loinc_system ?? null,
    loincScale: row.loinc_scale ?? null,
    loincMethod: row.loinc_method ?? null,
    loincUnits: row.loinc_units ?? null,
    longName: row.long_name ?? null,
    examinationId: row.examination_id === null ? null : Number(row.examination_id),
    examinationDescription: row.examination_description ?? null,
    examinationGroup: row.examination_group ?? null,
    edapyCode: row.edapy_code ?? null,
    source: String(row.source || 'exam-codes'),
  };
}

export const dbService = new DbService();
