/**
 * scratch/test_socket_stage5b.mjs
 *
 * Stage 5B Validation Suite:
 * Socket.IO Real-Time Edge Client & Phaser Robot State Publication Integration
 *
 * Verifies:
 * 1. Server is running (or auto-spawned) on http://127.0.0.1:3001
 * 2. At least 3 simulated robot clients (R1, R2, R3) connect via socketClient.js
 * 3. Each robot publishes STATE_UPDATE using real runtime state format
 * 4. Server registry contains the correct isolated state for each robot
 * 5. Updating R1 state does not overwrite R2 or R3
 * 6. Peer NEIGHBOUR_STATE events are received and stored locally in neighbour registry
 * 7. Disconnecting R2 prunes R2 from server registry and local neighbour states of peers
 * 8. Malformed state updates are rejected safely without crashing server
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOrCreateRobotSocket,
  createRobotSocketClient,
  disconnectRobotSocket,
  disconnectAllRobotSockets,
  getNeighbourStates,
  getActiveSocketClients
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

async function waitForCondition(fn, timeoutMs = 4000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function runStage5bTests() {
  console.log('====================================================');
  console.log('STAGE 5B: PHASER ROBOT SOCKET.IO CLIENT TEST SUITE');
  console.log('====================================================\n');

  await ensureServerRunning();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: Server running & healthy
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 1: Verify Server Running ---');
    const health = await httpRequest(`${SERVER_URL}/health`);
    assert(health.statusCode === 200, 'Edge server responds with HTTP 200');
    assert(health.body?.status === 'ok', 'Edge server reports status "ok"');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Connect at least 3 simulated robot clients
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Connect 3 Simulated Robot Clients (R1, R2, R3) ---');
    const client1 = getOrCreateRobotSocket('R1');
    const client2 = getOrCreateRobotSocket('R2');
    const client3 = createRobotSocketClient('R3');

    // Wait for all 3 clients to establish WebSocket connection
    await waitForCondition(() => client1.isConnected() && client2.isConnected() && client3.isConnected(), 4000);

    assert(client1.isConnected(), 'Client R1 is connected');
    assert(client2.isConnected(), 'Client R2 is connected');
    assert(client3.isConnected(), 'Client R3 is connected');
    assert(getActiveSocketClients().size === 3, 'Active clients map contains 3 robots');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: Each robot sends STATE_UPDATE with real runtime state format
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Publish STATE_UPDATE for Each Robot ---');
    const now = Date.now();

    const stateR1 = {
      x: 320.0,
      y: 160.0,
      speed: 1.0,
      heading: 0.0,
      battery: 98.0,
      task: 'General Transport',
      priority: 1,
      status: 'MOVING',
      destination: { x: 640.0, y: 160.0, tileX: 20, tileY: 5 },
      timestamp: now
    };

    const stateR2 = {
      x: 480.0,
      y: 200.0,
      speed: 0.5,
      heading: 1.57,
      battery: 85.5,
      task: 'Priority Delivery',
      priority: 2,
      status: 'SLOW',
      destination: { x: 480.0, y: 400.0, tileX: 15, tileY: 12 },
      timestamp: now + 2
    };

    const stateR3 = {
      x: 100.0,
      y: 100.0,
      speed: 0.0,
      heading: 3.14,
      battery: 60.0,
      task: 'Idle Wait',
      priority: 1,
      status: 'IDLE',
      destination: null,
      timestamp: now + 4
    };

    // Send with ack verification
    const sendWithAck = (client, state) => new Promise((resolve) => {
      const sent = client.sendState(state, (ack) => resolve(ack));
      if (!sent) resolve({ success: false, error: 'Send returned false' });
    });

    const [ack1, ack2, ack3] = await Promise.all([
      sendWithAck(client1, stateR1),
      sendWithAck(client2, stateR2),
      sendWithAck(client3, stateR3)
    ]);

    assert(ack1?.success === true, 'R1 STATE_UPDATE acknowledged by server');
    assert(ack2?.success === true, 'R2 STATE_UPDATE acknowledged by server');
    assert(ack3?.success === true, 'R3 STATE_UPDATE acknowledged by server');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Server registry contains the correct isolated state for each robot
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Server Registry Verification ---');
    await sleep(150);
    const regRes = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(regRes.statusCode === 200, 'GET /edge/robots returns 200');

    const robotsOnServer = regRes.body?.robots || {};
    assert(robotsOnServer.R1 !== undefined, 'R1 exists in server registry');
    assert(robotsOnServer.R2 !== undefined, 'R2 exists in server registry');
    assert(robotsOnServer.R3 !== undefined, 'R3 exists in server registry');

    assert(robotsOnServer.R1.state.x === 320.0, 'R1 coordinate x is 320.0');
    assert(robotsOnServer.R1.state.battery === 98.0, 'R1 battery is 98.0');
    assert(robotsOnServer.R2.state.speed === 0.5, 'R2 speed is 0.5');
    assert(robotsOnServer.R2.state.status === 'SLOW', 'R2 status is SLOW');
    assert(robotsOnServer.R3.state.destination === null, 'R3 destination is null');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Changing R1 state does not overwrite R2 or R3
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: State Modification Isolation ---');
    const stateR1_updated = {
      ...stateR1,
      x: 352.0,
      y: 160.0,
      speed: 0.8,
      timestamp: Date.now()
    };

    const ack1_v2 = await sendWithAck(client1, stateR1_updated);
    assert(ack1_v2?.success === true, 'R1 update acknowledged');

    await sleep(150);
    const regRes2 = await httpRequest(`${SERVER_URL}/edge/robots`);
    const sR1 = regRes2.body?.robots?.R1?.state;
    const sR2 = regRes2.body?.robots?.R2?.state;
    const sR3 = regRes2.body?.robots?.R3?.state;

    assert(sR1?.x === 352.0, 'R1 coordinate x updated to 352.0');
    assert(sR1?.speed === 0.8, 'R1 speed updated to 0.8');
    assert(sR2?.x === 480.0 && sR2?.speed === 0.5, 'R2 state completely unmodified');
    assert(sR3?.x === 100.0 && sR3?.speed === 0.0, 'R3 state completely unmodified');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: Peer NEIGHBOUR_STATE events are received and stored locally
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: Local Neighbour State Reception ---');
    // Wait for event propagation to local caches
    await waitForCondition(() => {
      const n2 = client2.getNeighbourStates();
      return n2.R1 !== undefined;
    }, 2000);

    const n2States = client2.getNeighbourStates();
    const n3States = client3.getNeighbourStates();
    const n1States = client1.getNeighbourStates();

    assert(n2States.R1 !== undefined, 'Client R2 has cached neighbour state for R1');
    assert(n2States.R1.x === 352.0, 'R2 neighbour cache reflects R1 updated position (352.0)');
    assert(n2States.R2 === undefined, 'Client R2 does NOT contain itself in neighbour cache');

    assert(n3States.R1 !== undefined, 'Client R3 has cached neighbour state for R1');
    assert(n3States.R2 !== undefined, 'Client R3 has cached neighbour state for R2');

    assert(n1States.R2 !== undefined, 'Client R1 has cached neighbour state for R2');
    assert(n1States.R3 !== undefined, 'Client R1 has cached neighbour state for R3');

    // Verify getter function getNeighbourStates()
    const r1NeighboursViaGetter = getNeighbourStates('R1');
    assert(r1NeighboursViaGetter.R2 !== undefined, 'getNeighbourStates("R1") returns R2');

    const allNeighbours = getNeighbourStates();
    assert(allNeighbours.R1 !== undefined && allNeighbours.R2 !== undefined, 'getNeighbourStates() aggregates peers');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Disconnecting R2 removes R2 from server registry & local neighbour states
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 7: Disconnect Handling & Local Peer Pruning ---');
    disconnectRobotSocket('R2');
    assert(!client2.isConnected(), 'Client R2 is disconnected');
    assert(getActiveSocketClients().has('R2') === false, 'R2 removed from activeSocketClients map');

    // Wait for server to process disconnect and broadcast ROBOT_DISCONNECTED
    await waitForCondition(() => {
      const n1 = client1.getNeighbourStates();
      return n1.R2 === undefined;
    }, 2000);

    const n1AfterDisconnect = client1.getNeighbourStates();
    const n3AfterDisconnect = client3.getNeighbourStates();

    assert(n1AfterDisconnect.R2 === undefined, 'R2 pruned from R1 local neighbour cache');
    assert(n3AfterDisconnect.R2 === undefined, 'R2 pruned from R3 local neighbour cache');
    assert(n1AfterDisconnect.R3 !== undefined, 'R3 remains active in R1 neighbour cache');

    // Check server registry
    const regResAfterDisconnect = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(regResAfterDisconnect.body?.robots?.R2 === undefined, 'R2 pruned from server registry');
    assert(regResAfterDisconnect.body?.robots?.R1 !== undefined, 'R1 still active in server registry');
    assert(regResAfterDisconnect.body?.robots?.R3 !== undefined, 'R3 still active in server registry');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Malformed state still does not crash server
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 8: Malformed State Safety ---');
    const malformed1 = {
      x: 'not_a_number',
      y: 100,
      speed: -20,
      battery: 'full'
    };

    const ackMalformed = await sendWithAck(client1, malformed1);
    assert(ackMalformed?.success === false, 'Malformed state safely rejected with error');

    // Server must still be healthy
    const healthAfter = await httpRequest(`${SERVER_URL}/health`);
    assert(healthAfter.statusCode === 200 && healthAfter.body?.status === 'ok', 'Server remains 100% operational');

  } finally {
    console.log('\n[Teardown] Disconnecting all robot sockets...');
    disconnectAllRobotSockets();

    if (serverProc) {
      console.log('[Teardown] Terminating spawned test server...');
      serverProc.kill();
    }
  }

  console.log('\n====================================================');
  console.log(`STAGE 5B TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runStage5bTests().catch((err) => {
  console.error('Fatal test error:', err);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
