#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenTankApi } from './agentank-api.mjs';
import { loadConfig } from './config.mjs';
import {
  dataRoot,
  ensureDataDirs,
  latestFilePath,
  latestJson,
  projectRoot,
  readJsonSafe,
  sha256,
  timestampId,
  writeJson,
} from './files.mjs';
import { analyzeReplay } from './replay-analyzer.mjs';
import { redact } from './redact.mjs';
import { evaluateCandidate, scoreSimulation } from './scoring.mjs';
import { buildBaseStrategy } from './strategy/base-strategy.mjs';

process.env.INJECTION_APPLY = '1';

const TRAINING_BOTS = ['nova-scout', 'azure-hunter', 'crimson-bastion'];

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command: positionals[0] || 'help', flags };
}

function apiFromConfig(config = loadConfig()) {
  return new AgenTankApi(config);
}

function observation(content, extra = {}) {
  return {
    source: 'agentank-evolver',
    subject: 'agentank-tank',
    kind: 'agentank_evolution',
    content,
    confidence: 'medium',
    tags: ['agentank', 'evolution'],
    ...extra,
  };
}

function output(result) {
  console.log(JSON.stringify(redact(result), null, 2));
}

export async function syncCommand({ api = apiFromConfig(), flags = {} } = {}) {
  ensureDataDirs();
  const tank = await api.getTank();
  const leaderboard = await api.getLeaderboard({ period: flags.period || 'today', sort: flags.sort || 'win_rate', limit: Number(flags.limit || 30) });
  const matches = await api.getMatches({ limit: Number(flags.matches || 10), offset: 0 });
  const id = timestampId();
  const record = {
    id,
    syncedAt: new Date().toISOString(),
    tank,
    leaderboard,
    matches,
  };
  const path = writeJson(join(dataRoot, 'context', `sync-${id}.json`), redact(record));
  return {
    success: true,
    status: 'synced',
    path,
    evidence: {
      tankName: tank?.tank?.name ?? tank?.name ?? null,
      skillType: tank?.skill?.type ?? tank?.tank?.skillType ?? null,
      standing: tank?.standing ?? null,
      matchCount: Array.isArray(matches?.matches) ? matches.matches.length : 0,
    },
    writes: {
      observations: [
        observation('已同步 AgenTank 远端 context、leaderboard 和 recent matches。', {
          evidence: { path, standing: tank?.standing ?? null },
        }),
      ],
    },
  };
}

export async function generateCommand({ flags = {} } = {}) {
  ensureDataDirs();
  const injectionOn = process.env.INJECTION_APPLY === '1' || process.env.INJECTION_APPLY === 'true';
  const latestContext = latestJson(join(dataRoot, 'context'))?.value;
  const tankName = latestContext?.tank?.tank?.name || latestContext?.tank?.name || 'agentank-tank';
  let params;
  if (flags.params) {
    try {
      params = JSON.parse(flags.params);
    } catch (err) {
      return { success: false, status: 'invalid_params', message: `Failed to parse --params JSON: ${err.message}` };
    }
  }
  // When injection is off, ignore param-driven mutations (only explicit overrides take effect)
  const effectiveParams = injectionOn ? (params ?? null) : null;
  const seed = flags.seed != null ? Number(flags.seed) : (params?._seed != null ? Number(params._seed) : Date.now());
  const injectionPoints = effectiveParams ? Object.entries(effectiveParams).sort((a, b) => a[0].localeCompare(b[0])) : [];
  const code = buildBaseStrategy({ tankName, seed, params: effectiveParams });
  const codeHash = sha256(code + JSON.stringify(injectionPoints));
  const id = `candidate-${timestampId()}`;
  const candidate = {
    id,
    createdAt: new Date().toISOString(),
    source: injectionOn ? 'injection-mutation' : 'baseline-robust-combat',
    injectionOn,
    seed,
    params: effectiveParams ?? null,
    codeHash,
    notes: flags.notes || (injectionOn
      ? '注入启用的变异策略（22 个注入点参数化）。'
      : '安全移动、抢星、直线射击、躲弹和技能门禁的保守基线。'),
    code,
  };
  const path = writeJson(join(dataRoot, 'candidates', `${id}.json`), candidate);
  writeJson(latestFilePath, {
    candidate: id,
    score: null,
    timestamp: new Date().toISOString(),
  });
  return {
    success: true,
    status: 'candidate_generated',
    injectionOn,
    candidate: { id, codeHash, seed, injectionOn, notes: candidate.notes },
    path,
    writes: {
      observations: [
        observation(`已生成候选策略 ${id}（seed=${seed}${injectionOn ? ', injection=on' : ''}）。`, { evidence: { path, codeHash, seed, injectionOn } }),
      ],
    },
  };
}

