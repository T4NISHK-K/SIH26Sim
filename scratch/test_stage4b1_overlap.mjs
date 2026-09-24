/**
 * scratch/test_stage4b1_overlap.mjs
 *
 * Stage 4B.1 Focused Verification Suite:
 * Tests that robot center-to-center distance NEVER drops below 64px (2.0m),
 * completely preventing visual sprite overlap across all interaction patterns.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runPairedBenchmark } from '../src/simulation/benchmarkHarness.js';

const tmjPath = path.resolve('map/warehousemap.tmj');
const mapData = JSON.parse(fs.readFileSync(tmjPath, 'utf8'));

let passed = 0;
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  passed++;
  console.log(`PASS: ${message}`);
}

console.log('='.repeat(70));
console.log('STAGE 4B.1: ROBOT OVERLAP & CONTINUOUS SEPARATION TEST SUITE');
console.log('='.repeat(70));

// ── 1. Single Robot Movement ────────────────────────────────────────────────
console.log('\n--- Test 1: Single Robot Nominal Movement ---');
{
  const scn1 = {
    name: 'Single Robot Nominal Movement',
    robots: [
      { robotId: 'R-Solo', start: { tileX: 10, tileY: 28 }, destination: { tileX: 20, tileY: 28 }, speed: 100 }
    ]
  };
  const res = await runPairedBenchmark(scn1, { mapData, verbose: false });
  assert(res.ares.missions_completed === 1, 'Single robot completes mission');
  assert(res.ares.collision_events === 0, 'Zero collisions for single robot');
  assert(Math.abs(res.ares.total_distance_m - res.baseline.total_distance_m) < 0.1, 'Nominal distance preserved');
}

// ── 2. Two Robots Same-Direction (Following) ────────────────────────────────
console.log('\n--- Test 2: Two Robots Same-Direction (Faster Pursuer Behind Slower Lead) ---');
{
  const scn2 = {
    name: 'Same-Direction Following',
    robots: [
      { robotId: 'R1-Lead', start: { tileX: 20, tileY: 28 }, destination: { tileX: 40, tileY: 28 }, speed: 70, priority: 1 },
      { robotId: 'R2-Pursuer', start: { tileX: 10, tileY: 28 }, destination: { tileX: 40, tileY: 28 }, speed: 130, priority: 2 }
    ]
  };
  const res = await runPairedBenchmark(scn2, { mapData, verbose: false });
  assert(res.ares.collision_events === 0, 'Zero collision events in following');
  assert(res.ares.near_collision_events === 0, 'Zero near-collision events in following');
  // Visual overlap threshold: 64px = 2.0m
  assert(res.ares.minimum_separation_m >= 2.0, `Minimum separation >= 2.0m (got ${res.ares.minimum_separation_m}m) - ZERO visual overlap`);
  assert(res.ares.missions_completed === 2, 'Both robots complete missions');
}

// ── 3. Two Robots Head-On Corridor ──────────────────────────────────────────
console.log('\n--- Test 3: Two Robots Head-On Corridor ---');
{
  const scn3 = {
    name: 'Head-On Corridor Conflict',
    robots: [
      { robotId: 'R1-East', start: { tileX: 10, tileY: 28 }, destination: { tileX: 35, tileY: 28 }, speed: 100 },
      { robotId: 'R2-West', start: { tileX: 35, tileY: 28 }, destination: { tileX: 10, tileY: 28 }, speed: 100 }
    ]
  };
  const res = await runPairedBenchmark(scn3, { mapData, verbose: false });
  assert(res.ares.collision_events === 0, 'Zero collision events in head-on');
  assert(res.ares.near_collision_events === 0, 'Zero near-collision events in head-on');
  assert(res.ares.minimum_separation_m >= 2.0, `Minimum separation >= 2.0m (got ${res.ares.minimum_separation_m}m) - ZERO visual overlap`);
  assert(res.ares.reroute_count >= 1, `A* reroute executed without teleportation (reroutes: ${res.ares.reroute_count})`);
  assert(res.ares.missions_completed === 2, 'Both robots reach destinations');
}

// ── 4. Crossing Intersection ────────────────────────────────────────────────
console.log('\n--- Test 4: Crossing Intersection Conflict ---');
{
  const scn4 = {
    name: 'Crossing Intersection Conflict',
    robots: [
      { robotId: 'R1-CrossH', start: { tileX: 15, tileY: 28 }, destination: { tileX: 35, tileY: 28 }, speed: 100, priority: 2 },
      { robotId: 'R2-CrossV', start: { tileX: 25, tileY: 18 }, destination: { tileX: 25, tileY: 38 }, speed: 100, priority: 1 }
    ]
  };
  const res = await runPairedBenchmark(scn4, { mapData, verbose: false });
  assert(res.ares.collision_events === 0, 'Zero collision events in crossing');
  assert(res.ares.near_collision_events === 0, 'Zero near-collision events in crossing');
  assert(res.ares.minimum_separation_m >= 2.0, `Minimum separation >= 2.0m (got ${res.ares.minimum_separation_m}m) - ZERO visual overlap`);
  assert(res.ares.missions_completed === 2, 'Both robots cross safely');
}

// ── 5. 4-Robot Congestion ───────────────────────────────────────────────────
console.log('\n--- Test 5: 4-Robot Congested Intersection ---');
{
  const scn5 = {
    name: '4-Robot Congested Intersection',
    robots: [
      { robotId: 'R1-East', start: { tileX: 15, tileY: 28 }, destination: { tileX: 35, tileY: 28 }, speed: 100, priority: 1 },
      { robotId: 'R2-West', start: { tileX: 35, tileY: 28 }, destination: { tileX: 15, tileY: 28 }, speed: 100, priority: 2 },
      { robotId: 'R3-South', start: { tileX: 25, tileY: 18 }, destination: { tileX: 25, tileY: 38 }, speed: 100, priority: 3 },
      { robotId: 'R4-North', start: { tileX: 25, tileY: 38 }, destination: { tileX: 25, tileY: 18 }, speed: 100, priority: 1 }
    ]
  };
  const res = await runPairedBenchmark(scn5, { mapData, verbose: false });
  assert(res.ares.collision_events === 0, 'Zero collision events in 4-robot congestion');
  assert(res.ares.near_collision_events === 0, 'Zero near-collision events in 4-robot congestion');
  assert(res.ares.minimum_separation_m >= 2.0, `Minimum separation >= 2.0m (got ${res.ares.minimum_separation_m}m) - ZERO visual overlap`);
  assert(res.ares.deadlocks === 0, 'Zero deadlocks in 4-robot congestion');
  assert(res.ares.missions_completed === 4, 'All 4 robots complete missions');
}

// ── 6. BASELINE Independence ────────────────────────────────────────────────
console.log('\n--- Test 6: BASELINE Mode Independence ---');
{
  const scn6 = {
    name: 'Baseline Mode Verification',
    robots: [
      { robotId: 'R-Base1', start: { tileX: 15, tileY: 28 }, destination: { tileX: 35, tileY: 28 }, speed: 100 },
      { robotId: 'R-Base2', start: { tileX: 35, tileY: 28 }, destination: { tileX: 15, tileY: 28 }, speed: 100 }
    ]
  };
  const res = await runPairedBenchmark(scn6, { mapData, verbose: false });
  assert(res.baseline.reroute_count === 0, 'Baseline does not reroute');
  assert(res.baseline.average_wait_time_sec === 0, 'Baseline does not pause/wait');
  assert(res.baseline.collision_events > 0, 'Baseline uncoordinated mode collides as expected');
}

console.log('\n' + '='.repeat(70));
console.log(`ALL ${passed} STAGE 4B.1 VERIFICATION CHECKS PASSED!`);
console.log('='.repeat(70));
