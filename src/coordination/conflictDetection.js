/**
 * coordination/conflictDetection.js
 * Predictive fleet conflict detection — detects vertex and edge conflicts across
 * all unique robot pairs based on time-parameterized paths.
 *
 * Exported factory receives its dependencies; it DOES NOT import robots globally.
 *
 * Functions preserved verbatim from original main.js:
 *   buildTimeParameterizedPath()
 *   detectVertexConflicts()
 *   detectEdgeConflicts()
 *   detectFleetConflicts()
 *   renderConflicts()   (canvas drawing, depth 95)
 *
 * CONFLICT_TIME_THRESHOLD = 0.75 s (imported from constants).
 * Do NOT change the algorithm.
 */

import { CONFLICT_TIME_THRESHOLD, SAFE_TIME_SEPARATION, MAX_PLAUSIBLE_DELAY_SEC } from '../config/constants.js';

/**
 * Helper to compute travel unit vector for a robot at a given waypoint index.
 * Looks backward to determine incoming direction, or forward if at start index.
 *
 * @param {Array<object>} path - Waypoint list with tileX/navX, tileY/navY
 * @param {number} idx - Current waypoint index
 * @returns {{ dx: number, dy: number, isIncoming: boolean } | null}
 */
function getVectorAtIndex(path, idx) {
  if (!path || path.length <= 1 || idx < 0 || idx >= path.length) {
    return null;
  }

  const curr = path[idx];
  if (!curr) return null;
  const cx = curr.tileX !== undefined ? curr.tileX : curr.navX;
  const cy = curr.tileY !== undefined ? curr.tileY : curr.navY;
  if (cx === undefined || cy === undefined) return null;

  if (idx > 0) {
    // Look backward for a distinct predecessor waypoint (incoming vector)
    for (let p = idx - 1; p >= 0; p--) {
      const prev = path[p];
      if (!prev) continue;
      const px = prev.tileX !== undefined ? prev.tileX : prev.navX;
      const py = prev.tileY !== undefined ? prev.tileY : prev.navY;
      if (px !== undefined && py !== undefined) {
        const dx = cx - px;
        const dy = cy - py;
        const len = Math.hypot(dx, dy);
        if (len > 1e-5) {
          return { dx: dx / len, dy: dy / len, isIncoming: true };
        }
      }
    }
  }

  // If at start (idx === 0) or no distinct predecessor, look forward (outgoing vector)
  for (let n = idx + 1; n < path.length; n++) {
    const next = path[n];
    if (!next) continue;
    const nx = next.tileX !== undefined ? next.tileX : next.navX;
    const ny = next.tileY !== undefined ? next.tileY : next.navY;
    if (nx !== undefined && ny !== undefined) {
      const dx = nx - cx;
      const dy = ny - cy;
      const len = Math.hypot(dx, dy);
      if (len > 1e-5) {
        return { dx: dx / len, dy: dy / len, isIncoming: false };
      }
    }
  }

  return null;
}

/**
 * Locate matching waypoint for robot at given coordinates (and optional time)
 * and return its travel vector.
 *
 * @param {object} robot
 * @param {number} targetTileX
 * @param {number} targetTileY
 * @param {number|null} [targetTime]
 * @returns {{ dx: number, dy: number, isIncoming: boolean } | null}
 */
function getRobotTravelVector(robot, targetTileX, targetTileY, targetTime = null) {
  if (!robot || robot.status === 'completed') return null;
  const path = (Array.isArray(robot.timePath) && robot.timePath.length > 0)
    ? robot.timePath
    : (Array.isArray(robot.path) && robot.path.length > 0 ? robot.path : null);
  if (!path || path.length === 0) return null;

  let matchIndex = -1;
  let minTimeDiff = Infinity;

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (!node) continue;
    const nx = node.tileX !== undefined ? node.tileX : node.navX;
    const ny = node.tileY !== undefined ? node.tileY : node.navY;
    if (nx === undefined || ny === undefined) continue;

    if (Math.abs(nx - targetTileX) < 0.1 && Math.abs(ny - targetTileY) < 0.1) {
      if (targetTime !== null && node.time !== undefined) {
        const diff = Math.abs(node.time - targetTime);
        if (diff < minTimeDiff) {
          minTimeDiff = diff;
          matchIndex = i;
        }
      } else {
        matchIndex = i;
        break;
      }
    }
  }

  if (matchIndex === -1) {
    return null;
  }

  return getVectorAtIndex(path, matchIndex);
}

