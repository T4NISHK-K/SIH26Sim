import { classifyConflict, createConflictDetector } from 'file:///d:/SIH2026/Simulation/src/coordination/conflictDetection.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

console.log('=== TEST SUITE: CONFLICT CLASSIFICATION ===');

// ── 1. SAME_DIRECTION CONFLICTS ──────────────────────────────────────────────
console.log('\n--- 1. Same-Direction Conflicts ---');

// 1.1 Direct classification: both robots approaching vertex moving East
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 2,
    timeA: 1.0,
    timeB: 1.1
  };
  const rA = {
    id: 'R1',
    path: [{ tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }]
  };
  const rB = {
    id: 'R2',
    path: [{ tileX: 2, tileY: 2 }, { tileX: 3, tileY: 2 }, { tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'SAME_DIRECTION', `Both moving East into vertex: expected SAME_DIRECTION, got ${result}`);
}

// 1.2 Both moving North along vertical corridor
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 7,
    tileY: 3,
    timeA: 2.0,
    timeB: 2.2
  };
  const rA = {
    id: 'R1',
    path: [{ tileX: 7, tileY: 5 }, { tileX: 7, tileY: 4 }, { tileX: 7, tileY: 3 }]
  };
  const rB = {
    id: 'R2',
    path: [{ tileX: 7, tileY: 6 }, { tileX: 7, tileY: 5 }, { tileX: 7, tileY: 4 }, { tileX: 7, tileY: 3 }]
  };

  const result = classifyConflict(conflict, { R1: rA, R2: rB });
  assert(result === 'SAME_DIRECTION', `Both moving North along corridor: expected SAME_DIRECTION, got ${result}`);
}

// 1.3 One departing, one arriving in the same corridor direction
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 2,
    timeA: 0.0,
    timeB: 0.2
  };
  // R1 starts at conflict (5, 2) and departs East to (6, 2)
  const rA = {
    id: 'R1',
    path: [{ tileX: 5, tileY: 2 }, { tileX: 6, tileY: 2 }]
  };
  // R2 arrives at (5, 2) from (4, 2) (also moving East)
  const rB = {
    id: 'R2',
    path: [{ tileX: 4, tileY: 2 }, { tileX: 5, tileY: 2 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'SAME_DIRECTION', `Departing & arriving in same direction: expected SAME_DIRECTION, got ${result}`);
}

// ── 2. HEAD_ON CONFLICTS ─────────────────────────────────────────────────────
console.log('\n--- 2. Head-On Conflicts ---');

// 2.1 Direct vertex classification: robots travelling toward each other along corridor Y=4
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 4,
    timeA: 1.5,
    timeB: 1.6
  };
  // R1 moving East: (4, 4) -> (5, 4)
  const rA = {
    id: 'R1',
    path: [{ tileX: 3, tileY: 4 }, { tileX: 4, tileY: 4 }, { tileX: 5, tileY: 4 }]
  };
  // R2 moving West: (6, 4) -> (5, 4)
  const rB = {
    id: 'R2',
    path: [{ tileX: 7, tileY: 4 }, { tileX: 6, tileY: 4 }, { tileX: 5, tileY: 4 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'HEAD_ON', `Opposite approach along same corridor: expected HEAD_ON, got ${result}`);
}

// 2.2 Vertical head-on vertex conflict along X=10
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 10,
    tileY: 6,
    timeA: 1.2,
    timeB: 1.3
  };
  // R1 moving South: (10, 5) -> (10, 6)
  const rA = {
    id: 'R1',
    path: [{ tileX: 10, tileY: 5 }, { tileX: 10, tileY: 6 }]
  };
  // R2 moving North: (10, 7) -> (10, 6)
  const rB = {
    id: 'R2',
    path: [{ tileX: 10, tileY: 7 }, { tileX: 10, tileY: 6 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'HEAD_ON', `Vertical head-on: expected HEAD_ON, got ${result}`);
}

// 2.3 Edge conflict: robots traversing opposite directions on same edge
{
  const edgeConflict = {
    type: 'edge',
    robotA: 'R1',
    robotB: 'R2',
    fromA: { tileX: 4, tileY: 3, navX: 4, navY: 3 },
    toA:   { tileX: 5, tileY: 3, navX: 5, navY: 3 },
    fromB: { tileX: 5, tileY: 3, navX: 5, navY: 3 },
    toB:   { tileX: 4, tileY: 3, navX: 4, navY: 3 },
    timeA: 1.0,
    timeB: 1.0
  };

  const result = classifyConflict(edgeConflict);
  assert(result === 'HEAD_ON', `Edge conflict opposite directions: expected HEAD_ON, got ${result}`);
}

// ── 3. CROSSING CONFLICTS ────────────────────────────────────────────────────
console.log('\n--- 3. Crossing Conflicts ---');

// 3.1 Perpendicular approach: R1 moving South, R2 moving East
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 6,
    tileY: 8,
    timeA: 1.8,
    timeB: 1.9
  };
  // R1 moving South: (6, 7) -> (6, 8)
  const rA = {
    id: 'R1',
    path: [{ tileX: 6, tileY: 6 }, { tileX: 6, tileY: 7 }, { tileX: 6, tileY: 8 }]
  };
  // R2 moving East: (5, 8) -> (6, 8)
  const rB = {
    id: 'R2',
    path: [{ tileX: 4, tileY: 8 }, { tileX: 5, tileY: 8 }, { tileX: 6, tileY: 8 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'CROSSING', `Perpendicular intersection approach: expected CROSSING, got ${result}`);
}

// 3.2 Perpendicular approach: R1 moving North, R2 moving West
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 8,
    tileY: 10,
    timeA: 2.0,
    timeB: 2.1
  };
  // R1 moving North: (8, 11) -> (8, 10)
  const rA = {
    id: 'R1',
    path: [{ tileX: 8, tileY: 11 }, { tileX: 8, tileY: 10 }]
  };
  // R2 moving West: (9, 10) -> (8, 10)
  const rB = {
    id: 'R2',
    path: [{ tileX: 9, tileY: 10 }, { tileX: 8, tileY: 10 }]
  };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'CROSSING', `North & West crossing: expected CROSSING, got ${result}`);
}

