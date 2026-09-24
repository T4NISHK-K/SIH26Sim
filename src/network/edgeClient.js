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
 * Exact V2 feature keys contract (22 numerical + 4 categorical = 26 features)
 */
export const V2_FEATURE_KEYS = [
  'current_x',
  'current_y',
  'destination_x',
  'destination_y',
  'distance_to_destination_m',
  'eta_sec',
  'speed_mps',
  'heading_rad',
  'battery_pct',
  'obstacle_detected',
  'path_blocked',
  'alternative_route_available',
  'dynamic_interaction_radius_m',
  'nearby_robot_count',
  'nearest_robot_distance_m',
  'nearest_robot_relative_speed_mps',
  'nearest_robot_relative_heading_rad',
  'closing_velocity_mps',
  'true_ttc_sec',
  'cpa_time_sec',
  'cpa_distance_m',
  'intersection_conflict',
  'task_type',
  'task_priority',
  'traffic_level',
  'relative_direction'
];

/**
 * Normalizes an angle to [-PI, PI].
 * @param {number} angle
 * @returns {number}
 */
export function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2.0 * Math.PI;
  while (a < -Math.PI) a += 2.0 * Math.PI;
  return a;
}

/**
 * Explicit mapping function for task types to valid V2 categories:
 * ['CHARGE', 'DROP', 'PICK', 'RELOCATE'].
 * @param {string} [task]
 * @returns {"CHARGE"|"DROP"|"PICK"|"RELOCATE"}
 */
export function mapTaskType(task) {
  if (!task) return 'DROP';
  const t = String(task).toUpperCase().trim();
  if (t.includes('CHARG')) return 'CHARGE';
  if (t.includes('PICK')) return 'PICK';
  if (t.includes('RELOCATE') || t.includes('TRANSFER') || t.includes('RETURN')) return 'RELOCATE';
  if (t.includes('DROP') || t.includes('DELIVER') || t.includes('TRANSPORT')) return 'DROP';
  return 'DROP';
}

/**
 * Helper to extract continuous grid coordinates for a robot.
 *
 * Coordinate / Unit definition confirmed from V2 training:
 * 1 grid tile corresponds to 1 meter (100m x 100m model bounds).
 * Speed conversion: 100 px/s in simulation corresponds to 1.0 m/s.
 *
 * @param {object} r - Robot instance
 * @param {Phaser.Tilemaps.Tilemap} [map]
 * @returns {{ x: number, y: number }}
 */
function getRobotGridCoords(r, map = null) {
  let gx = 0;
  let gy = 0;
  if (!r) return { x: 0, y: 0 };

  if (r.tileX !== undefined && r.tileY !== undefined) {
    gx = r.tileX;
    gy = r.tileY;
  } else if (r.x !== undefined && r.y !== undefined) {
    if (r.coordsInMeters || r.isTileCoord) {
      gx = r.x;
      gy = r.y;
    } else if (Math.abs(r.x) > 60 || Math.abs(r.y) > 40) {
      gx = (r.x - 16) / 32;
      gy = (r.y - 16) / 32;
    } else {
      if (map && typeof map.worldToTileX === 'function') {
        gx = map.worldToTileX(r.x);
        gy = map.worldToTileY(r.y);
      } else {
        gx = r.x;
        gy = r.y;
      }
    }
  } else if (map && typeof map.worldToTileX === 'function' && r.x !== undefined && r.y !== undefined) {
    gx = map.worldToTileX(r.x);
    gy = map.worldToTileY(r.y);
  } else if (r.start) {
    gx = r.start.tileX;
    gy = r.start.tileY;
  }
  return {
    x: Number(gx.toFixed(3)),
    y: Number(gy.toFixed(3))
  };
}

/**
 * Computes heading angle in radians normalized to [-PI, PI] from current position
 * to next waypoint along planned trajectory.
 *
 * @param {object} robot
 * @param {number} currentX
 * @param {number} currentY
 * @param {number} destX
 * @param {number} destY
 * @returns {number} Angle in radians [-PI, PI]
 */