/**
 * Classify a conflict using trajectory/path geometry and direction information.
 *
 * Possible classifications:
 * - 'SAME_DIRECTION' : Robots are travelling along the same route direction / same corridor direction.
 * - 'HEAD_ON'        : Robots are travelling toward each other on the same narrow route/edge/corridor.
 * - 'CROSSING'       : Robots approach a shared intersection/conflict area from different directions.
 * - 'UNKNOWN'        : Insufficient geometry to confidently classify the conflict.
 *
 * Does NOT infer classification from robot priority.
 *
 * @param {object} conflict - Conflict descriptor (vertex or edge)
 * @param {object|Object.<string, object>} [rAOrRobots] - Live robot A state OR fleet dictionary
 * @param {object} [rB] - Live robot B state
 * @param {number} [idxA] - Optional precomputed waypoint index for robot A
 * @param {number} [idxB] - Optional precomputed waypoint index for robot B
 * @returns {"SAME_DIRECTION"|"HEAD_ON"|"CROSSING"|"UNKNOWN"}
 */
export function classifyConflict(conflict, rAOrRobots, rB, idxA, idxB) {
  if (!conflict || typeof conflict !== 'object') return 'UNKNOWN';

  let robotA = rAOrRobots;
  let robotB = rB;

  if (rAOrRobots && typeof rAOrRobots === 'object' && !rB && (conflict.robotA || conflict.robotB)) {
    robotA = rAOrRobots[conflict.robotA];
    robotB = rAOrRobots[conflict.robotB];
  }

  if (conflict.type === 'edge') {
    if (!conflict.fromA || !conflict.toA || !conflict.fromB || !conflict.toB) {
      return 'UNKNOWN';
    }
    const ax = conflict.fromA.tileX !== undefined ? conflict.fromA.tileX : conflict.fromA.navX;
    const ay = conflict.fromA.tileY !== undefined ? conflict.fromA.tileY : conflict.fromA.navY;
    const bx = conflict.toA.tileX !== undefined ? conflict.toA.tileX : conflict.toA.navX;
    const by = conflict.toA.tileY !== undefined ? conflict.toA.tileY : conflict.toA.navY;
    const cx = conflict.fromB.tileX !== undefined ? conflict.fromB.tileX : conflict.fromB.navX;
    const cy = conflict.fromB.tileY !== undefined ? conflict.fromB.tileY : conflict.fromB.navY;
    const dx = conflict.toB.tileX !== undefined ? conflict.toB.tileX : conflict.toB.navX;
    const dy = conflict.toB.tileY !== undefined ? conflict.toB.tileY : conflict.toB.navY;

    if (ax === undefined || ay === undefined || bx === undefined || by === undefined ||
        cx === undefined || cy === undefined || dx === undefined || dy === undefined) {
      return 'UNKNOWN';
    }

    const vAx = bx - ax;
    const vAy = by - ay;
    const vBx = dx - cx;
    const vBy = dy - cy;
    const lenA = Math.hypot(vAx, vAy);
    const lenB = Math.hypot(vBx, vBy);
    if (lenA < 1e-5 || lenB < 1e-5) return 'UNKNOWN';

    const dot = (vAx * vBx + vAy * vBy) / (lenA * lenB);
    if (dot < -0.7) return 'HEAD_ON';
    if (dot > 0.7) return 'SAME_DIRECTION';
    return 'UNKNOWN';
  }

  if (conflict.type === 'vertex') {
    const targetX = conflict.tileX !== undefined ? conflict.tileX : conflict.navX;
    const targetY = conflict.tileY !== undefined ? conflict.tileY : conflict.navY;
    if (targetX === undefined || targetY === undefined) return 'UNKNOWN';

    const pathA = (robotA && Array.isArray(robotA.timePath) && robotA.timePath.length > 0)
      ? robotA.timePath
      : (robotA && Array.isArray(robotA.path) && robotA.path.length > 0 ? robotA.path : null);

    const pathB = (robotB && Array.isArray(robotB.timePath) && robotB.timePath.length > 0)
      ? robotB.timePath
      : (robotB && Array.isArray(robotB.path) && robotB.path.length > 0 ? robotB.path : null);

    if (!pathA || !pathB) return 'UNKNOWN';

    let vecA = null;
    if (typeof idxA === 'number' && idxA >= 0 && idxA < pathA.length) {
      vecA = getVectorAtIndex(pathA, idxA);
    } else {
      vecA = getRobotTravelVector(robotA, targetX, targetY, conflict.timeA !== undefined ? conflict.timeA : null);
    }

    let vecB = null;
    if (typeof idxB === 'number' && idxB >= 0 && idxB < pathB.length) {
      vecB = getVectorAtIndex(pathB, idxB);
    } else {
      vecB = getRobotTravelVector(robotB, targetX, targetY, conflict.timeB !== undefined ? conflict.timeB : null);
    }

    if (!vecA || !vecB) return 'UNKNOWN';

    const dot = vecA.dx * vecB.dx + vecA.dy * vecB.dy;

    if (vecA.isIncoming && vecB.isIncoming) {
      if (dot > 0.7) return 'SAME_DIRECTION';
      if (dot < -0.7) return 'HEAD_ON';
      return 'CROSSING';
    }

    if (!vecA.isIncoming && !vecB.isIncoming) {
      if (dot > 0.7) return 'SAME_DIRECTION';
      if (Math.abs(dot) <= 0.7) return 'CROSSING';
      return 'UNKNOWN';
    }

    // One incoming, one outgoing
    if (dot > 0.7) return 'SAME_DIRECTION';
    if (dot < -0.7) return 'HEAD_ON';
    return 'CROSSING';
  }

  return 'UNKNOWN';
}

