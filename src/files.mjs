import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = join(projectRoot, 'data');

export const DATA_DIRS = [
  'context',
  'candidates',
  'simulations',
  'matches',
  'scores',
  'publish',
  'challenge-requests',
  'challenges',
];

export function ensureDataDirs() {
  for (const dir of DATA_DIRS) mkdirSync(join(dataRoot, dir), { recursive: true });
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return filePath;
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function latestJson(dirPath) {
  if (!existsSync(dirPath)) return null;
  let latest = null;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const full = join(dirPath, entry.name);
    const stat = statSync(full);
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { path: full, mtimeMs: stat.mtimeMs, value: readJsonSafe(full, null) };
    }
  }
  return latest;
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
