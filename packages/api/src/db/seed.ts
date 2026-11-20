/**
 * Seed script — εισάγει δοκιμαστικά δεδομένα στη Neon PostgreSQL.
 * Εκτελείται με: npx ts-node src/db/seed.ts
 */

import { Pool } from 'pg';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '..', '..', '..', '..', '.env.local') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 10000,
});

// ── Βοηθητικές ──

const now = new Date().toISOString();

function ts() {
  return Date.now().toString();
}

function uid(prefix: string) {
  return `${prefix}_seed_${ts()}_${Math.random().toString(36).substring(2, 8)}`;
}

// ── Δεδομένα ──

const adminDoctorId = 'z6VSCtG6N1eK25rxpo1tswFoMgN2';

const patients = [
  {
    id: uid('patient'),
    firstName: 'Γεώργιος',
    lastName: 'Παπαδόπουλος',
    dateOfBirth: '1965-03-15',
    gender: 'male',
    amka: '15036512345',
    status: 'geriatric',
    medicalHistory: [
      'Υπέρταση (διαγνώστηκε 2010)',
      'Σακχαρώδης Διαβήτης τύπου 2 (διαγνώστηκε 2015)',
      'Υπερλιπιδαιμία',
    ],
    medications: ['Metformin 850mg 2x/day', 'Amlodipine 5mg 1x/day', 'Atorvastatin 20mg 1x/day'],
    height: 172,
    weight: 88,
    doctorId: adminDoctorId,
  },
  {
    id: uid('patient'),
    firstName: 'Μαρία',
    lastName: 'Κωνσταντίνου',
    dateOfBirth: '1982-07-22',
    gender: 'female',
    amka: '22078298765',
    status: 'non_fasting',
    medicalHistory: ['Θυρεοειδίτιδα Hashimoto (διαγνώστηκε 2018)', 'Αναιμία', 'Αλλεργική ρινίτιδα'],
    medications: ['Levothyroxine 75μg 1x/day', 'Iron supplement'],
    height: 165,
    weight: 62,
    doctorId: adminDoctorId,
  },
  {
    id: uid('patient'),
    firstName: 'Νικόλαος',
    lastName: 'Αντωνίου',
    dateOfBirth: '1990-11-05',
    gender: 'male',
    amka: '05119011223',
    status: 'fasting',
    medicalHistory: ['Άσθμα (διαγνώστηκε 2005)'],
    medications: ['Salbutamol inhaler PRN'],
    height: 182,
    weight: 78,
    doctorId: adminDoctorId,
  },
  {
    id: uid('patient'),
    firstName: 'Ελένη',
    lastName: 'Δημητρίου',
    dateOfBirth: '1958-01-30',
    gender: 'female',
    amka: '30015845678',
    status: 'post_menopausal',
    medicalHistory: [
      'Οστεοπόρωση (διαγνώστηκε 2012)',
      'Υπέρταση (διαγνώστηκε 2018)',
      'Χρόνια Νεφρική Νόσος σταδίου 2',
    ],
    medications: ['Alendronate 70mg 1x/week', 'Losartan 50mg 1x/day', 'Calcium + Vit D'],
    height: 160,
    weight: 71,
    doctorId: adminDoctorId,
  },
  {
    id: uid('patient'),
    firstName: 'Δημήτριος',
    lastName: 'Παπανικολάου',
    dateOfBirth: '2015-09-12',
    gender: 'male',
    amka: '12091533445',
    status: 'pediatric',
    medicalHistory: ['Αλλεργία σε ξηρούς καρπούς', 'Ατοπική δερματίτιδα'],
    medications: ['Antihistamine PRN'],
    height: 128,
    weight: 27,
    doctorId: adminDoctorId,
  },
];

