#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenTankApi } from './agentank-api.mjs';
import { loadConfig } from './config.mjs';
import {
  dataRoot,
  ensureDataDirs,
  latestJson,
  projectRoot,
  sha256,
  timestampId,
  writeJson,
} from './files.mjs';
import { analyzeReplay } from './replay-analyzer.mjs';
import { redact } from './redact.mjs';
import { evaluateCandidate, scoreSimulation } from './scoring.mjs';
import { buildBaseStrategy } from './strategy/base-strategy.mjs';

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
  const latestContext = latestJson(join(dataRoot, 'context'))?.value;
  const tankName = latestContext?.tank?.tank?.name || latestContext?.tank?.name || 'agentank-tank';
  const code = buildBaseStrategy({ tankName });
  const codeHash = sha256(code);
  const id = `candidate-${timestampId()}`;
  const candidate = {
    id,
    createdAt: new Date().toISOString(),
    source: 'baseline-robust-combat',
    codeHash,
    notes: flags.notes || '安全移动、抢星、直线射击、躲弹和技能门禁的保守基线。',
    code,
  };
  const path = writeJson(join(dataRoot, 'candidates', `${id}.json`), candidate);
  return {
    success: true,
    status: 'candidate_generated',
    candidate: { id, codeHash, notes: candidate.notes },
    path,
    writes: {
      observations: [
        observation(`已生成候选策略 ${id}。`, { evidence: { path, codeHash } }),
      ],
    },
  };
}

export async function simulateCommand({ api = apiFromConfig(), flags = {} } = {}) {
  ensureDataDirs();
  const candidateFile = flags.candidate
    ? { value: JSON.parse(readFileSync(flags.candidate, 'utf-8')) }
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
    const response = await api.simulate({ opponentId, mapId, code: candidate.code });
    const metrics = analyzeReplay(response, { opponentId, mapId });
    simulations.push({
      opponentId,
      mapId,
      metrics,
      score: scoreSimulation(metrics),
      response: redact(response),
    });
  }
  const id = `simulation-${timestampId()}`;
  const record = {
    id,
    candidateId: candidate.id,
    candidateHash: candidate.codeHash,
    createdAt: new Date().toISOString(),
    simulations,
  };
  const path = writeJson(join(dataRoot, 'simulations', `${id}.json`), redact(record));
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
  const simulation = flags.simulation
    ? readFileSync(flags.simulation, 'utf-8')
    : null;
  const record = simulation ? JSON.parse(simulation) : latestJson(join(dataRoot, 'simulations'))?.value;
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
  return {
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
        commands: ['sync', 'generate', 'simulate', 'evaluate', 'publish', 'challenge-request'],
        projectRoot,
      };
    }
    if (command === 'sync') return syncCommand({ flags });
    if (command === 'generate') return generateCommand({ flags });
    if (command === 'simulate') return simulateCommand({ flags });
    if (command === 'evaluate') return evaluateCommand({ flags });
    if (command === 'publish') return publishCommand({ flags });
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