// ── 4. UNKNOWN / FALLBACK CASES ──────────────────────────────────────────────
console.log('\n--- 4. Unknown / Fallback Cases ---');

// 4.1 Null conflict
{
  const result = classifyConflict(null);
  assert(result === 'UNKNOWN', `Null conflict: expected UNKNOWN, got ${result}`);
}

// 4.2 Missing coordinates in vertex conflict
{
  const conflict = { type: 'vertex', robotA: 'R1', robotB: 'R2' };
  const result = classifyConflict(conflict, { R1: { path: [] }, R2: { path: [] } });
  assert(result === 'UNKNOWN', `Missing coordinates: expected UNKNOWN, got ${result}`);
}

// 4.3 Missing robots in fleet map
{
  const conflict = { type: 'vertex', robotA: 'R1', robotB: 'R2', tileX: 5, tileY: 5 };
  const result = classifyConflict(conflict, {});
  assert(result === 'UNKNOWN', `Robots not in fleet map: expected UNKNOWN, got ${result}`);
}

// 4.4 Stationary robot with single waypoint (no movement vector)
{
  const conflict = {
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    tileX: 5,
    tileY: 5
  };
  const rA = { id: 'R1', path: [{ tileX: 5, tileY: 5 }] }; // stationary
  const rB = { id: 'R2', path: [{ tileX: 4, tileY: 5 }, { tileX: 5, tileY: 5 }] };

  const result = classifyConflict(conflict, rA, rB);
  assert(result === 'UNKNOWN', `Stationary robot: expected UNKNOWN, got ${result}`);
}

// 4.5 Malformed edge conflict with missing nodes
{
  const edgeConflict = {
    type: 'edge',
    robotA: 'R1',
    robotB: 'R2',
    fromA: { tileX: 4, tileY: 3 }
    // missing toA, fromB, toB
  };
  const result = classifyConflict(edgeConflict);
  assert(result === 'UNKNOWN', `Malformed edge conflict: expected UNKNOWN, got ${result}`);
}

// ── 5. INTEGRATION TEST WITH createConflictDetector ──────────────────────────
console.log('\n--- 5. Integration with createConflictDetector ---');

