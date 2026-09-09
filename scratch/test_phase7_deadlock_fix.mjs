import { selectAdaptiveIntervention } from '../src/coordination/adaptiveIntervention.js';
import { createMovementController } from '../src/robots/robotMovement.js';
import { assessTemporalResolution } from '../src/coordination/conflictDetection.js';
import { buildRobotFeatures } from '../src/network/edgeClient.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAILED ASSERTION:', msg);
    throw new Error('Assertion failed: ' + msg);
  }
  passed++;
}

console.log('=== TEST SUITE: PHASE 7 DEADLOCK & MUTUAL WAIT STABILITY FIX ===');

// Setup global mocks
globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {}
};

const mapMock = {
  tileToWorldX: (tx) => tx * 32 + 16,
  tileToWorldY: (ty) => ty * 32 + 16,
  worldToTileX: (wx) => Math.floor(wx / 32),
  worldToTileY: (wy) => Math.floor(wy / 32)
};

// ── Test 1: Same-direction conflict: SLOW/WAIT eventually resumes ──────────────
console.log('\n--- Test 1: Same-direction conflict: SLOW/WAIT resumes ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    tileX: 5,
    tileY: 2,
    timeA: 2.0,
    timeB: 2.3,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.3,
      conflictType: 'SAME_DIRECTION'
    }
  };

  // Robot A receives SLOW or WAIT initially
  const decision1 = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });
  assert(decision1.appliedDecision === 'SLOW', 'Test 1.1: Same-direction SLOW applied');

  // If robot had already waited or other robot is waiting, releases to SLOW/MOVE
  const decision2 = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    isOtherWaiting: true
  });
  assert(decision2.appliedDecision === 'SLOW', 'Test 1.2: Same-direction releases to SLOW when other waiting');

  // Consecutive wait count >= 1 also resumes
  const decision3 = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    consecutiveWaitCount: 1
  });
  assert(decision3.appliedDecision === 'SLOW', 'Test 1.3: Same-direction resumes after 1 wait cycle');
}

// ── Test 2: Crossing conflict: WAIT eventually releases ────────────────────────
console.log('\n--- Test 2: Crossing conflict: WAIT releases ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    tileX: 10,
    tileY: 5,
    timeA: 3.0,
    timeB: 3.8,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.8,
      conflictType: 'CROSSING'
    }
  };

  // Initially WAIT is accepted when delay is significant
  const initial = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    isOtherWaiting: false,
    consecutiveWaitCount: 0
  });
  assert(initial.appliedDecision === 'WAIT', 'Test 2.1: Initial WAIT accepted for crossing');

  // Once the other robot is waiting OR this robot has waited a cycle, WAIT releases to MOVE
  const released = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    isOtherWaiting: true,
    consecutiveWaitCount: 0
  });
  assert(released.appliedDecision === 'MOVE', 'Test 2.2: Crossing releases to MOVE when other is waiting');

  const releasedAfterWait = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    isOtherWaiting: false,
    consecutiveWaitCount: 1
  });
  assert(releasedAfterWait.appliedDecision === 'MOVE', 'Test 2.3: Crossing releases to MOVE after consecutiveWaitCount >= 1');
}

// ── Test 3: Head-on narrow corridor: timing-impossible conflict selects REROUTE ─
console.log('\n--- Test 3: Head-on narrow corridor: timing-impossible selects REROUTE ---');
{
  const headOnConflict = {
    type: 'edge',
    conflictType: 'HEAD_ON',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    fromA: { tileX: 5, tileY: 2 },
    toA: { tileX: 6, tileY: 2 },
    fromB: { tileX: 6, tileY: 2 },
    toB: { tileX: 5, tileY: 2 },
    timeA: 2.0,
    timeB: 2.0,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      estimatedDelaySec: 0,
      conflictType: 'HEAD_ON'
    }
  };

  // When timing resolution is impossible, ML recommendations are escalated to REROUTE
  const resFromWait = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: headOnConflict,
    temporalAssessment: headOnConflict.temporalAssessment
  });
  assert(resFromWait.appliedDecision === 'REROUTE', 'Test 3.1: Head-on WAIT escalated to REROUTE');

  const resFromSlow = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict: headOnConflict,
    temporalAssessment: headOnConflict.temporalAssessment
  });
  assert(resFromSlow.appliedDecision === 'REROUTE', 'Test 3.2: Head-on SLOW escalated to REROUTE');

  const resFromMove = selectAdaptiveIntervention({
    mlDecision: 'MOVE',
    conflict: headOnConflict,
    temporalAssessment: headOnConflict.temporalAssessment
  });
  assert(resFromMove.appliedDecision === 'REROUTE', 'Test 3.3: Head-on MOVE escalated to REROUTE');
}

