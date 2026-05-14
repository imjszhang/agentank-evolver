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
  const passed = scored.length > 0 && average >= minimumAverage && losses < scored.length;
  return {
    passed,
    average,
    total,
    count: scored.length,
    losses,
    recommendation: passed ? 'publish_candidate' : 'keep_current',
    scored,
  };
}
