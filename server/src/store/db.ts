import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.MASTER_DATA_DIR ?? join(here, '..', '..', '..', 'data');

export function openDb(file = join(DATA_DIR, 'master.db')): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

// Add columns introduced after a database was first created.
function migrate(db: DatabaseSync) {
  const cols = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('turns')) db.exec('ALTER TABLE tasks ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('model_reason')) db.exec('ALTER TABLE tasks ADD COLUMN model_reason TEXT');
}
