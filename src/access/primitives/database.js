
import { Pool } from 'postgrejs';

let pool = null;

export function openStore() {
  if (pool) return pool;

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

  pool = new Pool({
    host: process.env.DATABASE_URL,
    min: 0,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  return pool;
}

export function getStore() {
  if (!pool) throw new Error('Store is not open. Call openStore() first.');
  return pool;
}

export async function closeStore() {
  if (!pool) return;
  await pool.close(5000);
  pool = null;
}

export const isOpen = () => pool !== null;
