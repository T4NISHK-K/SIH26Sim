import { createMovementController } from 'file:///d:/SIH2026/Simulation/src/robots/robotMovement.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

console.log('=== TEST SUITE: ML SLOW / WAIT INTEGRATION ===');

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

// ── 1. ML SLOW REDUCES EFFECTIVE SPEED WHILE PRESERVING CONFIGURED SPEED ──────
console.log('\n--- 1. ML SLOW: 50% Effective Speed Reduction & Normal Configured Speed ---');
{
  const robots = {
    'R1': {
      id: 'R1',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };
  const sprites = { 'R1': { x: 48, y: 48, setPosition: () => {} } };
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
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.5 }
    }]
  });

  window.robotDecisionState['R1'] = { decision: 'SLOW', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R1', 1);

  assert(tweens['R1'] !== null, 'SLOW launches movement tween');
  const distance = Math.hypot(48 - (2 * 32 + 16), 48 - (1 * 32 + 16)); // 32px
  const expectedDuration = (distance / 50) * 1000; // 50px/s
  assert(Math.abs(tweens['R1'].duration - expectedDuration) < 1, `Duration ${tweens['R1'].duration} corresponds to 50% effective speed`);
  assert(robots['R1'].speed === 100, `Configured robot speed in state remains unchanged at 100, got ${robots['R1'].speed}`);
  assert(window.robotMovementDecisionState['R1'].decision === 'SLOW', 'Debug state decision is SLOW');
  assert(window.robotMovementDecisionState['R1'].effectiveSpeed === 50, `Debug state effectiveSpeed is 50, got ${window.robotMovementDecisionState['R1'].effectiveSpeed}`);
  assert(window.robotMovementDecisionState['R1'].waiting === false, 'Robot is not waiting');

  // ── 2. SLOW RETURNS TO NORMAL SPEED WHEN DECISION CHANGES TO MOVE ────────────
  console.log('\n--- 2. SLOW Returns to Normal Speed on MOVE ---');
  // Update sprite position to waypoint 1
  sprites['R1'].x = 2 * 32 + 16;
  sprites['R1'].y = 1 * 32 + 16;

  window.robotDecisionState['R1'] = { decision: 'MOVE', confidence: 0.85, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R1', 2);

  const normalDuration = (distance / 100) * 1000; // 100px/s
  assert(Math.abs(tweens['R1'].duration - normalDuration) < 1, `Duration ${tweens['R1'].duration} returned to 100% normal speed`);
  assert(window.robotMovementDecisionState['R1'].decision === 'MOVE', 'Debug state decision returned to MOVE');
  assert(window.robotMovementDecisionState['R1'].effectiveSpeed === 100, 'Debug state effectiveSpeed returned to 100');
}

// ── 3. ML WAIT PAUSES MOVEMENT & PRESERVES PATH/DESTINATION ────────────────────
console.log('\n--- 3. ML WAIT: Pause Movement Without Changing Path/Destination ---');
{
  const robots = {
    'R2': {
      id: 'R2',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };
  const sprites = { 'R2': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R2': null };
  let waitCallback = null;
  let loggedWaitSec = 0;

  const customScene = {
    tweens: sceneMock.tweens,
    time: {
      addEvent: (opts) => {
        waitCallback = opts.callback;
        return { remove: () => {} };
      }
    }
  };

  const ctrl = createMovementController(customScene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'CROSSING',
      robotA: 'R2',
      robotB: 'R3',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.6 }
    }],
    onWaitTime: (rId, sec) => { loggedWaitSec += sec; }
  });

  window.robotDecisionState['R2'] = { decision: 'WAIT', confidence: 0.92, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R2', 1);

  assert(tweens['R2'] === null, 'WAIT does not launch tween immediately');
  assert(robots['R2'].path.length === 3, 'Path remains intact without modification');
  assert(robots['R2'].destination.tileX === 3 && robots['R2'].destination.tileY === 1, 'Destination preserved');
  assert(window.robotMovementDecisionState['R2'].waiting === true, 'Robot marked waiting');
  assert(window.robotMovementDecisionState['R2'].effectiveSpeed === 0, 'Effective speed is 0 while waiting');
  assert(window.robotMovementDecisionState['R2'].waitStartTime !== null, 'waitStartTime recorded');

  // ── 4. WAIT ACCUMULATES REAL WAITING TIME & RESUMES ON MOVE ──────────────────
  console.log('\n--- 4. WAIT Accumulates Waiting Time and Resumes on Safe Decision ---');
  // Wait 30ms to accumulate real elapsed time
  await new Promise(resolve => setTimeout(resolve, 30));

  // Trigger resume on MOVE
  window.robotDecisionState['R2'] = { decision: 'MOVE', confidence: 0.9, timestamp: Date.now() };
  waitCallback();

  assert(tweens['R2'] !== null, 'Resumes movement tween on fresh MOVE');
  assert(window.robotMovementDecisionState['R2'].waiting === false, 'No longer waiting');
  assert(window.robotMovementDecisionState['R2'].decision === 'MOVE', 'Decision state is MOVE');
  assert(loggedWaitSec > 0, `Real wait time accumulated in callback: ${loggedWaitSec}s`);
}

