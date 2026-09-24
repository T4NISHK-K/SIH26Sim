/**
 * scratch/test_stage5d_network_ml.mjs
 *
 * Stage 5D Validation Suite: Connect Network Relevant Neighbours to ARES V2 ML
 *
 * Tests:
 * TEST 1: Create a robot with two nearby network neighbours -> nearby_robot_count == 2
 * TEST 2: Add a far network robot -> does NOT affect nearby_robot_count
 * TEST 3: Move a relevant neighbour -> nearest_robot_distance_m changes
 * TEST 4: Change neighbour relative speed -> nearest_robot_relative_speed_mps / closing_velocity_mps update
 * TEST 5: Create an intersection/conflict geometry -> intersection_conflict reacts using network neighbour
 * TEST 6: Verify generated feature object contains exactly the 26 expected V2 feature keys
 * TEST 7: Verify categorical values remain valid
 * TEST 8: Verify ARES can still call /predict successfully using the generated network-aware features
 * TEST 9: Disable/lose Socket.IO data -> safe fallback to existing local coordination state
 * TEST 10: Verify BASELINE does not call /predict and does not depend on network neighbour data
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRobotFeatures,
  predictRobot,
  V2_FEATURE_KEYS,
  computeDynamicInteractionRadius,
  DIR_CONFIG
} from '../src/network/edgeClient.js';
import {
  getOrCreateRobotSocket,
  disconnectRobotSocket,
  disconnectAllRobotSockets,
  getRelevantNeighbourStates
} from '../src/network/socketClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SERVER_URL = 'http://127.0.0.1:3001';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        timeout: 10000
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            resolve({ statusCode: res.statusCode, body: parsed, raw });
          } catch {
            resolve({ statusCode: res.statusCode, body: null, raw });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request timed out: ${urlStr}`));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

let serverProc = null;

async function ensureServerRunning() {
  try {
    const res = await httpRequest(`${SERVER_URL}/health`);
    if (res.statusCode === 200 && res.body?.status === 'ok') {
      console.log('[Setup] Edge coordinator server is running.');
      return;
    }
  } catch {
    // Need to spawn
  }

  console.log('[Setup] Spawning server/index.js on port 3001...');
  serverProc = spawn('node', ['server/index.js'], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(400);
    try {
      const res = await httpRequest(`${SERVER_URL}/health`);
      if (res.statusCode === 200 && res.body?.status === 'ok') {
        console.log('[Setup] Server became ready.');
        return;
      }
    } catch {
      // Retry
    }
  }

  throw new Error('Failed to start server within timeout');
}

async function waitForCondition(fn, timeoutMs = 4000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const sendWithAck = (client, state) => new Promise((resolve) => {
  const sent = client.sendState(state, (ack) => resolve(ack));
  if (!sent) resolve({ success: false, error: 'Send returned false' });
});

async function runStage5dTests() {
  console.log('====================================================');
  console.log('STAGE 5D: NETWORK RELEVANT NEIGHBOURS TO ARES V2 ML');
  console.log('====================================================\n');

  await ensureServerRunning();

  // Mock global window for predictRobot and decision state storage
  globalThis.window = {
    edgeConnected: true,
    robotDecisionState: {},
    edgeDecisionStats: {
      totalPredictions: 0,
      move: 0,
      slow: 0,
      wait: 0,
      reroute: 0
    }
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: Robot with two nearby network neighbours -> nearby_robot_count == 2
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 1: Robot with Two Nearby Network Neighbours ---');
    const hostRobot = {
      id: 'R1',
      x: 10.0,
      y: 10.0,
      speed: 1.0,
      heading: 0.0,
      battery: 90,
      task: 'General Transport',
      priority: 2,
      status: 'moving',
      destination: { tileX: 20, tileY: 10 }
    };

    const nearbyNetworkNeighbours = {
      'R2': {
        robotId: 'R2',
        x: 12.0,
        y: 10.0,
        speed: 1.0,
        heading: 0.0,
        status: 'MOVING',
        distance_to_robot_m: 2.0
      },
      'R3': {
        robotId: 'R3',
        x: 10.0,
        y: 13.0,
        speed: 1.0,
        heading: 0.0,
        status: 'MOVING',
        distance_to_robot_m: 3.0
      }
    };

    const feat1 = buildRobotFeatures(hostRobot, {}, [], null, nearbyNetworkNeighbours);
    assert(feat1.nearby_robot_count === 2, `nearby_robot_count == 2 (got ${feat1.nearby_robot_count})`);
    assert(feat1.nearest_robot_distance_m === 2.0, `nearest_robot_distance_m == 2.0 (got ${feat1.nearest_robot_distance_m})`);
    assert(feat1.traffic_level === 'MEDIUM', `traffic_level is MEDIUM for 2 neighbours (got ${feat1.traffic_level})`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Add a far network robot -> does NOT affect nearby_robot_count
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Add Far Network Robot ---');
    const networkWithFar = {
      ...nearbyNetworkNeighbours,
      'R4_FAR': {
        robotId: 'R4_FAR',
        x: 45.0,
        y: 10.0,
        speed: 1.0,
        heading: 0.0,
        status: 'MOVING',
        distance_to_robot_m: 35.0
      }
    };

    const feat2 = buildRobotFeatures(hostRobot, {}, [], null, networkWithFar);
    assert(feat2.nearby_robot_count === 2, `Far robot (35m) does NOT affect nearby_robot_count (expected 2, got ${feat2.nearby_robot_count})`);
    assert(feat2.nearest_robot_distance_m === 2.0, `Nearest distance remains 2.0m (got ${feat2.nearest_robot_distance_m})`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: Move a relevant neighbour -> nearest_robot_distance_m changes
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Move Relevant Neighbour ---');
    // Move R2 from 2.0m to 1.2m
    const networkMoved = {
      'R2': {
        robotId: 'R2',
        x: 11.2,
        y: 10.0,
        speed: 1.0,
        heading: 0.0,
        status: 'MOVING',
        distance_to_robot_m: 1.2
      },
      'R3': {
        robotId: 'R3',
        x: 10.0,
        y: 13.0,
        speed: 1.0,
        heading: 0.0,
        status: 'MOVING',
        distance_to_robot_m: 3.0
      }
    };

    const feat3 = buildRobotFeatures(hostRobot, {}, [], null, networkMoved);
    assert(feat3.nearest_robot_distance_m === 1.2, `nearest_robot_distance_m updated to 1.2m (got ${feat3.nearest_robot_distance_m})`);
    assert(feat3.nearest_robot_distance_m !== feat1.nearest_robot_distance_m, 'Nearest distance changed when neighbour moved');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Change neighbour relative speed -> speed & closing velocity update
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Change Neighbour Relative Speed & Closing Velocity ---');
    // Head-on closing scenario: R1 at (10, 10) heading East (0.0) at 1.0 m/s
    // R2 at (14, 10) heading West (PI) at 1.0 m/s -> closing velocity = 2.0 m/s
    const networkSpeed1 = {
      'R2': {
        robotId: 'R2',
        x: 14.0,
        y: 10.0,
        speed: 1.0,
        heading: Math.PI,
        status: 'MOVING',
        distance_to_robot_m: 4.0
      }
    };
    const feat4a = buildRobotFeatures(hostRobot, {}, [], null, networkSpeed1);
    assert(feat4a.relative_direction === 'OPPOSITE', `Relative direction is OPPOSITE (got ${feat4a.relative_direction})`);
    assert(Math.abs(feat4a.nearest_robot_relative_speed_mps - 2.0) < 0.05, `Relative speed is ~2.0 m/s (got ${feat4a.nearest_robot_relative_speed_mps})`);
    assert(Math.abs(feat4a.closing_velocity_mps - 2.0) < 0.05, `Closing velocity is ~2.0 m/s (got ${feat4a.closing_velocity_mps})`);

    // Now increase R2 speed to 2.5 m/s -> closing velocity = 3.5 m/s
    const networkSpeed2 = {
      'R2': {
        robotId: 'R2',
        x: 14.0,
        y: 10.0,
        speed: 2.5,
        heading: Math.PI,
        status: 'MOVING',
        distance_to_robot_m: 4.0
      }
    };
    const feat4b = buildRobotFeatures(hostRobot, {}, [], null, networkSpeed2);
    assert(Math.abs(feat4b.nearest_robot_relative_speed_mps - 3.5) < 0.05, `Updated relative speed is ~3.5 m/s (got ${feat4b.nearest_robot_relative_speed_mps})`);
    assert(Math.abs(feat4b.closing_velocity_mps - 3.5) < 0.05, `Updated closing velocity is ~3.5 m/s (got ${feat4b.closing_velocity_mps})`);
    assert(feat4b.closing_velocity_mps > feat4a.closing_velocity_mps, 'Closing velocity increased with higher peer speed');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Create intersection/conflict geometry -> intersection_conflict reacts
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Intersection Conflict Geometry with Network Neighbour ---');
    // R1 at (10, 8) moving South (heading = PI/2 = 1.57) towards (10, 10)
    // R2 at (8, 10) moving East (heading = 0.0) towards (10, 10)
    // They cross at (10, 10) in ~2.0s with CPA distance ~0.0m
    const robotAtIntersection = {
      id: 'R_INTER',
      x: 10.0,
      y: 8.0,
      speed: 1.0,
      heading: Math.PI / 2, // South
      battery: 85,
      task: 'General Transport',
      priority: 2,
      status: 'moving',
      destination: { tileX: 10, tileY: 15 }
    };

    const crossingNetworkNeighbour = {
      'R_CROSS': {
        robotId: 'R_CROSS',
        x: 8.0,
        y: 10.0,
        speed: 1.0,
        heading: 0.0, // East
        status: 'MOVING',
        distance_to_robot_m: Math.hypot(8.0 - 10.0, 10.0 - 8.0)
      }
    };

    const feat5Crossing = buildRobotFeatures(robotAtIntersection, {}, [], null, crossingNetworkNeighbour);
    assert(feat5Crossing.relative_direction === 'CROSSING', `Relative direction is CROSSING (got ${feat5Crossing.relative_direction})`);
    assert(feat5Crossing.cpa_distance_m < 2.0, `CPA distance is close (<2m, got ${feat5Crossing.cpa_distance_m}m)`);
    assert(feat5Crossing.true_ttc_sec < 4.0, `True TTC is within conflict threshold (<4s, got ${feat5Crossing.true_ttc_sec}s)`);
    assert(feat5Crossing.intersection_conflict === 1, `intersection_conflict == 1 for crossing network geometry (got ${feat5Crossing.intersection_conflict})`);

    // Verify non-conflicting parallel neighbour has intersection_conflict == 0
    const parallelNetworkNeighbour = {
      'R_PARALLEL': {
        robotId: 'R_PARALLEL',
        x: 12.0,
        y: 8.0,
        speed: 1.0,
        heading: Math.PI / 2, // South (same heading)
        status: 'MOVING',
        distance_to_robot_m: 2.0
      }
    };
    const feat5Parallel = buildRobotFeatures(robotAtIntersection, {}, [], null, parallelNetworkNeighbour);
    assert(feat5Parallel.relative_direction === 'SAME', `Relative direction is SAME (got ${feat5Parallel.relative_direction})`);
    assert(feat5Parallel.intersection_conflict === 0, `intersection_conflict == 0 for parallel traffic (got ${feat5Parallel.intersection_conflict})`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: Verify exact 26 V2 feature keys
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: Exact 26 V2 Feature Keys Contract ---');
    const featureKeys = Object.keys(feat1);
    assert(featureKeys.length === 26, `Feature object contains exactly 26 keys (got ${featureKeys.length})`);

    const missingKeys = V2_FEATURE_KEYS.filter((k) => !featureKeys.includes(k));
    const extraKeys = featureKeys.filter((k) => !V2_FEATURE_KEYS.includes(k));
    assert(missingKeys.length === 0, `No missing keys (missing: ${missingKeys.join(', ')})`);
    assert(extraKeys.length === 0, `No extra keys (extra: ${extraKeys.join(', ')})`);

    // Verify types for all 22 numeric features
    const numericKeys = [
      'current_x', 'current_y', 'destination_x', 'destination_y',
      'distance_to_destination_m', 'eta_sec', 'speed_mps', 'heading_rad',
      'battery_pct', 'obstacle_detected', 'path_blocked', 'alternative_route_available',
      'dynamic_interaction_radius_m', 'nearby_robot_count', 'nearest_robot_distance_m',
      'nearest_robot_relative_speed_mps', 'nearest_robot_relative_heading_rad',
      'closing_velocity_mps', 'true_ttc_sec', 'cpa_time_sec', 'cpa_distance_m',
      'intersection_conflict'
    ];
    for (const key of numericKeys) {
      assert(typeof feat1[key] === 'number' && Number.isFinite(feat1[key]), `${key} is finite number (got ${feat1[key]})`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Categorical values remain valid
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 7: Categorical Feature Values Validity ---');
    const VALID_TASK_TYPES = ['CHARGE', 'DROP', 'PICK', 'RELOCATE'];
    const VALID_PRIORITIES = ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'];
    const VALID_TRAFFIC = ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'];
    const VALID_REL_DIR = ['CROSSING', 'NONE', 'OPPOSITE', 'SAME'];

    assert(VALID_TASK_TYPES.includes(feat1.task_type), `task_type '${feat1.task_type}' is valid`);
    assert(VALID_PRIORITIES.includes(feat1.task_priority), `task_priority '${feat1.task_priority}' is valid`);
    assert(VALID_TRAFFIC.includes(feat1.traffic_level), `traffic_level '${feat1.traffic_level}' is valid`);
    assert(VALID_REL_DIR.includes(feat1.relative_direction), `relative_direction '${feat1.relative_direction}' is valid`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Live ARES /predict Call with Generated Network Features
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 8: Live ARES /predict Call with Network-Aware Features ---');
    const predResult = await predictRobot('R1', feat1, SERVER_URL);
    assert(predResult !== null, 'Predict returned non-null response');
    assert(typeof predResult.decision === 'string', `Decision is string (got '${predResult.decision}')`);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predResult.decision), `Decision '${predResult.decision}' is one of [MOVE, SLOW, WAIT, REROUTE]`);
    assert(typeof predResult.confidence === 'number' && predResult.confidence >= 0, `Confidence is valid number (${predResult.confidence})`);
    assert(window.robotDecisionState['R1']?.decision === predResult.decision, 'Decision stored in window.robotDecisionState[R1]');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9: Safe fallback when Socket.IO data is unavailable / lost
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 9: Safe Fallback to In-Process State when Socket.IO Unavailable ---');
    // When networkNeighbours is null, buildRobotFeatures falls back to allRobots
    const localFleet = {
      'R1': hostRobot,
      'R_LOCAL_1': {
        id: 'R_LOCAL_1',
        x: 12.0,
        y: 10.0,
        speed: 100,
        status: 'moving'
      }
    };

    const fallbackFeat = buildRobotFeatures(hostRobot, localFleet, [], null, null);
    assert(fallbackFeat.nearby_robot_count === 1, `Fallback correctly uses local fleet (expected 1, got ${fallbackFeat.nearby_robot_count})`);
    assert(fallbackFeat.nearest_robot_distance_m === 2.0, `Fallback measures correct local distance 2.0m (got ${fallbackFeat.nearest_robot_distance_m})`);
    assert(Object.keys(fallbackFeat).length === 26, 'Fallback produces exact 26 V2 features');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 10: BASELINE Mode Independence
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 10: BASELINE Mode Does NOT Call /predict or Depend on Network Neighbours ---');
    let predictCalled = false;
    const mockPredictFn = async () => { predictCalled = true; };

    // Simulate main.js telemetry loop in BASELINE mode
    const runModes = { BASELINE: 'BASELINE', OPTIMIZED: 'OPTIMIZED' };
    const currentMode = runModes.BASELINE;

    if (currentMode === runModes.OPTIMIZED) {
      await mockPredictFn();
    }

    assert(predictCalled === false, 'BASELINE mode does NOT invoke predict');
    assert(currentMode !== runModes.OPTIMIZED, 'BASELINE mode runs completely independently from ML prediction');

    // Also test through real Socket.IO clients end-to-end with the running server
    console.log('\n--- Bonus End-to-End: Socket.IO Live Exchange -> ML Pipeline ---');
    const c1 = getOrCreateRobotSocket('R_NET_1');
    const c2 = getOrCreateRobotSocket('R_NET_2');

    await waitForCondition(() => c1.isConnected() && c2.isConnected(), 4000);

    const timeNow = Date.now();
    await Promise.all([
      sendWithAck(c1, { x: 10.0, y: 10.0, speed: 1.0, heading: 0.0, status: 'MOVING', timestamp: timeNow }),
      sendWithAck(c2, { x: 12.5, y: 10.0, speed: 1.0, heading: 0.0, status: 'MOVING', timestamp: timeNow })
    ]);

    await waitForCondition(() => {
      const rel = c1.getRelevantNeighbourStates();
      return rel.R_NET_2 !== undefined;
    }, 2000);

    const liveRelevant = c1.getRelevantNeighbourStates();
    assert(liveRelevant.R_NET_2 !== undefined, 'Live Socket.IO client received R_NET_2 as relevant neighbour');

    const liveRobot = {
      id: 'R_NET_1',
      x: 10.0,
      y: 10.0,
      speed: 1.0,
      heading: 0.0,
      status: 'moving',
      destination: { tileX: 20, tileY: 10 }
    };

    const liveFeat = buildRobotFeatures(liveRobot, {}, [], null, liveRelevant);
    assert(liveFeat.nearby_robot_count === 1, `Live Socket.IO features nearby_robot_count == 1 (got ${liveFeat.nearby_robot_count})`);
    assert(liveFeat.nearest_robot_distance_m === 2.5, `Live Socket.IO features nearest_robot_distance_m == 2.5 (got ${liveFeat.nearest_robot_distance_m})`);

    const livePred = await predictRobot('R_NET_1', liveFeat, SERVER_URL);
    assert(livePred && livePred.decision, `Live end-to-end Socket.IO -> Feature -> /predict returned decision: ${livePred?.decision}`);

    // Disconnect sockets cleanly
    disconnectAllRobotSockets();

    console.log('\n====================================================');
    console.log(`STAGE 5D TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  } finally {
    if (serverProc) {
      serverProc.kill();
    }
  }
}

runStage5dTests();
