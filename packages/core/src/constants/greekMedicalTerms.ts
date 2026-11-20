/**
 * Ελληνικοί → Αγγλικοί ιατρικοί όροι για αναζήτηση στον κατάλογο LOINC.
 * Χρησιμοποιείται από το /api/loinc/search για αυτόματη μετάφραση ελληνικών όρων.
 */

export const GREEK_TO_ENGLISH_MEDICAL: Record<string, string> = {
  // ── Αιματολογικές εξετάσεις ──
  'γενική αίματος': 'complete blood count',
  'γενικη αιματος': 'complete blood count',
  'γενική': 'complete blood count',
  'γενικη': 'complete blood count',
  'cbc': 'complete blood count',
  'αιμοσφαιρίνη': 'hemoglobin',
  'αιμοσφαιρινη': 'hemoglobin',
  'hgb': 'hemoglobin',
  'hbg': 'hemoglobin',
  'αιματοκρίτης': 'hematocrit',
  'αιματοκριτης': 'hematocrit',
  'hct': 'hematocrit',
  'λευκά αιμοσφαίρια': 'leukocytes',
  'λευκα αιμοσφαιρια': 'leukocytes',
  'λευκά': 'leukocytes',
  'λευκα': 'leukocytes',
  'wbc': 'leukocytes',
  'ερυθρά αιμοσφαίρια': 'erythrocytes',
  'ερυθρα αιμοσφαιρια': 'erythrocytes',
  'ερυθρά': 'erythrocytes',
  'rbc': 'erythrocytes',
  'αιμοπετάλια': 'platelets',
  'αιμοπεταλια': 'platelets',
  'plt': 'platelets',
  'mcv': 'mean corpuscular volume',
  'mch': 'mean corpuscular hemoglobin',
  'mchc': 'mean corpuscular hemoglobin concentration',
  'rdw': 'red cell distribution width',
  'τκε': 'erythrocyte sedimentation rate',
  'tke': 'erythrocyte sedimentation rate',
  'esr': 'erythrocyte sedimentation rate',

  // ── Βιοχημικές εξετάσεις ──
  'σάκχαρο': 'glucose',
  'σακχαρο': 'glucose',
  'γλυκόζη': 'glucose',
  'γλυκοζη': 'glucose',
  'glucose': 'glucose',
  'ουρία': 'urea',
  'ουρια': 'urea',
  'κρεατινίνη': 'creatinine',
  'κρεατινινη': 'creatinine',
  'ουρικό οξύ': 'uric acid',
  'ουρικο οξυ': 'uric acid',
  'ουρικό': 'uric acid',
  'χοληστερίνη': 'cholesterol',
  'χοληστερινη': 'cholesterol',
  'χοληστερόλη': 'cholesterol',
  'χοληστερολη': 'cholesterol',
  'ολική χοληστερίνη': 'total cholesterol',
  'ολικη χοληστερινη': 'total cholesterol',
  'hdl': 'HDL cholesterol',
  'ldl': 'LDL cholesterol',
  'τριγλυκερίδια': 'triglycerides',
  'τριγλυκεριδια': 'triglycerides',
  'τριγλυκερίνη': 'triglycerides',
  'λιπίδια': 'lipids',
  'λιπιδια': 'lipids',
  'λιπιδαιμικό': 'lipid panel',
  'λιπιδαιμικο': 'lipid panel',

  // ── Ηπατικές εξετάσεις ──
  'ήπαρ': 'liver',
  'ηπαρ': 'liver',
  'ηπατική': 'liver',
  'ηπατικη': 'liver',
  'ηπατικές': 'liver function',
  'ηπατικες': 'liver function',
  'τρανσαμινάσες': 'aminotransferase',
  'τρανσαμινασες': 'aminotransferase',
  'sgot': 'aspartate aminotransferase',
  'ast': 'aspartate aminotransferase',
  'sgpt': 'alanine aminotransferase',
  'alt': 'alanine aminotransferase',
  'γgt': 'gamma glutamyl transferase',
  'ggt': 'gamma glutamyl transferase',
  'γ-gt': 'gamma glutamyl transferase',
  'αλκαλική φωσφατάση': 'alkaline phosphatase',
  'αλκαλικη φωσφαταση': 'alkaline phosphatase',
  'alp': 'alkaline phosphatase',
  'χολερυθρίνη': 'bilirubin',
  'χολερυθρινη': 'bilirubin',
  'άμεση χολερυθρίνη': 'direct bilirubin',
  'έμμεση χολερυθρίνη': 'indirect bilirubin',
  'αμεση χολερυθρινη': 'direct bilirubin',
  'εμμεση χολερυθρινη': 'indirect bilirubin',

  // ── Ηλεκτρολύτες ──
  'ηλεκτρολύτες': 'electrolytes',
  'ηλεκτρολυτες': 'electrolytes',
  'κάλιο': 'potassium',
  'καλιο': 'potassium',
  'kalium': 'potassium',
  'νάτριο': 'sodium',
  'νατριο': 'sodium',
  'natrium': 'sodium',
  'ασβέστιο': 'calcium',
  'ασβεστιο': 'calcium',
  'μαγνήσιο': 'magnesium',
  'μαγνησιο': 'magnesium',
  'φώσφορος': 'phosphorus',
  'φωσφορος': 'phosphorus',

  // ── Νεφρική λειτουργία ──
  'νεφρά': 'kidney',
  'νεφρα': 'kidney',
  'νεφρική': 'renal',
  'νεφρικη': 'renal',
  'νεφρικές': 'renal function',
  'gfr': 'glomerular filtration rate',
  'egfr': 'estimated glomerular filtration rate',

  // ── Σίδηρος ──
  'σίδηρος': 'iron',
  'σιδηρος': 'iron',
  'fe': 'iron',
  'φερριτίνη': 'ferritin',
  'φερριτινη': 'ferritin',
  'φερριτί': 'ferritin',
  'τρανσφερρίνη': 'transferrin',
  'τρανσφερρινη': 'transferrin',

  // ── Ένζυμα ──
  'αμυλάση': 'amylase',
  'αμυλαση': 'amylase',
  'λιπάση': 'lipase',
  'λιπαση': 'lipase',
  'ldh': 'lactate dehydrogenase',
  'ck': 'creatine kinase',
  'cpk': 'creatine kinase',
  'ck-mb': 'creatine kinase MB',
  'τροπονίνη': 'troponin',
  'τροπονινη': 'troponin',
  'tni': 'troponin I',
  'tnt': 'troponin T',

  // ── Καρδιολογικοί δείκτες ──
  'bnp': 'brain natriuretic peptide',
  'nt-probnp': 'NT-proBNP',
  'probnp': 'NT-proBNP',
  'd-dimer': 'D dimer',
  'd dimer': 'D dimer',
  'ddimer': 'D dimer',
  'ινωδογόνο': 'fibrinogen',
  'ινωδογονο': 'fibrinogen',

  // ── Ενδοκρινολογικές ──
  'θυρεοειδής': 'thyroid',
  'θυρεοειδης': 'thyroid',
  'θυρεοειδούς': 'thyroid',
  'tsh': 'thyroid stimulating hormone',
  'θυρεοτρόπος': 'thyroid stimulating hormone',
  't3': 'triiodothyronine',
  't4': 'thyroxine',
  'ft3': 'free T3',
  'ft4': 'free T4',
  'προλακτίνη': 'prolactin',
  'προλακτινη': 'prolactin',
  'prl': 'prolactin',
  'κορτιζόλη': 'cortisol',
  'κορτιζολη': 'cortisol',
  'τεστοστερόνη': 'testosterone',
  'τεστοστερονη': 'testosterone',
  'οιστραδιόλη': 'estradiol',
  'οιστραδιολη': 'estradiol',
  'e2': 'estradiol',
  'προγεστερόνη': 'progesterone',
  'προγεστερονη': 'progesterone',
  'ινσουλίνη': 'insulin',
  'ινσουλινη': 'insulin',
  'παραθορμόνη': 'parathyroid hormone',
  'παραθορμονη': 'parathyroid hormone',
  'pth': 'parathyroid hormone',
  'βιταμίνη d': 'vitamin D',
  'βιταμινη d': 'vitamin D',
  'vitamin d': 'vitamin D',
  'βιταμίνη b12': 'vitamin B12',
  'βιταμινη b12': 'vitamin B12',
  'b12': 'vitamin B12',
  'φυλλικό οξύ': 'folic acid',
  'φυλλικο οξυ': 'folic acid',
  'φυλλικό': 'folic acid',

  // ── Πρωτεΐνες ──
  'λευκώματα': 'total protein',
  'λευκωματα': 'total protein',
  'ολικά λευκώματα': 'total protein',
  'ολικες πρωτεΐνες': 'total protein',
  'αλβουμίνη': 'albumin',
  'αλβουμινη': 'albumin',
  'σφαιρίνες': 'globulin',
  'σφαιρινες': 'globulin',
  'ηλεκτροφόρηση': 'protein electrophoresis',
  'ηλεκτροφορηση': 'protein electrophoresis',

  // ── Φλεγμονώδεις δείκτες ──
  'crp': 'C reactive protein',
  'c αντιδρώσα': 'C reactive protein',
  'c αντιδρωσα': 'C reactive protein',
  'υψηλής ευαισθησίας crp': 'high sensitivity C reactive protein',
  'hscrp': 'high sensitivity C reactive protein',
  'hs-crp': 'high sensitivity C reactive protein',

  // ── Πήξη ──
  'πήξη': 'coagulation',
  'πηξη': 'coagulation',
  'inr': 'international normalized ratio',
  'pt': 'prothrombin time',
  'ptt': 'partial thromboplastin time',
  'aptt': 'activated partial thromboplastin time',
  'χρόνος προθρομβίνης': 'prothrombin time',
  'χρονος προθρομβινης': 'prothrombin time',

  // ── Ούρα ──
  'ούρα': 'urinalysis',
  'ουρα': 'urinalysis',
  'γενική ούρων': 'urinalysis',
  'γενικη ουρων': 'urinalysis',
  'urine': 'urinalysis',
  'ουροκαλλιέργεια': 'urine culture',
  'ουροκαλλιεργεια': 'urine culture',
  'καλλιέργεια ούρων': 'urine culture',
  'καλλιέργεια': 'culture',
  'καλλιεργεια': 'culture',

  // ── Σάκχαρο/Διαβήτης ──
  'hba1c': 'hemoglobin A1c',
  'hba1': 'hemoglobin A1c',
  'a1c': 'hemoglobin A1c',
  'γλυκοζυλιωμένη αιμοσφαιρίνη': 'hemoglobin A1c',
  'γλυκοζυλιωμενη': 'hemoglobin A1c',
  'καμπύλη σακχάρου': 'glucose tolerance test',
  'καμπυλη σακχαρου': 'glucose tolerance test',
  'ogtt': 'glucose tolerance test',

  // ── Ορμόνες ──
  'lh': 'luteinizing hormone',
  'fsh': 'follicle stimulating hormone',
  'β-hcg': 'beta HCG',
  'hcg': 'HCG',
  'χοριακή': 'HCG',
  'χοριακη': 'HCG',
  'κύηση': 'pregnancy test',
  'κυηση': 'pregnancy test',
  'pregnancy': 'HCG',

  // ── Ανοσολογικές ──
  'ana': 'antinuclear antibody',
  'rheumatoid factor': 'rheumatoid factor',
  'ρευματοειδής': 'rheumatoid factor',
  'ρευματοειδης': 'rheumatoid factor',
  'rf': 'rheumatoid factor',
  'ανοσοσφαιρίνες': 'immunoglobulins',
  'ανοσοσφαιρινες': 'immunoglobulins',
  'ige': 'immunoglobulin E',
  'igg': 'immunoglobulin G',
  'igm': 'immunoglobulin M',
  'iga': 'immunoglobulin A',

  // ── Ογκολογικοί δείκτες ──
  'psa': 'prostate specific antigen',
  'προστατικό': 'prostate specific antigen',
  'προστατικο': 'prostate specific antigen',
  'cea': 'carcinoembryonic antigen',
  'afp': 'alpha fetoprotein',
  'ca 125': 'CA 125',
  'ca125': 'CA 125',
  'ca 15-3': 'CA 15-3',
  'ca153': 'CA 15-3',
  'ca 19-9': 'CA 19-9',
  'ca199': 'CA 19-9',

  // ── Αέρια αίματος ──
  'αέρια αίματος': 'blood gas',
  'αερια αιματος': 'blood gas',
  'abg': 'blood gas',
  'po2': 'oxygen partial pressure',
  'pco2': 'carbon dioxide partial pressure',
  'ph': 'pH',
  'hco3': 'bicarbonate',
  'διττανθρακικά': 'bicarbonate',
  'διττανθρακικα': 'bicarbonate',

  // ── Γενικά / Άλλα ──
  'γενική εξέταση': 'routine',
  'γενικη εξεταση': 'routine',
  'προληπτικός': 'screening',
  'προληπτικος': 'screening',
  'check up': 'screening panel',
  'checkup': 'screening panel',
  'ιολογικές': 'viral',
  'ιολογικες': 'viral',
  'μικροβιολογικές': 'microbiology',
  'μικροβιολογικες': 'microbiology',
};

