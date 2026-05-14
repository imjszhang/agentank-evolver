import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReplay } from '../src/replay-analyzer.mjs';
import { redact } from '../src/redact.mjs';
import { evaluateCandidate, scoreSimulation } from '../src/scoring.mjs';
import { buildBaseStrategy } from '../src/strategy/base-strategy.mjs';

test('redacts bearer tokens and secret-like fields', () => {
  const value = redact({
    headers: { authorization: 'Bearer tank-secret' },
    nested: { AGENTANK_TANK_KEY: 'tank-secret' },
    message: 'Authorization: Bearer tank-secret',
  });

  assert.equal(value.headers.authorization, '[REDACTED]');
  assert.equal(value.nested.AGENTANK_TANK_KEY, '[REDACTED]');
  assert.match(value.message, /Bearer \[REDACTED\]/);
});

test('analyzes replay-like payloads into scoreable metrics', () => {
  const metrics = analyzeReplay({
    winner: 'challenger',
    replay: {
      meta: { challenger: { name: 'challenger' } },
      frames: [
        { events: ['fire', 'star'] },
        { events: ['hit', 'boost'] },
      ],
    },
  }, { opponentId: 'nova-scout', mapId: 'classic' });

  assert.equal(metrics.win, true);
  assert.equal(metrics.opponentId, 'nova-scout');
  assert.ok(scoreSimulation(metrics) > 100);
});

test('blocks publish recommendation when all simulations are losses', () => {
  const evaluation = evaluateCandidate([
    { metrics: { win: false, draw: false, survivalScore: 0.1, fireEvents: 8, hitEvents: 0, crashEvents: 1 } },
  ]);

  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.recommendation, 'keep_current');
});

test('generated strategy preserves AgenTank onIdle entrypoint', () => {
  const code = buildBaseStrategy({ tankName: 'test-tank' });

  assert.match(code, /function onIdle\(me, enemy, game\)/);
  assert.match(code, /me\.fire\(\)/);
  assert.match(code, /me\.go\(\)/);
});
