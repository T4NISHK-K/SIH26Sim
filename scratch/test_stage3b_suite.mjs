import { buildRobotFeatures, V2_FEATURE_KEYS, mapTaskType, normalizeAngle } from '../src/network/edgeClient.js';
import http from 'node:http';
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
console.log('STAGE 3B VALIDATION TEST SUITE');
console.log('====================================================\n');

// ----------------------------------------------------
// TEST 8: Verify Feature Key Count and Exact Key Set
// ----------------------------------------------------
console.log('--- TEST 8: Feature Schema & Key Verification ---');
assert(V2_FEATURE_KEYS.length === 26, `V2_FEATURE_KEYS must have 26 keys (got ${V2_FEATURE_KEYS.length})`);

const dummyRobot = {
  id: 'Robot-01',
  x: 816, // (816 - 16) / 32 = 25
  y: 496, // (496 - 16) / 32 = 15
  destination: { tileX: 45, tileY: 35 },
  speed: 100,
  battery: 90,
  task: 'DELIVER',
  priority: 3
};

const dummyFeatures = buildRobotFeatures(dummyRobot, { 'Robot-01': dummyRobot }, [], null);
const generatedKeys = Object.keys(dummyFeatures);
assert(generatedKeys.length === 26, `buildRobotFeatures output must have 26 keys (got ${generatedKeys.length})`);

for (const expectedKey of V2_FEATURE_KEYS) {
  assert(expectedKey in dummyFeatures, `Key "${expectedKey}" must be present in output`);
}

// Ensure old V1 keys are strictly ABSENT
const forbiddenKeys = [
  'direction', 'congestion_score', 'collision_risk', 'deadlock_risk',
  'waiting_time_sec', 'charging_required', 'route_length_m'
];
for (const fk of forbiddenKeys) {
  assert(!(fk in dummyFeatures), `Old V1 key "${fk}" must NOT be present`);
}

// ----------------------------------------------------
// TEST 4: No-Neighbour Robot Case Verification
// ----------------------------------------------------
console.log('\n--- TEST 4: No-Neighbour Robot Fallbacks ---');
const isolatedRobot = {
  id: 'Robot-Solo',
  x: 816,
  y: 496,
  destination: { tileX: 45, tileY: 35 },
  speed: 100,
  battery: 100,
  task: 'Pickup',
  priority: 2
};

const soloFeatures = buildRobotFeatures(isolatedRobot, { 'Robot-Solo': isolatedRobot }, [], null);
assert(soloFeatures.nearby_robot_count === 0, 'nearby_robot_count must be 0 for solo robot');
assert(soloFeatures.nearest_robot_distance_m === 99.0, `nearest_robot_distance_m must default to 99.0 (got ${soloFeatures.nearest_robot_distance_m})`);
assert(soloFeatures.nearest_robot_relative_speed_mps === 0.0, 'nearest_robot_relative_speed_mps must default to 0.0');
assert(soloFeatures.nearest_robot_relative_heading_rad === 0.0, 'nearest_robot_relative_heading_rad must default to 0.0');
assert(soloFeatures.closing_velocity_mps === 0.0, 'closing_velocity_mps must default to 0.0');
assert(soloFeatures.true_ttc_sec === 99.0, 'true_ttc_sec must default to 99.0');
assert(soloFeatures.cpa_time_sec === 0.0, 'cpa_time_sec must default to 0.0');
assert(soloFeatures.cpa_distance_m === 99.0, 'cpa_distance_m must default to 99.0');
assert(soloFeatures.relative_direction === 'NONE', 'relative_direction must default to NONE');
assert(soloFeatures.intersection_conflict === 0, 'intersection_conflict must default to 0');
assert(soloFeatures.traffic_level === 'LOW', 'traffic_level must default to LOW');
assert(soloFeatures.dynamic_interaction_radius_m === 6.5, `dynamic_interaction_radius_m with speed=1.0 and rho=0 must be 6.5 (got ${soloFeatures.dynamic_interaction_radius_m})`);

