import { selectAdaptiveIntervention } from 'file:///d:/SIH2026/Simulation/src/coordination/adaptiveIntervention.js';
import { createMovementController } from 'file:///d:/SIH2026/Simulation/src/robots/robotMovement.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

console.log('=== TEST SUITE: ADAPTIVE INTERVENTION SELECTION ===');

// Common mocks
globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {}
};

const sceneMock = {
  tweens: {
    add: (opts) => ({
      targets: opts.targets,
      duration: opts.duration,
      stop: () => {},
      complete: () => opts.onComplete && opts.onComplete()
    })
  },
  time: {
    addEvent: (opts) => ({
      remove: () => {},
      trigger: () => opts.callback && opts.callback()
    })
  }
};

const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32
};

// ── 1. ML REROUTE + TEMPORAL RESOLUTION POSSIBLE + SMALL DELAY ───────────────
console.log('\n--- 1. ML REROUTE + timingResolutionPossible=true → Suppress Reroute & Apply Temporal Action ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    tileX: 3,
    tileY: 2,
    timeA: 1.0,
    timeB: 1.3,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.4,
      conflictType: 'SAME_DIRECTION'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'REROUTE', 'recommendedDecision is original ML REROUTE');
  assert(intervention.mlDecision === 'REROUTE', 'mlDecision preserves REROUTE');
  assert(intervention.appliedDecision === 'SLOW', `appliedDecision is SLOW (least disruptive), got ${intervention.appliedDecision}`);
  assert(intervention.finalDecision === 'SLOW', 'finalDecision is SLOW');
  assert(intervention.rerouteRequired === false, 'rerouteRequired is false');
  assert(intervention.reason.includes('reroute suppressed'), 'reason explains reroute suppression');

  // Integration test: verify movement controller applies SLOW instead of rerouting
  const robots = {
    'R1': {
      id: 'R1',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 2 },
      path: [{ tileX: 1, tileY: 2 }, { tileX: 2, tileY: 2 }, { tileX: 3, tileY: 2 }],
      destination: { tileX: 3, tileY: 2 }
    }
  };
  const sprites = { 'R1': { x: 48, y: 80, setPosition: () => {} } };
  const tweens = { 'R1': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'SAME_DIRECTION',
      robotA: 'R1',
      robotB: 'R2',
      tileX: 2,
      tileY: 2,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.4, conflictType: 'SAME_DIRECTION' }
    }]
  });

  window.robotDecisionState['R1'] = { decision: 'REROUTE', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R1', 1);

  assert(robots['R1'].path.length === 3, 'Path unchanged (no unnecessary reroute)');
  assert(window.robotMovementDecisionState['R1'].mlDecision === 'REROUTE', 'Debug state mlDecision is REROUTE');
  assert(window.robotMovementDecisionState['R1'].finalDecision === 'SLOW', 'Debug state finalDecision is SLOW');
  assert(window.robotMovementDecisionState['R1'].effectiveSpeed === 50, 'Effective speed is 50 (SLOW applied)');
}

// ── 2. ML REROUTE + TEMPORAL RESOLUTION IMPOSSIBLE ───────────────────────────
console.log('\n--- 2. ML REROUTE + timingResolutionPossible=false → REROUTE Remains ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'HEAD_ON',
    tileX: 5,
    tileY: 3,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: 'Opposing traversal of shared corridor'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'REROUTE', 'recommendedDecision is REROUTE');
  assert(intervention.appliedDecision === 'REROUTE', 'appliedDecision remains REROUTE');
  assert(intervention.finalDecision === 'REROUTE', 'finalDecision remains REROUTE');
  assert(intervention.rerouteRequired === true, 'rerouteRequired is true');
  assert(intervention.reason.includes('Spatial rerouting required'), 'reason explains spatial rerouting');
}

// ── 3. ML SLOW + TEMPORAL RESOLUTION POSSIBLE ────────────────────────────────
console.log('\n--- 3. ML SLOW + timingResolutionPossible=true → SLOW Remains ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    tileX: 4,
    tileY: 2,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.5
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'SLOW', 'recommendedDecision is SLOW');
  assert(intervention.appliedDecision === 'SLOW', 'appliedDecision remains SLOW');
  assert(intervention.finalDecision === 'SLOW', 'finalDecision remains SLOW');
  assert(intervention.rerouteRequired === false, 'rerouteRequired is false');
}

// ── 4. ML SLOW + TEMPORAL RESOLUTION IMPOSSIBLE ──────────────────────────────
console.log('\n--- 4. ML SLOW + timingResolutionPossible=false → Escalates Safely to REROUTE ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'HEAD_ON',
    tileX: 5,
    tileY: 3,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: 'Opposing corridor cannot be resolved by slow speed'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'SLOW', 'recommendedDecision is SLOW');
  assert(intervention.appliedDecision === 'REROUTE', 'appliedDecision escalated to REROUTE');
  assert(intervention.finalDecision === 'REROUTE', 'finalDecision escalated to REROUTE');
  assert(intervention.rerouteRequired === true, 'rerouteRequired is true');
  assert(intervention.reason.includes('escalating SLOW to REROUTE'), 'reason notes escalation');
}

