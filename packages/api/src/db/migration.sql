-- ============================================================
-- MediLab PostgreSQL Schema Migration
-- Neon PostgreSQL (Serverless)
-- ============================================================

-- Users: ο πίνακας "user" του Better Auth είναι η μοναδική πηγή χρηστών.
-- Ο παλιός πίνακας `users` (Firebase era) μεταφέρεται και διαγράφεται στο startup.

-- Patients
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  doctor_id TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_patients_doctor ON patients(doctor_id);

-- Lab Results
CREATE TABLE IF NOT EXISTS lab_results (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lab_results_patient ON lab_results(patient_id);

-- Reports (DiagnosticReport)
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_patient ON reports(patient_id);

-- Analyses
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analyses_patient ON analyses(patient_id);

-- Visits
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  doctor_id TEXT,
  visit_date DATE,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_doctor ON visits(doctor_id);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  visit_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals(patient_id);
CREATE INDEX IF NOT EXISTS idx_referrals_visit ON referrals(visit_id);
CREATE INDEX IF NOT EXISTS idx_referrals_doctor ON referrals(doctor_id);

-- Exams
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  referral_id TEXT,
  visit_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exams_patient ON exams(patient_id);
CREATE INDEX IF NOT EXISTS idx_exams_referral ON exams(referral_id);
CREATE INDEX IF NOT EXISTS idx_exams_visit ON exams(visit_id);
CREATE INDEX IF NOT EXISTS idx_exams_doctor ON exams(doctor_id);

-- Exam Catalog (reference data, synced from ΗΔΙΚΑ API)
CREATE TABLE IF NOT EXISTS exam_catalog (
  exam_code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ
);

-- Exam LOINC (reference data, synced from ΗΔΙΚΑ API masterdata)
CREATE TABLE IF NOT EXISTS exam_loinc (
  loinc_code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exam_loinc_component ON exam_loinc USING GIN ((data->'loincComponent'));

-- ============================================================
-- Exam Parameters (Master Data → δικοί μας πίνακες)
-- Κανονικοποιημένη σχέση «εξέταση → παράμετροι».
-- Πηγές (ΗΔΙΚΑ Lab Data Repository):
--   • GET /api/masterdata/exam-codes/loinc → suggestedLoincs[]
--   • GET /api/masterdata/loinc            → loincsExaminations[]
-- Το join των δύο πηγών γίνεται με το edapyCode.
-- ============================================================

CREATE TABLE IF NOT EXISTS exam_parameters (
  id                      TEXT PRIMARY KEY,          -- '<examCode>:<loincCode|seq>'
  exam_code               TEXT NOT NULL,
  position                INTEGER NOT NULL DEFAULT 0,
  loinc_code              TEXT,
  loinc_component         TEXT,
  loinc_system            TEXT,
  loinc_scale             TEXT,
  loinc_method            TEXT,
  loinc_units             TEXT,
  long_name               TEXT,
  examination_id          INTEGER,
  examination_description TEXT,
  examination_group       TEXT,
  edapy_code              TEXT,
  source                  TEXT NOT NULL DEFAULT 'exam-codes', -- 'exam-codes' | 'loinc'
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exam_parameters_exam ON exam_parameters(exam_code, position);
CREATE INDEX IF NOT EXISTS idx_exam_parameters_loinc ON exam_parameters(loinc_code);

-- Στοιχεία εξέτασης από το Master Data (ενημέρωση από τον ίδιο συγχρονισμό)
ALTER TABLE exam_catalog ADD COLUMN IF NOT EXISTS examination_id INTEGER;
ALTER TABLE exam_catalog ADD COLUMN IF NOT EXISTS examination_group TEXT;
ALTER TABLE exam_catalog ADD COLUMN IF NOT EXISTS parameter_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_catalog ADD COLUMN IF NOT EXISTS params_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_exam_catalog_params_synced ON exam_catalog(params_synced_at);

-- ============================================================
-- E-Fulfillment (e-Prescription / ΗΔΙΚΑ)
-- Credentials + τελευταία ληφθέντα στοιχεία χρήστη από το /api/me.
-- Ο φορέας απαιτεί κλήση του /api/me τουλάχιστον κάθε 24 ώρες (αλλιώς σφάλμα 603).
-- ============================================================

CREATE TABLE IF NOT EXISTS user_efulfillment (
  user_id UUID PRIMARY KEY,
  epres_username TEXT NOT NULL,
  epres_password_enc TEXT NOT NULL,
  doctor_ip TEXT,
  data JSONB,
  last_sync_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_efulfillment_last_sync ON user_efulfillment(last_sync_at);

-- Ρυθμίσεις εφαρμογής (π.χ. E-Fulfillment Api-Key / Base URL) — υπερισχύουν των env vars
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Better Auth (Neon PostgreSQL) — αντικαθιστά το Firebase/Google Auth
-- Το Better Auth γράφει στο schema `neon_auth`, που είναι και το schema
-- που διαβάζει το Neon Auth dashboard (console.neon.tech → Auth).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS neon_auth;

CREATE TABLE IF NOT EXISTS neon_auth."user" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL,
  "image" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "role" TEXT DEFAULT 'doctor',
  "banned" BOOLEAN,
  "banReason" TEXT,
  "banExpires" TIMESTAMPTZ,
  "legacyUid" TEXT
);

CREATE TABLE IF NOT EXISTS neon_auth."session" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" UUID NOT NULL REFERENCES neon_auth."user" ("id") ON DELETE CASCADE,
  "impersonatedBy" TEXT,
  "activeOrganizationId" TEXT
);

CREATE TABLE IF NOT EXISTS neon_auth.account (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" UUID NOT NULL REFERENCES neon_auth."user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS neon_auth."verification" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON neon_auth."session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON neon_auth.account ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON neon_auth."verification" ("identifier");
CREATE INDEX IF NOT EXISTS "user_legacyUid_idx" ON neon_auth."user" ("legacyUid");

-- Πρόσθετα πεδία σε περίπτωση που το neon_auth δημιουργήθηκε από το Neon Auth
ALTER TABLE neon_auth."user" ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'doctor';
ALTER TABLE neon_auth."user" ADD COLUMN IF NOT EXISTS "legacyUid" TEXT;
-- ============================================================
-- Reference Centers (Κέντρα Αναφοράς) — SLIS / Infomed XML
-- Αποστολή εξετάσεων παραπεμπτικού σε εξωτερικό κέντρο.
-- ============================================================

CREATE TABLE IF NOT EXISTS reference_centers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'slis',
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

INSERT INTO reference_centers (id, name, url, protocol, config, active)
VALUES (
  'microanalysis',
  'ΜΙΚΡΟΑΝΑΛΥΣΗ',
  'http://xxx.xxx.xxx.xxx:xxxx/SLISMESSAGE',
  'slis',
  '{"requestType":"create-order","senderCode":"","username":"","password":"","requestor":"","action":1}'::jsonb,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Ταμείο — οφειλές προς κέντρα αναφοράς / φορείς και απαιτήσεις
-- από ασθενείς. Κάθε γραμμή είναι μια κίνηση (υποχρέωση ή απαίτηση)
-- με δυνατότητα μερικών εξοφλήσεων (payments στο JSONB data).
-- ============================================================

CREATE TABLE IF NOT EXISTS finance_entries (
  id           TEXT PRIMARY KEY,
  direction    TEXT NOT NULL,                 -- 'debt' (οφειλή) | 'receivable' (απαίτηση)
  party_type   TEXT NOT NULL,                 -- 'reference_center' | 'payer' | 'patient'
  party_id     TEXT,
  party_name   TEXT NOT NULL,
  patient_id   TEXT,
  referral_id  TEXT,
  doctor_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  issue_date   DATE,
  due_date     DATE,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_finance_entries_direction ON finance_entries(direction);
CREATE INDEX IF NOT EXISTS idx_finance_entries_party ON finance_entries(party_type, party_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_status ON finance_entries(status);
CREATE INDEX IF NOT EXISTS idx_finance_entries_patient ON finance_entries(patient_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_referral ON finance_entries(referral_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_doctor ON finance_entries(doctor_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_due_date ON finance_entries(due_date);

-- ============================================================
-- Ημερολόγιο — ραντεβού ανά ασθενή
-- Κάθε ραντεβού μπορεί να μετατραπεί σε επίσκεψη (visit_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS appointments (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,
  doctor_id     TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',
  visit_id      TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_id);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at ON appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_visit ON appointments(visit_id);
