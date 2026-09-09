/**
 * scratch/test_step5_validation.mjs
 * Validation and tuning suite for Phase 7 Step 5: Adaptive Intervention Selection
 *
 * Tests the 5 core scenarios:
 * 1. SAME_DIRECTION following: preserves direct route, suppresses unnecessary REROUTE, uses SLOW/WAIT.
 * 2. CROSSING intersection: prefers temporal action (SLOW or WAIT), zero extra distance, no oscillation.
 * 3. HEAD_ON corridor: timing resolution impossible -> escalates to REROUTE, avoids corridor, no repeated rerouting.
 * 4. NO CONFLICT: nominal MOVE, suppresses unnecessary interventions.
 * 5. REROUTE FALLBACK: falls back safely to WAIT when alternate path is unavailable.
 * 6. Anti-oscillation: verifies no rapid switching between actions.
 * 7. Decision trace: inspects mlDecision, finalDecision, and decisionReason.
 * 8. Real metric comparison: BASELINE vs OPTIMIZED in conflict scenario.
 */

import { createMovementController } from 'file:///d:/SIH2026/Simulation/src/robots/robotMovement.js';
import { selectAdaptiveIntervention } from 'file:///d:/SIH2026/Simulation/src/coordination/adaptiveIntervention.js';
import { createRunMetrics, finaliseMetrics, compareRunMetrics } from 'file:///d:/SIH2026/Simulation/src/simulation/runMetrics.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

// Global window mock
globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {}
};

// Mock Scene and Map
function createMockEnvironment(robots = {}) {
  const tweens = {};
  for (const id of Object.keys(robots)) {
    tweens[id] = null;
  }
  const timerEvents = [];

  const scene = {
    tweens: {
      add: (opts) => {
        const targetId = Object.keys(sprites).find((k) => sprites[k] === opts.targets);
        const tween = {
          targets: opts.targets,
          duration: opts.duration,
          isCompleted: false,
          stop: () => {},
          complete: () => {
            if (!tween.isCompleted) {
              tween.isCompleted = true;
              if (opts.onComplete) opts.onComplete();
            }
          }
        };
        if (targetId) tweens[targetId] = tween;
        return tween;
      }
    },
    time: {
      addEvent: (opts) => {
        const ev = {
          callback: opts.callback,
          delay: opts.delay,
          removed: false,
          remove: () => { ev.removed = true; },
          trigger: () => { if (!ev.removed && opts.callback) opts.callback(); }
        };
        timerEvents.push(ev);
        return ev;
      }
    }
  };

  const map = {
    tileToWorldX: (tx) => tx * 32,
    tileToWorldY: (ty) => ty * 32,
    worldToTileX: (wx) => Math.floor(wx / 32),
    worldToTileY: (wy) => Math.floor(wy / 32)
  };

  const sprites = {};

  return { scene, map, sprites, tweens, timerEvents };
}

console.log('=== PHASE 7 STEP 5: ADAPTIVE BEHAVIOR VALIDATION & TUNING ===\n');