/**
 * Locate matching waypoint index for a robot at given coordinates (and optional time).
 *
 * @param {Array<object>} path
 * @param {number} targetX
 * @param {number} targetY
 * @param {number|null} [targetTime]
 * @returns {number}
 */
function findMatchingWaypointIndex(path, targetX, targetY, targetTime = null) {
  if (!path || path.length === 0) return -1;
  let matchIndex = -1;
  let minDiff = Infinity;
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    if (!n) continue;
    const nx = n.tileX !== undefined ? n.tileX : n.navX;
    const ny = n.tileY !== undefined ? n.tileY : n.navY;
    if (nx === undefined || ny === undefined) continue;
    if (Math.abs(nx - targetX) < 0.1 && Math.abs(ny - targetY) < 0.1) {
      if (targetTime !== null && typeof n.time === 'number') {
        const d = Math.abs(n.time - targetTime);
        if (d < minDiff) {
          minDiff = d;
          matchIndex = i;
        }
      } else {
        matchIndex = i;
        break;
      }
    }
  }
  return matchIndex;
}

/**
 * Check if two paths traverse the same corridor in opposite directions.
 * Returns true if Robot A's future waypoints after idxA overlap with Robot B's
 * past waypoints before idxB, OR if Robot B's future waypoints overlap with Robot A's past waypoints.
 *
 * @param {Array<object>} pathA
 * @param {number} idxA
 * @param {Array<object>} pathB
 * @param {number} idxB
 * @returns {boolean}
 */
