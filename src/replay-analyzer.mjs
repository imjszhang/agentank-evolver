function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function tankName(meta, side) {
  return meta?.[side]?.name || meta?.[`${side}Name`] || side;
}

export function analyzeReplay(response = {}, { opponentId = null, mapId = null } = {}) {
  const replay = response.replay || response;
  const meta = replay.meta || response.meta || {};
  const frames = asArray(response.replayData?.replay?.records || replay.frames || response.frames);
  const winner = response.winner || meta.winner || replay.winner || null;
  const reason = response.reason || meta.reason || replay.reason || null;
  const text = stableString(frames).toLowerCase();
  const myName = tankName(meta, 'challenger');

  const metrics = {
    opponentId,
    mapId,
    winner,
    reason,
    frameCount: frames.length,
    win: winner === 'me' ? true : (winner ? stableString(winner).toLowerCase().includes(String(myName).toLowerCase()) : false),
    draw: reason ? String(reason).toLowerCase().includes('draw') : false,
    starEvents: (text.match(/star/g) || []).length,
    fireEvents: (text.match(/type":"bullet/g) || []).length,
    hitEvents: (text.match(/hit|destroy|kill/g) || []).length,
    crashEvents: (text.match(/crash|wall|collision/g) || []).length,
    skillEvents: (text.match(/shield|freeze|stun|overload|cloak|poison|teleport|boost/g) || []).length,
  };

  metrics.survivalScore = metrics.frameCount > 0 ? Math.min(1, metrics.frameCount / 300) : 0;
  metrics.signal = [
    metrics.win ? 'win' : (metrics.draw ? 'draw' : 'loss-or-unknown'),
    `frames=${metrics.frameCount}`,
    `stars=${metrics.starEvents}`,
    `fires=${metrics.fireEvents}`,
    `hits=${metrics.hitEvents}`,
    `crashes=${metrics.crashEvents}`,
  ].join(' ');

  return metrics;
}
