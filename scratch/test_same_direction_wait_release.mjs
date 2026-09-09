import { selectAdaptiveIntervention } from '../src/coordination/adaptiveIntervention.js';
import { createConflictDetector } from '../src/coordination/conflictDetection.js';
import { createMovementController } from '../src/robots/robotMovement.js';
import { buildRobotFeatures } from '../src/network/edgeClient.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAILED ASSERTION:', msg);
    throw new Error('Assertion failed: ' + msg);
  }
  passed++;
}

console.log('=== TEST SUITE: SAME-DIRECTION WAIT RELEASE & COMPLETED ROBOTS ===');

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

const sceneMockFactory = () => {
  const events = [];
  return {
    add: {
      graphics: () => ({
        setDepth: () => {},
        clear: () => {},
        lineStyle: () => {},
        fillStyle: () => {},
        strokeCircle: () => {},
        fillCircle: () => {},
        lineBetween: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        strokePath: () => {}
      })
    },
    tweens: {
      add: (opts) => {
        const tween = {
          targets: opts.targets,
          duration: opts.duration,
          stop: () => {},
          complete: () => {
            if (opts.onComplete) opts.onComplete();
          }
        };
        return tween;
      }
    },
    time: {
      addEvent: (opts) => {
        const ev = {
          opts,
          remove: () => {
            const idx = events.indexOf(ev);
            if (idx >= 0) events.splice(idx, 1);
          },
          trigger: () => opts.callback && opts.callback()
        };
        events.push(ev);
        return ev;
      }
    }
  };
};

// ── Case A: Active same-direction conflict: WAIT/SLOW can still occur ──────────
console.log('\n--- Case A: Active same-direction conflict allows WAIT / SLOW ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    tileX: 4,
    tileY: 2,
    timeA: 2.0,
    timeB: 2.4,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.4,
      conflictType: 'SAME_DIRECTION'
    }
  };

  const resSlow = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict,
    temporalAssessment: conflict.temporalAssessment
  });
  assert(resSlow.appliedDecision === 'SLOW', 'Case A.1: SLOW applied for same-direction');

  // When delay is larger, WAIT is permitted
  const resWait = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: {
      ...conflict,
      temporalAssessment: { ...conflict.temporalAssessment, estimatedDelaySec: 0.8 }
    }
  });
  assert(resWait.appliedDecision === 'WAIT', 'Case A.2: WAIT applied when ML recommends and delay is larger');
}

// ── Case B: Leading robot completes: no longer causes active conflict ──────────
console.log('\n--- Case B: Leading robot completes: excluded from active conflicts ---');
{
  const scene = sceneMockFactory();
  const robots = {
    'Robot-01': {
      id: 'Robot-01',
      status: 'completed', // Already completed
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    },
    'Robot-02': {
      id: 'Robot-02',
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };

  const detector = createConflictDetector(scene, mapMock, robots, {
    updateConflictPanel: () => {}
  });

  const conflicts = detector.detectFleetConflicts();
  assert(conflicts.length === 0, `Case B.1: Completed robot produces 0 fleet conflicts, got ${conflicts.length}`);
  assert(robots['Robot-01'].timePath === null, 'Case B.2: Completed robot timePath is null');
}

// ── Case C: Waiting follower: resumes after leading robot completes ─────────────
console.log('\n--- Case C: Waiting follower resumes when leading robot completes ---');
{
  const scene = sceneMockFactory();
  const robots = {
    'Robot-01': {
      id: 'Robot-01',
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 },
      x: 32, y: 32,
      start: { tileX: 1, tileY: 1, x: 32, y: 32 }
    },
    'Robot-02': {
      id: 'Robot-02',
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 },
      x: 32, y: 32,
      start: { tileX: 1, tileY: 1, x: 32, y: 32 }
    }
  };

  const robotSprites = {
    'Robot-01': { x: 32, y: 32, setPosition(x, y) { this.x = x; this.y = y; } },
    'Robot-02': { x: 32, y: 32, setPosition(x, y) { this.x = x; this.y = y; } }
  };

  const detector = createConflictDetector(scene, mapMock, robots, {
    updateConflictPanel: () => {}
  });

  const activeTweens = { 'Robot-01': null, 'Robot-02': null };

  const controller = createMovementController(scene, mapMock, robots, robotSprites, activeTweens, {
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => detector.getConflicts(),
    findPath: () => null,
    detectFleetConflicts: () => detector.detectFleetConflicts(),
    updateStatusUI: () => {}
  });

  // Initially detect conflicts between moving robots
  detector.detectFleetConflicts();
  assert(detector.getConflicts().length > 0, 'Case C.1: Active conflicts detected while both are moving');

  // Robot-02 enters WAIT because Robot-01 is ahead
  globalThis.window.robotDecisionState = {
    'Robot-02': { decision: 'WAIT', confidence: 0.95, timestamp: Date.now() }
  };

  controller.moveRobotToNextWaypoint('Robot-02', 1);
  const debugWaiting = window.robotMovementDecisionState['Robot-02'];
  assert(debugWaiting.waiting === true, 'Case C.2: Robot-02 entered WAIT state');

  // Robot-01 now completes movement
  controller.finishRobotMovement('Robot-01');
  assert(robots['Robot-01'].status === 'completed', 'Case C.3: Robot-01 status is completed');
  assert(detector.getConflicts().length === 0, 'Case C.4: Conflicts automatically cleared after Robot-01 completed');

  // Verify Robot-02 immediately resumed from wait
  const debugResumed = window.robotMovementDecisionState['Robot-02'];
  assert(debugResumed.waiting === false, 'Case C.5: Robot-02 resumed from WAIT after Robot-01 completed');
}