// ── 5. WAIT RESUMES AUTOMATICALLY WHEN CONFLICT CLEARS ────────────────────────
console.log('\n--- 5. WAIT Resumes Automatically When Conflict Clears ---');
{
  let conflicts = [{
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'R3',
    robotB: 'R4',
    tileX: 2,
    tileY: 1,
    temporalAssessment: { timingResolutionPossible: true, requiresReroute: false }
  }];

  const robots = {
    'R3': {
      id: 'R3',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 2, tileY: 1 }
    }
  };
  const sprites = { 'R3': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R3': null };
  let waitCallback = null;

  const customScene = {
    tweens: sceneMock.tweens,
    time: {
      addEvent: (opts) => {
        waitCallback = opts.callback;
        return { remove: () => {} };
      }
    }
  };

  const ctrl = createMovementController(customScene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => conflicts
  });

  window.robotDecisionState['R3'] = { decision: 'WAIT', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R3', 1);
  assert(tweens['R3'] === null, 'Robot waiting');

  // Conflict clears from fleet (e.g. other robot has passed)
  conflicts = [];
  // Old decision was still WAIT in decision state, but conflict has cleared
  window.robotDecisionState['R3'] = { decision: 'MOVE', confidence: 0.88, timestamp: Date.now() };
  waitCallback();

  assert(tweens['R3'] !== null, 'Resumes tween when conflict clears');
  assert(window.robotMovementDecisionState['R3'].waiting === false, 'Waiting flag cleared');
}