/**
 * Ελέγχει αν ένα string περιέχει ελληνικούς χαρακτήρες.
 */
export function containsGreek(text: string): boolean {
  return /[\u0370-\u03FF\u1F00-\u1FFF]/.test(text);
}

/**
 * Αντίστροφο λεξικό: Αγγλικά → Ελληνικά.
 * Παράγεται από το GREEK_TO_ENGLISH_MEDICAL και στη συνέχεια
 * προστίθενται επιπλέον μεταφράσεις για όρους που εμφανίζονται
 * σε ονόματα εξετάσεων LOINC.
 */
function buildReverseDict(): Record<string, string> {
  const dict: Record<string, string> = {};

  // Derive from Greek→English (prefer accented, longer Greek forms)
  for (const [greek, english] of Object.entries(GREEK_TO_ENGLISH_MEDICAL)) {
    const existing = dict[english];
    if (!existing || (existing.length < greek.length && /[\u0370-\u03FF\u1F00-\u1FFF]/.test(greek))) {
      dict[english] = greek;
    }
  }

  // ── Πρόσθετες λέξεις που εμφανίζονται σε ονόματα LOINC ──
  // Using Object.assign to avoid TS1117 duplicate-key errors
  const extras: Record<string, string> = {};
  Object.assign(extras, {
    'blood': 'αίματος',
    'serum': 'ορού',
    'plasma': 'πλάσματος',
  'urine': 'ούρων',
  'test': 'εξέταση',
  'panel': 'panel',
  'antibody': 'αντισωμάτων',
  'antibodies': 'αντισωμάτων',
  'antigen': 'αντιγόνου',
  'hormone': 'ορμόνης',
  'vitamin': 'βιταμίνης',
  'total': 'ολική',
  'free': 'ελεύθερη',
  'direct': 'άμεση',
  'indirect': 'έμμεση',
  'count': 'μέτρηση',
  'level': 'επίπεδο',
  'index': 'δείκτης',
  'ratio': 'λόγος',
  'rate': 'ρυθμός',
  'volume': 'όγκος',
  'mass': 'μάζα',
  'concentration': 'συγκέντρωση',
  'fraction': 'κλάσμα',
  'activity': 'δραστηριότητα',
  'tolerance': 'ανοχή',
  'screening': 'προληπτικός έλεγχος',
  'culture': 'καλλιέργεια',
  'microscopic': 'μικροσκοπική',
  'qualitative': 'ποιοτική',
  'quantitative': 'ποσοτική',
  'differential': 'διαφορική',
  'metabolic': 'μεταβολικό',
  'function': 'λειτουργία',
  'profile': 'προφίλ',
  'basic': 'βασικό',
  'comprehensive': 'πλήρες',
  'complete': 'πλήρης',
  'routine': 'γενική',
  'fasting': 'νηστείας',
  'random': 'τυχαίο',
  'stimulated': 'διέγερσης',
  'post': 'μετά',
  'pre': 'προ',
  'hours': 'ωρών',
  'hour': 'ώρας',
  'specimen': 'δείγματος',
  'cells': 'κυττάρων',
  'cell': 'κυττάρου',
  'red': 'ερυθρών',
  'white': 'λευκών',
  'fluid': 'υγρού',
  'body': 'σώματος',
  'cerebrospinal': 'εγκεφαλονωτιαίου',
  'synovial': 'αρθρικού',
  'pleural': 'υπεζωκοτικού',
  'peritoneal': 'περιτοναϊκού',
  'capillary': 'τριχοειδικού',
  'venous': 'φλεβικού',
  'arterial': 'αρτηριακού',
  'cord': 'ομφάλιου',
  'amniotic': 'αμνιακού',
  'saliva': 'σιέλου',
  'stool': 'κοπράνων',
  'sweat': 'ιδρώτα',
  'breath': 'εκπνοής',
  'exhaled': 'εκπνεόμενου',
  'gas': 'αερίων',
  'oxygen': 'οξυγόνου',
  'carbon dioxide': 'διοξειδίου του άνθρακα',
  'lactate': 'γαλακτικού',
  'protein': 'πρωτεΐνης',
  'proteins': 'πρωτεϊνών',
  'albumin': 'αλβουμίνης',
  'globulin': 'σφαιρίνης',
  'creatinine': 'κρεατινίνης',
  'urea nitrogen': 'αζώτου ουρίας',
  'nitrogen': 'αζώτου',
  'clearance': 'κάθαρση',
  'excretion': 'απέκκριση',
  'saturation': 'κορεσμός',
  'binding': 'δέσμευσης',
  'capacity': 'ικανότητα',
  'uptake': 'πρόσληψη',
  'time': 'χρόνος',
  'partial': 'μερική',
  'pressure': 'πίεση',
  'electrophoresis': 'ηλεκτροφόρηση',
  'chromatography': 'χρωματογραφία',
  'immunoassay': 'ανοσοπροσδιορισμός',
  'assay': 'προσδιορισμός',
  'molecular': 'μοριακή',
  'genetic': 'γενετική',
  'dna': 'DNA',
  'rna': 'RNA',
  'pcr': 'PCR',
  'detection': 'ανίχνευση',
  'identification': 'ταυτοποίηση',
  'susceptibility': 'ευαισθησία',
  'resistance': 'αντοχή',
  'mutation': 'μετάλλαξη',
  'genotype': 'γονότυπος',
  'phenotype': 'φαινότυπος',
  'variant': 'παραλλαγή',
  'isolate': 'απομόνωση',
  'screen': 'έλεγχος',
  'screen method': 'μέθοδος ελέγχου',
  'confirmation': 'επιβεβαίωση',
  'confirmatory': 'επιβεβαιωτική',
  'presence': 'παρουσία',
  'absence': 'απουσία',
  'number': 'αριθμός',
  'percentage': 'ποσοστό',
  'absolute': 'απόλυτος',
  'relative': 'σχετικός',
  'calculated': 'υπολογισμένος',
  'estimated': 'εκτιμώμενος',
  'measured': 'μετρημένος',
  'corrected': 'διορθωμένος',
  'adjusted': 'προσαρμοσμένος',
  'standard': 'πρότυπη',
  'international': 'διεθνής',
  'normalized': 'κανονικοποιημένος',
  'distribution': 'κατανομή',
  'width': 'εύρος',
  'mean': 'μέσος',
  'median': 'διάμεσος',
  'minimum': 'ελάχιστος',
  'maximum': 'μέγιστος',
  'range': 'εύρος',
  'value': 'τιμή',
  // ── Ενδοκρινολογικά ──
  'stimulating': 'διεγερτική',
  'thyroperoxidase': 'θυρεοϋπεροξειδάσης',
  'peroxidase': 'υπεροξειδάσης',
  'thyroglobulin': 'θυρεοσφαιρίνης',
  'triiodothyronine': 'τριιωδοθυρονίνης',
  'thyroxine': 'θυροξίνης',
  'reverse': 'ανάστροφη',
  'cortisol': 'κορτιζόλης',
  'testosterone': 'τεστοστερόνης',
  'estradiol': 'οιστραδιόλης',
  'progesterone': 'προγεστερόνης',
  'prolactin': 'προλακτίνης',
  'insulin': 'ινσουλίνης',
  'parathyroid': 'παραθυρεοειδούς',
  'aldosterone': 'αλδοστερόνης',
  'renin': 'ρενίνης',
  'catecholamine': 'κατεχολαμίνης',
  'metanephrine': 'μετανεφρίνης',
  'normetanephrine': 'νορμετανεφρίνης',
  'homovanillate': 'ομοβανιλλικού',
  'vanillylmandelate': 'βανιλλυλμανδελικού',
  'hydroxyprogesterone': 'υδροξυπρογεστερόνης',
  'dehydroepiandrosterone': 'δεϋδροεπιανδροστερόνης',
  'androstenedione': 'ανδροστενεδιόνης',
  'sex hormone binding': 'δεσμευτικής φυλετικών ορμονών',
  'binding globulin': 'σφαιρίνης',
  // ── Καρδιολογικά ──
  'troponin': 'τροπονίνης',
  'natriuretic': 'νατριουρητικό',
  'peptide': 'πεπτίδιο',
  'probnp': 'proBNP',
  'creatine kinase': 'κρεατινικής κινάσης',
  'myoglobin': 'μυοσφαιρίνης',
  'homocysteine': 'ομοκυστεΐνης',
  'lipoprotein': 'λιποπρωτεΐνης',
  'apolipoprotein': 'απολιποπρωτεΐνης',
  'cholesterol': 'χοληστερόλης',
  'triglyceride': 'τριγλυκεριδίων',
  // ── Ηπατικά ──
  'bilirubin': 'χολερυθρίνης',
  'aminotransferase': 'τρανσαμινασών',
  'transferase': 'τρανσφεράσης',
  'alkaline phosphatase': 'αλκαλικής φωσφατάσης',
  'phosphatase': 'φωσφατάσης',
  // ── Αιματολογικά ──
  'hemoglobin': 'αιμοσφαιρίνης',
  'hematocrit': 'αιματοκρίτη',
  'erythrocyte': 'ερυθροκυττάρου',
  'leukocyte': 'λευκοκυττάρου',
  'platelet': 'αιμοπεταλίου',
  'reticulocyte': 'δικτυοερυθροκυττάρου',
  'corpuscular': 'σωματιδιακός',
  'sedimentation': 'καθίζησης',
  'fibrinogen': 'ινωδογόνου',
  'prothrombin': 'προθρομβίνης',
  'thromboplastin': 'θρομβοπλαστίνης',
  'thrombin': 'θρομβίνης',
  // ── Βιοχημικά ──
  'glucose': 'γλυκόζης',
  'urea': 'ουρίας',
  'uric acid': 'ουρικού οξέος',
  'calcium': 'ασβεστίου',
  'magnesium': 'μαγνησίου',
  'phosphorus': 'φωσφόρου',
  'potassium': 'καλίου',
  'sodium': 'νατρίου',
  'chloride': 'χλωρίου',
  'bicarbonate': 'διττανθρακικών',
  'amylase': 'αμυλάσης',
  'lipase': 'λιπάσης',
  'ferritin': 'φερριτίνης',
  'transferrin': 'τρανσφερρίνης',
  'iron': 'σιδήρου',
  'lactate dehydrogenase': 'γαλακτικής αφυδρογονάσης',
  'dehydrogenase': 'αφυδρογονάσης',
  // ── Ογκολογικοί δείκτες ──
  'prostate specific antigen': 'προστατικού αντιγόνου',
  'carcinoembryonic': 'καρκινοεμβρυϊκού',
  'fetoprotein': 'φετοπρωτεΐνης',
  // ── Ανοσολογικά ──
  'immunoglobulin': 'ανοσοσφαιρίνης',
  'antinuclear': 'αντιπυρηνικών',
  'rheumatoid': 'ρευματοειδής',
  'complement': 'συμπληρώματος',
  // ── Λοιμώδη ──
  'hepatitis': 'ηπατίτιδας',
  'influenza': 'γρίπης',
  'sars': 'SARS',
  'covid': 'COVID',
  'hiv': 'HIV',
  'streptococcus': 'στρεπτόκοκκου',
  'staphylococcus': 'σταφυλόκοκκου',
  'escherichia': 'Escherichia',
  'coli': 'coli',
  // ── Λέξεις που μένουν αμετάφραστες στα LOINC names ──
  'gland': 'αδένα',
  'colloidal': 'κολλοειδές',
  'challenge': 'δοκιμασία',
  'average': 'μέση',
  'measurements': 'μετρήσεις',
  'measurement': 'μέτρηση',
  'in': 'σε',
  'or': 'ή',
  'by': 'με',
  'of': 'του',
  'and': 'και',
  'with': 'με',
  'without': 'χωρίς',
  'after': 'μετά από',
  'before': 'πριν από',
  'during': 'κατά τη',
  'following': 'μετά από',
  'using': 'με',
  'via': 'μέσω',
  'from': 'από',
  'to': 'προς',
  'for': 'για',
  'as': 'ως',
  'at': 'σε',
  'on': 'σε',
  'per': 'ανά',
  'type': 'τύπου',
  'pattern': 'πρότυπο',
  'procedure': 'διαδικασία',
  'method': 'μέθοδος',
  'technique': 'τεχνική',
  'specimen type': 'τύπος δείγματος',
  'collection': 'συλλογή',
  'transport': 'μεταφορά',
  'storage': 'αποθήκευση',
  'temperature': 'θερμοκρασία',
  'room temperature': 'θερμοκρασία δωματίου',
  'frozen': 'κατεψυγμένο',
  'refrigerated': 'ψυγείου',
  'ambient': 'περιβάλλοντος',
  'Ab': 'αντισωμάτων',
  'Ag': 'αντιγόνου',
  'IgG': 'IgG',
  'IgM': 'IgM',
  'IgA': 'IgA',
  'IgE': 'IgE',
  'PCR': 'PCR',
  'ELISA': 'ELISA',
  'EIA': 'EIA',
  'RIA': 'RIA',
  'HPLC': 'HPLC',
  'GC': 'GC',
  'MS': 'MS',
  'NMR': 'NMR',
  'CT': 'CT',
  'MRI': 'MRI',
  'US': 'US',
  'Xray': 'ακτινογραφίας',
  'ultrasound': 'υπερήχου',
  'microscopy': 'μικροσκοπίας',
  'cytology': 'κυτταρολογίας',
  'histology': 'ιστολογίας',
  'pathology': 'παθολογίας',
  'surgical': 'χειρουργικό',
  'biopsy': 'βιοψίας',
  'aspirate': 'αναρρόφησης',
  'wash': 'έκπλυσης',
  'swab': 'επιχρίσματος',
  'brush': 'βούρτσας',
  'scraping': 'απόξεσης',
  'drainage': 'παροχέτευσης',
  'secretion': 'έκκρισης',
  'exudate': 'εξιδρώματος',
  'transudate': 'διιδρώματος',
  'effusion': 'συλλογής',
  'cyst': 'κύστης',
  'abscess': 'αποστήματος',
  'wound': 'τραύματος',
  'ulcer': 'έλκους',
  'lesion': 'βλάβης',
  'tissue': 'ιστού',
  'organ': 'οργάνου',
  'bone': 'οστού',
  'marrow': 'μυελού',
  'liver': 'ήπατος',
  'kidney': 'νεφρού',
  'heart': 'καρδιάς',
  'lung': 'πνεύμονα',
  'brain': 'εγκεφάλου',
  'muscle': 'μυός',
  'skin': 'δέρματος',
  'eye': 'οφθαλμού',
  'ear': 'ωτός',
  'nose': 'ρινός',
  'throat': 'φάρυγγα',
  'mouth': 'στόματος',
  'tongue': 'γλώσσας',
  'esophagus': 'οισοφάγου',
  'stomach': 'στομάχου',
  'intestine': 'εντέρου',
  'colon': 'κόλου',
  'rectum': 'ορθού',
  'anus': 'πρωκτού',
  'pancreas': 'παγκρέατος',
  'gallbladder': 'χοληδόχου κύστης',
  'bile': 'χολής',
  'spleen': 'σπληνός',
  'lymph node': 'λεμφαδένα',
  'thyroid': 'θυρεοειδούς',
  'parathyroid gland': 'παραθυρεοειδούς αδένα',
  'adrenal': 'επινεφριδίου',
  'pituitary': 'υπόφυσης',
  'hypothalamus': 'υποθαλάμου',
  'ovary': 'ωοθήκης',
  'testis': 'όρχεως',
  'prostate': 'προστάτη',
  'uterus': 'μήτρας',
  'cervix': 'τραχήλου',
  'vagina': 'κόλπου',
  'penis': 'πέους',
  'bladder': 'ουροδόχου κύστης',
  'urethra': 'ουρήθρας',
  'ureter': 'ουρητήρα',
  'seminal': 'σπερματικού',
  'breast': 'μαστού',
  'nipple': 'θηλής',
  'areola': 'θηλαίας άλω',
  'axilla': 'μασχάλης',
  'groin': 'βουβώνας',
  });

  // Merge extras (override any auto-generated entries)
  for (const [en, el] of Object.entries(extras)) {
    dict[en] = el;
  }

  return dict;
}

