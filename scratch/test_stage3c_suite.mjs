import { createMovementController } from '../src/robots/robotMovement.js';
import { buildRobotFeatures, predictRobot } from '../src/network/edgeClient.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log('====================================================');
console.log('STAGE 3C: V2 DECISION TO MOVEMENT INTEGRATION TEST');
console.log('====================================================\n');

// Mock Phaser environment
globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {},
  edgeConnected: false
};

const createMockScene = () => ({
  tweens: {
    add: (opts) => {
      const tweenObj = {
        targets: opts.targets,
        duration: opts.duration,
        isCompleted: false,
        stop: () => {},
        complete: () => {
          tweenObj.isCompleted = true;
          if (opts.onComplete) opts.onComplete();
        }
      };
      return tweenObj;
    }
  },
  time: {
    addEvent: (opts) => {
      const timerObj = {
        delay: opts.delay,
        remove: () => {},
        trigger: () => opts.callback && opts.callback()
      };
      return timerObj;
    }
  }
});

const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32,
  worldToTileX: (wx) => Math.floor(wx / 32),
  worldToTileY: (wy) => Math.floor(wy / 32)
};

// ----------------------------------------------------
// TEST 1 — MOVE Decision Execution
// ----------------------------------------------------
console.log('--- TEST 1: MOVE Decision Execution ---');
{
  const scene = createMockScene();
  const robots = {
    'R-MOVE': {
      id: 'R-MOVE',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-MOVE': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-MOVE': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED'
  });

  window.robotDecisionState['R-MOVE'] = { decision: 'MOVE', confidence: 0.95, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-MOVE', 1);

  assert(tweens['R-MOVE'] !== null, 'MOVE decision starts a movement tween');
  const targetX = 2 * 32 + 16;
  const targetY = 1 * 32 + 16;
  const dist = Math.hypot(32 - targetX, 32 - targetY);
  const normalDuration = (dist / 100) * 1000;
  assert(Math.abs(tweens['R-MOVE'].duration - normalDuration) < 1, `Normal speed duration executed (${tweens['R-MOVE'].duration}ms)`);
  assert(window.robotMovementDecisionState['R-MOVE'].decision === 'MOVE', 'Movement decision state is MOVE');
  assert(window.robotMovementDecisionState['R-MOVE'].effectiveSpeed === 100, 'Effective speed is 100% normal speed');
}

// ----------------------------------------------------
// TEST 2 — SLOW Decision Execution
// ----------------------------------------------------
console.log('\n--- TEST 2: SLOW Decision Execution ---');
{
  const scene = createMockScene();
  const robots = {
    'R-SLOW': {
      id: 'R-SLOW',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-SLOW': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-SLOW': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'SAME_DIRECTION',
      robotA: 'R-SLOW',
      robotB: 'R-OTHER',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.5 }
    }]
  });

  window.robotDecisionState['R-SLOW'] = { decision: 'SLOW', confidence: 0.88, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-SLOW', 1);

  assert(tweens['R-SLOW'] !== null, 'SLOW decision starts a movement tween');
  const targetX = 2 * 32 + 16;
  const targetY = 1 * 32 + 16;
  const dist = Math.hypot(32 - targetX, 32 - targetY);
  const expectedSlowDuration = (dist / 50) * 1000; // 50px/s
  assert(Math.abs(tweens['R-SLOW'].duration - expectedSlowDuration) < 1, `Reduced speed duration executed (${tweens['R-SLOW'].duration}ms vs expected ${expectedSlowDuration}ms)`);
  assert(robots['R-SLOW'].speed === 100, 'Configured robot speed in UI state remains unchanged at 100');
  assert(window.robotMovementDecisionState['R-SLOW'].effectiveSpeed === 50, 'Effective speed reduced to 50%');
  assert(window.robotMovementDecisionState['R-SLOW'].decision === 'SLOW', 'Movement decision state is SLOW');
}

