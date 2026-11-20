// Ρύθμιση για το Better Auth CLI (npx @better-auth/cli generate / migrate)
import { config } from 'dotenv';
import { resolve } from 'path';
import { Pool } from 'pg';
import { createAuth } from './src/services/auth.service';

config({ path: resolve(__dirname, '..', '..', '.env.local') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const auth = createAuth(pool);