/** Αγγλικοί → Ελληνικοί ιατρικοί όροι (αντίστροφο του GREEK_TO_ENGLISH_MEDICAL). */
export const ENGLISH_TO_GREEK_MEDICAL: Record<string, string> = buildReverseDict();

/**
 * Βοηθητική συνάρτηση: κεφαλαιοποιεί την πρώτη λέξη ενός κειμένου.
 */
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Μεταφράζει αγγλικό κείμενο (π.χ. όνομα εξέτασης LOINC) σε ελληνικά.
 * Διατηρεί τα brackets [...] ως έχουν και μεταφράζει μόνο το υπόλοιπο κείμενο.
 */
export function translateEnglishToGreek(text: string): string {
  if (!text) return text;

  // Separate bracket content (keep as-is)
  const bracketParts: string[] = [];
  const cleaned = text.replace(/\[([^\]]*)\]/g, (_, content) => {
    bracketParts.push(`[${content}]`);
    return ` [[BRACKET_${bracketParts.length - 1}]] `;
  });

  // Split into words
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  const translated = words.map(word => {
    // Restore bracket content
    const bracketMatch = word.match(/^\[\[BRACKET_(\d+)\]\]$/);
    if (bracketMatch) {
      return bracketParts[parseInt(bracketMatch[1])];
    }

    const lower = word.toLowerCase().replace(/[,;:.'"]/g, '');
    // Try exact match first
    if (ENGLISH_TO_GREEK_MEDICAL[lower]) {
      return ENGLISH_TO_GREEK_MEDICAL[lower];
    }
    return word;
  });

  const result = translated.join(' ');
  // Capitalize first letter
  return capitalizeFirst(result.replace(/\s+/g, ' ').trim());
}

/**
 * Δημιουργεί ένα ελληνικό όνομα εξέτασης από τα δεδομένα LOINC.
 * Συνδυάζει το component και το system για φυσική ελληνική απόδοση.
 */
export function makeGreekLoincName(component: string, system: string, longCommonName: string): string {
  // Try translating the longCommonName first for best results
  let greekName = translateEnglishToGreek(longCommonName);

  // If the translation didn't change much (mostly English), fall back to component + system
  const englishCharCount = (greekName.match(/[a-zA-Z]{3,}/g) || []).length;
  if (englishCharCount > 2) {
    const greekComponent = translateEnglishToGreek(component);
    const greekSystem = system ? translateEnglishToGreek(system) : '';
    greekName = greekSystem ? `${greekComponent} (${greekSystem})` : greekComponent;
  }

  return greekName;
}

/**
 * Μεταφράζει ελληνικό κείμενο αναζήτησης σε αγγλικούς όρους.
 * Εντοπίζει γνωστούς ελληνικούς όρους στο κείμενο και τους αντικαθιστά
 * με τις αγγλικές τους μεταφράσεις. Όροι που δεν βρίσκονται στο λεξικό
 * παραμένουν ως έχουν.
 */
export function translateGreekToEnglish(text: string): string {
  if (!containsGreek(text)) return text;

  const lowerText = text.toLowerCase().trim();

  // Sort keys by length descending so longer phrases match first
  const keys = Object.keys(GREEK_TO_ENGLISH_MEDICAL)
    .sort((a, b) => b.length - a.length);

  for (const greek of keys) {
    if (lowerText.includes(greek)) {
      return GREEK_TO_ENGLISH_MEDICAL[greek];
    }
  }

  // No exact phrase match — try word-by-word translation
  const words = lowerText.split(/\s+/).filter(w => w.length > 1);
  const translated = words.map(w => GREEK_TO_ENGLISH_MEDICAL[w] || w);
  const joined = translated.join(' ');
  if (joined !== lowerText) return joined;

  // Last resort: translate individual words that contain Greek chars
  for (const greek of keys) {
    for (const word of words) {
      if (word.includes(greek)) {
        const english = GREEK_TO_ENGLISH_MEDICAL[greek];
        return lowerText.replace(greek, english);
      }
    }
  }

  return 'blood test'; // generic fallback
}