// ── SCENARIO 1: SAME-DIRECTION FOLLOWING ─────────────────────────────────────
console.log('--- Scenario 1: Same-Direction Following ---');
{
  const robots = {
    'R_Lead': {
      id: 'R_Lead',
      speed: 100,
      status: 'moving',
      start: { tileX: 5, tileY: 2 },
      destination: { tileX: 10, tileY: 2 },
      path: [{ tileX: 5, tileY: 2 }, { tileX: 6, tileY: 2 }, { tileX: 7, tileY: 2 }, { tileX: 8, tileY: 2 }, { tileX: 9, tileY: 2 }, { tileX: 10, tileY: 2 }]
    },
    'R_Follow': {
      id: 'R_Follow',
      speed: 100,
      status: 'moving',
      start: { tileX: 3, tileY: 2 },
      destination: { tileX: 10, tileY: 2 },
      path: [{ tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }, { tileX: 6, tileY: 2 }, { tileX: 7, tileY: 2 }, { tileX: 8, tileY: 2 }, { tileX: 9, tileY: 2 }, { tileX: 10, tileY: 2 }]
    }
  };
  const env = createMockEnvironment(robots);

  env.sprites['R_Lead'] = { x: 5 * 32 + 16, y: 2 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };
  env.sprites['R_Follow'] = { x: 3 * 32 + 16, y: 2 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  let rerouteCalls = 0;
  let distanceFollowerPx = 0;

  const initialFollowerPathLength = robots['R_Follow'].path.length;

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    onSegmentTravelled: (rId, distPx) => {
      if (rId === 'R_Follow') distanceFollowerPx += distPx;
    },
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'SAME_DIRECTION',
      robotA: 'R_Lead',
      robotB: 'R_Follow',
      tileX: 6,
      tileY: 2,
      timeA: 1.0,
      timeB: 1.4,
      temporalAssessment: {
        timingResolutionPossible: true,
        requiresReroute: false,
        estimatedDelaySec: 0.4,
        conflictType: 'SAME_DIRECTION'
      }
    }],
    findPath: () => {
      rerouteCalls++;
      return null;
    }
  });

  // ML model produces REROUTE for follower catching up
  window.robotDecisionState['R_Follow'] = { decision: 'REROUTE', confidence: 0.88, timestamp: Date.now() };

  // Step follower
  ctrl.moveRobotToNextWaypoint('R_Follow', 1);

  // Verification 1: Reroute suppressed in favor of temporal action (SLOW)
  const state = window.robotMovementDecisionState['R_Follow'];
  assert(state.mlDecision === 'REROUTE', 'Follower ML recommendation preserved as REROUTE');
  assert(state.finalDecision === 'SLOW', 'Follower adaptive intervention selected SLOW');
  assert(state.decision === 'SLOW', 'Applied decision is SLOW');
  assert(state.effectiveSpeed === 50, 'Effective speed reduced to 50 px/s (50% reduction)');
  assert(rerouteCalls === 0, 'No A* reroute triggered (unnecessary rerouting avoided)');
  assert(robots['R_Follow'].path.length === initialFollowerPathLength, 'Follower remains on original direct path');
  assert(state.decisionReason.includes('Temporal separation is safely achievable'), 'Decision reason explains temporal separation');

  // Verify duration reflects 50% speed
  const dist = 32; // 1 tile
  const expectedDuration = (dist / 50) * 1000;
  assert(Math.abs(env.tweens['R_Follow'].duration - expectedDuration) < 1, 'Tween duration corresponds to 50% speed');
}

// ── SCENARIO 2: CROSSING INTERSECTION ────────────────────────────────────────
console.log('\n--- Scenario 2: Crossing Intersection ---');
{
  const robots = {
    'R_Cross1': {
      id: 'R_Cross1',
      speed: 100,
      status: 'moving',
      start: { tileX: 4, tileY: 1 },
      destination: { tileX: 4, tileY: 5 },
      path: [{ tileX: 4, tileY: 1 }, { tileX: 4, tileY: 2 }, { tileX: 4, tileY: 3 }, { tileX: 4, tileY: 4 }, { tileX: 4, tileY: 5 }]
    },
    'R_Cross2': {
      id: 'R_Cross2',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 3 },
      destination: { tileX: 6, tileY: 3 },
      path: [{ tileX: 2, tileY: 3 }, { tileX: 3, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 5, tileY: 3 }, { tileX: 6, tileY: 3 }]
    }
  };
  const env = createMockEnvironment(robots);

  env.sprites['R_Cross1'] = { x: 4 * 32 + 16, y: 1 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };
  env.sprites['R_Cross2'] = { x: 2 * 32 + 16, y: 3 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  let waitedTimeLogged = 0;
  let activeConflicts = [{
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'R_Cross1',
    robotB: 'R_Cross2',
    tileX: 4,
    tileY: 3,
    timeA: 2.0,
    timeB: 2.8,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.8,
      conflictType: 'CROSSING'
    }
  }];

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    onWaitTime: (rId, sec) => { waitedTimeLogged += sec; },
    getConflicts: () => activeConflicts
  });

  // ML recommends REROUTE for Cross2, but temporal assessment allows brief WAIT
  window.robotDecisionState['R_Cross2'] = { decision: 'REROUTE', confidence: 0.9, timestamp: Date.now() };

  ctrl.moveRobotToNextWaypoint('R_Cross2', 1);

  // Verification 2: Reroute suppressed in favor of WAIT
  const state2 = window.robotMovementDecisionState['R_Cross2'];
  assert(state2.mlDecision === 'REROUTE', 'Crossing ML recommendation preserved as REROUTE');
  assert(state2.finalDecision === 'WAIT', 'Crossing adaptive intervention selected WAIT');
  assert(state2.waiting === true, 'Robot entered waiting state');
  assert(env.tweens['R_Cross2'] === null, 'No movement tween launched while waiting');

  // Simulate Cross1 clearing the intersection after 0.5s
  activeConflicts = []; // conflict cleared
  const timer = env.timerEvents[env.timerEvents.length - 1];
  assert(timer !== undefined, 'Wait timer scheduled');

  // Advance time by 500ms
  const realNow = Date.now;
  Date.now = () => realNow() + 500;
  try {
    timer.trigger();
  } finally {
    Date.now = realNow;
  }

  // Robot resumes moving through intersection on its direct route
  assert(window.robotMovementDecisionState['R_Cross2'].waiting === false, 'Robot resumed from wait');
  assert(env.tweens['R_Cross2'] !== null, 'Movement tween launched upon conflict clear');
  assert(waitedTimeLogged > 0, `Waiting time logged accurately: ${waitedTimeLogged}s`);
  assert(robots['R_Cross2'].path.length === 5, 'Path length remains exact original direct distance (0 px detour)');
}

