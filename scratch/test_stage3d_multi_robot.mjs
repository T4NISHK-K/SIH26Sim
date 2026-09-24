/**
 * scratch/test_stage3d_multi_robot.mjs
 *
 * Stage 3D Validation Suite: Multi-Robot ARES V2 Runtime Integration
 * Tests 3-5 simultaneous robots across Scenarios A, B, C, D, E.
 */

import http from 'node:http';
import { buildRobotFeatures, predictRobot, V2_FEATURE_KEYS } from '../src/network/edgeClient.js';
import { createMovementController } from '../src/robots/robotMovement.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
    passed++;
  }
}

// Global browser window mock
globalThis.window = {
  robotDecisionState: {},
  robotMovementDecisionState: {},
  edgeDecisionStats: { totalPredictions: 0, move: 0, slow: 0, wait: 0, reroute: 0 }
};

// Mock map (32px tiles)
const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32,
  worldToTileX: (wx) => Math.floor(wx / 32),
  worldToTileY: (wy) => Math.floor(wy / 32)
};

function createMockScene() {
  const events = [];
  return {
    tweens: {
      add: (config) => {
        let isStopped = false;
        const tweenObj = {
          targets: config.targets,
          duration: config.duration,
          stop: () => { isStopped = true; },
          complete: () => {
            if (!isStopped) {
              if (config.onUpdate) config.onUpdate();
              if (config.onComplete) config.onComplete();
            }
          }
        };
        return tweenObj;
      }
    },
    time: {
      addEvent: (config) => {
        const event = {
          delay: config.delay,
          loop: config.loop,
          callback: config.callback,
          remove: () => {
            const idx = events.indexOf(event);
            if (idx !== -1) events.splice(idx, 1);
          }
        };
        events.push(event);
        return event;
      }
    }
  };
}