// ----------------------------------------------------
// TEST 5: Approaching / Head-on Robots Kinematics
// ----------------------------------------------------
console.log('\n--- TEST 5: Two Approaching Robots Kinematics ---');
// Robot A at (20, 50) moving East (speed 1.0 m/s) towards (80, 50)
const robotA = {
  id: 'Robot-A',
  x: 20 * 32 + 16,
  y: 50 * 32 + 16,
  path: [{ tileX: 25, tileY: 50 }],
  destination: { tileX: 80, tileY: 50 },
  speed: 100, // 1.0 m/s
  task: 'DELIVER'
};

// Robot B at (25, 50) moving West (speed 1.0 m/s) towards (10, 50)
const robotB = {
  id: 'Robot-B',
  x: 25 * 32 + 16,
  y: 50 * 32 + 16,
  path: [{ tileX: 20, tileY: 50 }],
  destination: { tileX: 10, tileY: 50 },
  speed: 100, // 1.0 m/s
  task: 'PICK'
};

const fleetHeadOn = { 'Robot-A': robotA, 'Robot-B': robotB };
const featA = buildRobotFeatures(robotA, fleetHeadOn, [], null);

assert(featA.nearby_robot_count === 1, `Robot-A should detect 1 neighbor (got ${featA.nearby_robot_count})`);
assert(featA.nearest_robot_distance_m === 5.0, `Distance should be 5.0m (got ${featA.nearest_robot_distance_m})`);
assert(featA.nearest_robot_relative_speed_mps > 1.9, `Relative speed should be ~2.0 m/s (got ${featA.nearest_robot_relative_speed_mps})`);
assert(featA.closing_velocity_mps > 1.9, `Closing velocity should be ~2.0 m/s (got ${featA.closing_velocity_mps})`);
assert(featA.true_ttc_sec > 2.0 && featA.true_ttc_sec < 3.0, `TTC should be ~2.5s (got ${featA.true_ttc_sec})`);
assert(featA.cpa_distance_m < 0.1, `CPA distance should be ~0.0m on head-on collision (got ${featA.cpa_distance_m})`);
assert(featA.relative_direction === 'OPPOSITE', `Relative direction should be OPPOSITE (got ${featA.relative_direction})`);

// ----------------------------------------------------
// TEST 6: Crossing Robots Conflict Detection
// ----------------------------------------------------
console.log('\n--- TEST 6: Crossing Robots Conflict ---');
const crossConflict = [
  {
    type: 'vertex',
    robotA: 'Robot-A',
    robotB: 'Robot-C',
    tileX: 30,
    tileY: 50,
    timeA: 2.0,
    timeB: 2.0
  }
];

const robotC = {
  id: 'Robot-C',
  x: 30 * 32 + 16,
  y: 45 * 32 + 16,
  path: [{ tileX: 30, tileY: 55 }],
  destination: { tileX: 30, tileY: 60 },
  speed: 100
};

const fleetCross = { 'Robot-A': robotA, 'Robot-C': robotC };
const featCross = buildRobotFeatures(robotA, fleetCross, crossConflict, null);
assert(featCross.intersection_conflict === 1, `intersection_conflict must be 1 for active crossing conflict (got ${featCross.intersection_conflict})`);

// ----------------------------------------------------
// TEST 7: Categorical Mapping & Sanitization
// ----------------------------------------------------
console.log('\n--- TEST 7: Categorical Mapping ---');
assert(mapTaskType('DELIVER') === 'DROP', 'DELIVER maps to DROP');
assert(mapTaskType('Pickup') === 'PICK', 'Pickup maps to PICK');
assert(mapTaskType('Charging') === 'CHARGE', 'Charging maps to CHARGE');
assert(mapTaskType('Warehouse Transfer') === 'RELOCATE', 'Warehouse Transfer maps to RELOCATE');
assert(mapTaskType('General Transport') === 'DROP', 'General Transport maps to DROP');
assert(mapTaskType('UnknownTask') === 'DROP', 'UnknownTask safely defaults to DROP');