// ── SCENARIO 3: HEAD-ON NARROW CORRIDOR ───────────────────────────────────────
console.log('\n--- Scenario 3: Head-On Narrow Corridor ---');
{
  const robots = {
    'R_East': {
      id: 'R_East',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 4 },
      destination: { tileX: 8, tileY: 4 },
      path: [{ tileX: 2, tileY: 4 }, { tileX: 3, tileY: 4 }, { tileX: 4, tileY: 4 }, { tileX: 5, tileY: 4 }, { tileX: 6, tileY: 4 }, { tileX: 7, tileY: 4 }, { tileX: 8, tileY: 4 }]
    },
    'R_West': {
      id: 'R_West',
      speed: 100,
      status: 'moving',
      start: { tileX: 8, tileY: 4 },
      destination: { tileX: 2, tileY: 4 },
      path: [{ tileX: 8, tileY: 4 }, { tileX: 7, tileY: 4 }, { tileX: 6, tileY: 4 }, { tileX: 5, tileY: 4 }, { tileX: 4, tileY: 4 }, { tileX: 3, tileY: 4 }, { tileX: 2, tileY: 4 }]
    }
  };
  const env = createMockEnvironment(robots);

  env.sprites['R_East'] = { x: 2 * 32 + 16, y: 4 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };
  env.sprites['R_West'] = { x: 8 * 32 + 16, y: 4 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  let aStarCallCount = 0;
  let rerouteVisualizationTriggered = false;

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'HEAD_ON',
      robotA: 'R_East',
      robotB: 'R_West',
      tileX: 5,
      tileY: 4,
      temporalAssessment: {
        timingResolutionPossible: false,
        requiresReroute: true,
        reason: 'Opposing traversal in single corridor'
      }
    }],
    findPath: (sx, sy, tx, ty) => {
      aStarCallCount++;
      // Return alternate route detouring around corridor via Y=2
      return [{ tileX: sx, tileY: sy }, { tileX: 2, tileY: 2 }, { tileX: 8, tileY: 2 }, { tileX: tx, tileY: ty }];
    },
    updatePathVisualization: () => { rerouteVisualizationTriggered = true; }
  });

  // Test 3a: Even if ML naively recommended SLOW or WAIT, system escalates to REROUTE
  window.robotDecisionState['R_East'] = { decision: 'SLOW', confidence: 0.9, timestamp: Date.now() };

  ctrl.moveRobotToNextWaypoint('R_East', 1);

  const state3 = window.robotMovementDecisionState['R_East'];
  assert(state3.mlDecision === 'SLOW', 'ML decision recorded as SLOW');
  assert(state3.finalDecision === 'REROUTE', 'Adaptive layer escalated to REROUTE because timing resolution is impossible');
  assert(state3.decision === 'REROUTE', 'Applied decision is REROUTE');
  assert(aStarCallCount >= 1, 'A* pathfinder executed to calculate detour route');
  assert(robots['R_East'].path.some(wp => wp.tileY === 2), 'Robot assigned alternate route via aisle Y=2');
  assert(!robots['R_East'].path.some(wp => wp.tileX === 5 && wp.tileY === 4), 'Conflict tile (5,4) is safely avoided');
  assert(rerouteVisualizationTriggered === true, 'Path visualization updated');

  // Test 3b: Anti-oscillation - subsequent waypoint does NOT re-trigger rerouting
  const currentCount = aStarCallCount;
  ctrl.moveRobotToNextWaypoint('R_East', 2);
  assert(aStarCallCount === currentCount, 'Rerouting did NOT re-trigger on subsequent step');
}

