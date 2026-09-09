import { buildRobotFeatures } from 'file:///d:/SIH2026/Simulation/src/network/edgeClient.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  passed++;
}

// Case 1: Nominal robot, no conflicts
{
  const robot = { id: 'R1', x: 100, y: 100, speed: 100, battery: 95, destination: { tileX: 10, tileY: 10 } };
  const allRobots = { 'R1': robot };
  const features = buildRobotFeatures(robot, allRobots, []);
  assert(features.collision_risk === 0.05, 'Nominal collision_risk is low (0.05)');
  assert(features.obstacle_detected === 0, 'No obstacle detected without conflict');
  assert(features.path_blocked === 0, 'Path is not blocked');
  assert(features.congestion_score === 0.0, 'Congestion score is 0 with no nearby robots');
  assert(features.traffic_level === 'LOW', 'Traffic level is LOW');
}

// Case 2: Active conflict detected
{
  const robot = { id: 'R1', x: 100, y: 100, speed: 100, battery: 80, destination: { tileX: 10, tileY: 10 } };
  const other = { id: 'R2', x: 132, y: 100, status: 'moving', destination: { tileX: 2, tileY: 3 } };
  const allRobots = { 'R1': robot, 'R2': other };
  const conflicts = [{
    type: 'vertex',
    robotA: 'R1',
    robotB: 'R2',
    timeA: 0.8,
    timeB: 0.8,
    tileX: 4,
    tileY: 3
  }];

  const features = buildRobotFeatures(robot, allRobots, conflicts);
  assert(features.obstacle_detected === 1, 'Obstacle detected when in conflict');
  assert(features.path_blocked === 1, 'Path blocked when conflict is imminent (<2s)');
  assert(features.collision_risk >= 0.85, 'Collision risk is high (>=0.85)');
  assert(features.relative_direction === 'CROSSING', 'Vertex conflict maps to CROSSING');
  assert(features.congestion_score > 0, 'Congestion score reflects active conflicts');
}

console.log('ALL FEATURE TESTS PASSED! Total assertions:', passed);
