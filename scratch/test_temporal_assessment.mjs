import { assessTemporalResolution, classifyConflict, createConflictDetector } from 'file:///d:/SIH2026/Simulation/src/coordination/conflictDetection.js';
import { SAFE_TIME_SEPARATION, MAX_PLAUSIBLE_DELAY_SEC } from 'file:///d:/SIH2026/Simulation/src/config/constants.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

console.log('=== TEST SUITE: TEMPORAL CONFLICT ASSESSMENT ===');

// ── 1. SAME-DIRECTION CONFLICT: SMALL TIMING ADJUSTMENT IS SUFFICIENT ────────
console.log('\n--- 1. Same-Direction Conflict (Timing Resolution Plausible) ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'SAME_DIRECTION',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 2,
    timeA: 1.0,
    timeB: 1.3
  };
  const rA = {
    id: 'R1',
    path: [{ tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }, { tileX: 6, tileY: 2 }]
  };
  const rB = {
    id: 'R2',
    path: [{ tileX: 2, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }, { tileX: 6, tileY: 2 }]
  };

  const assessment = assessTemporalResolution(conflict, rA, rB);
  assert(assessment.conflictType === 'SAME_DIRECTION', 'conflictType is SAME_DIRECTION');
  assert(assessment.timeGap === 0.3, `timeGap is 0.3s, got ${assessment.timeGap}`);
  assert(assessment.safeSeparationSec === SAFE_TIME_SEPARATION, `safeSeparationSec matches constant ${SAFE_TIME_SEPARATION}`);
  assert(assessment.estimatedDelaySec === 0.7, `estimatedDelaySec is 0.7s (1.0 - 0.3), got ${assessment.estimatedDelaySec}`);
  assert(assessment.timingResolutionPossible === true, 'timingResolutionPossible is true');
  assert(assessment.requiresReroute === false, 'requiresReroute is false');
  assert(typeof assessment.reason === 'string' && assessment.reason.length > 0, 'reason is provided');
}

// ── 2. CROSSING CONFLICT: WAIT/SLOW CAN SEPARATE ARRIVAL TIMES ────────────────
console.log('\n--- 2. Crossing Conflict (Timing Adjustment Resolves Intersection) ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'CROSSING',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 4,
    tileY: 4,
    timeA: 2.0,
    timeB: 2.4
  };
  // R1 moving South: (4, 3) -> (4, 4) -> (4, 5)
  const rA = {
    id: 'R1',
    path: [{ tileX: 4, tileY: 2 }, { tileX: 4, tileY: 3 }, { tileX: 4, tileY: 4 }, { tileX: 4, tileY: 5 }]
  };
  // R2 moving East: (3, 4) -> (4, 4) -> (5, 4)
  const rB = {
    id: 'R2',
    path: [{ tileX: 2, tileY: 4 }, { tileX: 3, tileY: 4 }, { tileX: 4, tileY: 4 }, { tileX: 5, tileY: 4 }]
  };

  const assessment = assessTemporalResolution(conflict, rA, rB);
  assert(assessment.conflictType === 'CROSSING', 'conflictType is CROSSING');
  assert(assessment.timeGap === 0.4, `timeGap is 0.4s, got ${assessment.timeGap}`);
  assert(assessment.estimatedDelaySec === 0.6, `estimatedDelaySec is 0.6s (1.0 - 0.4), got ${assessment.estimatedDelaySec}`);
  assert(assessment.timingResolutionPossible === true, 'timingResolutionPossible is true');
  assert(assessment.requiresReroute === false, 'requiresReroute is false');
  assert(assessment.reason.includes('Crossing'), 'reason explains crossing clearance');
}