// ── SCENARIO 4: NO CONFLICT ──────────────────────────────────────────────────
console.log('\n--- Scenario 4: No Conflict (Nominal Operation) ---');
{
  const robots = {
    'R_Clear': {
      id: 'R_Clear',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      destination: { tileX: 4, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }, { tileX: 4, tileY: 1 }]
    }
  };
  const env = createMockEnvironment(robots);
  env.sprites['R_Clear'] = { x: 1 * 32 + 16, y: 1 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [] // No conflicts in fleet
  });

  // ML model outputs false-positive REROUTE recommendation
  window.robotDecisionState['R_Clear'] = { decision: 'REROUTE', confidence: 0.95, timestamp: Date.now() };

  ctrl.moveRobotToNextWaypoint('R_Clear', 1);

  const state4 = window.robotMovementDecisionState['R_Clear'];
  assert(state4.mlDecision === 'REROUTE', 'Original ML false-positive preserved as REROUTE');
  assert(state4.finalDecision === 'MOVE', 'Adaptive layer suppressed unnecessary REROUTE to MOVE');
  assert(state4.decision === 'MOVE', 'Applied decision is MOVE');
  assert(state4.effectiveSpeed === 100, 'Effective speed is nominal 100 px/s');
  assert(state4.waiting === false, 'Robot is not waiting');
  assert(env.tweens['R_Clear'] !== null, 'Movement tween launched normally');
  assert(state4.decisionReason.includes('No active conflict affecting upcoming trajectory'), 'Reason cites absence of upcoming conflict');
}

// ── SCENARIO 5: REROUTE FALLBACK ─────────────────────────────────────────────
console.log('\n--- Scenario 5: Reroute Fallback (No Alternate Path) ---');
{
  const robots = {
    'R_Blocked': {
      id: 'R_Blocked',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 3 },
      destination: { tileX: 5, tileY: 3 },
      path: [{ tileX: 2, tileY: 3 }, { tileX: 3, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 5, tileY: 3 }]
    }
  };
  const env = createMockEnvironment(robots);
  env.sprites['R_Blocked'] = { x: 2 * 32 + 16, y: 3 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'HEAD_ON',
      robotA: 'R_Blocked',
      robotB: 'R_Other',
      tileX: 3,
      tileY: 3,
      temporalAssessment: {
        timingResolutionPossible: false,
        requiresReroute: true
      }
    }],
    findPath: () => null // All alternate paths blocked
  });

  window.robotDecisionState['R_Blocked'] = { decision: 'REROUTE', confidence: 0.9, timestamp: Date.now() };

  ctrl.moveRobotToNextWaypoint('R_Blocked', 1);

  const state5 = window.robotMovementDecisionState['R_Blocked'];
  assert(state5.decision === 'WAIT', 'When alternate path is unavailable, safely falls back to WAIT');
  assert(state5.waiting === true, 'Robot entered safe waiting state rather than colliding');
  assert(env.tweens['R_Blocked'] === null, 'Movement halted at safe position');
}

// ── SCENARIO 6: ANTI-OSCILLATION VALIDATION ──────────────────────────────────
console.log('\n--- Scenario 6: Anti-Oscillation Check ---');
{
  const robots = {
    'R_Osc': {
      id: 'R_Osc',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      destination: { tileX: 6, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }, { tileX: 4, tileY: 1 }, { tileX: 5, tileY: 1 }, { tileX: 6, tileY: 1 }]
    }
  };
  const env = createMockEnvironment(robots);
  env.sprites['R_Osc'] = { x: 1 * 32 + 16, y: 1 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

  let rerouteCount = 0;
  const history = [];

  const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'SAME_DIRECTION',
      robotA: 'R_Osc',
      robotB: 'R_Other2',
      tileX: 3,
      tileY: 1,
      temporalAssessment: {
        timingResolutionPossible: true,
        requiresReroute: false,
        estimatedDelaySec: 0.5,
        conflictType: 'SAME_DIRECTION'
      }
    }],
    findPath: () => {
      rerouteCount++;
      return null;
    }
  });

  // Rapid sequence of ML decisions across waypoints: REROUTE, REROUTE, SLOW, MOVE
  const decisions = ['REROUTE', 'REROUTE', 'SLOW', 'MOVE'];
  for (let i = 0; i < decisions.length; i++) {
    window.robotDecisionState['R_Osc'] = { decision: decisions[i], confidence: 0.9, timestamp: Date.now() + i * 100 };
    ctrl.moveRobotToNextWaypoint('R_Osc', 1);
    const applied = window.robotMovementDecisionState['R_Osc'].decision;
    history.push(applied);
  }

  // Because temporal separation is possible, REROUTE is cleanly converted to SLOW without oscillation
  assert(rerouteCount === 0, 'No oscillatory reroutes triggered');
  assert(!history.includes('REROUTE'), 'REROUTE action never leaked into applied actions');
  assert(history[0] === 'SLOW' && history[1] === 'SLOW', 'Stable consecutive SLOW interventions');
}

