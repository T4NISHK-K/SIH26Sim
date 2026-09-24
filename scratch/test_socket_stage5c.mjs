/**
 * scratch/test_socket_stage5c.mjs
 *
 * Stage 5C Validation Suite:
 * Dynamic Interaction Radius (DIR) + Relevant-Neighbour Filtering
 *
 * Verifies:
 * TEST 1: 3 robots close together -> all relevant neighbours returned
 * TEST 2: 3 robots far apart -> far robots are excluded
 * TEST 3: One robot close, one far -> only close robot is relevant
 * TEST 4: Dynamic radius changes with robot speed (faster -> larger radius)
 * TEST 5: Fleet density expands interaction radius according to DIR formula
 * TEST 6: Boundary behavior: d <= DIR included, d > DIR excluded
 * TEST 7: Self robot is never included in relevant neighbours
 * TEST 8: Disconnected robot is removed from relevant neighbours
 * TEST 9: Stale robot is safely excluded from relevant neighbours
 * TEST 10: Existing Stage 5A/5B Socket.IO communication & endpoints preserved
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
  getRelevantNeighbourStates,
  getDynamicInteractionRadius,
  DIR_CONFIG,
  computeDynamicInteractionRadius,
  toMetersCoords,
  computeDistanceMeters,
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

async function runStage5cTests() {
  console.log('====================================================');
  console.log('STAGE 5C: DYNAMIC INTERACTION RADIUS & RELEVANT NEIGHBOURS');
  console.log('====================================================\n');

  await ensureServerRunning();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: 3 Robots Close Together -> All relevant neighbours returned
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 1: 3 Robots Close Together ---');
    const c1 = getOrCreateRobotSocket('R1');
    const c2 = getOrCreateRobotSocket('R2');
    const c3 = getOrCreateRobotSocket('R3');

    await waitForCondition(() => c1.isConnected() && c2.isConnected() && c3.isConnected(), 4000);

    const now = Date.now();
    // R1 at (10, 10), R2 at (12, 10) [dist 2.0m], R3 at (10, 13) [dist 3.0m]
    await Promise.all([
      sendWithAck(c1, { x: 10.0, y: 10.0, speed: 1.0, priority: 1, status: 'MOVING', timestamp: now }),
      sendWithAck(c2, { x: 12.0, y: 10.0, speed: 1.0, priority: 2, status: 'MOVING', timestamp: now }),
      sendWithAck(c3, { x: 10.0, y: 13.0, speed: 1.0, priority: 3, status: 'MOVING', timestamp: now })
    ]);

    await waitForCondition(() => {
      const rel = getRelevantNeighbourStates('R1');
      return rel.R2 !== undefined && rel.R3 !== undefined;
    }, 2000);

    const rel1 = getRelevantNeighbourStates('R1');
    assert(rel1.R2 !== undefined, 'R2 is returned as relevant neighbour to R1 (2.0m away)');
    assert(rel1.R3 !== undefined, 'R3 is returned as relevant neighbour to R1 (3.0m away)');
    assert(rel1.R2.distance_to_robot_m === 2.0, 'R2 distance is exactly 2.0m');
    assert(rel1.R3.distance_to_robot_m === 3.0, 'R3 distance is exactly 3.0m');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: 3 Robots Far Apart -> Far robots excluded
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: 3 Robots Far Apart ---');
    // R1 at (10, 10), R2 at (45, 10) [dist 35.0m], R3 at (10, 40) [dist 30.0m]
    await Promise.all([
      sendWithAck(c1, { x: 10.0, y: 10.0, speed: 0.5, priority: 1, status: 'MOVING', timestamp: Date.now() }),
      sendWithAck(c2, { x: 45.0, y: 10.0, speed: 0.5, priority: 2, status: 'MOVING', timestamp: Date.now() }),
      sendWithAck(c3, { x: 10.0, y: 40.0, speed: 0.5, priority: 3, status: 'MOVING', timestamp: Date.now() })
    ]);

    await waitForCondition(() => {
      const rel = getRelevantNeighbourStates('R1');
      return Object.keys(rel).length === 0;
    }, 2000);

    const relFar = getRelevantNeighbourStates('R1');
    assert(Object.keys(relFar).length === 0, 'No relevant neighbours returned when all peers are outside DIR');
    assert(relFar.R2 === undefined, 'Far R2 (35m) is excluded');
    assert(relFar.R3 === undefined, 'Far R3 (30m) is excluded');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: One Close, One Far -> Only close robot is relevant
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: One Robot Close, One Far ---');
    // R1 at (10, 10), R2 at (13, 10) [dist 3.0m], R3 at (45, 10) [dist 35.0m]
    await Promise.all([
      sendWithAck(c1, { x: 10.0, y: 10.0, speed: 1.0, priority: 1, status: 'MOVING', timestamp: Date.now() }),
      sendWithAck(c2, { x: 13.0, y: 10.0, speed: 1.0, priority: 2, status: 'MOVING', timestamp: Date.now() }),
      sendWithAck(c3, { x: 45.0, y: 10.0, speed: 1.0, priority: 3, status: 'MOVING', timestamp: Date.now() })
    ]);

    await waitForCondition(() => {
      const rel = getRelevantNeighbourStates('R1');
      return rel.R2 !== undefined && rel.R3 === undefined;
    }, 2000);

    const relMixed = getRelevantNeighbourStates('R1');
    assert(relMixed.R2 !== undefined, 'Close robot R2 (3.0m) is included in relevant neighbours');
    assert(relMixed.R3 === undefined, 'Far robot R3 (35.0m) is excluded from relevant neighbours');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Dynamic Radius Changes with Robot Speed
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Dynamic Radius vs Robot Speed ---');
    // Formula: R = clip(5.0 + 1.5 * v + 1.0 * rho, 5.0, 20.0)
    const dir0 = computeDynamicInteractionRadius(0.0, 0);
    const dir1 = computeDynamicInteractionRadius(1.0, 0);
    const dir2 = computeDynamicInteractionRadius(2.0, 0);

    assert(dir0 === 5.0, `DIR at 0.0 m/s is 5.0m (got ${dir0})`);
    assert(dir1 === 6.5, `DIR at 1.0 m/s is 6.5m (got ${dir1})`);
    assert(dir2 === 8.0, `DIR at 2.0 m/s is 8.0m (got ${dir2})`);
    assert(dir2 > dir1 && dir1 > dir0, 'Faster speed strictly yields larger interaction radius');

    // Test spatial effect: place R2 at dist = 7.0m (x = 17.0, y = 10.0)
    // At speed 0.0 (DIR=5.0m): R2 excluded
    // At speed 1.0 (DIR=6.5m): R2 excluded
    // At speed 2.0 (DIR=8.0m): R2 INCLUDED!
    await sendWithAck(c2, { x: 17.0, y: 10.0, speed: 0.0, priority: 2, status: 'IDLE', timestamp: Date.now() });

    // R1 at speed 0.5 (DIR = 5.75m) -> R2 at 7.0m excluded
    await sendWithAck(c1, { x: 10.0, y: 10.0, speed: 0.5, priority: 1, status: 'MOVING', timestamp: Date.now() });
    await sleep(150);
    const relSlow = getRelevantNeighbourStates('R1');
    assert(relSlow.R2 === undefined, 'R2 at 7.0m is excluded when R1 is moving slowly (DIR = 5.75m)');

    // R1 accelerates to 2.0 m/s (DIR = 8.0m) -> R2 at 7.0m included!
    await sendWithAck(c1, { x: 10.0, y: 10.0, speed: 2.0, priority: 1, status: 'MOVING', timestamp: Date.now() });
    await sleep(150);
    const relFast = getRelevantNeighbourStates('R1');
    assert(relFast.R2 !== undefined, 'R2 at 7.0m is dynamically included when R1 speeds up to 2.0 m/s (DIR = 8.0m)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Fleet Density Expands Interaction Radius
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Density Expands Interaction Radius ---');
    // rho = number of peers within DENSITY_RADIUS (8.0m)
    // Formula: R = clip(5.0 + 1.5 * v + 1.0 * rho, 5.0, 20.0)
    const dirRho0 = computeDynamicInteractionRadius(1.0, 0); // 6.5m
    const dirRho2 = computeDynamicInteractionRadius(1.0, 2); // 8.5m
    const dirRho4 = computeDynamicInteractionRadius(1.0, 4); // 10.5m

    assert(dirRho0 === 6.5, `DIR at rho=0 is 6.5m (got ${dirRho0})`);
    assert(dirRho2 === 8.5, `DIR at rho=2 is 8.5m (got ${dirRho2})`);
    assert(dirRho4 === 10.5, `DIR at rho=4 is 10.5m (got ${dirRho4})`);
    assert(dirRho4 > dirRho2 && dirRho2 > dirRho0, 'Higher density expands interaction radius according to DIR formulation');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: Boundary Behavior (Consistent Inclusion / Exclusion at Limit)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: Boundary Behavior at Interaction Radius ---');
    // R1 at (10, 10), speed 0.0. With 1 peer within 8.0m (density radius), rho = 1 -> DIR = 5.0 + 1.0 = 6.0m
    await sendWithAck(c1, { x: 10.0, y: 10.0, speed: 0.0, priority: 1, status: 'IDLE', timestamp: Date.now() });

    // Place R2 exactly at 6.000m (x = 16.0, y = 10.0) -> dist = 6.0m <= DIR (6.0m) -> INCLUDED
    await sendWithAck(c2, { x: 16.0, y: 10.0, speed: 0.0, priority: 2, status: 'IDLE', timestamp: Date.now() });
    await sleep(150);
    const relBoundaryIn = getRelevantNeighbourStates('R1');
    assert(relBoundaryIn.R2 !== undefined, 'Peer at exactly distance == DIR (6.0m with rho=1) is included (boundary inclusive)');

    // Place R2 at 6.05m (x = 16.05, y = 10.0) -> dist = 6.05m > DIR (6.0m) -> EXCLUDED
    await sendWithAck(c2, { x: 16.05, y: 10.0, speed: 0.0, priority: 2, status: 'IDLE', timestamp: Date.now() });
    await sleep(150);
    const relBoundaryOut = getRelevantNeighbourStates('R1');
    assert(relBoundaryOut.R2 === undefined, 'Peer just beyond DIR (6.05m vs 6.0m) is safely excluded');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Self Robot is Never Included
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 7: Self Robot Exclusion ---');
    const r1Rel = getRelevantNeighbourStates('R1');
    const r2Rel = getRelevantNeighbourStates('R2');
    const r3Rel = getRelevantNeighbourStates('R3');

    assert(r1Rel.R1 === undefined, 'R1 is not in R1 relevant neighbours');
    assert(r2Rel.R2 === undefined, 'R2 is not in R2 relevant neighbours');
    assert(r3Rel.R3 === undefined, 'R3 is not in R3 relevant neighbours');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Disconnected Robot is Removed from Relevant Neighbours
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 8: Disconnect Prunes from Relevant Neighbours ---');
    // Bring R2 back close to R1 (2m away)
    await sendWithAck(c2, { x: 12.0, y: 10.0, speed: 1.0, priority: 2, status: 'MOVING', timestamp: Date.now() });
    await waitForCondition(() => getRelevantNeighbourStates('R1').R2 !== undefined, 2000);
    assert(getRelevantNeighbourStates('R1').R2 !== undefined, 'R2 is initially active relevant neighbour');

    // Disconnect R2
    disconnectRobotSocket('R2');
    await waitForCondition(() => getRelevantNeighbourStates('R1').R2 === undefined, 2000);

    const relAfterDisconnect = getRelevantNeighbourStates('R1');
    assert(relAfterDisconnect.R2 === undefined, 'Disconnected R2 is pruned from R1 relevant neighbours');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9: Stale Robot is Excluded from Relevant Neighbours
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 9: Stale State Safety ---');
    // Reconnect R2
    const c2Reconnected = getOrCreateRobotSocket('R2');
    await waitForCondition(() => c2Reconnected.isConnected(), 4000);

    // Send update from R2 with timestamp older than STALE_TIMEOUT_MS (10s)
    const staleTime = Date.now() - (STALE_TIMEOUT_MS + 2000);
    // Manually inject a stale entry into R1's neighbour cache to simulate stale dropped communication
    c1.neighbourStates.set('R2', {
      robotId: 'R2',
      x: 12.0,
      y: 10.0,
      speed: 1.0,
      status: 'MOVING',
      timestamp: staleTime,
      localReceivedAt: staleTime
    });

    const relStale = getRelevantNeighbourStates('R1');
    assert(relStale.R2 === undefined, 'Stale neighbour (>10s old) is excluded from relevant neighbours');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 10: Existing Stage 5A/5B Socket.IO Communication Preserved
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 10: Stage 5A/5B Compatibility & Raw State Access ---');
    // Raw neighbour getter preserves all received neighbour states
    const rawAll = getNeighbourStates('R1');
    assert(rawAll.R2 !== undefined, 'Raw getNeighbourStates("R1") retains raw state regardless of spatial distance');

    // Server health and endpoints
    const health = await httpRequest(`${SERVER_URL}/health`);
    assert(health.statusCode === 200, 'GET /health returns HTTP 200');
    assert(health.body?.status === 'ok', 'Server status is "ok"');

    const edgeRobots = await httpRequest(`${SERVER_URL}/edge/robots`);
    assert(edgeRobots.statusCode === 200, 'GET /edge/robots returns HTTP 200');
    assert(edgeRobots.body?.robots?.R1 !== undefined, 'R1 registered in edge coordinator');

  } finally {
    console.log('\n[Teardown] Disconnecting all robot sockets...');
    disconnectAllRobotSockets();

    if (serverProc) {
      console.log('[Teardown] Terminating spawned test server...');
      serverProc.kill();
    }
  }

  console.log('\n====================================================');
  console.log(`STAGE 5C TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runStage5cTests().catch((err) => {
  console.error('Fatal test error:', err);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