{
  // Mock Phaser scene and tilemap
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

  // Scenario: R1 and R2 in a HEAD_ON conflict along corridor Y=5
  const robots = {
    'R1': {
      id: 'R1',
      speed: 100,
      path: [
        { navX: 2, navY: 5, tileX: 2, tileY: 5 },
        { navX: 3, navY: 5, tileX: 3, tileY: 5 },
        { navX: 4, navY: 5, tileX: 4, tileY: 5 }
      ]
    },
    'R2': {
      id: 'R2',
      speed: 100,
      path: [
        { navX: 6, navY: 5, tileX: 6, tileY: 5 },
        { navX: 5, navY: 5, tileX: 5, tileY: 5 },
        { navX: 4, navY: 5, tileX: 4, tileY: 5 }
      ]
    }
  };

  let panelConflicts = null;
  const detector = createConflictDetector(sceneMock, mapMock, robots, {
    updateConflictPanel: (cList) => { panelConflicts = cList; }
  });

  const conflicts = detector.detectFleetConflicts();
  assert(conflicts.length > 0, 'Conflicts detected between R1 and R2');
  const c = conflicts[0];
  assert(c.conflictType === 'HEAD_ON', `Predicted conflict classified as HEAD_ON, got: ${c.conflictType}`);
  assert(c.type === 'vertex', `Original type field preserved as vertex, got: ${c.type}`);
  assert(c.tileX === 4 && c.tileY === 5, 'Conflict location is (4, 5)');
  assert(panelConflicts === conflicts, 'updateConflictPanel callback received conflict list with conflictType');
}

// Scenario: R1 and R2 in a CROSSING conflict at intersection (4, 4)
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
        { navX: 2, navY: 4, tileX: 2, tileY: 4 },
        { navX: 3, navY: 4, tileX: 3, tileY: 4 },
        { navX: 4, navY: 4, tileX: 4, tileY: 4 }
      ]
    },
    'R2': {
      id: 'R2',
      speed: 100,
      path: [
        { navX: 4, navY: 2, tileX: 4, tileY: 2 },
        { navX: 4, navY: 3, tileX: 4, tileY: 3 },
        { navX: 4, navY: 4, tileX: 4, tileY: 4 }
      ]
    }
  };

  const detector = createConflictDetector(sceneMock, mapMock, robots, {
    updateConflictPanel: () => {}
  });

  const conflicts = detector.detectFleetConflicts();
  assert(conflicts.length > 0, 'Crossing conflict detected between R1 and R2');
  const c = conflicts[0];
  assert(c.conflictType === 'CROSSING', `Predicted conflict classified as CROSSING, got: ${c.conflictType}`);
  assert(c.type === 'vertex', `Original type field preserved: ${c.type}`);
}

// Scenario: R1 and R2 in a SAME_DIRECTION catch-up conflict along corridor Y=3
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

  // R1 is at (3, 3) moving to (4, 3) at speed 50 (arrives at t = 0.64s)
  // R2 is at (2, 3) moving to (3, 3) -> (4, 3) at speed 100 (arrives at t = 0.64s)
  const robots = {
    'R1': {
      id: 'R1',
      speed: 50,
      path: [
        { navX: 3, navY: 3, tileX: 3, tileY: 3 },
        { navX: 4, navY: 3, tileX: 4, tileY: 3 }
      ]
    },
    'R2': {
      id: 'R2',
      speed: 100,
      path: [
        { navX: 2, navY: 3, tileX: 2, tileY: 3 },
        { navX: 3, navY: 3, tileX: 3, tileY: 3 },
        { navX: 4, navY: 3, tileX: 4, tileY: 3 }
      ]
    }
  };

  const detector = createConflictDetector(sceneMock, mapMock, robots, {
    updateConflictPanel: () => {}
  });

  const conflicts = detector.detectFleetConflicts();
  assert(conflicts.length > 0, 'Same-direction conflict detected between R1 and R2');
  const c = conflicts.find((conf) => conf.tileX === 4 && conf.tileY === 3);
  assert(c !== undefined, 'Conflict exists at tile (4, 3)');
  assert(c.conflictType === 'SAME_DIRECTION', `Conflict classified as SAME_DIRECTION, got: ${c.conflictType}`);
}

console.log(`\nALL CONFLICT CLASSIFICATION TESTS PASSED! Total assertions: ${passed}`);
