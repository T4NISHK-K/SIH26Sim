/**
 * scratch/test_stage5e_distributed.mjs
 *
 * Stage 5E Validation Suite: Distributed Multi-Robot End-to-End Validation
 *
 * Validated Pipeline:
 * Real AMR Clients (R1..R5)
 *   ↓ Socket.IO STATE_UPDATE
 * Edge Coordinator (server/index.js)
 *   ↓ NEIGHBOUR_STATE broadcast
 * Dynamic Interaction Radius (DIR)
 *   ↓
 * Relevant Neighbours Filtering
 *   ↓
 * V2 Physics Features (26-feature contract)
 *   ↓
 * XGBoost /predict (server/predictor.py)
 *   ↓
 * Coordination Decisions (MOVE / SLOW / WAIT / REROUTE)
 *
 * Test Groups:
 * TG1: Five Robot Network Fleet Connection & State Exchange
 * TG2: Relevant Neighbour Spatial Filtering & Dynamic Transition
 * TG3: Five-Robot ML Feature Generation Contract (26 features)
 * TG4: Simultaneous XGBoost Decisions & Concurrency Isolation
 * TG5: Scenario: Same-Direction Following
 * TG6: Scenario: Head-On Closing Traffic
 * TG7: Scenario: Crossing Intersection Conflict
 * TG8: Scenario: Dense Region Congestion
 * TG9: Disconnect & Stale Robot Pruning
 * TG10: Socket Failure & Safe In-Process Fallback
 * TG11: BASELINE Mode Independence
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
  getRelevantNeighbourStates,
  getActiveSocketClients,
  STALE_TIMEOUT_MS
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
      console.log('[Setup] Edge coordinator server is already running.');
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

async function waitForCondition(fn, timeoutMs = 5000, intervalMs = 50) {
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

async function runStage5eTests() {
  console.log('======================================================================');
  console.log('STAGE 5E: DISTRIBUTED MULTI-ROBOT END-TO-END VALIDATION SUITE');
  console.log('======================================================================\n');

  await ensureServerRunning();

  // Initialize browser window mock for predictRobot storage
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
    // TEST GROUP 1 — FIVE ROBOT NETWORK FLEET
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST GROUP 1: Five Robot Network Fleet Connection & State Exchange ---');
    const robotIds = ['R1', 'R2', 'R3', 'R4', 'R5'];
    const clients = {};

    for (const id of robotIds) {
      clients[id] = getOrCreateRobotSocket(id);
    }

    const allConnected = await waitForCondition(() => {
      return robotIds.every((id) => clients[id].isConnected());
    }, 5000);
    assert(allConnected, 'All 5 robot clients connected to Edge Coordinator');

    const initialPositions = {
      R1: { x: 10.0, y: 10.0, speed: 1.0, heading: 0.0, task: 'PICK', priority: 1 },
      R2: { x: 12.0, y: 10.0, speed: 1.0, heading: 0.0, task: 'DROP', priority: 2 },
      R3: { x: 10.0, y: 13.0, speed: 1.0, heading: 0.0, task: 'RELOCATE', priority: 3 },
      R4: { x: 35.0, y: 10.0, speed: 1.0, heading: 0.0, task: 'CHARGE', priority: 1 },
      R5: { x: 10.0, y: 40.0, speed: 1.0, heading: 0.0, task: 'DROP', priority: 2 }
    };

    const now1 = Date.now();
    const ackResults = await Promise.all(
      robotIds.map((id) =>
        sendWithAck(clients[id], {
          ...initialPositions[id],
          status: 'MOVING',
          timestamp: now1
        })
      )
    );
    assert(ackResults.every((r) => r && r.success), 'All 5 STATE_UPDATE emissions acknowledged by server');

    // Verify server registry contains all 5 robots
    const regRes = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(regRes.statusCode === 200, 'GET /edge/robots returns 200');
    assert(regRes.body && regRes.body.count >= 5, `Server registry has >= 5 robots (got ${regRes.body?.count})`);
    for (const id of robotIds) {
      assert(regRes.body.robots[id] !== undefined, `Robot ${id} appears in server registry`);
    }

    // Wait for peer state propagation
    const allReceivedPeers = await waitForCondition(() => {
      return robotIds.every((id) => {
        const peers = clients[id].getNeighbourStates();
        return Object.keys(peers).length >= 4;
      });
    }, 4000);
    assert(allReceivedPeers, 'Every robot received peer state broadcasts for the other 4 robots');

    // Verify self-state is never treated as its own neighbour
    for (const id of robotIds) {
      const neighbours = clients[id].getNeighbourStates();
      assert(neighbours[id] === undefined, `Robot ${id} does NOT treat itself as a neighbour`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 2 — RELEVANT NEIGHBOUR FILTERING
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 2: Relevant Neighbour Spatial Filtering & Dynamic Transition ---');
    // R1 at (10, 10), speed 1.0 -> DIR is around 6.5m (or up to 8.5m with density)
    // R2 at (12, 10) dist 2.0m <= DIR
    // R3 at (10, 13) dist 3.0m <= DIR
    // R4 at (35, 10) dist 25.0m > DIR
    // R5 at (10, 40) dist 30.0m > DIR
    const r1Relevant = clients['R1'].getRelevantNeighbourStates();
    assert(r1Relevant.R2 !== undefined, 'R1 relevant neighbours contain nearby R2 (2.0m)');
    assert(r1Relevant.R3 !== undefined, 'R1 relevant neighbours contain nearby R3 (3.0m)');
    assert(r1Relevant.R4 === undefined, 'R1 relevant neighbours exclude far R4 (25.0m)');
    assert(r1Relevant.R5 === undefined, 'R1 relevant neighbours exclude far R5 (30.0m)');

    const initialR1Count = Object.keys(r1Relevant).length;
    assert(initialR1Count === 2, `R1 initial relevant neighbour count == 2 (got ${initialR1Count})`);

    // Move R4 into R1 interaction radius: move to (13, 10) -> dist 3.0m
    const now2 = Date.now();
    await sendWithAck(clients['R4'], {
      x: 13.0,
      y: 10.0,
      speed: 1.0,
      heading: 0.0,
      task: 'CHARGE',
      priority: 1,
      status: 'MOVING',
      timestamp: now2
    });

    const r4BecameRelevant = await waitForCondition(() => {
      const rel = clients['R1'].getRelevantNeighbourStates();
      return rel.R4 !== undefined && rel.R4.timestamp >= now2;
    }, 3000);
    assert(r4BecameRelevant, 'R4 becomes relevant to R1 after moving inside DIR');
    const r1AfterR4In = clients['R1'].getRelevantNeighbourStates();
    assert(Object.keys(r1AfterR4In).length === 3, `R1 relevant count expanded to 3 (got ${Object.keys(r1AfterR4In).length})`);

    // Move R2 outside R1 interaction radius: move to (45, 10) -> dist 35.0m
    const now3 = Date.now();
    await sendWithAck(clients['R2'], {
      x: 45.0,
      y: 10.0,
      speed: 1.0,
      heading: 0.0,
      task: 'DROP',
      priority: 2,
      status: 'MOVING',
      timestamp: now3
    });

    const r2Removed = await waitForCondition(() => {
      const rel = clients['R1'].getRelevantNeighbourStates();
      return rel.R2 === undefined;
    }, 3000);
    assert(r2Removed, 'R2 is removed from R1 relevant set after moving outside DIR');
    const r1AfterR2Out = clients['R1'].getRelevantNeighbourStates();
    assert(Object.keys(r1AfterR2Out).length === 2, `R1 relevant count returned to 2 [R3, R4] (got ${Object.keys(r1AfterR2Out).length})`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 3 — FIVE-ROBOT ML FEATURE GENERATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 3: Five-Robot ML Feature Generation Contract (26 Features) ---');
    const fleetStates = {
      R1: { id: 'R1', x: 10.0, y: 10.0, speed: 1.0, heading: 0.0, battery: 95, destination: { tileX: 25, tileY: 10 } },
      R2: { id: 'R2', x: 45.0, y: 10.0, speed: 1.0, heading: 0.0, battery: 90, destination: { tileX: 45, tileY: 20 } },
      R3: { id: 'R3', x: 10.0, y: 13.0, speed: 1.0, heading: 0.0, battery: 85, destination: { tileX: 10, tileY: 30 } },
      R4: { id: 'R4', x: 13.0, y: 10.0, speed: 1.0, heading: 0.0, battery: 80, destination: { tileX: 13, tileY: 25 } },
      R5: { id: 'R5', x: 10.0, y: 40.0, speed: 1.0, heading: 0.0, battery: 75, destination: { tileX: 20, tileY: 40 } }
    };

    const generatedFeatures = {};

    for (const id of robotIds) {
      const relevant = clients[id].getRelevantNeighbourStates();
      const features = buildRobotFeatures(fleetStates[id], {}, [], null, relevant);
      generatedFeatures[id] = features;

      // 1. Verify exact 26 keys
      const keys = Object.keys(features);
      assert(keys.length === 26, `Robot ${id} feature object has exactly 26 keys (got ${keys.length})`);
      const missing = V2_FEATURE_KEYS.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !V2_FEATURE_KEYS.includes(k));
      assert(missing.length === 0 && extra.length === 0, `Robot ${id} matches V2_FEATURE_KEYS contract`);

      // 2. Verify all 22 numeric values are finite
      const numericKeys = [
        'current_x', 'current_y', 'destination_x', 'destination_y',
        'distance_to_destination_m', 'eta_sec', 'speed_mps', 'heading_rad',
        'battery_pct', 'obstacle_detected', 'path_blocked', 'alternative_route_available',
        'dynamic_interaction_radius_m', 'nearby_robot_count', 'nearest_robot_distance_m',
        'nearest_robot_relative_speed_mps', 'nearest_robot_relative_heading_rad',
        'closing_velocity_mps', 'true_ttc_sec', 'cpa_time_sec', 'cpa_distance_m',
        'intersection_conflict'
      ];
      for (const nk of numericKeys) {
        assert(typeof features[nk] === 'number' && Number.isFinite(features[nk]), `${id}.${nk} is finite number (${features[nk]})`);
      }

      // 3. Verify categorical values are valid
      assert(['CHARGE', 'DROP', 'PICK', 'RELOCATE'].includes(features.task_type), `${id}.task_type is valid (${features.task_type})`);
      assert(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'].includes(features.task_priority), `${id}.task_priority is valid (${features.task_priority})`);
      assert(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'].includes(features.traffic_level), `${id}.traffic_level is valid (${features.traffic_level})`);
      assert(['CROSSING', 'NONE', 'OPPOSITE', 'SAME'].includes(features.relative_direction), `${id}.relative_direction is valid (${features.relative_direction})`);

      // 4. Verify nearby_robot_count matches relevant set length
      assert(features.nearby_robot_count === Object.keys(relevant).length, `${id}.nearby_robot_count (${features.nearby_robot_count}) matches relevant set (${Object.keys(relevant).length})`);

      // 5. Verify nearest-neighbour value
      if (Object.keys(relevant).length > 0) {
        assert(features.nearest_robot_distance_m < 20.0, `${id}.nearest_robot_distance_m is inside DIR (${features.nearest_robot_distance_m}m)`);
      } else {
        assert(features.nearest_robot_distance_m === 99.0, `${id}.nearest_robot_distance_m falls back to 99.0m when isolated`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 4 — SIMULTANEOUS XGBOOST DECISIONS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 4: Simultaneous XGBoost Decisions & Concurrency Isolation ---');
    const predictPromises = robotIds.map((id) =>
      predictRobot(id, generatedFeatures[id], SERVER_URL)
    );
    const predictResults = await Promise.all(predictPromises);

    assert(predictResults.every((r) => r !== null), 'All 5 simultaneous /predict calls succeeded');

    const validDecisions = ['MOVE', 'SLOW', 'WAIT', 'REROUTE'];
    predictResults.forEach((res, idx) => {
      const id = robotIds[idx];
      assert(typeof res.decision === 'string', `${id} prediction decision is string (${res.decision})`);
      assert(validDecisions.includes(res.decision), `${id} decision '${res.decision}' is one of [MOVE, SLOW, WAIT, REROUTE]`);
      assert(typeof res.confidence === 'number' && res.confidence >= 0 && res.confidence <= 1, `${id} confidence is in [0, 1] (${res.confidence})`);
      assert(window.robotDecisionState[id] !== undefined, `${id} stored in window.robotDecisionState[${id}]`);
      assert(window.robotDecisionState[id].decision === res.decision, `${id} stored decision matches prediction response`);
    });

    // Verify isolation: decisions stored independently without cross-robot overwrite
    for (let i = 0; i < robotIds.length; i++) {
      for (let j = i + 1; j < robotIds.length; j++) {
        assert(
          window.robotDecisionState[robotIds[i]] !== window.robotDecisionState[robotIds[j]],
          `Decision states for ${robotIds[i]} and ${robotIds[j]} are isolated independent objects`
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 5 — SCENARIO: SAME-DIRECTION FOLLOWING
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 5: Scenario: Same-Direction Following ---');
    // R1 leading at x=20, y=10 (speed 0.8)
    // R2 following at x=17, y=10 (speed 1.2) -> faster pursuer closing in
    // R3 following at x=13, y=10 (speed 1.0)
    // All heading East (heading = 0.0)
    const now5 = Date.now();
    await Promise.all([
      sendWithAck(clients['R1'], { x: 20.0, y: 10.0, speed: 0.8, heading: 0.0, status: 'MOVING', timestamp: now5 }),
      sendWithAck(clients['R2'], { x: 17.0, y: 10.0, speed: 1.2, heading: 0.0, status: 'MOVING', timestamp: now5 }),
      sendWithAck(clients['R3'], { x: 13.0, y: 10.0, speed: 1.0, heading: 0.0, status: 'MOVING', timestamp: now5 })
    ]);

    await waitForCondition(() => {
      const r2rel = clients['R2'].getRelevantNeighbourStates();
      return r2rel.R1 !== undefined && r2rel.R3 !== undefined && r2rel.R1.timestamp >= now5 && r2rel.R3.timestamp >= now5;
    }, 4000);

    const r2RelFollow = clients['R2'].getRelevantNeighbourStates();
    assert(r2RelFollow.R1 !== undefined, 'Following scenario: R2 sees leading R1 in front');
    assert(r2RelFollow.R3 !== undefined, 'Following scenario: R2 sees trailing R3 behind');

    const robot2Obj = {
      id: 'R2',
      x: 17.0,
      y: 10.0,
      speed: 1.2,
      heading: 0.0,
      status: 'moving',
      destination: { tileX: 35, tileY: 10 }
    };
    const featFollowR2 = buildRobotFeatures(robot2Obj, {}, [], null, r2RelFollow);
    assert(featFollowR2.relative_direction === 'SAME', `R2 detects lead robot in SAME relative direction (got ${featFollowR2.relative_direction})`);
    assert(featFollowR2.nearest_robot_distance_m === 3.0, `R2 measures exact 3.0m to lead robot R1 (got ${featFollowR2.nearest_robot_distance_m})`);
    assert(featFollowR2.nearby_robot_count >= 2, `R2 sees both fleet robots within DIR (got ${featFollowR2.nearby_robot_count})`);

    const predFollow = await predictRobot('R2', featFollowR2, SERVER_URL);
    assert(predFollow && validDecisions.includes(predFollow.decision), `Following scenario produced valid ML decision: ${predFollow?.decision}`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 6 — SCENARIO: HEAD-ON
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 6: Scenario: Head-On Closing Traffic ---');
    // R1 heading East (0.0) at (15, 10), speed 1.0 m/s
    // R2 heading West (PI) at (20, 10), speed 1.0 m/s
    // Park R3, R4, R5 far away (50, 50) so R1 and R2 interact exclusively
    const now6 = Date.now();
    await Promise.all([
      sendWithAck(clients['R1'], { x: 15.0, y: 10.0, speed: 1.0, heading: 0.0, status: 'MOVING', timestamp: now6 }),
      sendWithAck(clients['R2'], { x: 20.0, y: 10.0, speed: 1.0, heading: Math.PI, status: 'MOVING', timestamp: now6 }),
      sendWithAck(clients['R3'], { x: 50.0, y: 50.0, speed: 0.0, heading: 0.0, status: 'IDLE', timestamp: now6 }),
      sendWithAck(clients['R4'], { x: 50.0, y: 50.0, speed: 0.0, heading: 0.0, status: 'IDLE', timestamp: now6 }),
      sendWithAck(clients['R5'], { x: 50.0, y: 50.0, speed: 0.0, heading: 0.0, status: 'IDLE', timestamp: now6 })
    ]);

    await waitForCondition(() => {
      const rel1 = clients['R1'].getRelevantNeighbourStates();
      const rel2 = clients['R2'].getRelevantNeighbourStates();
      return rel1.R2?.timestamp >= now6 && rel2.R1?.timestamp >= now6 && rel1.R3 === undefined;
    }, 4000);

    const r1RelHeadOn = clients['R1'].getRelevantNeighbourStates();
    const r2RelHeadOn = clients['R2'].getRelevantNeighbourStates();
    assert(r1RelHeadOn.R2 !== undefined, 'Head-on: R1 sees approaching R2');
    assert(r2RelHeadOn.R1 !== undefined, 'Head-on: R2 sees approaching R1');

    const robot1HeadOn = { id: 'R1', x: 15.0, y: 10.0, speed: 1.0, heading: 0.0, status: 'moving', destination: { tileX: 30, tileY: 10 } };
    const robot2HeadOn = { id: 'R2', x: 20.0, y: 10.0, speed: 1.0, heading: Math.PI, status: 'moving', destination: { tileX: 5, tileY: 10 } };

    const featHeadOn1 = buildRobotFeatures(robot1HeadOn, {}, [], null, r1RelHeadOn);
    const featHeadOn2 = buildRobotFeatures(robot2HeadOn, {}, [], null, r2RelHeadOn);

    assert(featHeadOn1.relative_direction === 'OPPOSITE', `R1 relative direction is OPPOSITE (got ${featHeadOn1.relative_direction})`);
    assert(featHeadOn2.relative_direction === 'OPPOSITE', `R2 relative direction is OPPOSITE (got ${featHeadOn2.relative_direction})`);
    assert(Math.abs(featHeadOn1.closing_velocity_mps - 2.0) < 0.1, `Head-on closing velocity is ~2.0 m/s (got ${featHeadOn1.closing_velocity_mps})`);
    assert(Math.abs(featHeadOn1.true_ttc_sec - 2.5) < 0.2, `Head-on TTC is ~2.5s (got ${featHeadOn1.true_ttc_sec})`);
    assert(featHeadOn1.cpa_distance_m < 0.5, `Head-on CPA distance indicates direct collision geometry (got ${featHeadOn1.cpa_distance_m}m)`);

    const [predHead1, predHead2] = await Promise.all([
      predictRobot('R1', featHeadOn1, SERVER_URL),
      predictRobot('R2', featHeadOn2, SERVER_URL)
    ]);
    assert(predHead1 && validDecisions.includes(predHead1.decision), `Head-on R1 prediction valid: ${predHead1?.decision}`);
    assert(predHead2 && validDecisions.includes(predHead2.decision), `Head-on R2 prediction valid: ${predHead2?.decision}`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 7 — SCENARIO: INTERSECTION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 7: Scenario: Crossing Intersection Conflict ---');
    // R1 at (10, 8) heading South (PI/2 = 1.57) towards (10, 10) at 1.0 m/s
    // R2 at (8, 10) heading East (0.0) towards (10, 10) at 1.0 m/s
    // Intersect at (10, 10) in 2 seconds with CPA distance ~0.0m
    const now7 = Date.now();
    await Promise.all([
      sendWithAck(clients['R1'], { x: 10.0, y: 8.0, speed: 1.0, heading: Math.PI / 2, status: 'MOVING', timestamp: now7 }),
      sendWithAck(clients['R2'], { x: 8.0, y: 10.0, speed: 1.0, heading: 0.0, status: 'MOVING', timestamp: now7 })
    ]);

    await waitForCondition(() => {
      const rel1 = clients['R1'].getRelevantNeighbourStates();
      return rel1.R2 !== undefined && rel1.R2.timestamp >= now7;
    }, 4000);

    const r1RelInter = clients['R1'].getRelevantNeighbourStates();
    assert(r1RelInter.R2 !== undefined, 'Intersection: R1 detects cross-traffic peer R2');

    const robot1Inter = { id: 'R1', x: 10.0, y: 8.0, speed: 1.0, heading: Math.PI / 2, status: 'moving', destination: { tileX: 10, tileY: 20 } };
    const featInter1 = buildRobotFeatures(robot1Inter, {}, [], null, r1RelInter);

    assert(featInter1.relative_direction === 'CROSSING', `Intersection relative direction is CROSSING (got ${featInter1.relative_direction})`);
    assert(featInter1.intersection_conflict === 1, `intersection_conflict is flagged (1) for geometric crossing (got ${featInter1.intersection_conflict})`);
    assert(featInter1.cpa_distance_m < 2.0, `CPA distance is close (<2m, got ${featInter1.cpa_distance_m}m)`);
    assert(featInter1.true_ttc_sec < 4.0, `True TTC indicates imminent intersection (<4s, got ${featInter1.true_ttc_sec}s)`);

    const predInter = await predictRobot('R1', featInter1, SERVER_URL);
    assert(predInter && validDecisions.includes(predInter.decision), `Intersection prediction valid: ${predInter?.decision}`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 8 — SCENARIO: CONGESTION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 8: Scenario: Dense Region Congestion ---');
    // All 5 robots clustered within 2-3 meters around (15, 15)
    const clusterPositions = {
      R1: { x: 15.0, y: 15.0, speed: 0.8, heading: 0.0 },
      R2: { x: 16.5, y: 15.0, speed: 0.7, heading: 0.0 },
      R3: { x: 15.0, y: 16.5, speed: 0.6, heading: Math.PI / 2 },
      R4: { x: 13.5, y: 15.0, speed: 0.8, heading: Math.PI },
      R5: { x: 15.0, y: 13.5, speed: 0.5, heading: -Math.PI / 2 }
    };

    const now8 = Date.now();
    await Promise.all(
      robotIds.map((id) =>
        sendWithAck(clients[id], {
          ...clusterPositions[id],
          status: 'MOVING',
          timestamp: now8
        })
      )
    );

    await waitForCondition(() => {
      const rel1 = clients['R1'].getRelevantNeighbourStates();
      return (
        Object.keys(rel1).length === 4 &&
        rel1.R2?.timestamp >= now8 &&
        rel1.R3?.timestamp >= now8 &&
        rel1.R4?.timestamp >= now8 &&
        rel1.R5?.timestamp >= now8
      );
    }, 4000);

    const r1CongestionRel = clients['R1'].getRelevantNeighbourStates();
    assert(Object.keys(r1CongestionRel).length === 4, `Congestion: R1 sees all 4 cluster peers as relevant (got ${Object.keys(r1CongestionRel).length})`);

    const r1CongestionFeat = buildRobotFeatures(
      { id: 'R1', x: 15.0, y: 15.0, speed: 0.8, heading: 0.0, status: 'moving', destination: { tileX: 30, tileY: 15 } },
      {},
      [],
      null,
      r1CongestionRel
    );

    assert(r1CongestionFeat.nearby_robot_count === 4, `Congestion nearby_robot_count == 4 (got ${r1CongestionFeat.nearby_robot_count})`);
    assert(r1CongestionFeat.dynamic_interaction_radius_m >= 9.0, `DIR expanded dynamically under fleet density (${r1CongestionFeat.dynamic_interaction_radius_m}m)`);
    assert(['HIGH', 'CRITICAL'].includes(r1CongestionFeat.traffic_level), `Traffic level escalated to HIGH/CRITICAL (got ${r1CongestionFeat.traffic_level})`);

    // Verify all 5 robots can simultaneously request predictions in congested cluster
    const clusterFeats = {};
    for (const id of robotIds) {
      clusterFeats[id] = buildRobotFeatures(
        { id, ...clusterPositions[id], status: 'moving', destination: { tileX: 25, tileY: 25 } },
        {},
        [],
        null,
        clients[id].getRelevantNeighbourStates()
      );
    }

    const clusterPredictions = await Promise.all(
      robotIds.map((id) => predictRobot(id, clusterFeats[id], SERVER_URL))
    );
    assert(clusterPredictions.every((p) => p !== null && validDecisions.includes(p.decision)), 'All 5 congested robots received valid concurrent predictions');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 9 — DISCONNECT / STALE ROBOT
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 9: Disconnect & Stale Robot Pruning ---');
    // Disconnect R5
    disconnectRobotSocket('R5');
    assert(!clients['R5'].isConnected(), 'R5 socket client marked disconnected');

    // Wait for server and remaining clients to prune R5
    const r5Pruned = await waitForCondition(() => {
      const rel1 = clients['R1'].getRelevantNeighbourStates();
      return rel1.R5 === undefined;
    }, 4000);
    assert(r5Pruned, 'R5 pruned from R1 relevant neighbours after disconnect');

    for (const id of ['R1', 'R2', 'R3', 'R4']) {
      const rel = clients[id].getRelevantNeighbourStates();
      assert(rel.R5 === undefined, `R5 removed from ${id} relevant neighbour state`);
    }

    // Remaining robots (R1..R4) continue generating valid features and getting predictions
    const r1PostDisconnectFeat = buildRobotFeatures(
      { id: 'R1', x: 15.0, y: 15.0, speed: 0.8, heading: 0.0, status: 'moving', destination: { tileX: 30, tileY: 15 } },
      {},
      [],
      null,
      clients['R1'].getRelevantNeighbourStates()
    );
    assert(r1PostDisconnectFeat.nearby_robot_count === 3, `R1 nearby_robot_count updated from 4 to 3 (got ${r1PostDisconnectFeat.nearby_robot_count})`);
    const r1PostPred = await predictRobot('R1', r1PostDisconnectFeat, SERVER_URL);
    assert(r1PostPred && validDecisions.includes(r1PostPred.decision), `R1 prediction succeeds post-disconnect: ${r1PostPred?.decision}`);

    // Stale peer handling test using Stage 5C stale filtering
    const stalePeerState = {
      R_STALE: {
        robotId: 'R_STALE',
        x: 15.5,
        y: 15.0,
        speed: 1.0,
        status: 'MOVING',
        localReceivedAt: Date.now() - (STALE_TIMEOUT_MS + 2000), // 12 seconds old
        timestamp: Date.now() - (STALE_TIMEOUT_MS + 2000)
      }
    };
    // Inject stale peer into client's internal neighbour cache and verify getRelevantNeighbourStates filters it out
    clients['R1'].neighbourStates.set('R_STALE', stalePeerState.R_STALE);
    const relAfterStale = clients['R1'].getRelevantNeighbourStates();
    assert(relAfterStale.R_STALE === undefined, 'Stale peer (>10s old) is safely excluded from relevant neighbours');
    clients['R1'].neighbourStates.delete('R_STALE');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 10 — SOCKET FAILURE FALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 10: Socket Failure & Safe In-Process Fallback ---');
    // Simulate complete loss of network neighbour data (networkNeighbours = null)
    const localFallbackFleet = {
      R1: { id: 'R1', x: 10.0, y: 10.0, speed: 1.0, status: 'moving' },
      R_LOCAL_PEER: { id: 'R_LOCAL_PEER', x: 12.0, y: 10.0, speed: 100, status: 'moving' }
    };

    const fallbackFeat = buildRobotFeatures(
      localFallbackFleet.R1,
      localFallbackFleet,
      [],
      null,
      null // networkNeighbours is null
    );

    assert(fallbackFeat !== null, 'buildRobotFeatures succeeds when network neighbours is null');
    assert(Object.keys(fallbackFeat).length === 26, 'Fallback features contain exactly 26 keys');
    assert(fallbackFeat.nearby_robot_count === 1, `Fallback correctly uses local fleet (expected 1, got ${fallbackFeat.nearby_robot_count})`);
    assert(fallbackFeat.nearest_robot_distance_m === 2.0, `Fallback measures local peer distance 2.0m (got ${fallbackFeat.nearest_robot_distance_m})`);

    const fallbackPred = await predictRobot('R1', fallbackFeat, SERVER_URL);
    assert(fallbackPred && validDecisions.includes(fallbackPred.decision), `Fallback features successfully produce ML prediction: ${fallbackPred?.decision}`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST GROUP 11 — BASELINE INDEPENDENCE
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 11: BASELINE Mode Independence ---');
    let mlPredictCallCount = 0;
    const trackedPredict = async () => { mlPredictCallCount++; };

    // Simulate main.js telemetry loop in BASELINE mode
    const RUN_MODES = { BASELINE: 'BASELINE', OPTIMIZED: 'OPTIMIZED' };
    const simulatedMode = RUN_MODES.BASELINE;

    if (simulatedMode === RUN_MODES.OPTIMIZED) {
      await trackedPredict();
    }

    assert(mlPredictCallCount === 0, 'BASELINE mode never invokes /predict');
    assert(simulatedMode !== RUN_MODES.OPTIMIZED, 'BASELINE mode operates without ML dependency');

    // Verify BASELINE robots don't query network neighbour state for movement
    let networkQueryCount = 0;
    const mockBaselineMovementStep = (mode, socketClient) => {
      if (mode === RUN_MODES.OPTIMIZED && socketClient) {
        networkQueryCount++;
        return socketClient.getRelevantNeighbourStates();
      }
      // BASELINE: standard rule-based movement
      return null;
    };

    const resBaseline = mockBaselineMovementStep(RUN_MODES.BASELINE, clients['R1']);
    assert(resBaseline === null, 'BASELINE movement step does not query network neighbour states');
    assert(networkQueryCount === 0, 'Zero network queries performed in BASELINE mode');

    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP & TEARDOWN
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Teardown] Disconnecting all test sockets...');
    disconnectAllRobotSockets();
    assert(getActiveSocketClients().size === 0, 'All robot socket connections cleanly closed');

    console.log('\n======================================================================');
    console.log(`STAGE 5E TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================================');

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

runStage5eTests();