// ── SCENARIO 7: DECISION TRACE VERIFICATION ──────────────────────────────────
console.log('\n--- Scenario 7: Decision Trace Verification ---');
{
  const intervention1 = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict: { type: 'vertex', conflictType: 'SAME_DIRECTION' },
    temporalAssessment: { timingResolutionPossible: true, estimatedDelaySec: 0.5, conflictType: 'SAME_DIRECTION' }
  });

  assert(intervention1.mlDecision === 'REROUTE', 'Trace 1: mlDecision is REROUTE');
  assert(intervention1.finalDecision === 'SLOW', 'Trace 1: finalDecision is SLOW');
  assert(intervention1.decisionReason.includes('unnecessary reroute suppressed'), 'Trace 1: decisionReason is informative');

  const intervention2 = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: { type: 'vertex', conflictType: 'HEAD_ON' },
    temporalAssessment: { timingResolutionPossible: false, conflictType: 'HEAD_ON' }
  });

  assert(intervention2.mlDecision === 'WAIT', 'Trace 2: mlDecision is WAIT');
  assert(intervention2.finalDecision === 'REROUTE', 'Trace 2: finalDecision is REROUTE');
  assert(intervention2.decisionReason.includes('escalating WAIT to REROUTE'), 'Trace 2: decisionReason is informative');
}

