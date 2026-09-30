import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const STORAGE_DIR = process.env.CURVE_STORAGE_DIR || path.join(ROOT, 'storage/curves');

export const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5439),
  user: process.env.PGUSER || 'pguser',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'roaststory',
};

export const PORT = Number(process.env.PORT || 3000);
export const ADMIN_USER = 'admin';
export const ADMIN_PASS = 'roast2026';
export const MAX_GAP_SAMPLES_FOR_INTERP = 2; // 仅对 <=2 个连续缺测点做显示用插值
