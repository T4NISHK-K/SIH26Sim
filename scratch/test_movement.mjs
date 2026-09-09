import { createMovementController } from 'file:///d:/SIH2026/Simulation/src/robots/robotMovement.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {}
};

const sceneMock = {
  tweens: {
    add: (opts) => {
      return {
        targets: opts.targets,
        duration: opts.duration,
        stop: () => {},
        complete: () => opts.onComplete()
      };
    }
  },
  time: {
    addEvent: (opts) => {
      return {
        remove: () => {},
        trigger: () => opts.callback()
      };
    }
  }
};

const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32
};

// Test 1: BASELINE ignores ML
{
  let mode = 'BASELINE';
  const robots = {
    'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }] }
  };
  const sprites = { 'R1': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R1': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode
  });

  window.robotDecisionState['R1'] = { decision: 'WAIT', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R1', 1);
  assert(tweens['R1'] !== null, 'BASELINE ignores ML WAIT and launches tween');
  assert(window.robotMovementDecisionState['R1'].decision === 'MOVE', 'BASELINE decision is MOVE');
}

// Test 2: OPTIMIZED with SLOW reduces speed by 50%
{
  let mode = 'OPTIMIZED';
  const robots = {
    'R2': { id: 'R2', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }] }
  };
  const sprites = { 'R2': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R2': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode,
    getConflicts: () => [{
      type: 'vertex',
      robotA: 'R2',
      robotB: 'R99',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.5 }
    }]
  });

  window.robotDecisionState['R2'] = { decision: 'SLOW', confidence: 0.9, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R2', 1);
  assert(tweens['R2'] !== null, 'SLOW launches tween');
  const normalDuration = (Math.hypot(32 - (2 * 32 + 16), 32 - (1 * 32 + 16)) / 100) * 1000;
  const expectedSlowDuration = (Math.hypot(32 - (2 * 32 + 16), 32 - (1 * 32 + 16)) / 50) * 1000;
  assert(Math.abs(tweens['R2'].duration - expectedSlowDuration) < 1, 'SLOW duration corresponds to 50% speed');
  assert(robots['R2'].speed === 100, 'Robot configured speed in state is not modified');
  assert(window.robotMovementDecisionState['R2'].decision === 'SLOW', 'Decision state marked SLOW');
}

// Test 3: Stale decision (>3000ms) treated as MOVE
{
  let mode = 'OPTIMIZED';
  const robots = {
    'R3': { id: 'R3', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }] }
  };
  const sprites = { 'R3': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R3': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode
  });

  window.robotDecisionState['R3'] = { decision: 'WAIT', confidence: 0.9, timestamp: Date.now() - 4000 };
  ctrl.moveRobotToNextWaypoint('R3', 1);
  assert(tweens['R3'] !== null, 'Stale decision ignored and tween started');
  assert(window.robotMovementDecisionState['R3'].decision === 'MOVE', 'Stale decision falls back to MOVE');
}

// Test 4: WAIT pauses robot and resumes on MOVE
{
  let mode = 'OPTIMIZED';
  let waitedSecLogged = 0;
  const robots = {
    'R4': { id: 'R4', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }] }
  };
  const sprites = { 'R4': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R4': null };
  let timerCb = null;
  const customScene = {
    tweens: sceneMock.tweens,
    time: {
      addEvent: (opts) => {
        timerCb = opts.callback;
        return { remove: () => {} };
      }
    }
  };
  const ctrl = createMovementController(customScene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode,
    getConflicts: () => [{
      type: 'vertex',
      robotA: 'R4',
      robotB: 'R99',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.8 }
    }],
    onWaitTime: (rId, sec) => { waitedSecLogged = sec; }
  });

  window.robotDecisionState['R4'] = { decision: 'WAIT', confidence: 0.95, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R4', 1);
  assert(tweens['R4'] === null, 'WAIT does not launch tween immediately');
  assert(window.robotMovementDecisionState['R4'].waiting === true, 'Robot marked waiting');

  // Simulate MOVE decision arrived
  window.robotDecisionState['R4'] = { decision: 'MOVE', confidence: 0.9, timestamp: Date.now() };
  timerCb(); // trigger wait check
  assert(tweens['R4'] !== null, 'Resumes tween on fresh MOVE');
  assert(window.robotMovementDecisionState['R4'].waiting === false, 'Robot no longer waiting');
}

// Test 5: REROUTE uses A* to find alternative path and cooldown prevents duplicate
{
  let mode = 'OPTIMIZED';
  let aStarCalled = false;
  const robots = {
    'R5': {
      id: 'R5',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      destination: { tileX: 5, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }, { tileX: 4, tileY: 1 }, { tileX: 5, tileY: 1 }]
    }
  };
  const sprites = { 'R5': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R5': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode,
    getConflicts: () => [{ type: 'vertex', robotA: 'R5', robotB: 'R6', tileX: 2, tileY: 1 }],
    findPath: (sx, sy, tx, ty) => {
      aStarCalled = true;
      if (sx === 1 && sy === 2 && tx === 5 && ty === 1) {
        return [{ tileX: 1, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: 5, tileY: 1 }];
      }
      if (sx === 1 && sy === 1 && tx === 1 && ty === 2) {
        return [{ tileX: 1, tileY: 1 }, { tileX: 1, tileY: 2 }];
      }
      return null;
    }
  });

  const decTimestamp = Date.now();
  window.robotDecisionState['R5'] = { decision: 'REROUTE', confidence: 0.88, timestamp: decTimestamp };
  ctrl.moveRobotToNextWaypoint('R5', 1);
  assert(aStarCalled, 'A* called during reroute');
  assert(robots['R5'].path.length === 4, 'Alternate path applied to robot');
  assert(window.robotMovementDecisionState['R5'].rerouteCount === 1, 'Reroute count incremented');

  // Duplicate call with same timestamp triggers cooldown / duplicate guard -> moves normally without re-rerouting
  ctrl.moveRobotToNextWaypoint('R5', 1);
  assert(window.robotMovementDecisionState['R5'].rerouteCount === 1, 'Reroute count did not duplicate');
}

// Test 6: Failed REROUTE becomes WAIT
{
  let mode = 'OPTIMIZED';
  const robots = {
    'R6': {
      id: 'R6',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      destination: { tileX: 5, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }]
    }
  };
  const sprites = { 'R6': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R6': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode,
    getConflicts: () => [{ type: 'vertex', robotA: 'R6', robotB: 'R1', tileX: 2, tileY: 1 }],
    findPath: () => null // no alternate path exists
  });

  window.robotDecisionState['R6'] = { decision: 'REROUTE', confidence: 0.85, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R6', 1);
  assert(tweens['R6'] === null, 'Failed REROUTE did not launch tween');
  assert(window.robotMovementDecisionState['R6'].waiting === true, 'Failed REROUTE falls back to WAIT');
}

// Test 7: Low confidence decision (<0.60) treated as MOVE
{
  let mode = 'OPTIMIZED';
  const robots = {
    'R7': {
      id: 'R7',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }]
    }
  };
  const sprites = { 'R7': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R7': null };
  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => mode
  });

  // Low confidence decision (0.45 < 0.60)
  window.robotDecisionState['R7'] = { decision: 'WAIT', confidence: 0.45, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R7', 1);
  assert(tweens['R7'] !== null, 'Low confidence decision ignored and tween started');
  assert(window.robotMovementDecisionState['R7'].decision === 'MOVE', 'Low confidence falls back to MOVE');
}

console.log('ALL TESTS PASSED! Total assertions:', passed);

