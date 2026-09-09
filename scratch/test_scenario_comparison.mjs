import { createMovementController } from 'file:///d:/SIH2026/Simulation/src/robots/robotMovement.js';
import { buildRobotFeatures } from 'file:///d:/SIH2026/Simulation/src/network/edgeClient.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

// Scene & Map mock
const sceneMock = {
  tweens: {
    add: (opts) => ({
      targets: opts.targets,
      duration: opts.duration,
      stop: () => {},
      complete: () => opts.onComplete()
    })
  },
  time: {
    addEvent: (opts) => ({
      remove: () => {},
      trigger: () => opts.callback()
    })
  }
};

const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32
};

// Simulation scenario setup:
// Two robots moving toward each other on corridor Y=5:
// Robot-01 moving East: starts at (2, 5), destination (10, 5)
// Robot-02 moving West: starts at (10, 5), destination (2, 5)
// Vertex conflict at (6, 5)

console.log('--- TEST: BASELINE in conflict-heavy scenario ---');
{
  globalThis.window = {
    robotDecisionState: {
      'Robot-01': { decision: 'REROUTE', confidence: 0.85, timestamp: Date.now() },
      'Robot-02': { decision: 'WAIT', confidence: 0.80, timestamp: Date.now() }
    },
    robotMovementDecisionState: {}
  };

  const robots = {
    'Robot-01': {
      id: 'Robot-01',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 5 },
      destination: { tileX: 10, tileY: 5 },
      path: [{ tileX: 2, tileY: 5 }, { tileX: 3, tileY: 5 }, { tileX: 4, tileY: 5 }, { tileX: 5, tileY: 5 }, { tileX: 6, tileY: 5 }]
    }
  };
  const sprites = { 'Robot-01': { x: 64, y: 160, setPosition: () => {} } };
  const tweens = { 'Robot-01': null };

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'BASELINE' // BASELINE mode
  });

  ctrl.moveRobotToNextWaypoint('Robot-01', 1);

  // BASELINE must ignore REROUTE and continue on current path with decision MOVE
  assert(window.robotMovementDecisionState['Robot-01'].decision === 'MOVE', 'BASELINE ignores ML REROUTE and uses MOVE');
  assert(robots['Robot-01'].path.length === 5, 'BASELINE path remains unmodified');
  assert(tweens['Robot-01'] !== null, 'BASELINE launches tween normally');
}

console.log('--- TEST: OPTIMIZED in conflict-heavy scenario ---');
{
  globalThis.window = {
    robotDecisionState: {
      'Robot-01': { decision: 'REROUTE', confidence: 0.85, timestamp: Date.now() },
      'Robot-02': { decision: 'MOVE', confidence: 0.72, timestamp: Date.now() }
    },
    robotMovementDecisionState: {}
  };

  const robots = {
    'Robot-01': {
      id: 'Robot-01',
      speed: 100,
      status: 'moving',
      start: { tileX: 2, tileY: 5 },
      destination: { tileX: 10, tileY: 5 },
      path: [{ tileX: 2, tileY: 5 }, { tileX: 3, tileY: 5 }, { tileX: 4, tileY: 5 }, { tileX: 5, tileY: 5 }, { tileX: 6, tileY: 5 }]
    },
    'Robot-02': {
      id: 'Robot-02',
      speed: 100,
      status: 'moving',
      start: { tileX: 10, tileY: 5 },
      destination: { tileX: 2, tileY: 5 },
      path: [{ tileX: 10, tileY: 5 }, { tileX: 9, tileY: 5 }, { tileX: 8, tileY: 5 }, { tileX: 7, tileY: 5 }, { tileX: 6, tileY: 5 }]
    }
  };
  const sprites = {
    'Robot-01': { x: 64, y: 160, setPosition: () => {} },
    'Robot-02': { x: 320, y: 160, setPosition: () => {} }
  };
  const tweens = { 'Robot-01': null, 'Robot-02': null };

  let rerouteVisualizationTriggered = false;

  const ctrl = createMovementController(sceneMock, mapMock, robots, sprites, tweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => {},
    getRunMode: () => 'OPTIMIZED', // OPTIMIZED mode
    getConflicts: () => [
      { type: 'vertex', robotA: 'Robot-01', robotB: 'Robot-02', tileX: 6, tileY: 5 }
    ],
    findPath: (sx, sy, tx, ty) => {
      // Parallel aisle at Y=3 bypasses conflict at (6, 5)
      if (sx === 2 && sy === 5 && tx === 2 && ty === 3) {
        return [{ tileX: 2, tileY: 5 }, { tileX: 2, tileY: 3 }];
      }
      if (sx === 2 && sy === 3 && tx === 10 && ty === 5) {
        return [{ tileX: 2, tileY: 3 }, { tileX: 6, tileY: 3 }, { tileX: 10, tileY: 3 }, { tileX: 10, tileY: 5 }];
      }
      return null;
    },
    updatePathVisualization: () => { rerouteVisualizationTriggered = true; }
  });

  // Verify feature generation indicates conflict
  const features = buildRobotFeatures(robots['Robot-01'], robots, [
    { type: 'vertex', robotA: 'Robot-01', robotB: 'Robot-02', tileX: 6, tileY: 5 }
  ]);
  assert(features.obstacle_detected === 1, 'Feature obstacle_detected is 1');
  assert(features.path_blocked === 1, 'Feature path_blocked is 1');
  assert(features.collision_risk >= 0.80, 'Feature collision_risk is high (>=0.80)');

  // Execute movement step for Robot-01
  ctrl.moveRobotToNextWaypoint('Robot-01', 1);

  assert(window.robotMovementDecisionState['Robot-01'].decision === 'REROUTE', 'OPTIMIZED receives and applies REROUTE');
  assert(window.robotMovementDecisionState['Robot-01'].rerouteCount === 1, 'Reroute count incremented to 1');
  assert(robots['Robot-01'].path.some(n => n.tileY === 3), 'Alternate path safely detours along aisle Y=3');
  assert(!robots['Robot-01'].path.some(n => n.tileX === 6 && n.tileY === 5), 'Alternate path completely avoids conflict at (6, 5)');
  assert(rerouteVisualizationTriggered === true, 'Path visualization updated with new route');
}

console.log(`ALL INTEGRATION CHECKS PASSED! Total assertions: ${passed}`);
