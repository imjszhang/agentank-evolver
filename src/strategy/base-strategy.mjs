function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intRange(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDefensiveSkills(useShield, useBoost, useCloak, order) {
  const lines = [];
  const map = {
    shield: '  if (skillReady(me, "shield") && me.shield) { me.shield(); return true; }',
    boost: '  if (skillReady(me, "boost") && me.boost) { me.boost(); return true; }',
    cloak: '  if (skillReady(me, "cloak") && me.cloak) { me.cloak(); return true; }',
  };
  const enabled = { shield: useShield, boost: useBoost, cloak: useCloak };
  for (const skill of order) {
    if (enabled[skill]) lines.push(map[skill]);
  }
  return lines.join('\n');
}

function buildPressureSkills(vars, order) {
  const lines = [];
  const templates = {
    freeze: `  if (dist <= ${vars.freezeDist} && skillReady(me, "freeze") && me.freeze) { me.freeze(); return true; }`,
    stun: `  if (dist <= ${vars.stunDist} && skillReady(me, "stun") && me.stun) { me.stun(); return true; }`,
    poison: `  if (dist <= ${vars.poisonDist}${vars.strictLineClear ? ' && lineClear(game, my, enemyPos)' : ''} && skillReady(me, "poison") && me.poison) { me.poison(); return true; }`,
    overload: `  if (dist <= ${vars.overloadDist} && lineClear(game, my, enemyPos) && skillReady(me, "overload") && me.overload${vars.checkBulletBeforeOverload ? ' && !me.bullet' : ''}) { me.overload(); return true; }`,
  };
  for (const skill of order) {
    lines.push(templates[skill]);
  }
  return lines.join('\n');
}

function buildNeighbors(dirs) {
  return dirs
    .map((d) => `    { x: p.x ${d.dx >= 0 ? '+' : '-'} ${Math.abs(d.dx || 0)}, y: p.y ${d.dy >= 0 ? '+' : '-'} ${Math.abs(d.dy || 0)} }`)
    .join(',\n');
}

function buildTurnToward(turnRightFirst) {
  if (turnRightFirst) {
    return `function turnToward(me, need) {
  var dirs = ["up", "right", "down", "left"];
  var a = dirs.indexOf(me.tank.direction);
  var b = dirs.indexOf(need);
  if ((a + 1) % 4 === b) me.turn("right");
  else me.turn("left");
}`;
  }
  return `function turnToward(me, need) {
  var dirs = ["up", "left", "down", "right"];
  var a = dirs.indexOf(me.tank.direction);
  var b = dirs.indexOf(need);
  if ((a + 1) % 4 === b) me.turn("left");
  else me.turn("right");
}`;
}

export function buildBaseStrategy({ tankName = 'agentank-tank', seed = 0, params } = {}) {
  const rng = mulberry32(seed);

  // === Group 1: Numerical Thresholds (8) ===
  const bfsLimit = params?.bfsLimit ?? intRange(rng, 50, 120);
  const bulletThreatRange = params?.bulletThreatRange ?? intRange(rng, 2, 6);
  const enemyDangerRange = params?.enemyDangerRange ?? intRange(rng, 2, 5);
  const freezeDist = params?.freezeDist ?? intRange(rng, 3, 8);
  const stunDist = params?.stunDist ?? intRange(rng, 3, 8);
  const poisonDist = params?.poisonDist ?? intRange(rng, 4, 9);
  const overloadDist = params?.overloadDist ?? intRange(rng, 4, 9);
  const defenseThreatRange = params?.defenseThreatRange ?? intRange(rng, 3, 7);

  // === Group 2: Boolean Switches (6) ===
  const checkFireLocked = params?.checkFireLocked ?? rng() > 0.3;
  const checkShielded = params?.checkShielded ?? rng() > 0.4;
  const useShield = params?.useShield ?? rng() > 0.25;
  const useBoost = params?.useBoost ?? rng() > 0.25;
  const useCloak = params?.useCloak ?? rng() > 0.35;
  const checkBulletBeforeOverload = params?.checkBulletBeforeOverload ?? rng() > 0.4;

  // === Group 3: Priority Orderings (4) ===
  const defensiveOrder = shuffle(rng, ['shield', 'boost', 'cloak']);
  const pressureOrder = shuffle(rng, ['freeze', 'stun', 'poison', 'overload']);
  const neighborDirs = shuffle(rng, [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ]);
  const turnRightFirst = rng() > 0.5;

  // === Group 4: Behavioral Strategies (4) ===
  const preferStar = rng() > 0.4;
  const aggressiveDodge = rng() > 0.5;
  const preemptiveSkills = rng() > 0.5;
  const strictLineClear = rng() > 0.5;

  const vars = {
    bfsLimit,
    bulletThreatRange,
    enemyDangerRange,
    freezeDist,
    stunDist,
    poisonDist,
    overloadDist,
    defenseThreatRange,
    checkFireLocked,
    checkShielded,
    useShield,
    useBoost,
    useCloak,
    checkBulletBeforeOverload,
    defensiveOrder,
    pressureOrder,
    neighborDirs,
    turnRightFirst,
    preferStar,
    aggressiveDodge,
    preemptiveSkills,
    strictLineClear,
    fireLockedShoot: checkFireLocked ? ' && !me.status.fireLocked' : '',
    fireLockedCanShoot: checkFireLocked ? ' || me.status.fireLocked' : '',
    shieldedCheck: checkShielded ? ' || enemy.status.shielded' : '',
    targetExpr: preferStar ? 'starPos || enemyPos' : 'enemyPos || starPos',
    aggressiveDodgeBlock: aggressiveDodge
      ? `  if (enemyPos && canShootNow(me, enemy, game, my, enemyPos)) {\n    return aimOrFire(me, my, enemyPos);\n  }\n`
      : '',
    preemptiveSkillsBlock: preemptiveSkills
      ? `  if (enemyPos && tryPressureSkill(me, enemy, game, my, enemyPos)) return;\n`
      : '',
  };

  const defensiveSkillsBlock = buildDefensiveSkills(useShield, useBoost, useCloak, defensiveOrder);
  const pressureSkillsBlock = buildPressureSkills(vars, pressureOrder);
  const neighborsBlock = buildNeighbors(neighborDirs);
  const turnTowardBlock = buildTurnToward(turnRightFirst);

  return `// ${tankName} baseline generated by agentank-evolver (seed=${seed}).
function onIdle(me, enemy, game) {
  var my = pos(me.tank);
  var enemyPos = enemy && enemy.tank ? pos(enemy.tank) : null;
  var starPos = game.star ? { x: game.star[0], y: game.star[1] } : null;

${vars.preemptiveSkillsBlock}`/* no leading newline needed — the block has its own */ + `  if (tryDefensiveSkill(me, enemy, my)) return;

  var dodge = dodgeMove(me, enemy, game, my);
  if (dodge) return actMove(me, dodge);

  if (enemyPos && canShootNow(me, enemy, game, my, enemyPos)) {
    return aimOrFire(me, my, enemyPos);
  }

  if (tryPressureSkill(me, enemy, game, my, enemyPos)) return;

  var target = ${vars.targetExpr};
  if (target) {
    var step = nextStepToward(game, my, target, enemyPos);
    if (step && isSafeAfterMove(step, enemy, game)) return actMove(me, step);
  }

  var safe = safestNeighbor(game, my, enemy, enemyPos);
  if (safe) return actMove(me, safe);
  if (enemyPos) return aimOrFire(me, my, enemyPos);
  me.turn("right");
}

function pos(tank) {
  return { x: tank.position[0], y: tank.position[1] };
}

function dirDelta(dir) {
  if (dir === "up") return { x: 0, y: -1 };
  if (dir === "down") return { x: 0, y: 1 };
  if (dir === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function wantedDir(from, to) {
  if (to.x > from.x) return "right";
  if (to.x < from.x) return "left";
  if (to.y > from.y) return "down";
  if (to.y < from.y) return "up";
  return null;
}

function actMove(me, target) {
  var need = wantedDir(pos(me.tank), target);
  if (!need) return;
  if (me.tank.direction === need) me.go();
  else turnToward(me, need);
}

${turnTowardBlock}

function aimOrFire(me, my, target) {
  var need = wantedDir(my, target);
  if (!need) return;
  if (me.tank.direction === need${vars.fireLockedShoot} && !me.bullet) me.fire();
  else turnToward(me, need);
}

function inside(game, p) {
  return p.x >= 0 && p.y >= 0 && game.map[p.x] && game.map[p.x][p.y] != null;
}

function passable(game, p, enemyPos) {
  if (!inside(game, p)) return false;
  var tile = game.map[p.x][p.y];
  if (tile === "x" || tile === "m") return false;
  if (enemyPos && enemyPos.x === p.x && enemyPos.y === p.y) return false;
  return true;
}

function lineClear(game, a, b) {
  if (a.x !== b.x && a.y !== b.y) return false;
  var dx = b.x === a.x ? 0 : (b.x > a.x ? 1 : -1);
  var dy = b.y === a.y ? 0 : (b.y > a.y ? 1 : -1);
  var p = { x: a.x + dx, y: a.y + dy };
  while (p.x !== b.x || p.y !== b.y) {
    if (!inside(game, p)) return false;
    var tile = game.map[p.x][p.y];
    if (tile === "x" || tile === "m") return false;
    p = { x: p.x + dx, y: p.y + dy };
  }
  return true;
}

function canShootNow(me, enemy, game, my, enemyPos) {
  if (!enemyPos || me.bullet${vars.fireLockedCanShoot}${vars.shieldedCheck}) return false;
  return lineClear(game, my, enemyPos);
}

function bulletThreatens(p, bullet) {
  if (!bullet || !bullet.position) return false;
  var b = { x: bullet.position[0], y: bullet.position[1] };
  var d = bullet.direction || bullet.dir;
  if (b.x === p.x && b.y === p.y) return true;
  if (d === "left" && b.y === p.y && b.x > p.x && b.x - p.x <= ${bulletThreatRange}) return true;
  if (d === "right" && b.y === p.y && b.x < p.x && p.x - b.x <= ${bulletThreatRange}) return true;
  if (d === "up" && b.x === p.x && b.y > p.y && b.y - p.y <= ${bulletThreatRange}) return true;
  if (d === "down" && b.x === p.x && b.y < p.y && p.y - b.y <= ${bulletThreatRange}) return true;
  return false;
}

function isSafeAfterMove(p, enemy, game) {
  if (bulletThreatens(p, enemy && enemy.bullet)) return false;
  if (enemy && enemy.tank) {
    var ep = pos(enemy.tank);
    if (lineClear(game, ep, p) && Math.abs(ep.x - p.x) + Math.abs(ep.y - p.y) <= ${enemyDangerRange}) return false;
  }
  return true;
}

function dodgeMove(me, enemy, game, my) {
  if (!bulletThreatens(my, enemy && enemy.bullet)) return null;
${vars.aggressiveDodgeBlock}  return safestNeighbor(game, my, enemy, enemy && enemy.tank ? pos(enemy.tank) : null);
}

function neighbors(p) {
  return [
${neighborsBlock}
  ];
}

function safestNeighbor(game, my, enemy, enemyPos) {
  var list = neighbors(my);
  for (var i = 0; i < list.length; i++) {
    if (passable(game, list[i], enemyPos) && isSafeAfterMove(list[i], enemy, game)) return list[i];
  }
  return null;
}

function nextStepToward(game, start, target, enemyPos) {
  var q = [{ p: start, first: null }];
  var seen = {};
  seen[start.x + "," + start.y] = true;
  for (var head = 0; head < q.length && head < ${bfsLimit}; head++) {
    var cur = q[head];
    if (cur.p.x === target.x && cur.p.y === target.y) return cur.first;
    var ns = neighbors(cur.p);
    for (var i = 0; i < ns.length; i++) {
      var n = ns[i];
      var key = n.x + "," + n.y;
      if (seen[key] || !passable(game, n, enemyPos)) continue;
      seen[key] = true;
      q.push({ p: n, first: cur.first || n });
    }
  }
  return null;
}

function skillReady(me, type) {
  return me.skill && me.skill.type === type && me.skill.remainingCooldownFrames === 0;
}

function tryDefensiveSkill(me, enemy, my) {
  if (!bulletThreatens(my, enemy && enemy.bullet)) return false;
${defensiveSkillsBlock}
  return false;
}

function tryPressureSkill(me, enemy, game, my, enemyPos) {
  if (!enemyPos) return false;
  var dist = Math.abs(my.x - enemyPos.x) + Math.abs(my.y - enemyPos.y);
${pressureSkillsBlock}
  return false;
}
`;
}
