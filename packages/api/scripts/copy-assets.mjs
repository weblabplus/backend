#!/usr/bin/env node
// Αντιγράφει τα non-TS assets (SQL) στο dist, ώστε να δουλεύουν και σε production
// builds όπου το tsc δεν τα μεταφέρει.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = [join('db', 'migration.sql')];

for (const asset of assets) {
  const from = join(root, 'src', asset);
  const to = join(root, 'dist', asset);

  if (!existsSync(from)) {
    console.warn(`[copy-assets] skipped (missing): ${from}`);
    continue;
  }

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[copy-assets] ${asset} -> dist`);
}
