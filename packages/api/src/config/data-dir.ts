import fs from 'fs';
import path from 'path';

/**
 * Φάκελος για τα disk caches (exam catalog, LOINC).
 *
 * Στο Render το cwd είναι η ρίζα του repo, οπότε ένα `<cwd>/data` θα ήταν άδειο
 * σε κάθε cold start και θα ξανάκανε sync 100k+ εγγραφές. Σειρά προτεραιότητας:
 *   1. `DATA_DIR` (explicit override — π.χ. persistent disk)
 *   2. `<cwd>/data` (τοπική ανάπτυξη, όπου το cwd είναι το packages/api)
 *   3. `<cwd>/packages/api/data` (bundled caches του repo)
 */
function resolveDataDir(): string {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }

  const local = path.resolve(process.cwd(), 'data');
  if (fs.existsSync(local)) return local;

  const bundled = path.resolve(process.cwd(), 'packages', 'api', 'data');
  if (fs.existsSync(bundled)) return bundled;

  return local;
}

export const DATA_DIR = resolveDataDir();