const visitReasons = [
  {
    reason: 'Προληπτικός έλεγχος ρουτίνας',
    diagnosis: 'Υπέρταση αρρύθμιστη — ανάγκη τροποποίησης αγωγής',
    notes: 'Ο ασθενής αναφέρει ζαλάδες το πρωί. Προτείνεται 24ωρη καταγραφή πίεσης.',
  },
  {
    reason: 'Διερεύνηση κόπωσης και αδυναμίας',
    diagnosis: 'Σιδηροπενική αναιμία (Hb=10.2, Ferritin=12)',
    notes: 'Έναρξη σιδήρου από του στόματος. Επανέλεγχος σε 3 μήνες.',
  },
  {
    reason: 'Πόνος στο στήθος κατά την άσκηση',
    diagnosis: 'Στηθάγχη — παραπομπή για δοκιμασία κοπώσεως',
    notes: 'ΗΚΓ: χωρίς ισχαιμικές αλλοιώσεις. Οικογενειακό ιστορικό ΣΝ.',
  },
  {
    reason: 'Παρακολούθηση θυρεοειδούς',
    diagnosis: 'Υποθυρεοειδισμός υπό αγωγή — TSH=3.8 εντός στόχου',
    notes: 'Συνέχιση ίδιας δοσολογίας Levothyroxine.',
  },
  {
    reason: 'Εμβολιασμός και γενική εξέταση',
    diagnosis: 'Φυσιολογική ανάπτυξη. Χορήγηση εμβολίου.',
    notes: 'Το παιδί είναι σε καλή γενική κατάσταση. Βάρος/ύψος στην 50η ΕΘ.',
  },
  {
    reason: 'Έλεγχος λιπιδαιμικού προφίλ',
    diagnosis: 'Μικτή υπερλιπιδαιμία (LDL=165, HDL=38, TG=220)',
    notes: 'Έναρξη Rosuvastatin 10mg. Διατροφικές οδηγίες.',
  },
  {
    reason: 'Πόνος στις αρθρώσεις — διερεύνηση',
    diagnosis: 'Οστεοαρθρίτιδα γονάτων — ακτινολογική επιβεβαίωση',
    notes: 'Παραπομπή σε Ορθοπεδικό. Έναρξη φυσικοθεραπείας.',
  },
];

const referralSpecialties = [
  { specialty: 'Καρδιολόγος', reason: 'Δοκιμασία κοπώσεως λόγω στηθάγχης', hospital: 'Γενικό Νοσοκομείο "Ιπποκράτειο"' },
  { specialty: 'Ακτινοδιαγνώστης', reason: 'Ακτινογραφία θώρακος', hospital: 'Διαγνωστικό Κέντρο "Υγεία"' },
  { specialty: 'Ενδοκρινολόγος', reason: 'Ρύθμιση σακχαρώδη διαβήτη', hospital: 'Πανεπιστημιακό Νοσοκομείο' },
  { specialty: 'Ορθοπεδικός', reason: 'Αξιολόγηση οστεοαρθρίτιδας γονάτων', hospital: 'Ιατρικό Κέντρο Αθηνών' },
  { specialty: 'Οφθαλμίατρος', reason: 'Βυθοσκόπηση — ετήσιος έλεγχος διαβητικού', hospital: 'Οφθαλμολογικό Κέντρο "Διάθλαση"' },
  { specialty: 'Γαστρεντερολόγος', reason: 'Γαστροσκόπηση — διερεύνηση αναιμίας', hospital: 'Γενική Κλινική "Ευρωκλινική"' },
  { specialty: 'Νεφρολόγος', reason: 'Παρακολούθηση ΧΝΝ σταδίου 2', hospital: 'Πανεπιστημιακό Νοσοκομείο' },
  { specialty: 'Αλλεργιολόγος', reason: 'Δερματικές δοκιμασίες αλλεργίας', hospital: 'Παιδιατρικό Νοσοκομείο "Αγία Σοφία"' },
  { specialty: 'Πνευμονολόγος', reason: 'Σπιρομέτρηση — έλεγχος άσθματος', hospital: 'Γενικό Νοσοκομείο "Σωτηρία"' },
];

