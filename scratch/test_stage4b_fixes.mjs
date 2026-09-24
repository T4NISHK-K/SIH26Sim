/**
 * scratch/test_stage4b_fixes.mjs
 *
 * Focused regression tests for Stage 4B timing and safety investigation.
 * Verifies:
 *   1. Forward heading calculation (does not point backwards to past waypoints)
 *   2. Continuous grid coordinates (preserves fractional corridor centers)
 *   3. Case 0 proactive headway honoring (dynamic proximity SLOW honored)
 *   4. Case D trailing robot intervention (does not approve MOVE directly into conflict)
 *   5. Crossing scenario: zero collisions and separation > 1.5m
 *   6. Same-direction following scenario: zero collisions and separation > 1.5m
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildRobotFeatures,
  predictRobot
} from '../src/network/edgeClient.js';
import { selectAdaptiveIntervention } from '../src/coordination/adaptiveIntervention.js';
import { runPairedBenchmark } from '../src/simulation/benchmarkHarness.js';

let passed = 0;
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  passed++;
  console.log(`PASS: ${message}`);
}

console.log('='.repeat(70));
console.log('STAGE 4B REGRESSION TEST SUITE');
console.log('='.repeat(70));

// ── 1. Heading Calculation ──────────────────────────────────────────────────
console.log('\n--- 1. Forward Heading Radian Calculation ---');
{
  const robot = {
    id: 'R-Trail',
    waypointIndex: 2,
    speed: 100,
    path: [
      { tileX: 10, tileY: 28 },
      { tileX: 11, tileY: 28 },
      { tileX: 12, tileY: 28 },
      { tileX: 13, tileY: 28 },
      { tileX: 14, tileY: 28 }
    ],
    destination: { tileX: 14, tileY: 28 },
    x: 12 * 32 + 16, // at tile 12.0
    y: 28 * 32 + 16
  };

  const f = buildRobotFeatures(robot, {}, []);
  // Moving East along corridor Y=28: heading must be approximately 0.0 radians (East), NOT PI (West)
  assert(Math.abs(f.heading_rad) < 0.1, `Heading at waypointIndex 2 points forward East (~0.0 rad), got ${f.heading_rad}`);
}

// ── 2. Continuous Grid Coordinate Resolution ────────────────────────────────
console.log('\n--- 2. Continuous Grid Coordinates (No Integer Floor Distortion) ---');
{
  const robot = {
    id: 'R-Corridor',
    x: 25 * 32 + 16,
    y: 28.5 * 32 + 16, // centerline of corridor between tile 28 and 29
    speed: 100
  };

  const f = buildRobotFeatures(robot, {}, []);
  assert(f.current_x === 25.0, `X coordinate exactly 25.0, got ${f.current_x}`);
  assert(f.current_y === 28.5, `Y coordinate exactly 28.5 (not floored to 28 or 29), got ${f.current_y}`);
}

// ── 3. Adaptive Intervention Case 0 Headway Control ─────────────────────────
console.log('\n--- 3. Case 0: Proactive SLOW Honored Without Scheduled Conflict ---');
{
  const intervention = selectAdaptiveIntervention({
    mlDecision: 'SLOW',
    conflict: null,
    temporalAssessment: null
  });
  assert(intervention.appliedDecision === 'SLOW', `Proactive SLOW honored in Case 0, got ${intervention.appliedDecision}`);
  assert(intervention.rerouteRequired === false, 'Reroute is false for proactive SLOW');

  // Verify MOVE is applied if ML recommended MOVE or invalid
  const nom = selectAdaptiveIntervention({
    mlDecision: 'MOVE',
    conflict: null,
    temporalAssessment: null
  });
  assert(nom.appliedDecision === 'MOVE', `Nominal MOVE returned when ML is MOVE, got ${nom.appliedDecision}`);
}

// ── 4. Adaptive Intervention Case D Trailing Safety ─────────────────────────
console.log('\n--- 4. Case D: Trailing Robot Intervened in Upcoming Conflict ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    robotA: 'R1-Lead',
    robotB: 'R2-Trail',
    timeA: 5.0, // R1 arrives at t=5.0s
    timeB: 5.4, // R2 arrives at t=5.4s (trailing)
    temporalAssessment: {
      timingResolutionPossible: true,
      estimatedDelaySec: 0.4
    }
  };

  // Trailing robot R2 should NOT get applied MOVE
  const intTrail = selectAdaptiveIntervention({
    mlDecision: 'MOVE',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: { id: 'R2-Trail' }
  });
  assert(intTrail.appliedDecision === 'SLOW', `Trailing robot in SAME_DIRECTION conflict intervened with SLOW, got ${intTrail.appliedDecision}`);

  // Lead robot R1 should get MOVE to clear the zone
  const intLead = selectAdaptiveIntervention({
    mlDecision: 'MOVE',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: { id: 'R1-Lead' }
  });
  assert(intLead.appliedDecision === 'MOVE', `Lead robot in SAME_DIRECTION conflict gets MOVE to clear, got ${intLead.appliedDecision}`);
}

// ── 5. End-to-End Paired Benchmark Verification ─────────────────────────────
console.log('\n--- 5. End-to-End Simulation: Crossing and Following Scenarios ---');
{
  const tmjPath = path.resolve('map/warehousemap.tmj');
  const mapData = JSON.parse(fs.readFileSync(tmjPath, 'utf8'));

  // Scenario 2: Crossing
  const scn2 = {
    name: 'Scenario 2: Crossing',
    robots: [
      { robotId: 'R1', start: { tileX: 15, tileY: 28 }, destination: { tileX: 35, tileY: 28 }, speed: 100, priority: 2 },
      { robotId: 'R2', start: { tileX: 25, tileY: 18 }, destination: { tileX: 25, tileY: 38 }, speed: 100, priority: 1 }
    ]
  };

  const res2 = await runPairedBenchmark(scn2, { mapData, verbose: false });
  assert(res2.ares.collision_events === 0, `Crossing ARES collision events === 0, got ${res2.ares.collision_events}`);
  assert(res2.ares.near_collision_events === 0, `Crossing ARES near-collision events === 0, got ${res2.ares.near_collision_events}`);
  assert(res2.ares.minimum_separation_m >= 1.5, `Crossing ARES minimum separation >= 1.5m, got ${res2.ares.minimum_separation_m}m`);

  // Scenario 3: Following
  const scn3 = {
    name: 'Scenario 3: Following',
    robots: [
      { robotId: 'R1-Lead', start: { tileX: 20, tileY: 28 }, destination: { tileX: 40, tileY: 28 }, speed: 70, priority: 1 },
      { robotId: 'R2-Pursuer', start: { tileX: 10, tileY: 28 }, destination: { tileX: 40, tileY: 28 }, speed: 130, priority: 2 }
    ]
  };

  const res3 = await runPairedBenchmark(scn3, { mapData, verbose: false });
  assert(res3.ares.collision_events === 0, `Following ARES collision events === 0, got ${res3.ares.collision_events}`);
  assert(res3.ares.near_collision_events === 0, `Following ARES near-collision events === 0, got ${res3.ares.near_collision_events}`);
  assert(res3.ares.minimum_separation_m >= 1.5, `Following ARES minimum separation >= 1.5m, got ${res3.ares.minimum_separation_m}m`);
}

console.log('\n' + '='.repeat(70));
console.log(`ALL ${passed} STAGE 4B REGRESSION TESTS PASSED!`);
console.log('='.repeat(70));