// ----------------------------------------------------
// TEST 3 — WAIT Decision Execution
// ----------------------------------------------------
console.log('\n--- TEST 3: WAIT Decision Execution ---');
{
  const scene = createMockScene();
  const robots = {
    'R-WAIT': {
      id: 'R-WAIT',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-WAIT': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-WAIT': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'CROSSING',
      robotA: 'R-WAIT',
      robotB: 'R-OTHER',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.5 }
    }]
  });

  window.robotDecisionState['R-WAIT'] = { decision: 'WAIT', confidence: 0.92, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-WAIT', 1);

  assert(tweens['R-WAIT'] === null, 'WAIT decision halts robot, NO tween launched');
  assert(window.robotMovementDecisionState['R-WAIT'].waiting === true, 'Robot is marked waiting: true');
  assert(window.robotMovementDecisionState['R-WAIT'].effectiveSpeed === 0, 'Effective speed is 0');
  assert(robots['R-WAIT'].path.length === 2, 'Waypoint path preserved during wait');
}

// ----------------------------------------------------
// TEST 4 — REROUTE Decision Execution
// ----------------------------------------------------
console.log('\n--- TEST 4: REROUTE Decision Execution ---');
{
  const scene = createMockScene();
  let aStarCalled = false;
  const robots = {
    'R-REROUTE': {
      id: 'R-REROUTE',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }, { tileX: 3, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-REROUTE': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-REROUTE': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED',
    getConflicts: () => [{
      type: 'vertex',
      conflictType: 'HEAD_ON',
      robotA: 'R-REROUTE',
      robotB: 'R-OTHER',
      tileX: 2,
      tileY: 1,
      temporalAssessment: { timingResolutionPossible: false, requiresReroute: true }
    }],
    findPath: (sx, sy, tx, ty) => {
      aStarCalled = true;
      // Return alternate route bypassing tile (2, 1)
      return [
        { tileX: 1, tileY: 1 },
        { tileX: 1, tileY: 2 },
        { tileX: 3, tileY: 2 },
        { tileX: 5, tileY: 1 }
      ];
    }
  });

  window.robotDecisionState['R-REROUTE'] = { decision: 'REROUTE', confidence: 0.85, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-REROUTE', 1);

  assert(aStarCalled === true, 'A* findPath called during REROUTE');
  assert(robots['R-REROUTE'].path.length === 4, 'Robot path replaced with alternate route');
  assert(robots['R-REROUTE'].path[1].tileY === 2, 'Robot path detours around obstacle');
  assert(window.robotMovementDecisionState['R-REROUTE'].rerouteCount === 1, 'Reroute count incremented to 1');
  assert(window.robotMovementDecisionState['R-REROUTE'].decision === 'REROUTE', 'Decision state is REROUTE');
}

// ----------------------------------------------------
// TEST 5 — BASELINE Mode Independence
// ----------------------------------------------------
console.log('\n--- TEST 5: BASELINE Mode Independence ---');
{
  const scene = createMockScene();
  const robots = {
    'R-BASE': {
      id: 'R-BASE',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-BASE': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-BASE': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'BASELINE' // BASELINE mode
  });

  // Put a WAIT decision in robotDecisionState
  window.robotDecisionState['R-BASE'] = { decision: 'WAIT', confidence: 0.99, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-BASE', 1);

  assert(tweens['R-BASE'] !== null, 'BASELINE ignores ML WAIT and launches normal tween');
  assert(window.robotMovementDecisionState['R-BASE'].decision === 'MOVE', 'BASELINE decision remains MOVE');
  assert(window.robotMovementDecisionState['R-BASE'].waiting === false, 'Robot is not waiting');
}

// ----------------------------------------------------
// TEST 7 — PREDICTOR FAILURE Safe Fallback
// ----------------------------------------------------
console.log('\n--- TEST 7: Predictor Failure Safe Fallback ---');
{
  const scene = createMockScene();
  const robots = {
    'R-FAIL': {
      id: 'R-FAIL',
      speed: 100,
      status: 'moving',
      start: { tileX: 1, tileY: 1 },
      path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }],
      destination: { tileX: 5, tileY: 1 }
    }
  };
  const sprites = { 'R-FAIL': { x: 32, y: 32, setPosition: () => {} } };
  const tweens = { 'R-FAIL': null };

  const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED'
  });

  // Case 7a: Missing decision
  window.robotDecisionState['R-FAIL'] = null;
  ctrl.moveRobotToNextWaypoint('R-FAIL', 1);
  assert(tweens['R-FAIL'] !== null, 'Missing ML decision falls back safely to MOVE');
  assert(window.robotMovementDecisionState['R-FAIL'].decision === 'MOVE', 'Decision state is MOVE');

  // Case 7b: Invalid / corrupted decision string
  tweens['R-FAIL'] = null;
  window.robotDecisionState['R-FAIL'] = { decision: 'INVALID_CMD_XYZ', confidence: 0.99, timestamp: Date.now() };
  ctrl.moveRobotToNextWaypoint('R-FAIL', 1);
  assert(tweens['R-FAIL'] !== null, 'Invalid ML decision string falls back safely to MOVE');
  assert(window.robotMovementDecisionState['R-FAIL'].decision === 'MOVE', 'Decision state is MOVE');

  // Case 7c: Stale decision (>3000ms old)
  tweens['R-FAIL'] = null;
  window.robotDecisionState['R-FAIL'] = { decision: 'WAIT', confidence: 0.99, timestamp: Date.now() - 5000 };
  ctrl.moveRobotToNextWaypoint('R-FAIL', 1);
  assert(tweens['R-FAIL'] !== null, 'Stale decision (>3000ms) falls back safely to MOVE');
  assert(window.robotMovementDecisionState['R-FAIL'].decision === 'MOVE', 'Decision state is MOVE');
}