const examTemplates = [
  {
    name: 'Γενική Αίματος (CBC)',
    category: 'Αιματολογικές',
    loincCode: '58410-2',
    hasParams: true,
    defaultParameters: [
      { name: 'WBC (Λευκά αιμοσφαίρια)', result: '7.2', unit: 'x10³/μL', referenceRange: '4.0-11.0' },
      { name: 'RBC (Ερυθρά αιμοσφαίρια)', result: '5.1', unit: 'x10⁶/μL', referenceRange: '4.5-5.9' },
      { name: 'HGB (Αιμοσφαιρίνη)', result: '14.8', unit: 'g/dL', referenceRange: '13.5-17.5' },
      { name: 'HCT (Αιματοκρίτης)', result: '44.2', unit: '%', referenceRange: '40-52' },
      { name: 'MCV (Μέσος όγκος ερυθρών)', result: '87', unit: 'fL', referenceRange: '80-100' },
      { name: 'MCH (Μέση Hb ερυθρών)', result: '29.5', unit: 'pg', referenceRange: '27-33' },
      { name: 'PLT (Αιμοπετάλια)', result: '245', unit: 'x10³/μL', referenceRange: '150-450' },
    ],
  },
  {
    name: 'Σάκχαρο (Γλυκόζη)',
    category: 'Βιοχημικές',
    loincCode: '2345-7',
    hasParams: false,
    result: '95',
    unit: 'mg/dL',
    referenceRange: '70-110',
  },
  {
    name: 'Γλυκοζυλιωμένη Αιμοσφαιρίνη (HbA1c)',
    category: 'Βιοχημικές',
    loincCode: '4548-4',
    hasParams: false,
    result: '6.8',
    unit: '%',
    referenceRange: '<5.7',
  },
  {
    name: 'Λιπιδαιμικό Προφίλ',
    category: 'Λιπίδια',
    hasParams: true,
    defaultParameters: [
      { name: 'Ολική Χοληστερίνη', result: '220', unit: 'mg/dL', referenceRange: '<200' },
      { name: 'LDL Χοληστερίνη', result: '145', unit: 'mg/dL', referenceRange: '<100' },
      { name: 'HDL Χοληστερίνη', result: '42', unit: 'mg/dL', referenceRange: '>40' },
      { name: 'Τριγλυκερίδια', result: '185', unit: 'mg/dL', referenceRange: '<150' },
    ],
  },
  {
    name: 'Θυρεοειδικές Ορμόνες',
    category: 'Ορμονολογικές',
    hasParams: true,
    defaultParameters: [
      { name: 'TSH', result: '2.8', unit: 'μIU/mL', referenceRange: '0.4-4.0' },
      { name: 'FT3', result: '3.2', unit: 'pg/mL', referenceRange: '2.0-4.4' },
      { name: 'FT4', result: '1.3', unit: 'ng/dL', referenceRange: '0.8-1.8' },
      { name: 'Anti-TPO', result: '125', unit: 'IU/mL', referenceRange: '<35' },
    ],
  },
  {
    name: 'Γενική Ούρων',
    category: 'Ουρολογικές',
    loincCode: '58066-8',
    hasParams: true,
    defaultParameters: [
      { name: 'Ειδικό Βάρος', result: '1.020', unit: '', referenceRange: '1.005-1.030' },
      { name: 'pH', result: '6.0', unit: '', referenceRange: '5.0-8.0' },
      { name: 'Λεύκωμα', result: 'Αρνητικό', unit: '', referenceRange: 'Αρνητικό' },
      { name: 'Γλυκόζη', result: 'Αρνητική', unit: '', referenceRange: 'Αρνητική' },
      { name: 'Ερυθρά', result: '0-2', unit: '/οπ', referenceRange: '0-2' },
      { name: 'Πυοσφαίρια', result: '0-2', unit: '/οπ', referenceRange: '0-5' },
    ],
  },
  {
    name: 'Σίδηρος – Φεριτίνη',
    category: 'Βιοχημικές',
    hasParams: true,
    defaultParameters: [
      { name: 'Σίδηρος (Fe)', result: '55', unit: 'μg/dL', referenceRange: '60-170' },
      { name: 'Φεριτίνη', result: '18', unit: 'ng/mL', referenceRange: '20-250' },
      { name: 'TIBC', result: '420', unit: 'μg/dL', referenceRange: '250-450' },
      { name: 'Κορεσμός', result: '13', unit: '%', referenceRange: '20-50' },
    ],
  },
  {
    name: 'Ηπατικές Δοκιμασίες',
    category: 'Βιοχημικές',
    hasParams: true,
    defaultParameters: [
      { name: 'SGOT (AST)', result: '25', unit: 'U/L', referenceRange: '5-40' },
      { name: 'SGPT (ALT)', result: '30', unit: 'U/L', referenceRange: '5-40' },
      { name: 'γ-GT', result: '28', unit: 'U/L', referenceRange: '5-55' },
      { name: 'ALP', result: '72', unit: 'U/L', referenceRange: '40-130' },
    ],
  },
  {
    name: 'Δείκτες Φλεγμονής',
    category: 'Ανοσολογικές',
    hasParams: true,
    defaultParameters: [
      { name: 'TKE', result: '22', unit: 'mm/h', referenceRange: '0-20' },
      { name: 'CRP', result: '8.5', unit: 'mg/L', referenceRange: '<5' },
    ],
  },
  {
    name: 'Ηλεκτρολύτες',
    category: 'Βιοχημικές',
    hasParams: true,
    defaultParameters: [
      { name: 'Νάτριο (Na)', result: '140', unit: 'mmol/L', referenceRange: '135-145' },
      { name: 'Κάλιο (K)', result: '4.2', unit: 'mmol/L', referenceRange: '3.5-5.1' },
      { name: 'Ασβέστιο (Ca)', result: '9.5', unit: 'mg/dL', referenceRange: '8.5-10.5' },
      { name: 'Μαγνήσιο (Mg)', result: '2.0', unit: 'mg/dL', referenceRange: '1.7-2.2' },
    ],
  },
];