function computeHeadingRad(robot, currentX, currentY, destX, destY) {
  if (robot && typeof robot.heading === 'number' && Number.isFinite(robot.heading)) {
    return normalizeAngle(robot.heading);
  }

  if (robot && robot.path && robot.path.length > 0) {
    let startIndex = 0;
    if (typeof robot.waypointIndex === 'number' && robot.waypointIndex >= 0) {
      startIndex = robot.waypointIndex;
    } else {
      let minD = Infinity;
      let closestIdx = 0;
      for (let i = 0; i < robot.path.length; i++) {
        const wp = robot.path[i];
        if (!wp) continue;
        const wx = wp.tileX !== undefined ? wp.tileX : wp.navX;
        const wy = wp.tileY !== undefined ? wp.tileY : wp.navY;
        if (wx !== undefined && wy !== undefined) {
          const d = Math.hypot(wx - currentX, wy - currentY);
          if (d < minD) {
            minD = d;
            closestIdx = i;
          }
        }
      }
      startIndex = closestIdx;
    }

    for (let i = startIndex; i < robot.path.length; i++) {
      const wp = robot.path[i];
      if (!wp) continue;
      const wx = wp.tileX !== undefined ? wp.tileX : wp.navX;
      const wy = wp.tileY !== undefined ? wp.tileY : wp.navY;
      if (wx !== undefined && wy !== undefined) {
        const dx = wx - currentX;
        const dy = wy - currentY;
        if (Math.hypot(dx, dy) > 0.15) {
          return normalizeAngle(Math.atan2(dy, dx));
        }
      }
    }
  }

  // Fallback towards destination
  const ddx = destX - currentX;
  const ddy = destY - currentY;
  if (Math.hypot(ddx, ddy) > 0.05) {
    return normalizeAngle(Math.atan2(ddy, ddx));
  }

  // Deterministic safe fallback
  return 0.0;
}

// ── Dynamic Interaction Radius (DIR) Configuration & Calculation ───────────────
export const DIR_CONFIG = {
  R_MIN: 5.0,
  R_MAX: 20.0,
  TAU_REACT: 1.5,
  BETA_DENSITY: 1.0,
  DENSITY_RADIUS: 8.0
};

/**
 * Computes Dynamic Interaction Radius (DIR) according to ARES V2 formulation:
 * R_i(t) = clip(R_min + tau_react * speed + beta_density * rho, R_min, R_max)
 *
 * @param {number} speedMps
 * @param {number} [localDensityCount=0]
 * @returns {number} Dynamic interaction radius in meters
 */
export function computeDynamicInteractionRadius(speedMps, localDensityCount = 0) {
  const { R_MIN, R_MAX, TAU_REACT, BETA_DENSITY } = DIR_CONFIG;
  const rawDir = R_MIN + Math.max(speedMps, 0.0) * TAU_REACT + BETA_DENSITY * Math.max(localDensityCount, 0);
  return Math.min(R_MAX, Math.max(R_MIN, rawDir));
}

/**
 * Convert existing robot state, fleet context, and conflicts into the exact 26 ARES V2 ML features.
 *
 * Formula definitions confirmed from V2 training (ares_simulation_engine.py):
 * - Dynamic Interaction Radius: R = clip(r_min + tau_react * speed + beta_density * rho, r_min, r_max)
 *   where r_min = 5.0, r_max = 20.0, tau_react = 1.5, beta_density = 1.0, density_radius = 8.0
 *   rho = count of active fleet neighbors within density_radius (8.0m)
 * - Closing velocity: v_close = -dot(r_ij, v_rel) / |r_ij|
 * - True TTC: dist / v_close if v_close > 0.05 else 99.0s fallback
 * - CPA time: clip(-dot(r_ij, v_rel) / |v_rel|^2, 0, 8.0s) else 0.0s
 * - CPA distance: |r_ij + v_rel * t_cpa| else dist
 * - No-neighbor defaults: d_near = 99.0, ttc = 99.0, cpa_d = 99.0, cpa_t = 0.0, rel_spd = 0.0, rel_dir = 'NONE'
 *
 * @param {object} robot - Current robot state object
 * @param {Object.<string, object>} allRobots - Entire fleet dictionary (fallback peer source)
 * @param {Array<object>} conflicts - Active detected conflicts list
 * @param {Phaser.Tilemaps.Tilemap} [map] - Tilemap for coordinate conversions
 * @param {Object.<string, object>|Array<object>|Map} [networkNeighbours=null] - Stage 5C network relevant neighbours
 * @returns {object} 26 ARES V2 ML feature object
 */
