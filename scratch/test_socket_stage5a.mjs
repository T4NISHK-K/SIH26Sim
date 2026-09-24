/**
 * scratch/test_socket_stage5a.mjs
 *
 * Stage 5A Validation Suite:
 * Socket.IO Real-Time Edge Communication Foundation
 *
 * Verifies:
 * 1. Multiple robot clients connect successfully via Socket.IO
 * 2. Server registers all connected robots
 * 3. R1, R2, R3 states are stored independently in registry
 * 4. State updates replace previous state for the same robot
 * 5. NEIGHBOUR_STATE broadcast events are received by peers
 * 6. Disconnecting a robot removes it from active registry & emits ROBOT_DISCONNECTED
 * 7. Remaining robots stay connected and functional
 * 8. Malformed STATE_UPDATE payloads are rejected safely without crashing server
 * 9. At least 5 simultaneous robot clients exchange state
 * 10. Existing HTTP endpoints (GET /health, POST /predict V2 contract) remain operational
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

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

// HTTP request helper
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
          } catch (err) {
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
  } catch (err) {
    // Not running, proceed to spawn
  }

  console.log('[Setup] Spawning server/index.js on port 3001...');
  serverProc = spawn('node', ['server/index.js'], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  // Poll until healthy
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

function createClient(robotId) {
  return ioClient(SERVER_URL, {
    query: { robotId },
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: false
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 4000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendStateUpdate(socket, payload) {
  return new Promise((resolve) => {
    socket.emit('STATE_UPDATE', payload, (ack) => {
      resolve(ack);
    });
  });
}

async function runStage5aTests() {
  console.log('====================================================');
  console.log('STAGE 5A: SOCKET.IO REAL-TIME EDGE COMMUNICATION TEST');
  console.log('====================================================\n');

  await ensureServerRunning();

  // ─────────────────────────────────────────────────────────────────────────
  // PART 9 — HTTP Health & Predict Regression Pre-check
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Existing HTTP Endpoints (GET /health & POST /predict) ---');
  {
    const health = await httpRequest(`${SERVER_URL}/health`);
    assert(health.statusCode === 200, 'GET /health returns HTTP 200');
    assert(health.body?.status === 'ok', 'Health response status is "ok"');
    assert(health.body?.service === 'local-edge-coordinator', 'Service name is local-edge-coordinator');
    assert(typeof health.body?.activeRobotsCount === 'number', 'Health includes activeRobotsCount');
    assert(typeof health.body?.socketClientsCount === 'number', 'Health includes socketClientsCount');

    // Test POST /predict with 26 V2 features contract
    const sampleFeatures = {
      current_x: 10.0,
      current_y: 10.0,
      destination_x: 20.0,
      destination_y: 10.0,
      distance_to_destination_m: 10.0,
      eta_sec: 10.0,
      speed_mps: 1.0,
      heading_rad: 0.0,
      battery_pct: 90.0,
      priority_level: 2,
      task_type_code: 1,
      nearby_robot_count: 1,
      nearest_robot_distance_m: 4.0,
      relative_speed_mps: 0.0,
      relative_heading_rad: 0.0,
      relative_direction: 'SAME',
      is_approaching: 0,
      bearing_to_nearest_rad: 0.0,
      ttc_sec: 10.0,
      in_blind_spot: 0,
      path_overlap_flag: 1,
      crossing_conflict_flag: 0,
      head_on_conflict_flag: 0,
      zone_density: 1,
      intersection_proximity_m: 5.0,
      priority_differential: 0
    };

    const predictRes = await httpRequest(`${SERVER_URL}/predict`, { method: 'POST' }, {
      robotId: 'R-RegressionTest',
      features: sampleFeatures
    });

    assert(predictRes.statusCode === 200, 'POST /predict returns HTTP 200');
    assert(predictRes.body?.robotId === 'R-RegressionTest', 'POST /predict echoes robotId');
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predictRes.body?.decision), `POST /predict returns valid decision (${predictRes.body?.decision})`);
    assert(typeof predictRes.body?.confidence === 'number', 'POST /predict returns numeric confidence');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PART 2 & 8 — 3 Robot Clients Connection & Registry
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: Multi-Robot Socket.IO Connections (R1, R2, R3) ---');
  const client1 = createClient('R1');
  const client2 = createClient('R2');
  const client3 = createClient('R3');

  try {
    await Promise.all([
      waitForConnect(client1),
      waitForConnect(client2),
      waitForConnect(client3)
    ]);
    assert(client1.connected, 'Client R1 connected successfully');
    assert(client2.connected, 'Client R2 connected successfully');
    assert(client3.connected, 'Client R3 connected successfully');

    // Verify server registered all 3 in active registry
    const regCheck = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(regCheck.statusCode === 200, 'GET /edge/robots returns HTTP 200');
    assert(regCheck.body?.robots?.R1 !== undefined, 'R1 registered in server Map');
    assert(regCheck.body?.robots?.R2 !== undefined, 'R2 registered in server Map');
    assert(regCheck.body?.robots?.R3 !== undefined, 'R3 registered in server Map');
    assert(regCheck.body?.count >= 3, `Registry count >= 3 (actual: ${regCheck.body?.count})`);

    // ─────────────────────────────────────────────────────────────────────────
    // PART 3, 4 & 5 — STATE_UPDATE and NEIGHBOUR_STATE Events
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: STATE_UPDATE Transmission & NEIGHBOUR_STATE Broadcast ---');
    const r2NeighbourEvents = [];
    const r3NeighbourEvents = [];

    client2.on('NEIGHBOUR_STATE', (data) => {
      r2NeighbourEvents.push(data);
    });
    client3.on('NEIGHBOUR_STATE', (data) => {
      r3NeighbourEvents.push(data);
    });

    const now = Date.now();
    const updateR1 = {
      robotId: 'R1',
      x: 10.5,
      y: 20.5,
      speed: 1.2,
      heading: 0.0,
      battery: 95.0,
      task: 'DELIVER',
      priority: 2,
      status: 'MOVING',
      destination: { x: 30.0, y: 20.5, tileX: 30, tileY: 20 },
      timestamp: now
    };

    const updateR2 = {
      robotId: 'R2',
      x: 15.0,
      y: 20.5,
      speed: 1.0,
      heading: 3.14,
      battery: 88.0,
      task: 'PICKUP',
      priority: 1,
      status: 'MOVING',
      destination: { x: 5.0, y: 20.5, tileX: 5, tileY: 20 },
      timestamp: now + 5
    };

    const updateR3 = {
      robotId: 'R3',
      x: 25.0,
      y: 10.0,
      speed: 0.0,
      heading: 1.57,
      battery: 70.0,
      task: 'IDLE',
      priority: 3,
      status: 'IDLE',
      destination: null,
      timestamp: now + 10
    };

    const [ack1, ack2, ack3] = await Promise.all([
      sendStateUpdate(client1, updateR1),
      sendStateUpdate(client2, updateR2),
      sendStateUpdate(client3, updateR3)
    ]);

    assert(ack1?.success === true, 'R1 STATE_UPDATE acknowledged with success');
    assert(ack2?.success === true, 'R2 STATE_UPDATE acknowledged with success');
    assert(ack3?.success === true, 'R3 STATE_UPDATE acknowledged with success');

    // Wait briefly for event propagation
    await sleep(200);

    // Verify peer event reception
    const receivedFromR1 = r2NeighbourEvents.find((evt) => evt.robotId === 'R1');
    assert(receivedFromR1 !== undefined, 'R2 received NEIGHBOUR_STATE broadcast from R1');
    assert(receivedFromR1?.x === 10.5 && receivedFromR1?.y === 20.5, 'NEIGHBOUR_STATE payload matches R1 coordinates');
    assert(receivedFromR1?.battery === 95.0, 'NEIGHBOUR_STATE payload matches R1 battery');

    const receivedFromR1OnR3 = r3NeighbourEvents.find((evt) => evt.robotId === 'R1');
    assert(receivedFromR1OnR3 !== undefined, 'R3 received NEIGHBOUR_STATE broadcast from R1');

    const receivedFromR2OnR3 = r3NeighbourEvents.find((evt) => evt.robotId === 'R2');
    assert(receivedFromR2OnR3 !== undefined, 'R3 received NEIGHBOUR_STATE broadcast from R2');

    // ─────────────────────────────────────────────────────────────────────────
    // PART 4 — Isolated State Storage in Server Registry
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Isolated State Storage in Server Registry ---');
    const stateCheck = await httpRequest(`${SERVER_URL}/edge/robots`);
    const regR1 = stateCheck.body?.robots?.R1?.state;
    const regR2 = stateCheck.body?.robots?.R2?.state;
    const regR3 = stateCheck.body?.robots?.R3?.state;

    assert(regR1?.x === 10.5 && regR1?.speed === 1.2, 'R1 state stored independently with correct values');
    assert(regR2?.x === 15.0 && regR2?.speed === 1.0, 'R2 state stored independently with correct values');
    assert(regR3?.x === 25.0 && regR3?.destination === null, 'R3 state stored independently with correct values');
    assert(regR1.robotId !== regR2.robotId, 'R1 and R2 remain isolated in registry Map');

    // ─────────────────────────────────────────────────────────────────────────
    // PART 4 — State Update Replacement for Same Robot
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: State Updates Replace Previous State for Same Robot ---');
    const updateR1_v2 = {
      ...updateR1,
      x: 12.0,
      y: 20.5,
      speed: 0.8,
      battery: 94.0,
      timestamp: Date.now()
    };

    const ack1_v2 = await sendStateUpdate(client1, updateR1_v2);
    assert(ack1_v2?.success === true, 'R1 second STATE_UPDATE acknowledged');

    const stateCheck2 = await httpRequest(`${SERVER_URL}/edge/robots`);
    const regR1_v2 = stateCheck2.body?.robots?.R1?.state;
    const regR2_untouched = stateCheck2.body?.robots?.R2?.state;

    assert(regR1_v2?.x === 12.0, 'R1 state updated to new x coordinate (12.0)');
    assert(regR1_v2?.speed === 0.8, 'R1 state updated to new speed (0.8)');
    assert(regR2_untouched?.x === 15.0, 'R2 state remained completely unaffected by R1 update');

    // ─────────────────────────────────────────────────────────────────────────
    // PART 6 — Disconnect Handling & Active Registry Pruning
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: Disconnect Handling & Active Registry Pruning ---');
    let disconnectEventReceived = false;
    let disconnectedRobotId = null;

    client1.on('ROBOT_DISCONNECTED', (data) => {
      disconnectEventReceived = true;
      disconnectedRobotId = data?.robotId;
    });

    // Disconnect R2
    client2.disconnect();
    await sleep(300);

    assert(disconnectEventReceived === true, 'ROBOT_DISCONNECTED event was broadcast');
    assert(disconnectedRobotId === 'R2', 'ROBOT_DISCONNECTED identified robotId: R2');

    // Check registry: R2 must be removed, R1 and R3 must remain
    const regAfterDisconnect = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(regAfterDisconnect.body?.robots?.R2 === undefined, 'R2 removed from active server registry Map');
    assert(regAfterDisconnect.body?.robots?.R1 !== undefined, 'R1 remains active in registry');
    assert(regAfterDisconnect.body?.robots?.R3 !== undefined, 'R3 remains active in registry');
    assert(client1.connected === true, 'Client R1 socket connection remains active');
    assert(client3.connected === true, 'Client R3 socket connection remains active');

    // ─────────────────────────────────────────────────────────────────────────
    // PART 3 & 8 — Malformed Payload Resilience (Server Never Crashes)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 7: Malformed Payload Safety (No Server Crash) ---');
    const malformedPayloads = [
      null,
      'just a string',
      {},
      { robotId: '', x: 10, y: 10, speed: 1, battery: 100, priority: 1, status: 'IDLE', destination: null, timestamp: Date.now() }, // empty robotId
      { robotId: 'R1', x: NaN, y: 10, speed: 1, battery: 100, priority: 1, status: 'IDLE', destination: null, timestamp: Date.now() }, // NaN x
      { robotId: 'R1', x: 10, y: 10, speed: -5, battery: 100, priority: 1, status: 'IDLE', destination: null, timestamp: Date.now() }, // negative speed
      { robotId: 'R1', x: 10, y: 10, speed: 1, battery: 'full', priority: 1, status: 'IDLE', destination: null, timestamp: Date.now() }, // non-numeric battery
      { robotId: 'R1', x: 10, y: 10, speed: 1, battery: 100, priority: 1, status: 'IDLE', destination: null, timestamp: 'invalid_date_abc' } // bad timestamp
    ];

    for (let i = 0; i < malformedPayloads.length; i++) {
      const ack = await sendStateUpdate(client1, malformedPayloads[i]);
      assert(ack?.success === false, `Malformed payload #${i + 1} safely rejected with error: "${ack?.error}"`);
    }

    // Server must still be completely healthy
    const healthAfterMalformed = await httpRequest(`${SERVER_URL}/health`);
    assert(healthAfterMalformed.statusCode === 200 && healthAfterMalformed.body?.status === 'ok', 'Server remains 100% healthy after malformed payloads');

    // ─────────────────────────────────────────────────────────────────────────
    // PART 7 — Staleness Exposure
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 8: Heartbeat & Staleness Exposure ---');
    const robotsList = await httpRequest(`${SERVER_URL}/edge/robots`);
    const r1Record = robotsList.body?.robots?.R1;
    assert(r1Record?.isStale === false, 'Recently active R1 is marked isStale === false');
    assert(typeof r1Record?.lastSeen === 'string', 'Record contains lastSeen ISO timestamp');
    assert(typeof r1Record?.lastSeenMs === 'number', 'Record contains lastSeenMs epoch millis');

    // Clean up initial clients
    client1.disconnect();
    client3.disconnect();
    await sleep(200);

    // ─────────────────────────────────────────────────────────────────────────
    // PART 8 — 5+ Simultaneous Robot Clients Test
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 9: 5 Simultaneous Robot Clients State Exchange ---');
    const fleetIds = ['Fleet-A', 'Fleet-B', 'Fleet-C', 'Fleet-D', 'Fleet-E'];
    const fleetClients = fleetIds.map((id) => createClient(id));

    await Promise.all(fleetClients.map((c) => waitForConnect(c)));
    fleetClients.forEach((c, idx) => {
      assert(c.connected, `${fleetIds[idx]} connected`);
    });

    const fleetNeighbourRecords = {};
    fleetIds.forEach((id) => { fleetNeighbourRecords[id] = []; });

    fleetClients.forEach((client, idx) => {
      const myId = fleetIds[idx];
      client.on('NEIGHBOUR_STATE', (msg) => {
        fleetNeighbourRecords[myId].push(msg);
      });
    });

    // Send state updates from all 5 robots concurrently
    const fleetUpdates = fleetIds.map((id, idx) => ({
      robotId: id,
      x: 10.0 + idx * 5.0,
      y: 20.0,
      speed: 1.0,
      heading: 0.0,
      battery: 100 - idx * 5,
      task: `TASK_${id}`,
      priority: (idx % 3) + 1,
      status: 'MOVING',
      destination: { tileX: 40, tileY: 20 },
      timestamp: Date.now()
    }));

    const acks = await Promise.all(
      fleetClients.map((client, idx) => sendStateUpdate(client, fleetUpdates[idx]))
    );

    acks.forEach((ack, idx) => {
      assert(ack?.success === true, `${fleetIds[idx]} update acknowledged`);
    });

    await sleep(300);

    // Verify registry contains all 5 robots
    const fleetReg = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(fleetReg.body?.count >= 5, `Registry contains at least 5 robots (count: ${fleetReg.body?.count})`);
    fleetIds.forEach((id) => {
      assert(fleetReg.body?.robots?.[id] !== undefined, `${id} stored in registry`);
      assert(fleetReg.body?.robots?.[id]?.state?.task === `TASK_${id}`, `${id} task state verified`);
    });

    // Verify state broadcasting across all 5 clients
    fleetIds.forEach((id) => {
      const receivedOtherCount = fleetNeighbourRecords[id].length;
      assert(receivedOtherCount > 0, `${id} received ${receivedOtherCount} neighbour broadcast events`);
      // Verify no robot received itself as a neighbour
      const selfReceived = fleetNeighbourRecords[id].some((m) => m.robotId === id);
      assert(!selfReceived, `${id} did not receive itself as a neighbour`);
    });

    // Disconnect all fleet clients
    fleetClients.forEach((c) => c.disconnect());
    await sleep(300);

    const regAfterFleet = await httpRequest(`${SERVER_URL}/edge/robots`);
    fleetIds.forEach((id) => {
      assert(regAfterFleet.body?.robots?.[id] === undefined, `${id} cleanly pruned from registry upon disconnect`);
    });

  } finally {
    // Ensure all test clients are disconnected
    client1.disconnect();
    client2.disconnect();
    client3.disconnect();

    if (serverProc) {
      console.log('\n[Teardown] Shutting down spawned server process...');
      serverProc.kill();
    }
  }

  console.log('\n====================================================');
  console.log(`STAGE 5A TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runStage5aTests().catch((err) => {
  console.error('Fatal test error:', err);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