// ── Case D: Waiting follower eventually reaches destination ────────────────────
console.log('\n--- Case D: Waiting follower continues and finishes route ---');
{
  const scene = sceneMockFactory();
  let stepCount = 0;
  const robots = {
    'Robot-02': {
      id: 'Robot-02',
      status: 'moving',
      speed: 100,
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1, x: 96, y: 32 },
      x: 32, y: 32,
      start: { tileX: 1, tileY: 1, x: 32, y: 32 }
    }
  };

  const robotSprites = {
    'Robot-02': { x: 32, y: 32, setPosition(x, y) { this.x = x; this.y = y; } }
  };

  const activeTweens = { 'Robot-02': null };

  let completedRobotId = null;
  const controller = createMovementController(scene, mapMock, robots, robotSprites, activeTweens, {
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [],
    findPath: () => null,
    detectFleetConflicts: () => [],
    updateStatusUI: () => {},
    onRobotCompleted: (id) => { completedRobotId = id; }
  });

  globalThis.window.robotDecisionState = {
    'Robot-02': { decision: 'MOVE', confidence: 0.95, timestamp: Date.now() }
  };

  // Move from wp 1
  controller.moveRobotToNextWaypoint('Robot-02', 1);
  if (activeTweens['Robot-02']) activeTweens['Robot-02'].complete();

  // Move from wp 2
  if (activeTweens['Robot-02']) activeTweens['Robot-02'].complete();

  assert(robots['Robot-02'].status === 'completed', 'Case D.1: Follower successfully completes all waypoints');
  assert(completedRobotId === 'Robot-02', 'Case D.2: onRobotCompleted fired for follower');
}

// ── Case E: Completed robot does not generate new future conflicts ─────────────
console.log('\n--- Case E: Completed robot does not generate new future conflicts ---');
{
  const robotCompleted = { id: 'Robot-01', status: 'completed', path: [{ tileX: 5, tileY: 5 }] };
  const robotActive = { id: 'Robot-02', status: 'moving', path: [{ tileX: 5, tileY: 5 }] };

  const features = buildRobotFeatures(robotActive, { 'Robot-01': robotCompleted, 'Robot-02': robotActive }, [
    // Stale conflict object if any remained
    { robotA: 'Robot-01', robotB: 'Robot-02', timeA: 1.0, timeB: 1.0 }
  ]);

  assert(features.obstacle_detected === 0, 'Case E.1: obstacle_detected is 0 because other robot is completed');
  assert(features.collision_risk <= 0.05, 'Case E.2: collision_risk is minimal for completed peer');
}

// ── Case F: Existing HEAD-ON REROUTE behavior remains intact ───────────────────
console.log('\n--- Case F: HEAD-ON REROUTE behavior remains intact ---');
{
  const headOnConflict = {
    type: 'edge',
    conflictType: 'HEAD_ON',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    fromA: { tileX: 2, tileY: 2 },
    toA: { tileX: 3, tileY: 2 },
    fromB: { tileX: 3, tileY: 2 },
    toB: { tileX: 2, tileY: 2 },
    timeA: 2.0,
    timeB: 2.0,
    temporalAssessment: {
      timingResolutionPossible: false,
      requiresReroute: true,
      estimatedDelaySec: 0,
      conflictType: 'HEAD_ON'
    }
  };

  const intervention = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: headOnConflict,
    temporalAssessment: headOnConflict.temporalAssessment
  });

  assert(intervention.appliedDecision === 'REROUTE', 'Case F.1: Head-on WAIT still escalates to REROUTE');
  assert(intervention.rerouteRequired === true, 'Case F.2: rerouteRequired is true');
}

// ── Case G: Existing mutual-WAIT / deadlock protection remains intact ──────────
console.log('\n--- Case G: Mutual-WAIT deadlock protection intact ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    tileX: 4,
    tileY: 4,
    temporalAssessment: {
      timingResolutionPossible: true,
      requiresReroute: false,
      estimatedDelaySec: 0.5,
      conflictType: 'CROSSING'
    }
  };

  const res = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    isOtherWaiting: true
  });

  assert(res.appliedDecision === 'MOVE', 'Case G.1: When other robot is waiting, yields to MOVE to break deadlock');
}

console.log(`\nALL ${passed} CHECKS PASSED SUCCESSFULLY!`);