export function buildRobotFeatures(robot, allRobots = {}, conflicts = [], map = null, networkNeighbours = null) {
  // 1. Current Coordinates (tiles/meters)
  const curr = getRobotGridCoords(robot, map);
  const currentTileX = curr.x;
  const currentTileY = curr.y;

  // 2. Destination Coordinates (tiles/meters)
  const destTileX = robot.destination
    ? (robot.destination.tileX !== undefined ? robot.destination.tileX : (robot.destination.x !== undefined ? (Math.abs(robot.destination.x) > 60 ? (robot.destination.x - 16) / 32 : robot.destination.x) : currentTileX))
    : currentTileX;
  const destTileY = robot.destination
    ? (robot.destination.tileY !== undefined ? robot.destination.tileY : (robot.destination.y !== undefined ? (Math.abs(robot.destination.y) > 40 ? (robot.destination.y - 16) / 32 : robot.destination.y) : currentTileY))
    : currentTileY;

  // 3. Distance to Destination & Speed (m/s)
  const distToDest = Math.hypot(destTileX - currentTileX, destTileY - currentTileY);
  const speedMps = robot.effectiveSpeed !== undefined
    ? (robot.effectiveSpeed > 10 ? Number((robot.effectiveSpeed / 100).toFixed(2)) : Number(robot.effectiveSpeed.toFixed(2)))
    : (typeof robot.speed === 'number'
        ? (robot.speed > 10 ? Number((robot.speed / 100).toFixed(2)) : Number(robot.speed.toFixed(2)))
        : 1.0);

  // 4. Heading in radians [-PI, PI]
  const headingRad = computeHeadingRad(robot, currentTileX, currentTileY, destTileX, destTileY);

  // 5. ETA (seconds)
  const etaSec = Number((distToDest / Math.max(speedMps, 0.2)).toFixed(2));

  // 6. Battery %
  const batteryPct = robot.battery !== undefined ? Number(robot.battery) : 100.0;

  // 7. Dynamic Interaction Radius (DIR) & Local Fleet Density
  // Use network neighbour state as source of peer state when available, with safe fallback to in-process allRobots
  let candidatePeers = [];
  const peerDict = {};

  if (networkNeighbours !== null && networkNeighbours !== undefined) {
    const entries = Array.isArray(networkNeighbours)
      ? networkNeighbours.map((p) => [p?.robotId || p?.id, p])
      : (networkNeighbours instanceof Map
          ? Array.from(networkNeighbours.entries())
          : Object.entries(networkNeighbours));

    for (const [key, peer] of entries) {
      if (!peer) continue;
      const pid = peer.robotId || peer.id || key;
      if (pid === robot.id) continue;
      if (peer.status && String(peer.status).toLowerCase() === 'completed') continue;
      peerDict[pid] = peer;
      candidatePeers.push({ id: pid, obj: peer });
    }
  } else {
    for (const [otherId, other] of Object.entries(allRobots)) {
      if (!other || otherId === robot.id || (other.status && String(other.status).toLowerCase() === 'completed')) continue;
      peerDict[otherId] = other;
      candidatePeers.push({ id: otherId, obj: other });
    }
  }

  let rho = 0;
  const otherRobotsList = [];

  for (const { id: peerId, obj: peer } of candidatePeers) {
    const peerCoords = getRobotGridCoords(peer, map);
    const dist = typeof peer.distance_to_robot_m === 'number'
      ? peer.distance_to_robot_m
      : Math.hypot(peerCoords.x - currentTileX, peerCoords.y - currentTileY);

    if (dist <= DIR_CONFIG.DENSITY_RADIUS) {
      rho++;
    }
    otherRobotsList.push({ otherId: peerId, other: peer, coords: peerCoords, dist });
  }

  // DIR Formula: clip(r_min + tau_react * speed + beta_density * rho, r_min, r_max)
  const dynamicInteractionRadiusM = computeDynamicInteractionRadius(speedMps, rho);

  // 8. Neighbor Filtering strictly inside DIR
  const neighbors = otherRobotsList.filter((item) => item.dist <= dynamicInteractionRadiusM);
  const nearbyRobotCount = neighbors.length;

  // 9. Traffic Level derived from DIR neighbor count (exact V2 training thresholds)
  let trafficLevel = 'LOW';
  if (nearbyRobotCount === 0) trafficLevel = 'LOW';
  else if (nearbyRobotCount <= 2) trafficLevel = 'MEDIUM';
  else if (nearbyRobotCount <= 4) trafficLevel = 'HIGH';
  else trafficLevel = 'CRITICAL';

  // 10. Conflict inspection from existing predictive conflict detection
  const robotConflicts = Array.isArray(conflicts)
    ? conflicts.filter((c) => {
        if (!c || (c.robotA !== robot.id && c.robotB !== robot.id)) return false;
        const otherId = c.robotA === robot.id ? c.robotB : c.robotA;
        const other = peerDict[otherId] || (allRobots && allRobots[otherId]);
        return !other || (other.status && String(other.status).toLowerCase() !== 'completed');
      })
    : [];

  const obstacleDetected = robotConflicts.length > 0 ? 1 : 0;
  const pathBlocked = obstacleDetected;

  // 11. Nearest Robot Kinematics & CPA / TTC Features
  let nearestRobotDistanceM = 99.0;
  let nearestRobotRelativeSpeedMps = 0.0;
  let nearestRobotRelativeHeadingRad = 0.0;
  let closingVelocityMps = 0.0;
  let trueTtcSec = 99.0;
  let cpaTimeSec = 0.0;
  let cpaDistanceM = 99.0;
  let relativeDirection = 'NONE';
  let intersectionConflict = 0;

  if (neighbors.length > 0) {
    // Single nearest relevant robot inside DIR
    neighbors.sort((a, b) => a.dist - b.dist);
    const nearestItem = neighbors[0];
    const nearestOther = nearestItem.other;
    const dist = nearestItem.dist;
    nearestRobotDistanceM = Number(dist.toFixed(3));

    const otherDestX = nearestOther.destination
      ? (nearestOther.destination.tileX !== undefined ? nearestOther.destination.tileX : (nearestOther.destination.x !== undefined ? (Math.abs(nearestOther.destination.x) > 60 ? (nearestOther.destination.x - 16) / 32 : nearestOther.destination.x) : nearestItem.coords.x))
      : nearestItem.coords.x;
    const otherDestY = nearestOther.destination
      ? (nearestOther.destination.tileY !== undefined ? nearestOther.destination.tileY : (nearestOther.destination.y !== undefined ? (Math.abs(nearestOther.destination.y) > 40 ? (nearestOther.destination.y - 16) / 32 : nearestOther.destination.y) : nearestItem.coords.y))
      : nearestItem.coords.y;

    const otherHeadingRad = computeHeadingRad(nearestOther, nearestItem.coords.x, nearestItem.coords.y, otherDestX, otherDestY);
    const otherSpeedMps = nearestOther.effectiveSpeed !== undefined
      ? (nearestOther.effectiveSpeed > 10 ? Number((nearestOther.effectiveSpeed / 100).toFixed(2)) : Number(nearestOther.effectiveSpeed.toFixed(2)))
      : (typeof nearestOther.speed === 'number'
          ? (nearestOther.speed > 10 ? Number((nearestOther.speed / 100).toFixed(2)) : Number(nearestOther.speed.toFixed(2)))
          : 1.0);

    // Vector kinematics
    const rx = nearestItem.coords.x - currentTileX;
    const ry = nearestItem.coords.y - currentTileY;

    const vxSelf = speedMps * Math.cos(headingRad);
    const vySelf = speedMps * Math.sin(headingRad);
    const vxOther = otherSpeedMps * Math.cos(otherHeadingRad);
    const vyOther = otherSpeedMps * Math.sin(otherHeadingRad);

    const vxRel = vxOther - vxSelf;
    const vyRel = vyOther - vySelf;

    nearestRobotRelativeSpeedMps = Number(Math.hypot(vxRel, vyRel).toFixed(3));
    nearestRobotRelativeHeadingRad = Number(normalizeAngle(otherHeadingRad - headingRad).toFixed(3));

    // Relative direction categories: SAME, OPPOSITE, CROSSING
    const absRelH = Math.abs(nearestRobotRelativeHeadingRad);
    if (absRelH <= Math.PI / 4.0) {
      relativeDirection = 'SAME';
    } else if (absRelH >= (3.0 * Math.PI) / 4.0) {
      relativeDirection = 'OPPOSITE';
    } else {
      relativeDirection = 'CROSSING';
    }

    // Closing velocity: -dot(r_ij, v_rel) / dist
    if (dist > 1e-6) {
      const dotRVel = rx * vxRel + ry * vyRel;
      closingVelocityMps = Number((-dotRVel / dist).toFixed(3));
    } else {
      closingVelocityMps = 0.0;
    }

    // Vector TTC: only defined when closing_velocity > 0.05 m/s, capped at 99.0s
    if (closingVelocityMps > 0.05) {
      trueTtcSec = Number(Math.min(99.0, dist / closingVelocityMps).toFixed(2));
    } else {
      trueTtcSec = 99.0;
    }

    // Closest Point of Approach (CPA)
    const vRelSq = vxRel * vxRel + vyRel * vyRel;
    if (vRelSq > 0.0025) {
      const tCpaRaw = -(rx * vxRel + ry * vyRel) / vRelSq;
      cpaTimeSec = Number(Math.max(0.0, Math.min(8.0, tCpaRaw)).toFixed(2));
      const posCpaX = rx + vxRel * cpaTimeSec;
      const posCpaY = ry + vyRel * cpaTimeSec;
      cpaDistanceM = Number(Math.hypot(posCpaX, posCpaY).toFixed(3));
    } else {
      cpaTimeSec = 0.0;
      cpaDistanceM = Number(dist.toFixed(3));
    }

    // Intersection conflict: 1 when active vertex/crossing conflict or geometric crossing condition
    const hasCrossingFromConflictSystem = robotConflicts.some(
      (c) => c.type === 'vertex' || c.conflictType === 'CROSSING' || c.classification === 'CROSSING'
    );
    const hasGeometricCrossing = relativeDirection === 'CROSSING' && cpaDistanceM < 2.0 && trueTtcSec < 4.0;
    intersectionConflict = (hasCrossingFromConflictSystem || hasGeometricCrossing) ? 1 : 0;
  } else {
    // No neighbors within DIR
    const hasCrossingFromConflictSystem = robotConflicts.some(
      (c) => c.type === 'vertex' || c.conflictType === 'CROSSING' || c.classification === 'CROSSING'
    );
    intersectionConflict = hasCrossingFromConflictSystem ? 1 : 0;
  }

  // 12. Task Priority mapping
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

  // 13. Assemble the exact 26-feature ARES V2 object
  const features = {
    current_x: Number(currentTileX.toFixed(2)),
    current_y: Number(currentTileY.toFixed(2)),
    destination_x: Number(destTileX.toFixed(2)),
    destination_y: Number(destTileY.toFixed(2)),
    distance_to_destination_m: Number(distToDest.toFixed(2)),
    eta_sec: etaSec,
    speed_mps: speedMps,
    heading_rad: Number(headingRad.toFixed(4)),
    battery_pct: batteryPct,
    obstacle_detected: obstacleDetected,
    path_blocked: pathBlocked,
    alternative_route_available: 1,
    dynamic_interaction_radius_m: Number(dynamicInteractionRadiusM.toFixed(2)),
    nearby_robot_count: nearbyRobotCount,
    nearest_robot_distance_m: nearestRobotDistanceM,
    nearest_robot_relative_speed_mps: nearestRobotRelativeSpeedMps,
    nearest_robot_relative_heading_rad: nearestRobotRelativeHeadingRad,
    closing_velocity_mps: closingVelocityMps,
    true_ttc_sec: trueTtcSec,
    cpa_time_sec: cpaTimeSec,
    cpa_distance_m: cpaDistanceM,
    intersection_conflict: intersectionConflict,
    task_type: mapTaskType(robot.task),
    task_priority: taskPriority,
    traffic_level: trafficLevel,
    relative_direction: relativeDirection
  };

  // Development-only assertion to verify exact key count and expected key set
  if (
    (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') ||
    (typeof window !== 'undefined' && window.__DEV__)
  ) {
    const keys = Object.keys(features);
    if (keys.length !== 26) {
      console.error(`[EdgeClient Assertion Error] Feature count mismatch: expected 26, got ${keys.length}`);
    }
    const missingKeys = V2_FEATURE_KEYS.filter((k) => !(k in features));
    const extraKeys = keys.filter((k) => !V2_FEATURE_KEYS.includes(k));
    if (missingKeys.length > 0 || extraKeys.length > 0) {
      console.error(
        `[EdgeClient Assertion Error] Key set mismatch! Missing: ${missingKeys.join(', ')} | Extra: ${extraKeys.join(', ')}`
      );
    }
  }

  return features;
}

