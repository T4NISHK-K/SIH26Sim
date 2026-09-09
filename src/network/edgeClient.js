/**
 * network/edgeClient.js
 * Minimal Local Edge Coordinator HTTP Client.
 *
 * Communicates with the local backend running at http://127.0.0.1:3001.
 * Maintains window.edgeConnected, window.robotDecisionState[robotId],
 * and window.edgeDecisionStats.
 */

const EDGE_BASE_URL = 'http://127.0.0.1:3001';

// Initialise global state containers
if (typeof window !== 'undefined') {
  window.edgeConnected = Boolean(window.edgeConnected);
  window.robotDecisionState = window.robotDecisionState || {};
  window.edgeDecisionStats = window.edgeDecisionStats || {
    totalPredictions: 0,
    move: 0,
    slow: 0,
    wait: 0,
    reroute: 0
  };
}

/**
 * Check health / test connection to the Local Edge Coordinator backend.
 * @param {string} [baseUrl]
 * @returns {Promise<boolean>}
 */
export async function connectEdge(baseUrl = EDGE_BASE_URL) {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      window.edgeConnected = true;
      console.log('[EdgeClient] Connected to Local Edge Coordinator:', data);
      return true;
    }
    window.edgeConnected = false;
    return false;
  } catch (err) {
    window.edgeConnected = false;
    return false;
  }
}

/**
 * Disconnect from the local edge coordinator.
 */
export function disconnectEdge() {
  window.edgeConnected = false;
  console.log('[EdgeClient] Disconnected from Local Edge Coordinator');
}

/**
 * Return current connection status.
 * @returns {boolean}
 */
export function isEdgeConnected() {
  return Boolean(typeof window !== 'undefined' && window.edgeConnected);
}

/**
 * Send robot telemetry / features to POST /predict and store decision in window.robotDecisionState.
 * Updates window.edgeDecisionStats with decision counts.
 *
 * @param {string} robotId
 * @param {object} features - The 24 ML features
 * @param {string} [baseUrl]
 * @returns {Promise<{ decision: string, confidence: number, timestamp: number } | null>}
 */