// ----------------------------------------------------
// TEST 6: V2 OPTIMIZED Full Runtime Chain
// ----------------------------------------------------
console.log('\n--- TEST 6: V2 OPTIMIZED Full Runtime Chain (End-to-End HTTP + Movement) ---');
const serverProc = spawn('node', ['server/index.js'], { cwd: rootDir, stdio: 'inherit' });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runEndToEndChain() {
  await sleep(1500);

  try {
    const testRobot = {
      id: 'Robot-Live',
      x: 816,
      y: 496,
      destination: { tileX: 45, tileY: 35 },
      speed: 100,
      battery: 90,
      task: 'DELIVER'
    };

    // 1. Build V2 features
    const features = buildRobotFeatures(testRobot, { 'Robot-Live': testRobot }, [], null);
    assert(Object.keys(features).length === 26, 'buildRobotFeatures produces exact 26 V2 features');

    // 2. Predict via edge client HTTP
    const predResult = await predictRobot('Robot-Live', features);
    assert(predResult !== null, 'predictRobot returns non-null result');
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predResult.decision), `Predict returns valid action (${predResult.decision})`);
    assert(window.robotDecisionState['Robot-Live'] !== undefined, 'window.robotDecisionState updated by edgeClient');

    // 3. Drive robotMovement.js with this live prediction
    const scene = createMockScene();
    const liveRobots = {
      'Robot-Live': {
        ...testRobot,
        status: 'moving',
        start: { tileX: 25, tileY: 15 },
        path: [{ tileX: 25, tileY: 15 }, { tileX: 26, tileY: 15 }]
      }
    };
    const liveSprites = { 'Robot-Live': { x: 816, y: 496, setPosition: () => {} } };
    const liveTweens = { 'Robot-Live': null };

    const ctrl = createMovementController(scene, mapMock, liveRobots, liveSprites, liveTweens, {
      updateStatusUI: () => {},
      detectFleetConflicts: () => {},
      getRunMode: () => 'OPTIMIZED'
    });

    ctrl.moveRobotToNextWaypoint('Robot-Live', 1);

    const executedDecision = window.robotMovementDecisionState['Robot-Live'].decision;
    assert(executedDecision === predResult.decision, `Movement executed live V2 decision (expected ${predResult.decision}, got ${executedDecision})`);

    console.log(`Live V2 decision "${predResult.decision}" (conf: ${predResult.confidence}) successfully drove movement controller!`);
  } catch (err) {
    console.error('End-to-End Chain Exception:', err);
    failures++;
  } finally {
    serverProc.kill();
    console.log('\n====================================================');
    console.log(`STAGE 3C TESTS COMPLETED with ${failures} failure(s)`);
    console.log('====================================================');
    process.exit(failures > 0 ? 1 : 0);
  }
}

runEndToEndChain();