// Now test HTTP endpoints
console.log('\n--- Starting Edge Server on Port 3001 for HTTP Integration Tests ---');
const serverProc = spawn('node', ['server/index.js'], { cwd: rootDir, stdio: 'inherit' });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runHttpTests() {
  await sleep(1500); // Give server and Python predictor time to spawn

  try {
    // ----------------------------------------------------
    // TEST 1: GET /health
    // ----------------------------------------------------
    console.log('\n--- TEST 1: GET /health ---');
    const healthRes = await fetch('http://127.0.0.1:3001/health');
    assert(healthRes.ok, `GET /health should return 200 OK (got ${healthRes.status})`);
    const healthData = await healthRes.json();
    assert(healthData.status === 'ok', `healthData.status should be 'ok'`);
    assert(healthData.predictorReady === true, `healthData.predictorReady should be true`);

    // ----------------------------------------------------
    // TEST 2: Known Synthetic V2 Feature Object
    // ----------------------------------------------------
    console.log('\n--- TEST 2: POST /predict with Synthetic V2 Object ---');
    const predRes1 = await fetch('http://127.0.0.1:3001/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        robotId: 'Robot-Solo',
        features: soloFeatures
      })
    });
    assert(predRes1.ok, `POST /predict should return 200 OK (got ${predRes1.status})`);
    const predData1 = await predRes1.json();
    console.log('Solo Robot Prediction:', predData1);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predData1.decision), `decision must be valid action (got ${predData1.decision})`);
    assert(typeof predData1.confidence === 'number' && predData1.confidence >= 0 && predData1.confidence <= 1, `confidence must be between 0 and 1 (got ${predData1.confidence})`);

    // ----------------------------------------------------
    // TEST 3: Contract Validation Sample
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Exact V2 Contract Validation Sample ---');
    const contractSample = {
      current_x: 25,
      current_y: 15,
      destination_x: 45,
      destination_y: 35,
      distance_to_destination_m: 28.28,
      eta_sec: 28.3,
      speed_mps: 1.0,
      heading_rad: 0.7854,
      battery_pct: 90,
      obstacle_detected: 1,
      path_blocked: 1,
      alternative_route_available: 1,
      dynamic_interaction_radius_m: 6.5,
      nearby_robot_count: 1,
      nearest_robot_distance_m: 2.5,
      nearest_robot_relative_speed_mps: 0.5,
      nearest_robot_relative_heading_rad: 3.1415,
      closing_velocity_mps: 1.5,
      true_ttc_sec: 1.67,
      cpa_time_sec: 1.5,
      cpa_distance_m: 0.5,
      intersection_conflict: 1,
      task_type: 'DROP',
      task_priority: 'HIGH',
      traffic_level: 'MEDIUM',
      relative_direction: 'OPPOSITE'
    };

    const predRes3 = await fetch('http://127.0.0.1:3001/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        robotId: 'Robot-Contract',
        features: contractSample
      })
    });
    assert(predRes3.ok, `POST /predict should return 200 OK for contract sample`);
    const predData3 = await predRes3.json();
    console.log('Contract Validation Prediction:', predData3);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predData3.decision), `decision must be valid action (got ${predData3.decision})`);
    assert(typeof predData3.confidence === 'number' && predData3.confidence >= 0 && predData3.confidence <= 1, `confidence must be between 0 and 1 (got ${predData3.confidence})`);

    // ----------------------------------------------------
    // TEST 7B: Verify Unsupported Categorical in Request is Safely Handled
    // ----------------------------------------------------
    console.log('\n--- TEST 7B: Unsupported Categorical Request ---');
    const weirdSample = {
      ...contractSample,
      task_type: 'STRANGE_TASK',
      relative_direction: 'PERPENDICULAR'
    };
    const predRes7 = await fetch('http://127.0.0.1:3001/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        robotId: 'Robot-Weird',
        features: weirdSample
      })
    });
    assert(predRes7.ok, `POST /predict with strange categorical should succeed`);
    const predData7 = await predRes7.json();
    console.log('Sanitized Prediction:', predData7);
    assert(!predData7.error, `No error should occur when categorical is sanitized`);
    assert(['MOVE', 'SLOW', 'WAIT', 'REROUTE'].includes(predData7.decision), `decision must be valid`);

  } catch (err) {
    console.error('HTTP Test Exception:', err);
    failures++;
  } finally {
    serverProc.kill();
    console.log('\n====================================================');
    console.log(`TEST SUITE COMPLETED with ${failures} failure(s)`);
    console.log('====================================================');
    process.exit(failures > 0 ? 1 : 0);
  }
}

runHttpTests();