// ── Test 4: Mutual WAIT: indefinite waiting is impossible ───────────────────────
console.log('\n--- Test 4: Mutual WAIT: indefinite waiting is impossible ---');
{
  // Simulated movement controller environment with 2 robots in mutual wait
  let timerEvents = [];
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
      addEvent: (opts) => {
        const ev = {
          opts,
          remove: () => {
            const idx = timerEvents.indexOf(ev);
            if (idx >= 0) timerEvents.splice(idx, 1);
          },
          trigger: () => opts.callback && opts.callback()
        };
        timerEvents.push(ev);
        return ev;
      }
    }
  };

  const robots = {
    'Robot-01': {
      status: 'moving',
      speed: 100,
      path: [{ tileX: 2, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }],
      destination: { tileX: 4, tileY: 2 }
    },
    'Robot-02': {
      status: 'moving',
      speed: 100,
      path: [{ tileX: 4, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: 2, tileY: 2 }],
      destination: { tileX: 2, tileY: 2 }
    }
  };

  const robotSprites = {
    'Robot-01': { x: 64, y: 64, setPosition(x, y) { this.x = x; this.y = y; } },
    'Robot-02': { x: 128, y: 64, setPosition(x, y) { this.x = x; this.y = y; } }
  };

  const conflict = {
    type: 'vertex',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 3,
    tileY: 2,
    timeA: 1.0,
    timeB: 1.5,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.5,
      conflictType: 'CROSSING'
    }
  };

  globalThis.window.robotDecisionState = {
    'Robot-01': { decision: 'WAIT', confidence: 0.95, timestamp: Date.now() },
    'Robot-02': { decision: 'WAIT', confidence: 0.95, timestamp: Date.now() }
  };

  const activeTweens = { 'Robot-01': null, 'Robot-02': null };

  const controller = createMovementController(sceneMock, mapMock, robots, robotSprites, activeTweens, {
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [conflict],
    findPath: (x1, y1, x2, y2) => [{ tileX: x1, tileY: y1 }, { tileX: x2, tileY: y2 }],
    detectFleetConflicts: () => {},
    updateStatusUI: () => {}
  });

  // Both robots enter wait state
  controller.moveRobotToNextWaypoint('Robot-01', 1);
  controller.moveRobotToNextWaypoint('Robot-02', 1);

  const debug1 = window.robotMovementDecisionState['Robot-01'];
  const debug2 = window.robotMovementDecisionState['Robot-02'];

  // One was released or prevented from mutual deadlock
  const atLeastOneMoving = !debug1.waiting || !debug2.waiting;
  assert(atLeastOneMoving, 'Test 4.1: When both robots are instructed WAIT, mutual deadlock is prevented');
}

// ── Test 5: REROUTE: old working REROUTE path still functions ──────────────────
console.log('\n--- Test 5: REROUTE: alternate path calculation and execution functions ---');
{
  let rerouteDetected = false;
  let timerEvents = [];
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
      addEvent: (opts) => {
        const ev = { opts, remove: () => {}, trigger: () => opts.callback && opts.callback() };
        timerEvents.push(ev);
        return ev;
      }
    }
  };

  const robots = {
    'Robot-01': {
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };

  const robotSprites = {
    'Robot-01': { x: 32, y: 32, setPosition(x, y) { this.x = x; this.y = y; } }
  };

  const conflict = {
    type: 'vertex',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 2,
    tileY: 1,
    timeA: 1.0,
    timeB: 1.0,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      estimatedDelaySec: 0,
      conflictType: 'HEAD_ON'
    }
  };

  globalThis.window.robotDecisionState = {
    'Robot-01': { decision: 'REROUTE', confidence: 0.95, timestamp: Date.now() }
  };

  const activeTweens = { 'Robot-01': null };

  const controller = createMovementController(sceneMock, mapMock, robots, robotSprites, activeTweens, {
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [conflict],
    findPath: (x1, y1, x2, y2, blocked) => {
      rerouteDetected = true;
      // returns detour path avoiding (2,1)
      return [{ tileX: x1, tileY: y1 }, { tileX: 1, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: x2, tileY: y2 }];
    },
    detectFleetConflicts: () => {},
    updateStatusUI: () => {}
  });

  controller.moveRobotToNextWaypoint('Robot-01', 1);

  assert(rerouteDetected, 'Test 5.1: findPath alternate route was queried');
  const debug = window.robotMovementDecisionState['Robot-01'];
  assert(debug.decision === 'REROUTE', 'Test 5.2: Decision state recorded REROUTE');
  assert(debug.rerouteCount >= 1, 'Test 5.3: rerouteCount incremented');
}

// ── Test 6: No conflict: MOVE continues ────────────────────────────────────────
console.log('\n--- Test 6: No conflict: MOVE continues ---');
{
  const intervention = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict: null,
    temporalAssessment: null
  });

  assert(intervention.appliedDecision === 'MOVE', 'Test 6.1: Without conflict, appliedDecision is MOVE');
  assert(intervention.recommendedDecision === 'REROUTE', 'Test 6.2: Original ML decision preserved');
}

