import dns from 'node:dns';
import { redact } from './redact.mjs';

dns.setDefaultResultOrder('ipv4first');

let nextRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (err.status) return false;
  const code = err.cause?.code;
  if (code) return ['ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
  if (err.message && err.message.includes('fetch failed')) return true;
  return false;
}

async function throttle(minIntervalMs = 2100) {
  const now = Date.now();
  if (nextRequestAt > now) await sleep(nextRequestAt - now);
  nextRequestAt = Date.now() + minIntervalMs;
}

export class AgenTankApi {
  constructor({ baseUrl, tankKey, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error('AGENTANK_BASE_URL is required');
    if (!tankKey) throw new Error('AGENTANK_TANK_KEY is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tankKey = tankKey;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body = null, auth = true, retries = 3 } = {}) {
    await throttle();
    const headers = { accept: 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.tankKey}`;
    if (body != null) headers['content-type'] = 'application/json';

    const url = `${this.baseUrl}${path}`;
    const fetchOptions = {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    };

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.fetch(url, fetchOptions);
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = { raw: text };
        }
        if (!response.ok) {
          const err = new Error(`AgenTank API ${method} ${path} failed with ${response.status}`);
          err.status = response.status;
          err.payload = redact(payload);
          throw err;
        }
        return payload;
      } catch (err) {
        lastError = err;
        if (attempt < retries && isRetryable(err)) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  getTank() {
    return this.request('/api/agent/tank');
  }

  getMatches({ limit = 10, offset = 0 } = {}) {
    return this.request(`/api/agent/tank/matches?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
  }

  getLeaderboard({ period = 'today', sort = 'win_rate', limit = 30 } = {}) {
    return this.request(`/api/agent/leaderboard?period=${encodeURIComponent(period)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(limit)}`);
  }

  findOpponents({ q = '', limit = 12 } = {}) {
    return this.request(`/api/agent/opponents?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`);
  }

  simulate({ opponentId, mapId = 'classic', code = undefined } = {}) {
    if (!opponentId) throw new Error('opponentId is required');
    return this.request('/api/agent/tank/simulate', {
      method: 'POST',
      body: { opponentId, mapId, ...(code ? { code } : {}) },
    });
  }

  publishCode({ code, notes, submittedBy }) {
    if (!code) throw new Error('code is required');
    if (!submittedBy) throw new Error('submittedBy is required');
    return this.request('/api/agent/tank/code', {
      method: 'POST',
      body: { code, notes: notes || 'AgenTank evolver update', submittedBy },
    });
  }

  /** Recorded battle: affects rankings. See POST /api/agent/tank/challenge in the Agent Guide. */
  challenge({ opponentTankId, randomOpponent = false, mapId = 'classic' } = {}) {
    if (randomOpponent) {
      return this.request('/api/agent/tank/challenge', {
        method: 'POST',
        body: { randomOpponent: true, mapId },
      });
    }
    if (opponentTankId != null && opponentTankId !== '') {
      return this.request('/api/agent/tank/challenge', {
        method: 'POST',
        body: { opponentTankId: Number(opponentTankId), mapId },
      });
    }
    throw new Error('challenge requires opponentTankId or randomOpponent: true');
  }
}
