/**
 * scratch/test_stage4b2_deadlock_priority.mjs
 * Validation suite for STAGE 4B.2:
 *
 * TEST 1: HIGH vs LOW intersection -> HIGH: MOVE, LOW: SLOW/WAIT
 * TEST 2: LOW vs HIGH intersection -> HIGH progresses, LOW yields
 * TEST 3: HIGH vs HIGH -> NOT both WAIT; one robot must progress when safe
 * TEST 4: Same-direction following -> MOVE -> SLOW -> MOVE; no permanent WAIT
 * TEST 5: Completed robot -> completed robot does not block another robot
 * TEST 6: Repeated WAIT -> No infinite WAIT loop
 * TEST 7: 4-5 robots in dense traffic -> At least one robot continues whenever safe
 * TEST 8: Existing head-on REROUTE -> preserve current working REROUTE behavior
 */

import assert from 'node:assert';
import {
  getRobotPriorityRank,
  arbitrateConflictRoles,
  selectAdaptiveIntervention
} from '../src/coordination/adaptiveIntervention.js';
import {
  classifyConflict,
  assessTemporalResolution
} from '../src/coordination/conflictDetection.js';

console.log('─── RUNNING STAGE 4B.2 TEST SUITE ───\n');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: HIGH vs LOW intersection
// Expected: HIGH -> MOVE, LOW -> SLOW/WAIT
// ─────────────────────────────────────────────────────────────────────────────
console.log('TEST 1: HIGH vs LOW intersection');
{
  const robotHigh = { id: 'Robot-01', priority: 3, speed: 100, x: 100, y: 100 }; // HIGH
  const robotLow = { id: 'Robot-02', priority: 1, speed: 100, x: 200, y: 200 };  // LOW

  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 10,
    tileY: 10,
    timeA: 2.0,
    timeB: 2.2,
    temporalAssessment: {
      conflictType: 'CROSSING',
      timingResolutionPossible: true,
      estimatedDelaySec: 1.2
    }
  };

  // Evaluation for Robot HIGH (even if raw ML says WAIT for both due to proximity)
  const decisionHigh = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotHigh,
    otherRobotState: robotLow,
    isOtherWaiting: false,
    consecutiveWaitCount: 0
  });

  // Evaluation for Robot LOW
  const decisionLow = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotLow,
    otherRobotState: robotHigh,
    isOtherWaiting: false,
    consecutiveWaitCount: 0
  });

  assert.strictEqual(decisionHigh.appliedDecision, 'MOVE', 'HIGH priority robot must be allowed to MOVE');
  assert.ok(
    decisionLow.appliedDecision === 'WAIT' || decisionLow.appliedDecision === 'SLOW',
    'LOW priority robot must yield (WAIT or SLOW)'
  );
  assert.notStrictEqual(
    decisionHigh.appliedDecision + decisionLow.appliedDecision,
    'WAITWAIT',
    'Both robots must NEVER both receive WAIT'
  );
  console.log(`  ✓ HIGH (${robotHigh.id}) -> ${decisionHigh.appliedDecision}`);
  console.log(`  ✓ LOW (${robotLow.id}) -> ${decisionLow.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: LOW vs HIGH intersection
// Expected: HIGH progresses, LOW yields
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 2: LOW vs HIGH intersection (reversed roles)');
{
  const robotLow = { id: 'Robot-01', priority: 'LOW', speed: 100 };
  const robotHigh = { id: 'Robot-02', priority: 'CRITICAL', speed: 100 };

  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 15,
    tileY: 12,
    timeA: 1.8,
    timeB: 1.9,
    temporalAssessment: {
      conflictType: 'CROSSING',
      timingResolutionPossible: true,
      estimatedDelaySec: 1.0
    }
  };

  const decisionLow = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotLow,
    otherRobotState: robotHigh,
    isOtherWaiting: false
  });

  const decisionHigh = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotHigh,
    otherRobotState: robotLow,
    isOtherWaiting: false
  });

  assert.strictEqual(decisionHigh.appliedDecision, 'MOVE', 'CRITICAL robot must progress with MOVE');
  assert.ok(
    decisionLow.appliedDecision === 'WAIT' || decisionLow.appliedDecision === 'SLOW',
    'LOW robot must yield'
  );
  console.log(`  ✓ HIGH/CRITICAL (${robotHigh.id}) -> ${decisionHigh.appliedDecision}`);
  console.log(`  ✓ LOW (${robotLow.id}) -> ${decisionLow.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: HIGH vs HIGH intersection
// Expected: NOT both WAIT; one robot must progress when safe
// ─────────────────────────────────────────────────────────────────────
console.log('\nTEST 3: HIGH vs HIGH same priority intersection');
{
  const robotA = { id: 'Robot-01', priority: 'HIGH', speed: 100, x: 100, y: 100 };
  const robotB = { id: 'Robot-02', priority: 'HIGH', speed: 100, x: 130, y: 100 };

  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 10,
    tileY: 10,
    timeA: 1.5, // Robot A arrives earlier
    timeB: 1.8,
    temporalAssessment: {
      conflictType: 'CROSSING',
      timingResolutionPossible: true,
      estimatedDelaySec: 0.9
    }
  };

  const decisionA = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotA,
    otherRobotState: robotB
  });

  const decisionB = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robotB,
    otherRobotState: robotA
  });

  assert.notStrictEqual(
    decisionA.appliedDecision + decisionB.appliedDecision,
    'WAITWAIT',
    'Same priority robots must NOT both receive WAIT'
  );
  assert.ok(
    decisionA.appliedDecision === 'MOVE' || decisionB.appliedDecision === 'MOVE',
    'At least one robot must receive MOVE'
  );
  assert.strictEqual(decisionA.appliedDecision, 'MOVE', 'Robot A (arriving earlier) must progress');
  assert.ok(decisionB.appliedDecision === 'WAIT' || decisionB.appliedDecision === 'SLOW', 'Robot B must yield');
  console.log(`  ✓ Robot A (earlier arrival) -> ${decisionA.appliedDecision}`);
  console.log(`  ✓ Robot B (later arrival) -> ${decisionB.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Same-direction following
// Expected: MOVE -> SLOW -> MOVE; no permanent WAIT
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 4: Same-direction following interaction');
{
  const leadRobot = { id: 'Robot-01', priority: 1, speed: 100 };
  const trailingRobot = { id: 'Robot-02', priority: 1, speed: 100 };

  const followingConflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 20,
    tileY: 10,
    timeA: 2.0, // Lead arrives at waypoint earlier
    timeB: 2.8, // Trailing follows behind
    temporalAssessment: {
      conflictType: 'SAME_DIRECTION',
      timingResolutionPossible: true,
      estimatedDelaySec: 0.4
    }
  };

  // Lead robot should always MOVE
  const decisionLead = selectAdaptiveIntervention({
    mlDecision: 'MOVE',
    conflict: followingConflict,
    temporalAssessment: followingConflict.temporalAssessment,
    robotState: leadRobot,
    otherRobotState: trailingRobot
  });

  // Trailing robot should SLOW down to maintain headway, NOT enter permanent WAIT
  const decisionTrailing = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: followingConflict,
    temporalAssessment: followingConflict.temporalAssessment,
    robotState: trailingRobot,
    otherRobotState: leadRobot
  });

  assert.strictEqual(decisionLead.appliedDecision, 'MOVE', 'Lead robot must MOVE');
  assert.strictEqual(decisionTrailing.appliedDecision, 'SLOW', 'Trailing robot must SLOW down for headway, not permanent WAIT');
  console.log(`  ✓ Lead (${leadRobot.id}) -> ${decisionLead.appliedDecision}`);
  console.log(`  ✓ Trailing (${trailingRobot.id}) -> ${decisionTrailing.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Completed robot
// Expected: Completed robot does NOT block another robot
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 5: Completed robot exclusion');
{
  const activeRobot = { id: 'Robot-01', priority: 2, speed: 100, status: 'moving' };
  const completedRobot = { id: 'Robot-02', priority: 3, speed: 100, status: 'completed' };

  // 1. In assessTemporalResolution
  const assessment = assessTemporalResolution(
    { type: 'vertex', robotA: 'Robot-01', robotB: 'Robot-02', timeA: 1.0, timeB: 1.0, tileX: 5, tileY: 5 },
    activeRobot,
    completedRobot
  );
  assert.strictEqual(assessment.reason, 'Completed robot is not an active interaction partner');

  // 2. In selectAdaptiveIntervention
  const decision = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict: { type: 'vertex', robotA: 'Robot-01', robotB: 'Robot-02' },
    temporalAssessment: assessment,
    robotState: activeRobot,
    otherRobotState: completedRobot
  });

  assert.strictEqual(decision.appliedDecision, 'MOVE', 'Active robot must proceed with MOVE past completed robot');
  console.log(`  ✓ Active robot facing completed robot -> ${decision.appliedDecision} (${decision.decisionReason})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Repeated WAIT
// Expected: No infinite WAIT loop
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 6: Repeated WAIT anti-deadlock');
{
  const robot = { id: 'Robot-01', priority: 1, speed: 100 };
  const otherRobot = { id: 'Robot-02', priority: 1, speed: 100 };

  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    tileX: 10,
    tileY: 10,
    timeA: 2.0,
    timeB: 2.0,
    temporalAssessment: {
      conflictType: 'CROSSING',
      timingResolutionPossible: true,
      estimatedDelaySec: 0.5
    }
  };

  // Repeated wait (consecutiveWaitCount >= 1)
  const decisionBreak = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: robot,
    otherRobotState: otherRobot,
    consecutiveWaitCount: 1
  });

  assert.ok(
    decisionBreak.appliedDecision === 'MOVE' || decisionBreak.appliedDecision === 'SLOW',
    'Repeated wait must release with MOVE or SLOW rather than another WAIT'
  );
  console.log(`  ✓ Consecutive wait count = 1 forced release -> ${decisionBreak.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7: 4-5 robots in dense traffic
// Expected: At least one robot continues whenever safe
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 7: 4-5 robots dense traffic progress guarantee');
{
  const robots = [
    { id: 'Robot-01', priority: 1, x: 10, y: 10 },
    { id: 'Robot-02', priority: 2, x: 12, y: 10 },
    { id: 'Robot-03', priority: 3, x: 10, y: 12 },
    { id: 'Robot-04', priority: 4, x: 12, y: 12 }
  ];

  // In any conflict pairing among these robots:
  const highestRobot = robots[3]; // priority 4
  const otherRobot = robots[2];   // priority 3

  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: highestRobot.id,
    robotB: otherRobot.id,
    tileX: 11,
    tileY: 11,
    timeA: 1.0,
    timeB: 1.0,
    temporalAssessment: {
      conflictType: 'CROSSING',
      timingResolutionPossible: true,
      estimatedDelaySec: 0.8
    }
  };

  const decHighest = selectAdaptiveIntervention({
    mlDecision: 'WAIT',
    conflict,
    temporalAssessment: conflict.temporalAssessment,
    robotState: highestRobot,
    otherRobotState: otherRobot
  });

  assert.strictEqual(decHighest.appliedDecision, 'MOVE', 'Highest priority robot in group must progress');
  console.log(`  ✓ In 4-robot group, highest priority robot granted -> ${decHighest.appliedDecision}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8: Existing head-on REROUTE
// Expected: Preserve current working REROUTE behavior
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTEST 8: Head-on corridor REROUTE preservation');
{
  const robotA = { id: 'Robot-01', priority: 2, speed: 100 };
  const robotB = { id: 'Robot-02', priority: 2, speed: 100 };

  const headOnConflict = {
    type: 'edge',
    conflictType: 'HEAD_ON',
    robotA: 'Robot-01',
    robotB: 'Robot-02',
    fromA: { tileX: 10, tileY: 10 },
    toA: { tileX: 11, tileY: 10 },
    fromB: { tileX: 11, tileY: 10 },
    toB: { tileX: 10, tileY: 10 },
    temporalAssessment: {
      conflictType: 'HEAD_ON',
      timingResolutionPossible: false,
      requiresReroute: true,
      estimatedDelaySec: null,
      reason: 'Opposing traversal of shared edge cannot be resolved by timing alone; spatial rerouting required'
    }
  };

  const decisionA = selectAdaptiveIntervention({
    mlDecision: 'REROUTE',
    conflict: headOnConflict,
    temporalAssessment: headOnConflict.temporalAssessment,
    robotState: robotA,
    otherRobotState: robotB
  });

  assert.strictEqual(decisionA.appliedDecision, 'REROUTE', 'Head-on unresolvable corridor must preserve REROUTE');
  assert.strictEqual(decisionA.rerouteRequired, true, 'Reroute required flag must be true');
  console.log(`  ✓ Head-on opposing corridor -> ${decisionA.appliedDecision} (rerouteRequired: ${decisionA.rerouteRequired})`);
}

console.log('\n✅ ALL STAGE 4B.2 UNIT & COORDINATION TESTS PASSED!\n');