// ── 5. ML WAIT + TEMPORAL RESOLUTION POSSIBLE ────────────────────────────────
console.log('\n--- 5. ML WAIT + timingResolutionPossible=true → WAIT Remains ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    tileX: 6,
    tileY: 4,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 1.2
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'WAIT', 'recommendedDecision is WAIT');
  assert(intervention.appliedDecision === 'WAIT', 'appliedDecision remains WAIT');
  assert(intervention.finalDecision === 'WAIT', 'finalDecision remains WAIT');
  assert(intervention.rerouteRequired === false, 'rerouteRequired is false');
}

// ── 6. ML WAIT + TEMPORAL RESOLUTION IMPOSSIBLE ──────────────────────────────
console.log('\n--- 6. ML WAIT + timingResolutionPossible=false → Escalates Safely to REROUTE ---');
{
  const conflict = {
    type: 'edge',
    conflictType: 'HEAD_ON',
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: 'Opposing traversal of shared edge cannot wait'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.recommendedDecision === 'WAIT', 'recommendedDecision is WAIT');
  assert(intervention.appliedDecision === 'REROUTE', 'appliedDecision escalated to REROUTE');
  assert(intervention.finalDecision === 'REROUTE', 'finalDecision escalated to REROUTE');
  assert(intervention.rerouteRequired === true, 'rerouteRequired is true');
  assert(intervention.reason.includes('escalating WAIT to REROUTE'), 'reason notes escalation');
}

// ── 7. NO RELEVANT CONFLICT → MOVE / NO UNNECESSARY INTERVENTION ─────────────
console.log('\n--- 7. No Relevant Conflict → Nominal MOVE ---');
{
  const intervention = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict: null,
    temporalAssessment: null
  });

  assert(intervention.recommendedDecision === 'REROUTE', 'recommendedDecision is REROUTE');
  assert(intervention.appliedDecision === 'MOVE', 'appliedDecision reverts to MOVE when no conflict exists');
  assert(intervention.rerouteRequired === false, 'rerouteRequired is false');
  assert(intervention.reason.includes('No active conflict'), 'reason explains nominal movement');
}

// ── 8. BASELINE REMAINS ML-FREE ──────────────────────────────────────────────
console.log('\n--- 8. BASELINE Remains Completely ML-Free ---');
{
  const robots = {
    'R8': {
      id: 'R8',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 2, tileY: 1 }
    }
  };
  const sprites = { 'R8': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R8': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'BASELINE' // BASELINE mode
  });

  window.robotDecisionState['R8'] = { decision: 'REROUTE', confidence: 0.99, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R8', 1);

  assert(window.robotMovementDecisionState['R8'].decision === 'MOVE', 'BASELINE ignores ML and sets decision MOVE');
  assert(window.robotMovementDecisionState['R8'].mlDecision === 'MOVE', 'BASELINE mlDecision is MOVE');
  assert(window.robotMovementDecisionState['R8'].finalDecision === 'MOVE', 'BASELINE finalDecision is MOVE');
  assert(robots['R8'].path.length === 2, 'BASELINE path remains unmodified');
}

// ── 9. EXISTING REROUTE PATH CALCULATION STILL WORKS ─────────────────────────
console.log('\n--- 9. Existing REROUTE Path Calculation Still Works ---');
{
  let aStarCalled = false;
  const robots = {
    'R9': {
      id: 'R9',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };
  const sprites = { 'R9': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R9': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      robotA: 'R9',
      robotB: 'R10',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: false, requiresReroute: true }
    }],
    findPath: (sx, sy, tx, ty) => {
      aStarCalled = true;
      return [{ tileX: sx, tileY: sy }, { tileX: 1, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: tx, tileY: ty }];
    }
  });

  window.robotDecisionState['R9'] = { decision: 'REROUTE', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R9', 1);

  assert(aStarCalled === true, 'A* called for spatial reroute when timing resolution is impossible');
  assert(robots['R9'].path.some(n => n.tileY === 2), 'Alternate path safely detours');
  assert(window.robotMovementDecisionState['R9'].decision === 'REROUTE', 'Final applied decision is REROUTE');
  assert(window.robotMovementDecisionState['R9'].rerouteCount === 1, 'Reroute count incremented to 1');
}

// ── 10. EXISTING METRICS REMAIN REAL AND UNTOUCHED ───────────────────────────
console.log('\n--- 10. Existing Metrics Remain Real and Untouched ---');
{
  let waitLogged = 0;
  let distLogged = 0;

  const robots = {
    'R10': {
      id: 'R10',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 2, tileY: 1 }
    }
  };
  const sprites = { 'R10': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R10': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    onWaitTime: (rId, sec) => { waitLogged += sec; },
    onSegmentTravelled: (rId, px) => { distLogged += px; }
  });

  // Regular move tween execution
  window.robotDecisionState['R10'] = { decision: 'MOVE', confidence: 0.95, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R10', 1);

  // Complete tween to test real distance reporting
  tweens['R10'].complete();
  assert(distLogged === 32, `Segment distance logged via real physics/geometry: ${distLogged}px`);
  assert(waitLogged === 0, 'No wait time logged for MOVE');
}

console.log(`\nALL ADAPTIVE INTERVENTION TESTS PASSED! Total assertions: ${passed}`);