async function runAllTests() {
  console.log('====================================================');
  console.log('STAGE 3D: MULTI-ROBOT ARES V2 RUNTIME INTEGRATION TEST');
  console.log('====================================================');

  const BASE_URL = 'http://127.0.0.1:3001';

  // ----------------------------------------------------
  // TEST 1: SCENARIO A — 3 Robots Same-Direction (Following)
  // ----------------------------------------------------
  console.log('\n--- SCENARIO A: 3 Robots Same-Direction (Following) ---');
  {
    // R1 leads at x=20, R2 follows at x=17, R3 follows at x=14 along y=10
    const robots = {
      'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 20, tileY: 10 }, x: 20 * 32 + 16, y: 10 * 32 + 16, destination: { tileX: 40, tileY: 10 }, path: [{ tileX: 20, tileY: 10 }, { tileX: 25, tileY: 10 }] },
      'R2': { id: 'R2', speed: 100, status: 'moving', start: { tileX: 17, tileY: 10 }, x: 17 * 32 + 16, y: 10 * 32 + 16, destination: { tileX: 40, tileY: 10 }, path: [{ tileX: 17, tileY: 10 }, { tileX: 22, tileY: 10 }] },
      'R3': { id: 'R3', speed: 100, status: 'moving', start: { tileX: 14, tileY: 10 }, x: 14 * 32 + 16, y: 10 * 32 + 16, destination: { tileX: 40, tileY: 10 }, path: [{ tileX: 14, tileY: 10 }, { tileX: 19, tileY: 10 }] }
    };

    // 1. Build features for all 3 robots
    const featR1 = buildRobotFeatures(robots['R1'], robots, [], mapMock);
    const featR2 = buildRobotFeatures(robots['R2'], robots, [], mapMock);
    const featR3 = buildRobotFeatures(robots['R3'], robots, [], mapMock);

    assert(featR1.nearby_robot_count === 2, 'R1 sees 2 nearby robots within DIR');
    assert(featR2.nearby_robot_count === 2, 'R2 sees 2 nearby robots within DIR');
    assert(featR2.relative_direction === 'SAME', 'R2 detects leading robot in SAME direction');
    assert(featR2.nearest_robot_distance_m === 3.0, 'R2 measures 3.0m to R1');

    // 2. Request concurrent predictions for all 3 robots
    const [p1, p2, p3] = await Promise.all([
      predictRobot('R1', featR1, BASE_URL),
      predictRobot('R2', featR2, BASE_URL),
      predictRobot('R3', featR3, BASE_URL)
    ]);

    assert(p1 && p1.decision, `R1 prediction returned: ${p1?.decision}`);
    assert(p2 && p2.decision, `R2 prediction returned: ${p2?.decision}`);
    assert(p3 && p3.decision, `R3 prediction returned: ${p3?.decision}`);

    // Verify independent prediction state storage
    assert(window.robotDecisionState['R1'].decision === p1.decision, 'R1 stored under robotId R1');
    assert(window.robotDecisionState['R2'].decision === p2.decision, 'R2 stored under robotId R2');
    assert(window.robotDecisionState['R3'].decision === p3.decision, 'R3 stored under robotId R3');
    assert(window.robotDecisionState['R1'] !== window.robotDecisionState['R2'], 'R1 and R2 state are independent objects');
  }

  // ----------------------------------------------------
  // TEST 2: SCENARIO B — 3 Robots Head-On
  // ----------------------------------------------------
  console.log('\n--- SCENARIO B: 3 Robots Head-On ---');
  {
    // R1 heading East at x=20, R2 heading West at x=24 (closing in), R3 nearby at y=15
    const robots = {
      'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 20, tileY: 10 }, x: 20 * 32 + 16, y: 10 * 32 + 16, destination: { tileX: 35, tileY: 10 }, path: [{ tileX: 20, tileY: 10 }, { tileX: 21, tileY: 10 }, { tileX: 22, tileY: 10 }, { tileX: 25, tileY: 10 }] },
      'R2': { id: 'R2', speed: 100, status: 'moving', start: { tileX: 24, tileY: 10 }, x: 24 * 32 + 16, y: 10 * 32 + 16, destination: { tileX: 10, tileY: 10 }, path: [{ tileX: 24, tileY: 10 }, { tileX: 23, tileY: 10 }, { tileX: 22, tileY: 10 }, { tileX: 18, tileY: 10 }] },
      'R3': { id: 'R3', speed: 100, status: 'moving', start: { tileX: 22, tileY: 15 }, x: 22 * 32 + 16, y: 15 * 32 + 16, destination: { tileX: 22, tileY: 30 }, path: [{ tileX: 22, tileY: 15 }, { tileX: 22, tileY: 20 }] }
    };

    const conflicts = [{
      type: 'vertex',
      conflictType: 'HEAD_ON',
      robotA: 'R1',
      robotB: 'R2',
      tileX: 22,
      tileY: 10,
      temporalAssessment: { timingResolutionPossible: false, requiresReroute: true }
    }];

    const featR1 = buildRobotFeatures(robots['R1'], robots, conflicts, mapMock);
    const featR2 = buildRobotFeatures(robots['R2'], robots, conflicts, mapMock);

    assert(featR1.relative_direction === 'OPPOSITE', 'Head-on relative direction is OPPOSITE');
    assert(featR1.closing_velocity_mps > 1.5, `Closing velocity is high (${featR1.closing_velocity_mps} m/s)`);
    assert(featR1.true_ttc_sec < 4.0, `True TTC indicates imminent collision (${featR1.true_ttc_sec} s)`);

    const p1 = await predictRobot('R1', featR1, BASE_URL);
    assert(p1.decision === 'REROUTE' || p1.decision === 'WAIT', `Head-on conflict produced safety decision: ${p1.decision}`);

    // Verify existing movement controller handles REROUTE
    const scene = createMockScene();
    const sprites = { 'R1': { x: 20 * 32 + 16, y: 10 * 32 + 16, setPosition: () => {} } };
    const tweens = { 'R1': null };
    let aStarCalled = false;

    const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
      updateStatusUI: () => {},
      detectFleetConflicts: () => {},
      getRunMode: () => 'OPTIMIZED',
      getConflicts: () => conflicts,
      findPath: () => {
        aStarCalled = true;
        return [{ tileX: 20, tileY: 10 }, { tileX: 20, tileY: 11 }, { tileX: 35, tileY: 10 }];
      }
    });

    ctrl.moveRobotToNextWaypoint('R1', 1);
    assert(aStarCalled === true, 'A* reroute called for head-on robot');
    assert(window.robotMovementDecisionState['R1'].decision === 'REROUTE', 'Movement decision state is REROUTE');
  }

  // ----------------------------------------------------
  // TEST 3: SCENARIO C — 3 Robots Crossing / Intersection
  // ----------------------------------------------------
  console.log('\n--- SCENARIO C: 3 Robots Crossing / Intersection ---');
  {
    // R1 heading East (45, 50), R2 heading South (50, 45), R3 heading North (50, 55) converging near (50, 50)
    const robots = {
      'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 46, tileY: 50 }, x: 46 * 32 + 16, y: 50 * 32 + 16, destination: { tileX: 60, tileY: 50 }, path: [{ tileX: 46, tileY: 50 }, { tileX: 52, tileY: 50 }] },
      'R2': { id: 'R2', speed: 100, status: 'moving', start: { tileX: 50, tileY: 46 }, x: 50 * 32 + 16, y: 46 * 32 + 16, destination: { tileX: 50, tileY: 60 }, path: [{ tileX: 50, tileY: 46 }, { tileX: 50, tileY: 52 }] },
      'R3': { id: 'R3', speed: 100, status: 'moving', start: { tileX: 50, tileY: 55 }, x: 50 * 32 + 16, y: 55 * 32 + 16, destination: { tileX: 50, tileY: 40 }, path: [{ tileX: 50, tileY: 55 }, { tileX: 50, tileY: 48 }] }
    };

    const crossingConflict = [{
      type: 'vertex',
      conflictType: 'CROSSING',
      robotA: 'R1',
      robotB: 'R2',
      tileX: 50,
      tileY: 50,
      temporalAssessment: { timingResolutionPossible: true, requiresReroute: false, estimatedDelaySec: 0.8 }
    }];

    const featR1 = buildRobotFeatures(robots['R1'], robots, crossingConflict, mapMock);
    const featR2 = buildRobotFeatures(robots['R2'], robots, crossingConflict, mapMock);
    const featR3 = buildRobotFeatures(robots['R3'], robots, crossingConflict, mapMock);

    assert(featR1.intersection_conflict === 1, 'R1 detects intersection_conflict = 1');
    assert(featR1.relative_direction === 'CROSSING', 'R1 relative_direction is CROSSING');

    const [p1, p2, p3] = await Promise.all([
      predictRobot('R1', featR1, BASE_URL),
      predictRobot('R2', featR2, BASE_URL),
      predictRobot('R3', featR3, BASE_URL)
    ]);

    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(p1.decision), `R1 intersection decision valid: ${p1.decision}`);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(p2.decision), `R2 intersection decision valid: ${p2.decision}`);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(p3.decision), `R3 intersection decision valid: ${p3.decision}`);
  }

  // ----------------------------------------------------
  // TEST 4: SCENARIO D — 4 to 5 Robots Congested Area
  // ----------------------------------------------------
  console.log('\n--- SCENARIO D: 4 to 5 Robots Congested Area ---');
  {
    // 5 robots clustered within 3 meters of each other
    const robots = {
      'R1': { id: 'R1', speed: 50, status: 'moving', start: { tileX: 30, tileY: 30 }, x: 30 * 32 + 16, y: 30 * 32 + 16, destination: { tileX: 50, tileY: 30 }, path: [{ tileX: 30, tileY: 30 }, { tileX: 32, tileY: 30 }] },
      'R2': { id: 'R2', speed: 50, status: 'moving', start: { tileX: 31, tileY: 30 }, x: 31 * 32 + 16, y: 30 * 32 + 16, destination: { tileX: 50, tileY: 31 }, path: [{ tileX: 31, tileY: 30 }, { tileX: 33, tileY: 30 }] },
      'R3': { id: 'R3', speed: 50, status: 'moving', start: { tileX: 30, tileY: 31 }, x: 30 * 32 + 16, y: 31 * 32 + 16, destination: { tileX: 50, tileY: 32 }, path: [{ tileX: 30, tileY: 31 }, { tileX: 32, tileY: 31 }] },
      'R4': { id: 'R4', speed: 50, status: 'moving', start: { tileX: 31, tileY: 31 }, x: 31 * 32 + 16, y: 31 * 32 + 16, destination: { tileX: 50, tileY: 33 }, path: [{ tileX: 31, tileY: 31 }, { tileX: 33, tileY: 31 }] },
      'R5': { id: 'R5', speed: 50, status: 'moving', start: { tileX: 32, tileY: 31 }, x: 32 * 32 + 16, y: 31 * 32 + 16, destination: { tileX: 50, tileY: 34 }, path: [{ tileX: 32, tileY: 31 }, { tileX: 34, tileY: 31 }] }
    };

    const featR1 = buildRobotFeatures(robots['R1'], robots, [], mapMock);
    assert(featR1.nearby_robot_count === 4, `Congested cluster nearby_robot_count = 4 (got ${featR1.nearby_robot_count})`);
    assert(featR1.traffic_level === 'CRITICAL' || featR1.traffic_level === 'HIGH', `Traffic level escalated (got ${featR1.traffic_level})`);
    assert(featR1.dynamic_interaction_radius_m >= 8.0, `DIR expanded for high density (${featR1.dynamic_interaction_radius_m}m)`);

    // All 5 robots get concurrent predictions
    const predictions = await Promise.all([
      predictRobot('R1', buildRobotFeatures(robots['R1'], robots, [], mapMock), BASE_URL),
      predictRobot('R2', buildRobotFeatures(robots['R2'], robots, [], mapMock), BASE_URL),
      predictRobot('R3', buildRobotFeatures(robots['R3'], robots, [], mapMock), BASE_URL),
      predictRobot('R4', buildRobotFeatures(robots['R4'], robots, [], mapMock), BASE_URL),
      predictRobot('R5', buildRobotFeatures(robots['R5'], robots, [], mapMock), BASE_URL)
    ]);

    assert(predictions.length === 5, 'All 5 predictions received simultaneously');
    for (let i = 0; i < 5; i++) {
      const rid = `R${i + 1}`;
      assert(window.robotDecisionState[rid] !== undefined, `${rid} stored in robotDecisionState`);
      assert(typeof window.robotDecisionState[rid].confidence === 'number', `${rid} has numerical confidence`);
    }
  }

  // ----------------------------------------------------
  // TEST 5: SCENARIO E — Mixed Traffic
  // ----------------------------------------------------
  console.log('\n--- SCENARIO E: Mixed Traffic ---');
  {
    // R1: Open road, solo
    // R2 & R3: Approaching intersection conflict
    // R4: Completed
    const robots = {
      'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 5, tileY: 5 }, x: 5 * 32 + 16, y: 5 * 32 + 16, destination: { tileX: 25, tileY: 5 }, path: [{ tileX: 5, tileY: 5 }, { tileX: 10, tileY: 5 }] },
      'R2': { id: 'R2', speed: 100, status: 'moving', start: { tileX: 40, tileY: 40 }, x: 40 * 32 + 16, y: 40 * 32 + 16, destination: { tileX: 40, tileY: 60 }, path: [{ tileX: 40, tileY: 40 }, { tileX: 40, tileY: 45 }] },
      'R3': { id: 'R3', speed: 100, status: 'moving', start: { tileX: 38, tileY: 42 }, x: 38 * 32 + 16, y: 42 * 32 + 16, destination: { tileX: 50, tileY: 42 }, path: [{ tileX: 38, tileY: 42 }, { tileX: 44, tileY: 42 }] },
      'R4': { id: 'R4', speed: 100, status: 'completed', start: { tileX: 50, tileY: 50 }, x: 50 * 32 + 16, y: 50 * 32 + 16, destination: { tileX: 50, tileY: 50 }, path: [] }
    };

    const featR1 = buildRobotFeatures(robots['R1'], robots, [], mapMock);
    const p1 = await predictRobot('R1', featR1, BASE_URL);
    assert(p1.decision === 'MOVE', `Solo open road robot receives MOVE (got ${p1.decision})`);
    assert(p1.confidence > 0.95, `Solo robot confidence is very high (${p1.confidence})`);

    // Verify completed robot R4 is excluded from neighbors
    const featR2 = buildRobotFeatures(robots['R2'], robots, [], mapMock);
    assert(featR2.nearby_robot_count === 1, `R2 only counts active R3, excludes completed R4 (got ${featR2.nearby_robot_count})`);
  }

  // ----------------------------------------------------
  // TEST 6: Dynamic Feature Refresh During Movement
  // ----------------------------------------------------
  console.log('\n--- TEST 6: Dynamic Feature Refresh During Movement ---');
  {
    const robot = {
      id: 'R-DYN',
      speed: 100,
      status: 'moving',
      start: { tileX: 10, tileY: 10 },
      x: 10 * 32 + 16,
      y: 10 * 32 + 16,
      destination: { tileX: 30, tileY: 10 },
      path: [{ tileX: 10, tileY: 10 }, { tileX: 20, tileY: 10 }, { tileX: 30, tileY: 10 }]
    };
    const other = {
      id: 'R-OTHER',
      speed: 100,
      status: 'moving',
      start: { tileX: 25, tileY: 10 },
      x: 25 * 32 + 16,
      y: 10 * 32 + 16,
      destination: { tileX: 5, tileY: 10 },
      path: [{ tileX: 25, tileY: 10 }, { tileX: 15, tileY: 10 }]
    };
    const fleet = { 'R-DYN': robot, 'R-OTHER': other };

    // Initial state (T=0): R-OTHER is 15m away, which is outside DIR (6.5m)
    const f0 = buildRobotFeatures(robot, fleet, [], mapMock);
    assert(f0.current_x === 10.0, `Initial x is 10.0 (got ${f0.current_x})`);
    assert(f0.nearest_robot_distance_m === 99.0, `Initial distance is 99.0m (outside DIR 6.5m, got ${f0.nearest_robot_distance_m})`);
    assert(f0.nearby_robot_count === 0, 'No nearby robots inside initial DIR');

    // Simulated movement forward: robot moves to tile 18, other moves to tile 20 (gap = 2.0m, inside DIR)
    robot.x = 18 * 32 + 16;
    other.x = 20 * 32 + 16;
    const f1 = buildRobotFeatures(robot, fleet, [], mapMock);
    assert(f1.current_x === 18.0, `Updated x reflects current position 18.0 (got ${f1.current_x})`);
    assert(f1.nearest_robot_distance_m === 2.0, `Updated distance reflects current gap 2.0m inside DIR (got ${f1.nearest_robot_distance_m})`);
    assert(f1.nearby_robot_count === 1, '1 nearby robot inside updated DIR');
    assert(f1.distance_to_destination_m === 12.0, `Updated distance to dest is 12.0m (got ${f1.distance_to_destination_m})`);
    assert(f1.nearest_robot_distance_m !== f0.nearest_robot_distance_m, 'Features dynamically refreshed during movement');
  }

  // ----------------------------------------------------
  // TEST 7: BASELINE Mode Independence
  // ----------------------------------------------------
  console.log('\n--- TEST 7: BASELINE Mode Independence ---');
  {
    const scene = createMockScene();
    const robots = {
      'R-BASE1': { id: 'R-BASE1', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, x: 48, y: 48, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }], destination: { tileX: 2, tileY: 1 } },
      'R-BASE2': { id: 'R-BASE2', speed: 100, status: 'moving', start: { tileX: 3, tileY: 1 }, x: 112, y: 48, path: [{ tileX: 3, tileY: 1 }, { tileX: 2, tileY: 1 }], destination: { tileX: 2, tileY: 1 } }
    };
    const sprites = {
      'R-BASE1': { x: 48, y: 48, setPosition: () => {} },
      'R-BASE2': { x: 112, y: 48, setPosition: () => {} }
    };
    const tweens = { 'R-BASE1': null, 'R-BASE2': null };

    const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
      updateStatusUI: () => {},
      detectFleetConflicts: () => {},
      getRunMode: () => 'BASELINE' // BASELINE mode
    });

    // Plant WAIT decisions in robotDecisionState
    window.robotDecisionState['R-BASE1'] = { decision: 'WAIT', confidence: 0.99, timestamp: Date.now() };
    window.robotDecisionState['R-BASE2'] = { decision: 'WAIT', confidence: 0.99, timestamp: Date.now() };

    ctrl.moveRobotToNextWaypoint('R-BASE1', 1);
    ctrl.moveRobotToNextWaypoint('R-BASE2', 1);

    assert(tweens['R-BASE1'] !== null, 'BASELINE R-BASE1 ignores ML WAIT and launches tween');
    assert(tweens['R-BASE2'] !== null, 'BASELINE R-BASE2 ignores ML WAIT and launches tween');
    assert(window.robotMovementDecisionState['R-BASE1'].decision === 'MOVE', 'Decision state is MOVE');
    assert(window.robotMovementDecisionState['R-BASE2'].decision === 'MOVE', 'Decision state is MOVE');
  }

  // ----------------------------------------------------
  // TEST 8: Predictor Failure Behavior
  // ----------------------------------------------------
  console.log('\n--- TEST 8: Predictor Failure Behavior ---');
  {
    // Predict with unreachable port
    const failResult = await predictRobot('R-FAIL', { current_x: 0 }, 'http://127.0.0.1:9999');
    assert(failResult === null, 'Unreachable predictor safely returns null without throwing');

    // Movement controller given missing prediction
    const scene = createMockScene();
    const robots = {
      'R-FAIL': { id: 'R-FAIL', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, x: 48, y: 48, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }], destination: { tileX: 2, tileY: 1 } }
    };
    const sprites = { 'R-FAIL': { x: 48, y: 48, setPosition: () => {} } };
    const tweens = { 'R-FAIL': null };

    const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
      updateStatusUI: () => {},
      detectFleetConflicts: () => {},
      getRunMode: () => 'OPTIMIZED'
    });

    // null / missing decision
    window.robotDecisionState['R-FAIL'] = null;
    ctrl.moveRobotToNextWaypoint('R-FAIL', 1);

    assert(tweens['R-FAIL'] !== null, 'Predictor failure safely falls back to MOVE tween');
    assert(window.robotMovementDecisionState['R-FAIL'].decision === 'MOVE', 'Movement decision state falls back to MOVE');
  }

  console.log('\n====================================================');
  console.log(`STAGE 3D MULTI-ROBOT TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