// ── 3. HEAD-ON CONFLICT: TIMING CANNOT RESOLVE SHARED CORRIDOR ───────────────
console.log('\n--- 3. Head-On Conflict: Opposing Corridor Traversal (Requires Reroute) ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'HEAD_ON',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 3,
    timeA: 1.5,
    timeB: 1.6
  };
  // R1 traversing corridor Y=3 East: (3, 3) -> (4, 3) -> (5, 3) -> (6, 3) -> (7, 3)
  const rA = {
    id: 'R1',
    path: [{ tileX: 3, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 5, tileY: 3 }, { tileX: 6, tileY: 3 }, { tileX: 7, tileY: 3 }]
  };
  // R2 traversing corridor Y=3 West: (7, 3) -> (6, 3) -> (5, 3) -> (4, 3) -> (3, 3)
  const rB = {
    id: 'R2',
    path: [{ tileX: 7, tileY: 3 }, { tileX: 6, tileY: 3 }, { tileX: 5, tileY: 3 }, { tileX: 4, tileY: 3 }, { tileX: 3, tileY: 3 }]
  };

  const assessment = assessTemporalResolution(conflict, rA, rB);
  assert(assessment.conflictType === 'HEAD_ON', 'conflictType is HEAD_ON');
  assert(assessment.timingResolutionPossible === false, 'timingResolutionPossible is false for opposing corridor');
  assert(assessment.requiresReroute === true, 'requiresReroute is true');
  assert(assessment.reason.includes('Opposing traversal of shared corridor'), 'reason notes opposing corridor deadlock');
}

// 3b. Head-On conflict where paths diverge onto disjoint routes at vertex (Timing IS sufficient)
console.log('\n--- 3b. Head-On Diverging at Vertex (Timing Sufficient) ---');
{
  const conflict = {
    type: 'vertex',
    conflictType: 'HEAD_ON',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 5,
    timeA: 1.0,
    timeB: 1.2
  };
  // R1 comes from West: (4, 5) -> (5, 5), then turns North: -> (5, 4) -> (5, 3)
  const rA = {
    id: 'R1',
    path: [{ tileX: 3, tileY: 5 }, { tileX: 4, tileY: 5 }, { tileX: 5, tileY: 5 }, { tileX: 5, tileY: 4 }, { tileX: 5, tileY: 3 }]
  };
  // R2 comes from East: (6, 5) -> (5, 5), then turns South: -> (5, 6) -> (5, 7)
  const rB = {
    id: 'R2',
    path: [{ tileX: 7, tileY: 5 }, { tileX: 6, tileY: 5 }, { tileX: 5, tileY: 5 }, { tileX: 5, tileY: 6 }, { tileX: 5, tileY: 7 }]
  };

  const assessment = assessTemporalResolution(conflict, rA, rB);
  assert(assessment.conflictType === 'HEAD_ON', 'conflictType is HEAD_ON');
  assert(assessment.timingResolutionPossible === true, 'timingResolutionPossible is true when diverging onto separate routes');
  assert(assessment.requiresReroute === false, 'requiresReroute is false when diverging');
  assert(assessment.estimatedDelaySec === 0.8, `estimatedDelaySec is 0.8s, got ${assessment.estimatedDelaySec}`);
}

// ── 4. EDGE CONFLICT: TRAJECTORY CASE ─────────────────────────────────────────
console.log('\n--- 4. Edge Conflict Trajectory Case ---');
{
  const edgeConflict = {
    type: 'edge',
    conflictType: 'HEAD_ON',
    robotA: 'R1',
    robotB: 'R2',
    fromA: { tileX: 4, tileY: 2, navX: 4, navY: 2 },
    toA:   { tileX: 5, tileY: 2, navX: 5, navY: 2 },
    fromB: { tileX: 5, tileY: 2, navX: 5, navY: 2 },
    toB:   { tileX: 4, tileY: 2, navX: 4, navY: 2 },
    timeA: 1.2,
    timeB: 1.3
  };

  const assessment = assessTemporalResolution(edgeConflict);
  assert(assessment.conflictType === 'HEAD_ON', 'conflictType is HEAD_ON');
  assert(assessment.timingResolutionPossible === false, 'Edge conflict cannot be resolved by timing');
  assert(assessment.requiresReroute === true, 'Edge conflict requires spatial reroute');
  assert(assessment.reason.includes('shared edge'), 'reason notes shared edge opposing traversal');
}

// ── 5. INVALID / MISSING TRAJECTORY FALLBACKS ─────────────────────────────────
console.log('\n--- 5. Invalid / Missing Trajectory Fallbacks ---');