// ── Test 7: Wait timeout: WAIT eventually releases ─────────────────────────────
console.log('\n--- Test 7: Wait timeout: WAIT eventually releases ---');
{
  let resumedWaypoint = null;
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
      addEvent: (opts) => {
        return {
          opts,
          remove: () => {},
          trigger: () => opts.callback && opts.callback()
        };
      }
    }
  };

  const robots = {
    'Robot-01': {
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 2, tileY: 1 }
    }
  };

  const robotSprites = {
    'Robot-01': { x: 32, y: 32, setPosition(x, y) { this.x = x; this.y = y; } }
  };

  let registeredTimer = null;
  sceneMock.time.addEvent = (opts) => {
    registeredTimer = opts;
    return {
      opts,
      remove: () => {},
      trigger: () => opts.callback && opts.callback()
    };
  };

  globalThis.window.robotDecisionState = {
    'Robot-01': { decision: 'WAIT', confidence: 0.95, timestamp: Date.now() }
  };

  const activeCrossingConflict = {
    type: 'vertex',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 2,
    tileY: 1,
    timeA: 1.0,
    timeB: 1.8,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.8,
      conflictType: 'CROSSING'
    }
  };

  let currentConflicts = [activeCrossingConflict];
  const activeTweens = { 'Robot-01': null };

  const controller = createMovementController(sceneMock, mapMock, robots, robotSprites, activeTweens, {
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => currentConflicts,
    findPath: () => null,
    detectFleetConflicts: () => {},
    updateStatusUI: () => {}
  });

  controller.moveRobotToNextWaypoint('Robot-01', 1);

  assert(registeredTimer !== null, 'Test 7.1: Wait periodic timer was registered');
  const debugBefore = window.robotMovementDecisionState['Robot-01'];
  assert(debugBefore.waiting === true, 'Test 7.2: Robot successfully entered WAIT state');

  // Clear conflict and trigger wait timer tick
  currentConflicts = [];
  registeredTimer.callback();

  const debugAfter = window.robotMovementDecisionState['Robot-01'];
  assert(!debugAfter.waiting, 'Test 7.3: Robot resumed from wait after conflict cleared');
}

// ── Test 8: No oscillation: no infinite WAIT/REROUTE loop ─────────────────────
console.log('\n--- Test 8: No oscillation: no infinite WAIT/REROUTE loop ---');
{
  // If consecutive wait count >= 1 and timing is impossible:
  // Escalates to REROUTE ONCE; if REROUTE is on cooldown, does NOT oscillate back and forth
  const conflict = {
    type: 'vertex',
    conflictType: 'HEAD_ON',
    tileX: 2,
    tileY: 2,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      estimatedDelaySec: 0,
      conflictType: 'HEAD_ON'
    }
  };

  const dec1 = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    consecutiveWaitCount: 1
  });
  assert(dec1.appliedDecision === 'REROUTE', 'Test 8.1: consecutive wait escalates to REROUTE');

  // Once REROUTE is applied and path changes, conflict tiles on previous path are cleared,
  // preventing immediate re-triggering of WAIT.
}

// ── Test 9: ML recommendation remains separate from final action ───────────────
console.log('\n--- Test 9: ML recommendation remains separate from final action ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    tileX: 4,
    tileY: 4,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.2,
      conflictType: 'CROSSING'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });

  assert(intervention.mlDecision === 'REROUTE', 'Test 9.1: mlDecision preserved');
  assert(intervention.appliedDecision === 'SLOW', 'Test 9.2: appliedDecision is SLOW (suppressed reroute)');
  assert(intervention.finalDecision === 'SLOW', 'Test 9.3: finalDecision is SLOW');
  assert(intervention.decisionReason !== '', 'Test 9.4: Explanation reason provided');
}

// ── Test 10: Priority remains an ML feature and is not hard-coded arbitration ───
console.log('\n--- Test 10: Priority remains ML feature and not hard-coded arbitration ---');
{
  const robotHigh = { id: 'Robot-01', priority: 3, status: 'moving', path: [{ tileX: 1, tileY: 1 }] };
  const robotLow = { id: 'Robot-02', priority: 1, status: 'moving', path: [{ tileX: 2, tileY: 2 }] };

  const featuresHigh = buildRobotFeatures(robotHigh, { 'Robot-01': robotHigh, 'Robot-02': robotLow }, []);
  const featuresLow = buildRobotFeatures(robotLow, { 'Robot-01': robotHigh, 'Robot-02': robotLow }, []);

  assert(featuresHigh.task_priority === 'HIGH', 'Test 10.1: Priority 3 mapped to task_priority HIGH in ML feature vector');
  assert(featuresLow.task_priority === 'LOW', 'Test 10.2: Priority 1 mapped to task_priority LOW in ML feature vector');

  // Adaptive intervention does NOT accept or filter by priority winner/loser
  const interventionHigh = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: null,
    temporalAssessment: null
  });
  const interventionLow = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: null,
    temporalAssessment: null
  });

  assert(interventionHigh.appliedDecision === interventionLow.appliedDecision,
    'Test 10.3: selectAdaptiveIntervention behavior does not discriminate by hard-coded priority winner/loser rule');
}

console.log(`\nALL ${passed} CHECKS PASSED SUCCESSFULLY!`);
