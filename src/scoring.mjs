export function scoreSimulation(metrics = {}) {
  let score = 0;
  if (metrics.win) score += 100;
  if (metrics.draw) score += 35;
  score += Math.min(30, Number(metrics.starEvents || 0) * 2);
  score += Math.min(25, Number(metrics.hitEvents || 0) * 5);
  score += Math.round(Number(metrics.survivalScore || 0) * 25);
  score -= Math.min(25, Number(metrics.crashEvents || 0) * 5);
  score -= Math.min(15, Math.max(0, Number(metrics.fireEvents || 0) - Number(metrics.hitEvents || 0) * 4));
  return score;
}

export function evaluateCandidate(simulations = [], { minimumAverage = 45 } = {}) {
  const scored = simulations.map((item) => ({
    ...item,
    score: item.score ?? scoreSimulation(item.metrics || item),
  }));
  const total = scored.reduce((sum, item) => sum + item.score, 0);
  const average = scored.length ? total / scored.length : 0;
  const losses = scored.filter((item) => !item.metrics?.win && !item.win && !item.metrics?.draw && !item.draw).length;
  const variance = scored.length ? scored.reduce((sum, item) => sum + (item.score - average) ** 2, 0) / scored.length : 0;
  const std = Math.sqrt(variance);
  const min = scored.length ? Math.min(...scored.map((item) => item.score)) : 0;
  const max = scored.length ? Math.max(...scored.map((item) => item.score)) : 0;
  const range = max - min;
  const passed = scored.length > 0 && average >= minimumAverage && losses < scored.length && std <= 45 && min >= 10;
  return {
    passed,
    average,
    std,
    min,
    max,
    range,
    total,
    count: scored.length,
    losses,
    recommendation: passed ? 'publish_candidate' : 'keep_current',
    scored,
  };
}