function resolveCandidatePath(raw) {
  if (!raw.includes('/') && !raw.includes('\\')) {
    const filename = raw.endsWith('.json') ? raw : `${raw}.json`;
    return join(dataRoot, 'candidates', filename);
  }
  return raw;
}

export async function simulateCommand({ api = apiFromConfig(), flags = {} } = {}) {
  ensureDataDirs();
  const cooldownStatePath = join(dataRoot, 'cooldown-state.json');
  const cooldownState = readJsonSafe(cooldownStatePath, { lastSimulationAt: null, nextSimulationAt: null, skipLog: [] });
  const now = new Date();

  // Check persisted local cooldown first (survives process restarts)
  if (cooldownState.nextSimulationAt) {
    const localNext = new Date(cooldownState.nextSimulationAt);
    if (now < localNext) {
      const skipEntry = {
        skippedAt: now.toISOString(),
        reason: 'cooldown_active_local',
        nextSimulationAt: cooldownState.nextSimulationAt,
        remainingMs: localNext.getTime() - now.getTime(),
      };
      cooldownState.skipLog.push(skipEntry);
      if (cooldownState.skipLog.length > 50) cooldownState.skipLog = cooldownState.skipLog.slice(-50);
      writeJson(cooldownStatePath, cooldownState);
      return {
        success: true,
        status: 'skipped_cooldown',
        message: `Simulation cooldown active (local) until ${cooldownState.nextSimulationAt}. Skipped at ${now.toISOString()}.`,
        cooldown: {
          nextSimulationAt: cooldownState.nextSimulationAt,
          remainingMs: localNext.getTime() - now.getTime(),
          source: 'local_state',
          skipLogCount: cooldownState.skipLog.length,
        },
        writes: {
          observations: [
            observation(`模拟跳过：本地冷却生效至 ${cooldownState.nextSimulationAt}，剩余 ${Math.ceil((localNext - now) / 1000)}s。`, {
              evidence: { cooldownStatePath, skipEntry },
            }),
          ],
        },
      };
    }
  }

  const cooldown = await api.getSimulationCooldown();
  if (cooldown.nextSimulationAt) {
    const nextAt = new Date(cooldown.nextSimulationAt);
    if (now < nextAt) {
      const skipEntry = {
        skippedAt: now.toISOString(),
        reason: 'cooldown_active',
        nextSimulationAt: cooldown.nextSimulationAt,
        remainingMs: nextAt.getTime() - now.getTime(),
      };
      cooldownState.skipLog.push(skipEntry);
      if (cooldownState.skipLog.length > 50) cooldownState.skipLog = cooldownState.skipLog.slice(-50);
      writeJson(cooldownStatePath, cooldownState);
      return {
        success: true,
        status: 'skipped_cooldown',
        message: `Simulation cooldown active until ${cooldown.nextSimulationAt}. Skipped at ${now.toISOString()}.`,
        cooldown: {
          nextSimulationAt: cooldown.nextSimulationAt,
          remainingMs: nextAt.getTime() - now.getTime(),
          skipLogCount: cooldownState.skipLog.length,
        },
        writes: {
          observations: [
            observation(`模拟跳过：冷却生效至 ${cooldown.nextSimulationAt}，剩余 ${Math.ceil((nextAt - now) / 1000)}s。`, {
              evidence: { cooldownStatePath, skipEntry },
            }),
          ],
        },
      };
    }
  }

  const candidateFile = flags.candidate
    ? { value: JSON.parse(readFileSync(resolveCandidatePath(flags.candidate), 'utf-8')) }
    : latestJson(join(dataRoot, 'candidates'));
  const candidate = candidateFile?.value;
  if (!candidate?.code) throw new Error('No candidate code found. Run generate first.');

  const opponents = String(flags.opponents || flags.opponent || TRAINING_BOTS.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const mapId = String(flags.map || 'classic');
  const simulations = [];
  for (const opponentId of opponents) {
    try {
      const response = await api.simulate({ opponentId, mapId, code: candidate.code });
      const metrics = analyzeReplay(response, { opponentId, mapId });
      simulations.push({
        opponentId,
        mapId,
        metrics,
        score: scoreSimulation(metrics),
        response: redact(response),
      });
    } catch (err) {
      if (err.status === 429) {
        const retrySec = err.retryAfterSec ?? 60;
        const nextAt = new Date(Date.now() + retrySec * 1000).toISOString();
        cooldownState.lastSimulationAt = new Date().toISOString();
        cooldownState.nextSimulationAt = nextAt;
        writeJson(cooldownStatePath, cooldownState);

        if (simulations.length > 0) {
          const partialId = `simulation-${timestampId()}`;
          const partialRecord = {
            id: partialId,
            candidateId: candidate.id,
            candidateHash: candidate.codeHash,
            createdAt: new Date().toISOString(),
            simulations,
            partial: true,
            cooldownBlocked: { nextSimulationAt: nextAt },
          };
          const partialPath = writeJson(join(dataRoot, 'simulations', `${partialId}.json`), redact(partialRecord));
          return {
            success: true,
            status: 'partial_simulation_cooldown',
            message: `${simulations.length}/${opponents.length} simulations completed before 429 cooldown.`,
            simulation: { id: partialId, candidateId: candidate.id, count: simulations.length },
            path: partialPath,
            cooldown: { nextSimulationAt: nextAt },
            evidence: { summaries: simulations.map((item) => ({ opponentId: item.opponentId, score: item.score, signal: item.metrics.signal })) },
            writes: {
              observations: [
                observation(`候选策略 ${candidate.id} 部分模拟 ${simulations.length}/${opponents.length} 后遇 429 冷却。`, {
                  evidence: { path: partialPath, cooldownStatePath },
                }),
              ],
            },
          };
        }

        return {
          success: true,
          status: 'skipped_cooldown',
          message: `Simulation blocked by 429 cooldown. Next available: ${nextAt}`,
          cooldown: { nextSimulationAt: nextAt },
          writes: {
            observations: [
              observation(`模拟被 429 冷却阻塞，下次可用 ${nextAt}。`, {
                evidence: { cooldownStatePath },
              }),
            ],
          },
        };
      }
      throw err;
    }

    cooldownState.lastSimulationAt = new Date().toISOString();
    writeJson(cooldownStatePath, cooldownState);

    // Delay between consecutive simulate calls to avoid API rate-limit (HTTP 429)
    if (opponents.length > 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const id = `simulation-${timestampId()}`;
  const nowIso = new Date().toISOString();
  const record = {
    id,
    candidateId: candidate.id,
    candidateHash: candidate.codeHash,
    createdAt: nowIso,
    simulations,
  };
  const path = writeJson(join(dataRoot, 'simulations', `${id}.json`), redact(record));

  cooldownState.lastSimulationAt = nowIso;
  cooldownState.nextSimulationAt = cooldown.nextSimulationAt ?? null;
  if (cooldownState.skipLog.length > 50) cooldownState.skipLog = cooldownState.skipLog.slice(-50);
  writeJson(cooldownStatePath, cooldownState);

  return {
    success: true,
    status: 'simulated',
    simulation: { id, candidateId: candidate.id, count: simulations.length },
    path,
    evidence: { summaries: simulations.map((item) => ({ opponentId: item.opponentId, score: item.score, signal: item.metrics.signal })) },
    writes: {
      observations: [
        observation(`候选策略 ${candidate.id} 已完成 ${simulations.length} 次模拟。`, { evidence: { path } }),
      ],
    },
  };
}

export async function evaluateCommand({ flags = {} } = {}) {
  ensureDataDirs();
  let record;
  if (flags.simulation === 'latest') {
    const ref = readJsonSafe(latestFilePath);
    if (ref?.score) {
      const scoreRecord = readJsonSafe(join(dataRoot, 'scores', `${ref.score}.json`));
      if (scoreRecord?.simulationId) {
        record = readJsonSafe(join(dataRoot, 'simulations', `${scoreRecord.simulationId}.json`));
      }
    }
    if (!record) {
      record = latestJson(join(dataRoot, 'simulations'))?.value;
    }
  } else if (flags.simulation) {
    record = JSON.parse(readFileSync(flags.simulation, 'utf-8'));
  } else {
    record = latestJson(join(dataRoot, 'simulations'))?.value;
  }
  if (!record?.simulations) throw new Error('No simulation record found. Run simulate first.');
  const evaluation = evaluateCandidate(record.simulations, {
    minimumAverage: Number(flags.minimumAverage || 45),
  });
  const id = `score-${timestampId()}`;
  const scored = {
    id,
    createdAt: new Date().toISOString(),
    candidateId: record.candidateId,
    candidateHash: record.candidateHash,
    simulationId: record.id,
    ...evaluation,
  };
  const path = writeJson(join(dataRoot, 'scores', `${id}.json`), scored);
  writeJson(latestFilePath, {
    candidate: scored.candidateId,
    score: id,
    timestamp: new Date().toISOString(),
  });
  const result = {
    success: true,
    status: evaluation.passed ? 'passed' : 'failed',
    path,
    evaluation: {
      id,
      candidateId: record.candidateId,
      average: evaluation.average,
      count: evaluation.count,
      losses: evaluation.losses,
      recommendation: evaluation.recommendation,
    },
    writes: {
      observations: [
        observation(`候选策略 ${record.candidateId} 评分门禁：${evaluation.recommendation}。`, {
          evidence: { path, average: evaluation.average, count: evaluation.count },
        }),
      ],
    },
  };

  if (evaluation.passed && evaluation.recommendation === 'publish_candidate') {
    const cfg = loadConfig();
    if (cfg.allowPublish) {
      try {
        const pubResult = await publishCommand({ flags });
        result.publish = pubResult;
      } catch (err) {
        result.publish = {
          success: false,
          status: 'publish_failed',
          message: err?.message || String(err),
        };
      }
    }
  }

  return result;
}

export async function publishCommand({ api = apiFromConfig(), config = loadConfig(), flags = {} } = {}) {
  ensureDataDirs();
  const score = latestJson(join(dataRoot, 'scores'))?.value;
  if (!score) throw new Error('No score record found. Run evaluate first.');
  if (!score.passed) {
    return {
      success: false,
      status: 'blocked',
      message: 'Latest evaluation did not pass the publish gate.',
      evaluation: { id: score.id, recommendation: score.recommendation, average: score.average },
    };
  }
  if (!config.allowPublish && !flags.force) {
    return {
      success: true,
      status: 'requires_human_review',
      requires_approval: true,
      message: 'Publish gate passed, but AGENTANK_ALLOW_PUBLISH is not true.',
      evaluation: { id: score.id, candidateId: score.candidateId, average: score.average },
    };
  }
  const candidate = latestJson(join(dataRoot, 'candidates'))?.value;
  if (!candidate?.code || candidate.id !== score.candidateId) {
    throw new Error('Latest candidate does not match latest score record.');
  }
  const response = await api.publishCode({
    code: candidate.code,
    notes: flags.notes || candidate.notes,
    submittedBy: config.submittedBy,
  });
  const id = `publish-${timestampId()}`;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    candidateId: candidate.id,
    candidateHash: candidate.codeHash,
    scoreId: score.id,
    response: redact(response),
  };
  const path = writeJson(join(dataRoot, 'publish', `${id}.json`), record);
  return {
    success: true,
    status: 'published',
    path,
    publish: { id, candidateId: candidate.id, candidateHash: candidate.codeHash },
    writes: {
      observations: [
        observation(`候选策略 ${candidate.id} 已发布到 AgenTank。`, { evidence: { path, scoreId: score.id } }),
      ],
    },
  };
}

/** POST /api/agent/tank/challenge — real match record, affects rank. Gated by AGENTANK_ALLOW_CHALLENGE or --force. */
export async function challengeCommand({ api = apiFromConfig(), config = loadConfig(), flags = {} } = {}) {
  ensureDataDirs();
  const mapId = String(flags.map || 'classic');
  const randomOpponent =
    flags.randomOpponent === true || flags.randomOpponent === 'true';
  const opponentTankId = flags.opponentTankId ?? flags.opponent;

  if (!config.allowChallenge && !flags.force) {
    return {
      success: false,
      status: 'blocked',
      message:
        'Recorded challenge skipped. Set AGENTANK_ALLOW_CHALLENGE=true in .env or pass --force to call the challenge API.',
    };
  }
  if (!randomOpponent && (opponentTankId == null || opponentTankId === '')) {
    return {
      success: false,
      status: 'blocked',
      message: 'Specify --randomOpponent or --opponentTankId <id> (counts as a ranked match).',
    };
  }

  const response = await api.challenge({
    mapId,
    randomOpponent,
    ...(randomOpponent ? {} : { opponentTankId: Number(opponentTankId) }),
  });

  const id = `challenge-${timestampId()}`;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    mapId,
    randomOpponent,
    opponentTankId: randomOpponent ? null : Number(opponentTankId),
    response: redact(response),
  };
  const path = writeJson(join(dataRoot, 'challenges', `${id}.json`), record);

  const challengerId = response?.challengerTankId ?? null;
  const defenderId = response?.defenderTankId ?? null;
  const winnerTankId = response?.winnerTankId ?? null;
  let winnerSummary = null;
  if (challengerId != null && winnerTankId === challengerId) winnerSummary = 'challenger';
  else if (defenderId != null && winnerTankId === defenderId) winnerSummary = 'defender';
  const matchUrlId = response?.urlId ?? response?.matchUrlId ?? null;
  const historyPath = matchUrlId ? `/history/${matchUrlId}` : null;

  return {
    success: true,
    status: 'challenged',
    path,
    challenge: {
      id,
      mapId,
      randomOpponent,
      matchId: response?.id ?? null,
      resultReason: response?.resultReason ?? null,
      winnerTankId,
      winner: winnerSummary,
      challengerTankId: challengerId,
      defenderTankId: defenderId,
      matchUrlId,
      replayUrlPath: historyPath,
    },
    writes: {
      observations: [
        observation('已完成远端真实 challenge（计分战报）；结果已写入 data/challenges。', {
          evidence: { path, winner: winnerSummary, matchUrlId, resultReason: response?.resultReason },
        }),
      ],
    },
  };
}

export async function challengeRequestCommand({ flags = {} } = {}) {
  ensureDataDirs();
  const id = `challenge-request-${timestampId()}`;
  const request = {
    id,
    createdAt: new Date().toISOString(),
    status: 'requires_human_review',
    opponentTankId: flags.opponentTankId ? Number(flags.opponentTankId) : null,
    randomOpponent: flags.randomOpponent === true || flags.randomOpponent === 'true',
    mapId: flags.map || 'classic',
    reason: flags.reason || 'Manual approval required before any recorded challenge.',
  };
  const path = writeJson(join(dataRoot, 'challenge-requests', `${id}.json`), request);
  return {
    success: true,
    status: 'requires_human_review',
    requires_approval: true,
    message: 'Recorded challenge request only; no real challenge was executed.',
    path,
    request,
    writes: {
      observations: [
        observation(`已记录真实 challenge 审批请求 ${id}，未执行远端挑战。`, { evidence: { path } }),
      ],
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgv(argv);
  try {
    if (command === 'help') {
      return {
        success: true,
        commands: [
          'sync',
          'generate',
          'simulate',
          'evaluate',
          'publish',
          'challenge',
          'challenge-request',
        ],
        projectRoot,
      };
    }
    if (command === 'sync') return syncCommand({ flags });
    if (command === 'generate') return generateCommand({ flags });
    if (command === 'simulate') return simulateCommand({ flags });
    if (command === 'evaluate') return evaluateCommand({ flags });
    if (command === 'publish') return publishCommand({ flags });
    if (command === 'challenge') return challengeCommand({ flags });
    if (command === 'challenge-request') return challengeRequestCommand({ flags });
    return { success: false, status: 'unknown_command', command };
  } catch (error) {
    return {
      success: false,
      status: 'failed',
      message: error?.message || String(error),
      apiStatus: error?.status ?? null,
      payload: error?.payload ?? null,
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await main();
  output(result);
  process.exit(result.success ? 0 : 1);
}