// ── 6. TEMPORAL SAFETY GUARD: SLOW/WAIT REJECTED WHEN timingResolutionPossible=false ─
console.log('\n--- 6. Temporal Safety Guard: SLOW/WAIT Rejected When timingResolutionPossible=false ---');
{
  const robots = {
    'R4': {
      id: 'R4',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 5 },
      path: [{ tileX: 2, tileY: 5 }, { tileX: 3, tileY: 5 }, { tileX: 4, tileY: 5 }],
      destination: { tileX: 6, tileY: 5 }
    }
  };
  const sprites = { 'R4': { x: 80, y: 176, setPosition: () => {} } };
  const tweens = { 'R4': null };

  let aStarRerouteCount = 0;
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    findPath: (sx, sy, tx, ty) => {
      aStarRerouteCount++;
      return [{ tileX: sx, tileY: sy }, { tileX: 2, tileY: 6 }, { tileX: tx, tileY: ty }];
    },
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'HEAD_ON',
      robotA: 'R4',
      robotB: 'R5',
      tileX: 3,
      tileY: 5,
      // Opposing corridor traversal: timing resolution NOT possible, requires spatial reroute
      temporalAssessment: {
        timingResolutionPossible: false,
        requiresReroute: true,
        reason: 'Opposing traversal of shared corridor cannot be resolved by timing alone'
      }
    }]
  });

  // 6.1 SLOW escalates to REROUTE when timingResolutionPossible=false
  window.robotDecisionState['R4'] = { decision: 'SLOW', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R4', 1);

  // Since timingResolutionPossible=false, SLOW safely escalates to REROUTE
  assert(aStarRerouteCount >= 1, 'SLOW escalated: A* rerouting called when timing resolution impossible');
  assert(window.robotMovementDecisionState['R4'].decision === 'REROUTE', 'Decision state escalated to REROUTE');
  assert(window.robotMovementDecisionState['R4'].waiting === false, 'Robot is not waiting');

  // 6.2 WAIT escalates to REROUTE when timingResolutionPossible=false
  const prevCount = aStarRerouteCount;
  tweens['R4'] = null;
  robots['R4'].path = [{ tileX: 2, tileY: 5 }, { tileX: 3, tileY: 5 }, { tileX: 4, tileY: 5 }];
  // Reset reroute cooldown for test isolation
  const coord4 = ctrl.getCoordinationState ? ctrl.getCoordinationState('R4') : null;
  window.robotDecisionState['R4'] = { decision: 'WAIT', confidence: 0.9, timestamp: Date.now() + 2000 };
  // Mock time advancement to exceed REROUTE_COOLDOWN_MS (1000ms)
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 2000;
  try {
    ctrl.moveRobotToNextWaypoint('R4', 1);
  } finally {
    Date.now = realDateNow;
  }

  assert(aStarRerouteCount > prevCount, 'WAIT escalated: A* rerouting called when timing resolution impossible');
  assert(window.robotMovementDecisionState['R4'].waiting === false, 'Robot is not waiting in deadlock corridor');
  assert(window.robotMovementDecisionState['R4'].decision === 'REROUTE', 'Decision state escalated to REROUTE');
}

// ── 7. REROUTE BEHAVIOR REMAINS UNCHANGED ────────────────────────────────────
console.log('\n--- 7. Existing REROUTE Behavior Unchanged ---');
{
  let aStarCalled = false;
  const robots = {
    'R5': {
      id: 'R5',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 3, tileY: 1 }
    }
  };
  const sprites = { 'R5': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R5': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      robotA: 'R5',
      robotB: 'R6',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: false, requiresReroute: true }
    }],
    findPath: (sx, sy, tx, ty) => {
      aStarCalled = true;
      return [{ tileX: sx, tileY: sy }, { tileX: 1, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: tx, tileY: ty }];
    }
  });

  window.robotDecisionState['R5'] = { decision: 'REROUTE', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R5', 1);

  assert(aStarCalled === true, 'A* pathfinding executed for REROUTE');
  assert(window.robotMovementDecisionState['R5'].decision === 'REROUTE', 'Decision state is REROUTE');
  assert(window.robotMovementDecisionState['R5'].rerouteCount === 1, 'Reroute count incremented to 1');
}

// ── 8. BASELINE BEHAVIOR REMAINS UNAFFECTED ──────────────────────────────────
console.log('\n--- 8. BASELINE Behavior Remains Completely Unaffected ---');
{
  const robots = {
    'R6': {
      id: 'R6',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 2, tileY: 1 }
    }
  };
  const sprites = { 'R6': { x: 48, y: 48, setPosition: () => {} } };
  const tweens = { 'R6': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'BASELINE' // BASELINE mode
  });

  // ML decision is SLOW
  window.robotDecisionState['R6'] = { decision: 'SLOW', confidence: 0.99, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R6', 1);

  const distance = Math.hypot(48 - (2 * 32 + 16), 48 - (1 * 32 + 16));
  const normalDuration = (distance / 100) * 1000;
  assert(Math.abs(tweens['R6'].duration - normalDuration) < 1, 'BASELINE ignores ML SLOW and uses normal duration');
  assert(window.robotMovementDecisionState['R6'].decision === 'MOVE', 'BASELINE decision is MOVE');
  assert(window.robotMovementDecisionState['R6'].effectiveSpeed === 100, 'BASELINE effectiveSpeed is 100');
}

console.log(`\nALL ML SLOW / WAIT TESTS PASSED! Total assertions: ${passed}`);