export async function predictRobot(robotId, features, baseUrl = EDGE_BASE_URL) {
  try {
    const res = await fetch(`${baseUrl}/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        robotId,
        features
      })
    });

    if (!res.ok) {
      console.warn(`[EdgeClient] Predict request failed with status ${res.status}`);
      return null;
    }

    const data = await res.json();
    const result = {
      decision: data.decision || 'WAIT',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      timestamp: Date.now()
    };

    if (typeof window !== 'undefined') {
      if (!window.robotDecisionState) {
        window.robotDecisionState = {};
      }
      window.robotDecisionState[robotId] = result;

      // Update lightweight debug decision stats
      if (!window.edgeDecisionStats) {
        window.edgeDecisionStats = {
          totalPredictions: 0,
          move: 0,
          slow: 0,
          wait: 0,
          reroute: 0
        };
      }
      window.edgeDecisionStats.totalPredictions++;
      const dec = (result.decision || '').toLowerCase();
      if (dec === 'move') window.edgeDecisionStats.move++;
      else if (dec === 'slow') window.edgeDecisionStats.slow++;
      else if (dec === 'wait') window.edgeDecisionStats.wait++;
      else if (dec === 'reroute') window.edgeDecisionStats.reroute++;
    }

    return result;
  } catch (err) {
    console.warn(`[EdgeClient] Predict error for ${robotId}:`, err.message);
    return null;
  }
}

/**
 * Helper to compute cardinal direction from delta (dx, dy).
 * @param {number} dx
 * @param {number} dy
 * @returns {"North"|"South"|"East"|"West"}
 */
function getHeading(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'East' : 'West';
  }
  return dy >= 0 ? 'South' : 'North';
}

/**
 * Convert existing robot state, fleet context, and conflicts into the exact 24 ML features.
 * All features are derived from real simulation data without random numbers.
 *
 * @param {object} robot - Current robot state object
 * @param {Object.<string, object>} allRobots - Entire fleet dictionary
 * @param {Array<object>} conflicts - Active detected conflicts list
 * @param {Phaser.Tilemaps.Tilemap} [map] - Tilemap for coordinate conversions
 * @returns {object} 24 ML feature object
 */
export function buildRobotFeatures(robot, allRobots = {}, conflicts = [], map = null) {
  // 1. Current Tile Coordinates
  let currentTileX = 0;
  let currentTileY = 0;

  if (map && typeof map.worldToTileX === 'function') {
    currentTileX = map.worldToTileX(robot.x);
    currentTileY = map.worldToTileY(robot.y);
  } else if (robot.x !== undefined && robot.y !== undefined) {
    currentTileX = Math.round((robot.x - 16) / 32);
    currentTileY = Math.round((robot.y - 16) / 32);
  } else if (robot.start) {
    currentTileX = robot.start.tileX;
    currentTileY = robot.start.tileY;
  }

  // 2. Destination Tile Coordinates
  const destTileX = robot.destination ? robot.destination.tileX : currentTileX;
  const destTileY = robot.destination ? robot.destination.tileY : currentTileY;

  // 3. Speed in m/s (simulation defaults to 100px/s => 1.0 m/s)
  const speedMps = robot.speed ? Number((robot.speed / 100).toFixed(2)) : 1.0;

  // 4. Direction
  let direction = 'North';
  if (robot.path && robot.path.length > 0) {
    const target = robot.path[1] || robot.path[0];
    direction = getHeading(target.tileX - currentTileX, target.tileY - currentTileY);
  } else if (robot.destination) {
    direction = getHeading(destTileX - currentTileX, destTileY - currentTileY);
  }

  // 5. Battery
  const batteryPct = robot.battery !== undefined ? Number(robot.battery) : 100.0;

  // 6. Task Type
  let taskType = 'DELIVER';
  if (robot.task) {
    const t = String(robot.task).toUpperCase();
    if (t.includes('PICK')) taskType = 'PICK';
    else if (t.includes('CHARGE')) taskType = 'CHARGE';
    else if (t.includes('RETURN')) taskType = 'RETURN';
    else if (t.includes('RELOCATE')) taskType = 'RELOCATE';
    else taskType = 'DELIVER';
  }

  // 7. Task Priority
  let taskPriority = 'MEDIUM';
  if (typeof robot.priority === 'number') {
    if (robot.priority <= 1) taskPriority = 'LOW';
    else if (robot.priority === 2) taskPriority = 'MEDIUM';
    else if (robot.priority === 3) taskPriority = 'HIGH';
    else taskPriority = 'CRITICAL';
  } else if (typeof robot.priority === 'string') {
    const p = robot.priority.toUpperCase();
    if (['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'].includes(p)) {
      taskPriority = p;
    }
  }

  // 8. Fleet analysis: nearby robots, nearest distance, active moving, waiting robots
  let nearbyRobotCount = 0;
  let nearestRobotDistanceM = 999.0;
  let nearestRobot = null;
  let activeMovingCount = 0;
  let waitingRobotCount = 0;

  for (const [otherId, other] of Object.entries(allRobots)) {
    if (!other) continue;
    if (other.status === 'moving') {
      activeMovingCount++;
    }
    const isWaiting = other.status === 'waiting' ||
      (typeof window !== 'undefined' && window.robotMovementDecisionState?.[otherId]?.waiting);
    if (isWaiting) {
      waitingRobotCount++;
    }

    if (otherId === robot.id) continue;

    let otherTileX = other.destination ? other.destination.tileX : 0;
    let otherTileY = other.destination ? other.destination.tileY : 0;
    if (map && typeof map.worldToTileX === 'function' && other.x !== undefined) {
      otherTileX = map.worldToTileX(other.x);
      otherTileY = map.worldToTileY(other.y);
    } else if (other.x !== undefined && other.y !== undefined) {
      otherTileX = Math.round((other.x - 16) / 32);
      otherTileY = Math.round((other.y - 16) / 32);
    }

    const dist = Math.hypot(otherTileX - currentTileX, otherTileY - currentTileY);
    if (dist <= 6.0) {
      nearbyRobotCount++;
    }
    if (dist < nearestRobotDistanceM) {
      nearestRobotDistanceM = dist;
      nearestRobot = other;
    }
  }

  // 9. Conflict inspection derived from EXISTING predictive conflict detection
  const robotConflicts = Array.isArray(conflicts)
    ? conflicts.filter((c) => {
        if (!c || (c.robotA !== robot.id && c.robotB !== robot.id)) return false;
        const otherId = c.robotA === robot.id ? c.robotB : c.robotA;
        const other = allRobots[otherId];
        return !other || other.status !== 'completed';
      })
    : [];

  const obstacleDetected = robotConflicts.length > 0 ? 1 : 0;

  // Collision risk derived from real conflict arrival time and timeDiff
  let collisionRisk = 0.05;
  let minConflictTime = Infinity;

  if (robotConflicts.length > 0) {
    for (const c of robotConflicts) {
      const t = c.robotA === robot.id ? (c.timeA ?? 1.0) : (c.timeB ?? 1.0);
      if (t < minConflictTime) {
        minConflictTime = t;
      }
    }
    if (minConflictTime <= 1.5) {
      collisionRisk = 0.95;
    } else if (minConflictTime <= 3.5) {
      collisionRisk = 0.88;
    } else {
      collisionRisk = 0.80;
    }
  }

  // Path blocked: any active predicted conflict indicates an obstruction along the trajectory
  const pathBlocked = obstacleDetected;


  // 10. Relative Direction
  let relativeDirection = 'NONE';
  if (robotConflicts.length > 0) {
    const hasVertex = robotConflicts.some((c) => c.type === 'vertex');
    relativeDirection = hasVertex ? 'CROSSING' : 'OPPOSITE';
  } else if (nearestRobot) {
    let otherDir = 'North';
    if (nearestRobot.path && nearestRobot.path.length > 0) {
      const nextT = nearestRobot.path[1] || nearestRobot.path[0];
      otherDir = getHeading(nextT.tileX - currentTileX, nextT.tileY - currentTileY);
    }
    if (direction === otherDir) {
      relativeDirection = 'SAME';
    } else if (
      (direction === 'North' && otherDir === 'South') ||
      (direction === 'South' && otherDir === 'North') ||
      (direction === 'East' && otherDir === 'West') ||
      (direction === 'West' && otherDir === 'East')
    ) {
      relativeDirection = 'OPPOSITE';
    } else {
      relativeDirection = 'PERPENDICULAR';
    }
  }

  // 11. Distance & ETA
  const distToDest = Math.hypot(destTileX - currentTileX, destTileY - currentTileY);
  const etaSec = Number((distToDest / Math.max(speedMps, 0.1)).toFixed(1));

  // 12. Congestion score derived from nearby robots, conflicts, and waiting robots
  const rawCongestion = (nearbyRobotCount * 0.15) + (robotConflicts.length * 0.35) + (waitingRobotCount * 0.25);
  const congestionScore = Number(Math.min(1.0, Math.max(0.0, rawCongestion)).toFixed(2));

  // 13. Traffic Level: LOW / MEDIUM / HIGH
  let trafficLevel = 'LOW';
  if (congestionScore >= 0.60 || activeMovingCount >= 5) {
    trafficLevel = 'HIGH';
  } else if (congestionScore >= 0.25 || activeMovingCount >= 2) {
    trafficLevel = 'MEDIUM';
  }

  // 14. Deadlock risk
  let deadlockRisk = 0.0;
  if (pathBlocked && nearestRobotDistanceM < 2.5 && relativeDirection === 'OPPOSITE') {
    deadlockRisk = 0.85;
  } else if (robotConflicts.length > 0) {
    deadlockRisk = 0.45;
  }

  // 15. Waiting time sec
  let waitingTimeSec = 0.0;
  if (typeof window !== 'undefined' && window.robotMovementDecisionState?.[robot.id]?.waiting) {
    const wStart = window.robotMovementDecisionState[robot.id].lastAppliedAt;
    waitingTimeSec = wStart ? Math.min(10.0, (Date.now() - wStart) / 1000) : 1.0;
  }

  const routeLengthM = robot.path ? robot.path.length : Math.round(distToDest);

  return {
    current_x: Number(currentTileX.toFixed(2)),
    current_y: Number(currentTileY.toFixed(2)),
    destination_x: Number(destTileX.toFixed(2)),
    destination_y: Number(destTileY.toFixed(2)),
    speed_mps: speedMps,
    direction: direction,
    battery_pct: batteryPct,
    task_type: taskType,
    task_priority: taskPriority,
    traffic_level: trafficLevel,
    obstacle_detected: obstacleDetected,
    path_blocked: pathBlocked,
    nearby_robot_count: nearbyRobotCount,
    nearest_robot_distance_m: Number(nearestRobotDistanceM.toFixed(2)),
    relative_direction: relativeDirection,
    distance_to_destination_m: Number(distToDest.toFixed(2)),
    eta_sec: etaSec,
    congestion_score: congestionScore,
    collision_risk: collisionRisk,
    deadlock_risk: deadlockRisk,
    waiting_time_sec: Number(waitingTimeSec.toFixed(1)),
    charging_required: batteryPct < 20 ? 1 : 0,
    route_length_m: routeLengthM,
    alternative_route_available: 1
  };
}