// ── Συναρτήσεις εισαγωγής ──

async function seed() {
  console.log('🌱 Seeding PostgreSQL...\n');

  // ── Καθαρισμός παλιών test δεδομένων ──
  await pool.query("DELETE FROM exams WHERE id LIKE 'exam_seed_%'");
  await pool.query("DELETE FROM referrals WHERE id LIKE 'referral_seed_%'");
  await pool.query("DELETE FROM visits WHERE id LIKE 'visit_seed_%'");
  await pool.query("DELETE FROM patients WHERE id LIKE 'patient_seed_%'");
  console.log('🗑️  Παλιά δεδομένα διαγράφηκαν.\n');

  // ── Ασθενείς ──
  const patientIds: string[] = [];
  console.log('👤 Ασθενείς:');
  for (const p of patients) {
    await pool.query(
      `INSERT INTO patients (id, doctor_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [p.id, p.doctorId, JSON.stringify(p)]
    );
    patientIds.push(p.id);
    console.log(`  ✅ ${p.firstName} ${p.lastName} (${p.dateOfBirth}) — AMKA: ${p.amka}`);
  }

  // ── Επισκέψεις ──
  const visitIds: string[] = [];
  console.log('\n📅 Επισκέψεις:');
  const date = new Date('2026-06-01');
  for (let i = 0; i < patients.length; i++) {
    const visitDate = new Date(date.getTime() + i * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const reason = visitReasons[i % visitReasons.length];
    const v = {
      id: `visit_seed_${i + 1}`,
      patientId: patientIds[i],
      patientName: `${patients[i].firstName} ${patients[i].lastName}`,
      visitDate,
      reason: reason.reason,
      diagnosis: reason.diagnosis,
      notes: reason.notes,
      doctorId: adminDoctorId,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    };
    await pool.query(
      `INSERT INTO visits (id, patient_id, doctor_id, visit_date, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [v.id, v.patientId, v.doctorId, v.visitDate, JSON.stringify(v)]
    );
    visitIds.push(v.id);
    console.log(`  ✅ ${visitDate}: ${patients[i].firstName} — "${v.reason}"`);
  }

  // ── Προσθήκη 2ης επίσκεψης για μερικούς ασθενείς ──
  for (let i = 0; i < 3; i++) {
    const visitDate2 = new Date(date.getTime() + (i * 7 + 3) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const reason2 = visitReasons[(i + 5) % visitReasons.length];
    const vi = visitIds.length + 1;
    const v2 = {
      id: `visit_seed_${vi}`,
      patientId: patientIds[i],
      patientName: `${patients[i].firstName} ${patients[i].lastName}`,
      visitDate: visitDate2,
      reason: reason2.reason,
      diagnosis: reason2.diagnosis,
      notes: reason2.notes,
      doctorId: adminDoctorId,
      status: i < 2 ? 'completed' : 'in_progress',
      createdAt: now,
      updatedAt: now,
    };
    await pool.query(
      `INSERT INTO visits (id, patient_id, doctor_id, visit_date, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [v2.id, v2.patientId, v2.doctorId, v2.visitDate, JSON.stringify(v2)]
    );
    visitIds.push(v2.id);
    console.log(`  ✅ ${visitDate2}: ${patients[i].firstName} — "${v2.reason}" (2η επίσκεψη)`);
  }

  // ── Παραπεμπτικά ──
  const referralIds: string[] = [];
  console.log('\n📋 Παραπεμπτικά:');
  for (let i = 0; i < 6; i++) {
    const spec = referralSpecialties[i % referralSpecialties.length];
    const refDate = new Date(date.getTime() + i * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const ri = i + 1;
    const ref = {
      id: `referral_seed_${ri}`,
      visitId: visitIds[i],
      patientId: patientIds[i % patientIds.length],
      patientName: `${patients[i % patientIds.length].firstName} ${patients[i % patientIds.length].lastName}`,
      visitReason: visitReasons[i % visitReasons.length].reason,
      specialty: spec.specialty,
      reason: spec.reason,
      hospital: spec.hospital,
      referralDate: refDate,
      status: i < 3 ? 'completed' : i < 5 ? 'sent' : 'pending',
      notes: '',
      reportUrl: '',
      doctorId: adminDoctorId,
      createdAt: now,
      updatedAt: now,
    };
    await pool.query(
      `INSERT INTO referrals (id, visit_id, patient_id, doctor_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [ref.id, ref.visitId, ref.patientId, ref.doctorId, JSON.stringify(ref)]
    );
    referralIds.push(ref.id);
    console.log(`  ✅ #${ri}: ${ref.patientName} → ${ref.specialty} (${ref.hospital}) [${ref.status}]`);
  }

  // ── Εξετάσεις ──
  let examCount = 0;
  console.log('\n🔬 Εξετάσεις:');
  for (let i = 0; i < referralIds.length; i++) {
    // 2-3 εξετάσεις ανά παραπεμπτικό
    const numExams = 2 + (i % 2);
    for (let j = 0; j < numExams; j++) {
      const tmplIdx = (i * 3 + j) % examTemplates.length;
      const tmpl = examTemplates[tmplIdx];
      examCount++;
      const exam = {
        id: `exam_seed_${examCount}`,
        referralId: referralIds[i],
        visitId: visitIds[i],
        patientId: patientIds[i % patientIds.length],
        patientName: `${patients[i % patientIds.length].firstName} ${patients[i % patientIds.length].lastName}`,
        name: tmpl.name,
        category: tmpl.category,
        status: 'completed',
        result: (tmpl as any).result || '',
        unit: (tmpl as any).unit || '',
        referenceRange: (tmpl as any).referenceRange || '',
        parameters: tmpl.hasParams ? tmpl.defaultParameters : [],
        loincCode: (tmpl as any).loincCode || '',
        notes: '',
        examDate: new Date(date.getTime() + i * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        doctorId: adminDoctorId,
        createdAt: now,
        updatedAt: now,
      };
      await pool.query(
        `INSERT INTO exams (id, referral_id, visit_id, patient_id, doctor_id, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [exam.id, exam.referralId, exam.visitId, exam.patientId, exam.doctorId, JSON.stringify(exam)]
      );
      if (j === 0) {
        const shortName = tmpl.name.length > 30 ? tmpl.name.substring(0, 30) + '...' : tmpl.name;
        console.log(`  ✅ ${shortName} ${tmpl.hasParams ? `(${tmpl.defaultParameters!.length} παράμετροι)` : `(${exam.result} ${exam.unit})`}`);
      }
    }
  }

  // ── Σύνοψη ──
  console.log('\n═══════════════════════════════════');
  console.log('📊 ΣΥΝΟΨΗ ΔΕΔΟΜΕΝΩΝ');
  console.log('═══════════════════════════════════');
  console.log(`  Ασθενείς:      ${patients.length}`);
  console.log(`  Επισκέψεις:    ${visitIds.length}`);
  console.log(`  Παραπεμπτικά:  ${referralIds.length}`);
  console.log(`  Εξετάσεις:     ${examCount}`);
  console.log('═══════════════════════════════════');
  console.log('✅ Το seed ολοκληρώθηκε επιτυχώς!\n');

  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Σφάλμα κατά το seed:', err);
  pool.end();
  process.exit(1);
});