function checkOpposingCorridorOverlap(pathA, idxA, pathB, idxB) {
  if (!pathA || !pathB || idxA < 0 || idxB < 0) return false;

  const futureA = pathA.slice(idxA + 1);
  const pastB = pathB.slice(0, idxB);

  for (const fa of futureA) {
    const ax = fa.tileX !== undefined ? fa.tileX : fa.navX;
    const ay = fa.tileY !== undefined ? fa.tileY : fa.navY;
    if (ax === undefined || ay === undefined) continue;

    for (const pb of pastB) {
      const bx = pb.tileX !== undefined ? pb.tileX : pb.navX;
      const by = pb.tileY !== undefined ? pb.tileY : pb.navY;
      if (bx === undefined || by === undefined) continue;
      if (Math.abs(ax - bx) < 0.1 && Math.abs(ay - by) < 0.1) {
        return true;
      }
    }
  }

  const futureB = pathB.slice(idxB + 1);
  const pastA = pathA.slice(0, idxA);

  for (const fb of futureB) {
    const bx = fb.tileX !== undefined ? fb.tileX : fb.navX;
    const by = fb.tileY !== undefined ? fb.tileY : fb.navY;
    if (bx === undefined || by === undefined) continue;

    for (const pa of pastA) {
      const ax = pa.tileX !== undefined ? pa.tileX : pa.navX;
      const ay = pa.tileY !== undefined ? pa.tileY : pa.navY;
      if (ax === undefined || ay === undefined) continue;
      if (Math.abs(ax - bx) < 0.1 && Math.abs(ay - by) < 0.1) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Assess whether a predicted conflict can potentially be resolved by a small
 * TIMING adjustment instead of changing the route.
 *
 * Does NOT call any ML model or infer from robot priority.
 *
 * @param {object} conflict - Conflict descriptor (vertex or edge)
 * @param {object|Object.<string, object>} [rAOrRobots] - Live robot A state OR fleet dictionary
 * @param {object} [rB] - Live robot B state
 * @param {number} [idxA] - Optional precomputed waypoint index for robot A
 * @param {number} [idxB] - Optional precomputed waypoint index for robot B
 * @returns {{
 *   conflictType: string,
 *   timeA: number|null,
 *   timeB: number|null,
 *   timeGap: number|null,
 *   safeSeparationSec: number,
 *   estimatedDelaySec: number|null,
 *   timingResolutionPossible: boolean,
 *   requiresReroute: boolean,
 *   reason: string
 * }}
 */
export function assessTemporalResolution(conflict, rAOrRobots, rB, idxA, idxB) {
  if (!conflict || typeof conflict !== 'object') {
    return {
      conflictType: 'UNKNOWN',
      timeA: null,
      timeB: null,
      timeGap: null,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: false,
      reason: 'Invalid or missing conflict descriptor'
    };
  }

  let robotA = rAOrRobots;
  let robotB = rB;

  if (rAOrRobots && typeof rAOrRobots === 'object' && !rB && (conflict.robotA || conflict.robotB)) {
    robotA = rAOrRobots[conflict.robotA];
    robotB = rAOrRobots[conflict.robotB];
  }

  const conflictType = conflict.conflictType || classifyConflict(conflict, robotA, robotB, idxA, idxB);

  const timeA = typeof conflict.timeA === 'number' ? conflict.timeA : null;
  const timeB = typeof conflict.timeB === 'number' ? conflict.timeB : null;

  if (timeA === null || timeB === null) {
    return {
      conflictType,
      timeA,
      timeB,
      timeGap: null,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: false,
      reason: 'Missing arrival times on conflict'
    };
  }

  const timeGap = parseFloat(Math.abs(timeA - timeB).toFixed(2));

  // 1. Edge conflict assessment
  if (conflict.type === 'edge') {
    if (!conflict.fromA || !conflict.toA || !conflict.fromB || !conflict.toB) {
      return {
        conflictType,
        timeA,
        timeB,
        timeGap,
        safeSeparationSec: SAFE_TIME_SEPARATION,
        estimatedDelaySec: null,
        timingResolutionPossible: false,
        requiresReroute: false,
        reason: 'Malformed edge conflict geometry'
      };
    }
    return {
      conflictType: 'HEAD_ON',
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: 'Opposing traversal of shared edge cannot be resolved by timing alone; spatial rerouting required'
    };
  }

  // 2. Vertex conflict assessment
  const targetX = conflict.tileX !== undefined ? conflict.tileX : conflict.navX;
  const targetY = conflict.tileY !== undefined ? conflict.tileY : conflict.navY;
  if (targetX === undefined || targetY === undefined) {
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: false,
      reason: 'Missing vertex coordinates on conflict'
    };
  }

  const pathA = (robotA && Array.isArray(robotA.timePath) && robotA.timePath.length > 0)
    ? robotA.timePath
    : (robotA && Array.isArray(robotA.path) && robotA.path.length > 0 ? robotA.path : null);

  const pathB = (robotB && Array.isArray(robotB.timePath) && robotB.timePath.length > 0)
    ? robotB.timePath
    : (robotB && Array.isArray(robotB.path) && robotB.path.length > 0 ? robotB.path : null);

  if (!pathA || !pathB) {
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: false,
      reason: 'Missing trajectory paths for conflict robots'
    };
  }

  const iA = (typeof idxA === 'number' && idxA >= 0 && idxA < pathA.length)
    ? idxA
    : findMatchingWaypointIndex(pathA, targetX, targetY, timeA);

  const iB = (typeof idxB === 'number' && idxB >= 0 && idxB < pathB.length)
    ? idxB
    : findMatchingWaypointIndex(pathB, targetX, targetY, timeB);

  if (iA === -1 || iB === -1) {
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec: null,
      timingResolutionPossible: false,
      requiresReroute: false,
      reason: 'Conflict coordinates not found in robot trajectories'
    };
  }

  // Same-direction conflicts: usually prefer timing adjustment if delay safely separates robots
  if (conflictType === 'SAME_DIRECTION') {
    const needed = Math.max(0, SAFE_TIME_SEPARATION - timeGap);
    const estimatedDelaySec = parseFloat(needed.toFixed(2));
    if (estimatedDelaySec <= MAX_PLAUSIBLE_DELAY_SEC) {
      return {
        conflictType,
        timeA,
        timeB,
        timeGap,
        safeSeparationSec: SAFE_TIME_SEPARATION,
        estimatedDelaySec,
        timingResolutionPossible: true,
        requiresReroute: false,
        reason: `Same-direction trailing conflict resolvable by ${estimatedDelaySec}s yield delay`
      };
    }
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec,
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: `Required delay (${estimatedDelaySec}s) exceeds maximum plausible threshold (${MAX_PLAUSIBLE_DELAY_SEC}s); spatial rerouting preferred`
    };
  }

  // Crossing conflicts: prefer timing adjustment when lead robot clears intersection before yielding robot arrives
  if (conflictType === 'CROSSING') {
    const needed = Math.max(0, SAFE_TIME_SEPARATION - timeGap);
    const estimatedDelaySec = parseFloat(needed.toFixed(2));
    if (estimatedDelaySec <= MAX_PLAUSIBLE_DELAY_SEC) {
      return {
        conflictType,
        timeA,
        timeB,
        timeGap,
        safeSeparationSec: SAFE_TIME_SEPARATION,
        estimatedDelaySec,
        timingResolutionPossible: true,
        requiresReroute: false,
        reason: `Crossing intersection resolvable by ${estimatedDelaySec}s yield delay for trailing robot`
      };
    }
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec,
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: `Crossing delay (${estimatedDelaySec}s) exceeds maximum plausible threshold (${MAX_PLAUSIBLE_DELAY_SEC}s); spatial rerouting preferred`
    };
  }

  // Head-on conflicts: inspect trajectory geometry
  if (conflictType === 'HEAD_ON') {
    const hasOpposingCorridorOverlap = checkOpposingCorridorOverlap(pathA, iA, pathB, iB);

    if (hasOpposingCorridorOverlap) {
      return {
        conflictType,
        timeA,
        timeB,
        timeGap,
        safeSeparationSec: SAFE_TIME_SEPARATION,
        estimatedDelaySec: null,
        timingResolutionPossible: false,
        requiresReroute: true,
        reason: 'Opposing traversal of shared corridor cannot be resolved by timing alone; spatial rerouting required'
      };
    }

    // Opposite approach into a junction, but diverging onto separate disjoint routes
    const needed = Math.max(0, SAFE_TIME_SEPARATION - timeGap);
    const estimatedDelaySec = parseFloat(needed.toFixed(2));
    if (estimatedDelaySec <= MAX_PLAUSIBLE_DELAY_SEC) {
      return {
        conflictType,
        timeA,
        timeB,
        timeGap,
        safeSeparationSec: SAFE_TIME_SEPARATION,
        estimatedDelaySec,
        timingResolutionPossible: true,
        requiresReroute: false,
        reason: `Head-on approach diverges onto separate routes at vertex; timing delay of ${estimatedDelaySec}s is sufficient`
      };
    }
    return {
      conflictType,
      timeA,
      timeB,
      timeGap,
      safeSeparationSec: SAFE_TIME_SEPARATION,
      estimatedDelaySec,
      timingResolutionPossible: false,
      requiresReroute: true,
      reason: `Required junction clearance delay (${estimatedDelaySec}s) exceeds maximum plausible threshold; spatial rerouting preferred`
    };
  }

  // UNKNOWN or unhandled
  return {
    conflictType: conflictType || 'UNKNOWN',
    timeA,
    timeB,
    timeGap,
    safeSeparationSec: SAFE_TIME_SEPARATION,
    estimatedDelaySec: null,
    timingResolutionPossible: false,
    requiresReroute: false,
    reason: 'Insufficient trajectory geometry to confidently assess temporal resolution'
  };
}