// ── SCENARIO 8: REAL METRIC COMPARISON (BASELINE vs OPTIMIZED) ───────────────
console.log('\n--- Scenario 8: Metric Validation (BASELINE vs OPTIMIZED) ---');
{
  // Simulation: Two robots in a shared corridor with a potential conflict
  // Robot-A: starts (1, 3), destination (6, 3) (distance = 5 tiles = 160 px)
  // Robot-B: starts (3, 3), destination (7, 3)
  // We compare the real metrics tracked through createRunMetrics and finaliseMetrics

  function runSim(mode) {
    const metrics = createRunMetrics();
    metrics.totalRobots = 2;

    const robots = {
      'R_A': {
        id: 'R_A',
        speed: 100,
        status: 'moving',
        start: { tileX: 1, tileY: 3 },
        destination: { tileX: 6, tileY: 3 },
        path: [{ tileX: 1, tileY: 3 }, { tileX: 2, tileY: 3 }, { tileX: 3, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 5, tileY: 3 }, { tileX: 6, tileY: 3 }]
      },
      'R_B': {
        id: 'R_B',
        speed: 100,
        status: 'moving',
        start: { tileX: 3, tileY: 3 },
        destination: { tileX: 7, tileY: 3 },
        path: [{ tileX: 3, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 5, tileY: 3 }, { tileX: 6, tileY: 3 }, { tileX: 7, tileY: 3 }]
      }
    };
    const env = createMockEnvironment(robots);

    env.sprites['R_A'] = { x: 1 * 32 + 16, y: 3 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };
    env.sprites['R_B'] = { x: 3 * 32 + 16, y: 3 * 32 + 16, setPosition: function(x,y){this.x=x;this.y=y;} };

    const session = {
      sessionId: `run_${mode}`,
      scenarioId: 'scen_corridor',
      mode,
      startedAt: new Date(1000).toISOString(),
      completedAt: null,
      metrics
    };

    const ctrl = createMovementController(env.scene, env.map, robots, env.sprites, env.tweens, {
      updateStatusUI: () => {},
      detectFleetConflicts: () => {
        metrics.conflicts++;
      },
      getRunMode: () => mode,
      onSegmentTravelled: (rId, distPx) => {
        metrics.totalDistancePx = parseFloat((metrics.totalDistancePx + distPx).toFixed(2));
      },
      onWaitTime: (rId, sec) => {
        metrics.totalWaitingTimeSec = parseFloat((metrics.totalWaitingTimeSec + sec).toFixed(3));
      },
      onRobotCompleted: (rId) => {
        robots[rId].status = 'completed';
        robots[rId].completedAt = new Date(3500).toISOString();
      },
      getConflicts: () => [{
        type: 'vertex',
        conflictType: 'SAME_DIRECTION',
        robotA: 'R_B',
        robotB: 'R_A',
        tileX: 4,
        tileY: 3,
        temporalAssessment: {
          timingResolutionPossible: true,
          requiresReroute: false,
          estimatedDelaySec: 0.5,
          conflictType: 'SAME_DIRECTION'
        }
      }]
    });

    if (mode === 'OPTIMIZED') {
      window.robotDecisionState['R_A'] = { decision: 'REROUTE', confidence: 0.9, timestamp: 1100 };
    } else {
      window.robotDecisionState['R_A'] = { decision: 'MOVE', confidence: 0.5, timestamp: 1100 };
    }

    // Move R_A along each waypoint to completion
    for (let wp = 1; wp < robots['R_A'].path.length; wp++) {
      ctrl.moveRobotToNextWaypoint('R_A', wp);
      if (env.tweens['R_A']) {
        env.tweens['R_A'].complete();
      }
    }

    // Move R_B along each waypoint to completion
    for (let wp = 1; wp < robots['R_B'].path.length; wp++) {
      ctrl.moveRobotToNextWaypoint('R_B', wp);
      if (env.tweens['R_B']) {
        env.tweens['R_B'].complete();
      }
    }

    session.completedAt = new Date(4000).toISOString();
    finaliseMetrics(metrics, session, robots);

    return { session, metrics, robots };
  }

  const baselineRun = runSim('BASELINE');
  const optimizedRun = runSim('OPTIMIZED');

  console.log('BASELINE METRICS:');
  console.log('  Completion rate:     ', `${baselineRun.metrics.completionRate}%`);
  console.log('  Total distance:      ', `${baselineRun.metrics.totalDistancePx} px`);
  console.log('  Total run time:      ', `${baselineRun.metrics.totalRunTimeSec} s`);
  console.log('  Total waiting time:  ', `${baselineRun.metrics.totalWaitingTimeSec} s`);
  console.log('  Conflicts detected:  ', baselineRun.metrics.conflicts);

  console.log('\nOPTIMIZED METRICS (with Adaptive Intervention):');
  console.log('  Completion rate:     ', `${optimizedRun.metrics.completionRate}%`);
  console.log('  Total distance:      ', `${optimizedRun.metrics.totalDistancePx} px`);
  console.log('  Total run time:      ', `${optimizedRun.metrics.totalRunTimeSec} s`);
  console.log('  Total waiting time:  ', `${optimizedRun.metrics.totalWaitingTimeSec} s`);
  console.log('  Conflicts detected:  ', optimizedRun.metrics.conflicts);

  const comparison = compareRunMetrics(baselineRun.session, optimizedRun.session);
  console.log('\nCOMPARISON:');
  console.log('  Distance improvement:    ', `${comparison.distanceImprovementPct}%`);
  console.log('  Time improvement:        ', `${comparison.completionTimeImprovementPct}%`);
  console.log('  Conflict reduction:      ', `${comparison.conflictReductionPct}%`);

  // Assertions on real metrics
  assert(baselineRun.metrics.completionRate === 100, 'Baseline achieves 100% completion');
  assert(optimizedRun.metrics.completionRate === 100, 'Optimized achieves 100% completion');
  assert(optimizedRun.metrics.totalDistancePx === baselineRun.metrics.totalDistancePx, 'Optimized avoided unnecessary reroute; distance equals baseline');
  assert(baselineRun.metrics.totalWaitingTimeSec === 0, 'Baseline waiting time is 0s (no waiting behavior in baseline)');
  assert(optimizedRun.metrics.totalDistancePx > 0, 'Real distance accumulated via physics tween segments');
}

console.log(`\nALL STEP 5 VALIDATION TESTS PASSED! Total assertions: ${passed}`);
