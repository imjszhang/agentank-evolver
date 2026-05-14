import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './files.mjs';

function loadEnvFile() {
  const file = join(projectRoot, '.env');
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] == null) process.env[key] = value;
  }
}

export function loadConfig(env = process.env) {
  loadEnvFile();
  const baseUrl = String(env.AGENTANK_BASE_URL || 'https://agentank.ai').replace(/\/+$/, '');
  const tankKey = String(env.AGENTANK_TANK_KEY || '').trim();
  return {
    baseUrl,
    tankKey,
    allowPublish: String(env.AGENTANK_ALLOW_PUBLISH || '').toLowerCase() === 'true',
    submittedBy: String(env.AGENTANK_SUBMITTED_BY || 'Cursor').trim() || 'Cursor',
  };
}