/**
 * Create the conflict detection subsystem.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Object.<string, object>} robots  - live robot state objects (mutated externally)
 * @param {{ updateConflictPanel: Function }} callbacks
 * @returns {{
 *   conflictGraphics: Phaser.GameObjects.Graphics,
 *   detectFleetConflicts: Function,
 *   buildTimeParameterizedPath: Function,
 *   detectVertexConflicts: Function,
 *   detectEdgeConflicts: Function,
 *   getConflicts: Function
 * }}
 */
export function createConflictDetector(scene, map, robots, callbacks) {

  // Dedicated graphics layer — depth 95 renders above paths (85) and
  // destination markers (90) but below robot sprites (100).
  const conflictGraphics = scene.add.graphics();
  conflictGraphics.setDepth(95);

  // Mutable conflict list shared within this closure
  let conflicts = [];

  // ── 1. TIME-PARAMETERIZED PATH ──────────────────────────────────────────────
  // Builds robotState.timePath – an ordered list of { navX, navY, tileX, tileY, worldX, worldY, time }
  // where `time` is cumulative seconds from the robot's current position along the corridor centerline.
  // Does NOT touch robotState.path.
  const buildTimeParameterizedPath = (robotId) => {
    const r = robots[robotId];
    if (!r || !r.path || r.path.length === 0 || r.status === 'completed') {
      if (r) r.timePath = null;
      return null;
    }
    const timePath = [];
    let t = 0.0;
    const first = r.path[0];
    const firstWx = first.worldX !== undefined ? first.worldX : (map.tileToWorldX(first.tileX) + 16);
    const firstWy = first.worldY !== undefined ? first.worldY : (map.tileToWorldY(first.tileY) + 16);

    timePath.push({
      navX:   first.navX !== undefined ? first.navX : first.tileX,
      navY:   first.navY !== undefined ? first.navY : first.tileY,
      tileX:  first.tileX,
      tileY:  first.tileY,
      worldX: firstWx,
      worldY: firstWy,
      time:   0.0
    });

    for (let i = 1; i < r.path.length; i++) {
      const prev = r.path[i - 1];
      const curr = r.path[i];
      const px = prev.worldX !== undefined ? prev.worldX : (map.tileToWorldX(prev.tileX) + 16);
      const py = prev.worldY !== undefined ? prev.worldY : (map.tileToWorldY(prev.tileY) + 16);
      const cx = curr.worldX !== undefined ? curr.worldX : (map.tileToWorldX(curr.tileX) + 16);
      const cy = curr.worldY !== undefined ? curr.worldY : (map.tileToWorldY(curr.tileY) + 16);
      const dist = (typeof Phaser !== 'undefined' && Phaser?.Math?.Distance?.Between)
        ? Phaser.Math.Distance.Between(px, py, cx, cy)
        : Math.hypot(cx - px, cy - py);
      t += dist / (r.speed || 100);

      timePath.push({
        navX:   curr.navX !== undefined ? curr.navX : curr.tileX,
        navY:   curr.navY !== undefined ? curr.navY : curr.tileY,
        tileX:  curr.tileX,
        tileY:  curr.tileY,
        worldX: cx,
        worldY: cy,
        time:   parseFloat(t.toFixed(3))
      });
    }
    r.timePath = timePath;
    return timePath;
  };

  // ── 2. VERTEX CONFLICT DETECTOR ─────────────────────────────────────────────
  // Returns conflicts where robotA and robotB occupy the exact same logical node
  // within CONFLICT_TIME_THRESHOLD seconds of each other.
  const detectVertexConflicts = (idA, idB) => {
    const rA = robots[idA];
    const rB = robots[idB];
    if (!rA?.timePath || !rB?.timePath) return [];
    if (rA.status === 'completed' || rB.status === 'completed') return [];
    const found = [];
    for (let i = 0; i < rA.timePath.length; i++) {
      const nA = rA.timePath[i];
      for (let j = 0; j < rB.timePath.length; j++) {
        const nB = rB.timePath[j];
        if (nA.navX === nB.navX && nA.navY === nB.navY) {
          const dt = Math.abs(nA.time - nB.time);
          if (dt <= CONFLICT_TIME_THRESHOLD) {
            const conflict = {
              type: 'vertex',
              conflictType: classifyConflict({
                type: 'vertex',
                robotA: idA, robotB: idB,
                navX: nA.navX, navY: nA.navY,
                tileX: nA.tileX, tileY: nA.tileY,
                timeA: nA.time, timeB: nB.time
              }, rA, rB, i, j),
              robotA: idA, robotB: idB,
              navX: nA.navX, navY: nA.navY,
              tileX: nA.tileX, tileY: nA.tileY,
              worldX: nA.worldX, worldY: nA.worldY,
              timeA: parseFloat(nA.time.toFixed(2)),
              timeB: parseFloat(nB.time.toFixed(2)),
              timeDiff: parseFloat(dt.toFixed(2))
            };
            conflict.temporalAssessment = assessTemporalResolution(conflict, rA, rB, i, j);
            found.push(conflict);
          }
        }
      }
    }
    return found;
  };

  // ── 3. EDGE CONFLICT DETECTOR ────────────────────────────────────────────────
  // Returns conflicts where robotA traverses logical edge A→B while robotB traverses
  // B→A, and both traversal intervals overlap within the safety threshold.
  const detectEdgeConflicts = (idA, idB) => {
    const rA = robots[idA];
    const rB = robots[idB];
    if (!rA?.timePath || !rB?.timePath) return [];
    if (rA.status === 'completed' || rB.status === 'completed') return [];
    if (rA.timePath.length < 2 || rB.timePath.length < 2) return [];
    const found = [];
    for (let i = 1; i < rA.timePath.length; i++) {
      const fromA = rA.timePath[i - 1];
      const toA   = rA.timePath[i];
      for (let j = 1; j < rB.timePath.length; j++) {
        const fromB = rB.timePath[j - 1];
        const toB   = rB.timePath[j];
        // Opposite traversal of the same logical edge?
        if (fromA.navX === toB.navX && fromA.navY === toB.navY &&
            toA.navX === fromB.navX && toA.navY === fromB.navY) {
          // Do the traversal time-intervals overlap (with threshold slack)?
          const overlap =
            fromA.time <= toB.time   + CONFLICT_TIME_THRESHOLD &&
            fromB.time <= toA.time   + CONFLICT_TIME_THRESHOLD;
          if (overlap) {
            const conflict = {
              type: 'edge',
              conflictType: classifyConflict({
                type: 'edge',
                robotA: idA, robotB: idB,
                fromA: { navX: fromA.navX, navY: fromA.navY, tileX: fromA.tileX, tileY: fromA.tileY },
                toA:   { navX: toA.navX,   navY: toA.navY,   tileX: toA.tileX,   tileY: toA.tileY },
                fromB: { navX: fromB.navX, navY: fromB.navY, tileX: fromB.tileX, tileY: fromB.tileY },
                toB:   { navX: toB.navX,   navY: toB.navY,   tileX: toB.tileX,   tileY: toB.tileY }
              }, rA, rB),
              robotA: idA, robotB: idB,
              fromA: { navX: fromA.navX, navY: fromA.navY, tileX: fromA.tileX, tileY: fromA.tileY, worldX: fromA.worldX, worldY: fromA.worldY },
              toA:   { navX: toA.navX,   navY: toA.navY,   tileX: toA.tileX,   tileY: toA.tileY,   worldX: toA.worldX,   worldY: toA.worldY },
              fromB: { navX: fromB.navX, navY: fromB.navY, tileX: fromB.tileX, tileY: fromB.tileY, worldX: fromB.worldX, worldY: fromB.worldY },
              toB:   { navX: toB.navX,   navY: toB.navY,   tileX: toB.tileX,   tileY: toB.tileY,   worldX: toB.worldX,   worldY: toB.worldY },
              timeA: parseFloat(((fromA.time + toA.time) / 2).toFixed(2)),
              timeB: parseFloat(((fromB.time + toB.time) / 2).toFixed(2))
            };
            conflict.temporalAssessment = assessTemporalResolution(conflict, rA, rB);
            found.push(conflict);
          }
        }
      }
    }
    return found;
  };

  // ── 4. CONFLICT VISUALIZER ───────────────────────────────────────────────────
  // Draws warning markers on the Phaser canvas along the corridor centerline. Never modifies map tiles.
  const renderConflicts = () => {
    conflictGraphics.clear();
    if (!conflicts || conflicts.length === 0) return;

    for (const c of conflicts) {
      if (c.type === 'vertex') {
        const wx = c.worldX !== undefined ? c.worldX : (map.tileToWorldX(c.tileX) + 16);
        const wy = c.worldY !== undefined ? c.worldY : (map.tileToWorldY(c.tileY) + 16);
        // Soft outer glow
        conflictGraphics.lineStyle(8, 0xff1144, 0.25);
        conflictGraphics.strokeCircle(wx, wy, 16);
        // Bold ring
        conflictGraphics.lineStyle(2.5, 0xff2244, 0.95);
        conflictGraphics.strokeCircle(wx, wy, 13);
        // Semi-transparent fill
        conflictGraphics.fillStyle(0xff2244, 0.3);
        conflictGraphics.fillCircle(wx, wy, 13);
        // White ×
        conflictGraphics.lineStyle(2, 0xffffff, 0.95);
        conflictGraphics.lineBetween(wx - 5, wy - 5, wx + 5, wy + 5);
        conflictGraphics.lineBetween(wx - 5, wy + 5, wx + 5, wy - 5);
      } else if (c.type === 'edge') {
        const ax = c.fromA.worldX !== undefined ? c.fromA.worldX : (map.tileToWorldX(c.fromA.tileX) + 16);
        const ay = c.fromA.worldY !== undefined ? c.fromA.worldY : (map.tileToWorldY(c.fromA.tileY) + 16);
        const bx = c.toA.worldX   !== undefined ? c.toA.worldX   : (map.tileToWorldX(c.toA.tileX) + 16);
        const by = c.toA.worldY   !== undefined ? c.toA.worldY   : (map.tileToWorldY(c.toA.tileY) + 16);
        // Glow
        conflictGraphics.lineStyle(9, 0xff5500, 0.3);
        conflictGraphics.lineBetween(ax, ay, bx, by);
        // Sharp line
        conflictGraphics.lineStyle(3, 0xff6600, 0.95);
        conflictGraphics.lineBetween(ax, ay, bx, by);
        // Midpoint dot
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        conflictGraphics.fillStyle(0xffffff, 1);
        conflictGraphics.fillCircle(mx, my, 4);
        conflictGraphics.lineStyle(2, 0xff3300, 1);
        conflictGraphics.strokeCircle(mx, my, 6);
      }
    }
  };

  // ── 5. FLEET CONFLICT COORDINATOR ────────────────────────────────────────────
  // Rebuilds all time-parameterized paths, compares every unique robot pair,
  // then renders and reports results. Does NOT change any robot's behaviour.
  const detectFleetConflicts = () => {
    const ids = Object.keys(robots);

    // Rebuild time paths for all robots
    ids.forEach((id) => buildTimeParameterizedPath(id));

    // Collect conflicts from all unique pairs
    const all = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        all.push(...detectVertexConflicts(ids[i], ids[j]));
        all.push(...detectEdgeConflicts(ids[i], ids[j]));
      }
    }
    conflicts = all;

    renderConflicts();
    callbacks.updateConflictPanel(conflicts);
    return all;
  };

  /** Accessor so main.js can sync window.conflicts */
  const getConflicts = () => conflicts;

  return {
    conflictGraphics,
    detectFleetConflicts,
    buildTimeParameterizedPath,
    detectVertexConflicts,
    detectEdgeConflicts,
    getConflicts,
    classifyConflict,
    assessTemporalResolution
  };
}