// 5.1 Null conflict
{
  const assessment = assessTemporalResolution(null);
  assert(assessment.conflictType === 'UNKNOWN', 'Null conflict returns UNKNOWN');
  assert(assessment.timingResolutionPossible === false, 'timingResolutionPossible is false for null');
  assert(assessment.requiresReroute === false, 'requiresReroute is false for null');
  assert(assessment.reason.includes('Invalid'), 'reason notes invalid input');
}

// 5.2 Missing arrival times
{
  const conflict = { type: 'vertex', robotA: 'R1', robotB: 'R2', tileX: 2, tileY: 2 };
  const assessment = assessTemporalResolution(conflict);
  assert(assessment.timeA === null && assessment.timeB === null, 'Missing times return null');
  assert(assessment.timingResolutionPossible === false, 'timingResolutionPossible is false when times missing');
}

// 5.3 Missing robot trajectories
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 2,
    tileY: 2,
    timeA: 1.0,
    timeB: 1.2
  };
  const assessment = assessTemporalResolution(conflict, {}); // empty robots map
  assert(assessment.timingResolutionPossible === false, 'Missing paths return timingResolutionPossible = false');
  assert(assessment.reason.includes('Missing trajectory paths'), 'reason notes missing paths');
}

// 5.4 Malformed edge conflict
{
  const malformedEdge = {
    type: 'edge',
    robotA: 'R1',
    robotB: 'R2',
    fromA: { tileX: 1, tileY: 1 },
    timeA: 1.0,
    timeB: 1.2
  };
  const assessment = assessTemporalResolution(malformedEdge);
  assert(assessment.timingResolutionPossible === false, 'Malformed edge timingResolutionPossible is false');
  assert(assessment.reason.includes('Malformed edge'), 'reason notes malformed edge');
}

// ── 6. INTEGRATION WITH createConflictDetector ────────────────────────────────
console.log('\n--- 6. Integration with createConflictDetector ---');
{
  const sceneMock = {
    add: {
      graphics: () => ({
        setDepth: () => {},
        clear: () => {},
        lineStyle: () => {},
        fillStyle: () => {},
        strokeCircle: () => {},
        fillCircle: () => {},
        lineBetween: () => {}
      })
    }
  };
  const mapMock = {
    tileToWorldX: (tx) => tx * 32,
    tileToWorldY: (ty) => ty * 32
  };

  const robots = {
    'R1': {
      id: 'R1',
      speed: 100,
      path: [
        { navX: 2, navY: 5, tileX: 2, tileY: 5 },
        { navX: 3, navY: 5, tileX: 3, tileY: 5 },
        { navX: 4, navY: 5, tileX: 4, tileY: 5 },
        { navX: 5, navY: 5, tileX: 5, tileY: 5 }
      ]
    },
    'R2': {
      id: 'R2',
      speed: 100,
      path: [
        { navX: 6, navY: 5, tileX: 6, tileY: 5 },
        { navX: 5, navY: 5, tileX: 5, tileY: 5 },
        { navX: 4, navY: 5, tileX: 4, tileY: 5 },
        { navX: 3, navY: 5, tileX: 3, tileY: 5 }
      ]
    }
  };

  const detector = createConflictDetector(sceneMock, mapMock, robots, {
    updateConflictPanel: () => {}
  });

  const conflicts = detector.detectFleetConflicts();
  assert(conflicts.length > 0, 'Conflicts detected between opposing robots');

  for (const c of conflicts) {
    assert(c.temporalAssessment !== undefined, 'Conflict has temporalAssessment attached');
    assert(typeof c.temporalAssessment.timingResolutionPossible === 'boolean', 'timingResolutionPossible is boolean');
    assert(typeof c.temporalAssessment.requiresReroute === 'boolean', 'requiresReroute is boolean');
    assert(typeof c.temporalAssessment.reason === 'string', 'reason is string');
    assert(c.temporalAssessment.safeSeparationSec === SAFE_TIME_SEPARATION, 'safeSeparationSec is present');
  }
}

console.log(`\nALL TEMPORAL CONFLICT ASSESSMENT TESTS PASSED! Total assertions: ${passed}`);
