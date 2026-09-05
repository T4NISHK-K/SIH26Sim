/**
 * robots/robotMovement.js
 * Responsible for robot movement, tweening, and LOCAL EDGE ML decision execution.
 *
 * Mode handling:
 *   BASELINE:
 *     - Ignores all ML decisions.
 *     - Existing movement behavior remains completely unchanged.
 *   OPTIMIZED:
 *     - Reads latest decision from window.robotDecisionState[robotId].
 *     - MOVE:    Continue at configured robot speed.
 *     - SLOW:    Reduce current movement speed to 50% without changing r.speed in UI.
 *     - WAIT:    Pause temporarily, preserving path/position. Resumes on MOVE/SLOW
 *                or after a 3s safety timeout. Records waiting time in metrics.
 *     - REROUTE: Recalculates alternate path using existing A* avoiding conflict,
 *                without teleportation. If no alternate path exists, falls back to WAIT.
 */

const DECISION_MAX_AGE_MS = 3000;
const REROUTE_COOLDOWN_MS = 1500;
const WAIT_SAFETY_TIMEOUT_MS = 3000;

// Initialize global debug container
if (typeof window !== 'undefined') {
  window.robotMovementDecisionState = window.robotMovementDecisionState || {};
}

/**
 * Retrieve the latest valid decision for a robot.
 * In BASELINE mode or when decision is stale (>3000ms) or missing, returns MOVE.
 *
 * @param {string} robotId
 * @param {string} runMode
 * @returns {{ decision: "MOVE"|"SLOW"|"WAIT"|"REROUTE", isFresh: boolean, raw: object|null }}
 */
function getEffectiveDecision(robotId, runMode) {
  if (runMode !== 'OPTIMIZED') {
    return { decision: 'MOVE', isFresh: false, raw: null };
  }

  const record = (typeof window !== 'undefined' && window.robotDecisionState)
    ? window.robotDecisionState[robotId]
    : null;

  if (!record || !record.decision) {
    return { decision: 'MOVE', isFresh: false, raw: null };
  }

  const now = Date.now();
  const age = now - (record.timestamp || 0);

  if (age > DECISION_MAX_AGE_MS) {
    return { decision: 'MOVE', isFresh: false, raw: record };
  }

  // Optimized movement applies ML decisions only when confidence >= 0.60
  const confidence = typeof record.confidence === 'number' ? record.confidence : 0;
  if (confidence < 0.60) {
    return { decision: 'MOVE', isFresh: true, raw: record };
  }

  return { decision: record.decision, isFresh: true, raw: record };
}

/**
 * Create the movement controller.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Object.<string, object>} robots
 * @param {Object.<string, Phaser.GameObjects.Sprite>} robotSprites
 * @param {Object.<string, Phaser.Tweens.Tween|null>} activeTweens
 * @param {{
 *   updateStatusUI: Function,
 *   detectFleetConflicts: Function,
 *   onSegmentTravelled?: (robotId: string, distancePx: number) => void,
 *   onRobotCompleted?:   (robotId: string) => void,
 *   onWaitTime?:         (robotId: string, durationSec: number) => void,
 *   findPath?:           Function,
 *   getRunMode?:         () => string,
 *   getConflicts?:       () => Array<object>,
 *   updatePathVisualization?: (robotId: string) => void
 * }} callbacks
 * @returns {{
 *   startRobotMovement: Function,
 *   moveRobotToNextWaypoint: Function,
 *   finishRobotMovement: Function
 * }}
 */
export function createMovementController(scene, map, robots, robotSprites, activeTweens, callbacks) {

  // Per-robot internal coordination tracking
  const localCoordinationState = new Map();

  function getCoordinationState(robotId) {
    if (!localCoordinationState.has(robotId)) {
      localCoordinationState.set(robotId, {
        decision: 'MOVE',
        applied: false,
        waiting: false,
        rerouteCount: 0,
        lastAppliedAt: null,
        lastRerouteAt: 0,
        lastReroutedDecisionTimestamp: null,
        waitStartedAt: null,
        waitTimerEvent: null
      });
    }
    return localCoordinationState.get(robotId);
  }

  function syncDebugState(robotId) {
    if (typeof window === 'undefined') return;
    const state = getCoordinationState(robotId);
    if (!window.robotMovementDecisionState) {
      window.robotMovementDecisionState = {};
    }
    window.robotMovementDecisionState[robotId] = {
      decision: state.decision,
      applied: state.applied,
      waiting: state.waiting,
      rerouteCount: state.rerouteCount,
      lastAppliedAt: state.lastAppliedAt
    };
  }

  // ── Finish ────────────────────────────────────────────────────────────────────
  const finishRobotMovement = (robotId) => {
    const r = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite) return;

    activeTweens[robotId] = null;

    const coord = getCoordinationState(robotId);
    if (coord.waitTimerEvent) {
      coord.waitTimerEvent.remove();
      coord.waitTimerEvent = null;
    }
    coord.waiting = false;
    coord.waitStartedAt = null;
    syncDebugState(robotId);

    if (r.destination) {
      const finalX = r.destination.x;
      const finalY = r.destination.y;
      const finalTileX = r.destination.tileX;
      const finalTileY = r.destination.tileY;

      sprite.setPosition(finalX, finalY);
      r.x = finalX;
      r.y = finalY;
      r.start.x = finalX;
      r.start.y = finalY;
      r.start.tileX = finalTileX;
      r.start.tileY = finalTileY;
      r.previousValidPosition = { x: finalX, y: finalY };
    }

    r.status = 'completed';

    if (typeof callbacks.onRobotCompleted === 'function') {
      callbacks.onRobotCompleted(robotId);
    }

    callbacks.updateStatusUI();
    callbacks.detectFleetConflicts();
  };

  // ── Calculate Alternate Path for REROUTE ─────────────────────────────────────
  const tryCalculateAlternatePath = (robotId, currentTileX, currentTileY, destTileX, destTileY) => {
    if (typeof callbacks.findPath !== 'function') return null;

    // Find conflict tile involving this robot if available
    let conflictTile = null;
    const conflicts = typeof callbacks.getConflicts === 'function' ? callbacks.getConflicts() : [];
    for (const c of conflicts) {
      if (c && (c.robotA === robotId || c.robotB === robotId)) {
        if (c.type === 'vertex') {
          conflictTile = {
            tileX: c.tileX !== undefined ? c.tileX : c.navX,
            tileY: c.tileY !== undefined ? c.tileY : c.navY
          };
          break;
        } else if (c.type === 'edge') {
          const edgeTarget = c.robotA === robotId ? c.toA : c.toB;
          if (edgeTarget) {
            conflictTile = {
              tileX: edgeTarget.tileX !== undefined ? edgeTarget.tileX : edgeTarget.navX,
              tileY: edgeTarget.tileY !== undefined ? edgeTarget.tileY : edgeTarget.navY
            };
            break;
          }
        }
      }
    }

    // Direct alternate path avoiding conflict tile via A*
    if (conflictTile) {
      const directAlt = callbacks.findPath(currentTileX, currentTileY, destTileX, destTileY, [conflictTile]);
      if (directAlt && directAlt.length > 1) {
        return directAlt;
      }
    }

    // Generate detour candidates (1 to 4 steps in cardinal and diagonal directions)
    const candidateDeltas = [
      // 1-step cardinal
      { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
      // 2-step offsets (turning into adjacent parallel aisles)
      { dx: 0, dy: -2 }, { dx: 0, dy: 2 }, { dx: -2, dy: 0 }, { dx: 2, dy: 0 },
      { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 },
      // 3-step offsets
      { dx: 0, dy: -3 }, { dx: 0, dy: 3 }, { dx: -3, dy: 0 }, { dx: 3, dy: 0 },
      { dx: -2, dy: -2 }, { dx: 2, dy: -2 }, { dx: -2, dy: 2 }, { dx: 2, dy: 2 }
    ];

    let bestAlternatePath = null;
    let minPathLength = Infinity;

    for (const delta of candidateDeltas) {
      const candX = currentTileX + delta.dx;
      const candY = currentTileY + delta.dy;

      // Skip the conflict tile
      if (conflictTile && candX === conflictTile.tileX && candY === conflictTile.tileY) {
        continue;
      }

      // Step 1: Reach candidate from current position without touching conflict tile
      const pathToCand = callbacks.findPath(currentTileX, currentTileY, candX, candY, conflictTile ? [conflictTile] : []);
      if (!pathToCand || pathToCand.length < 2) {
        continue;
      }
      if (conflictTile && pathToCand.some((n) => n.tileX === conflictTile.tileX && n.tileY === conflictTile.tileY)) {
        continue;
      }

      // Step 2: Reach destination from candidate without touching conflict tile
      const pathFromCand = callbacks.findPath(candX, candY, destTileX, destTileY, conflictTile ? [conflictTile] : []);
      if (!pathFromCand || pathFromCand.length === 0) {
        continue;
      }
      if (conflictTile && pathFromCand.some((n) => n.tileX === conflictTile.tileX && n.tileY === conflictTile.tileY)) {
        continue;
      }

      // Valid alternate path assembled via existing A*
      const combined = pathToCand.concat(pathFromCand.slice(1));
      if (combined.length < minPathLength) {
        minPathLength = combined.length;
        bestAlternatePath = combined;
      }
    }

    return bestAlternatePath;
  };

  // ── Handle WAIT State ────────────────────────────────────────────────────────
  const enterWaitState = (robotId, waypointIndex, runMode) => {
    const r = robots[robotId];
    const coord = getCoordinationState(robotId);

    coord.decision = 'WAIT';
    coord.applied = true;
    coord.waiting = true;
    coord.lastAppliedAt = Date.now();
    if (!coord.waitStartedAt) {
      coord.waitStartedAt = Date.now();
    }
    syncDebugState(robotId);

    // Clear existing timer if any
    if (coord.waitTimerEvent) {
      coord.waitTimerEvent.remove();
      coord.waitTimerEvent = null;
    }

    // Periodic check to resume on fresh MOVE/SLOW or after 3s timeout
    coord.waitTimerEvent = scene.time.addEvent({
      delay: 150,
      loop: true,
      callback: () => {
        if (!r || r.status !== 'moving') {
          if (coord.waitTimerEvent) coord.waitTimerEvent.remove();
          coord.waitTimerEvent = null;
          coord.waiting = false;
          syncDebugState(robotId);
          return;
        }

        const waitElapsedMs = Date.now() - (coord.waitStartedAt || Date.now());
        const currentCheck = getEffectiveDecision(robotId, runMode);

        const shouldResume =
          waitElapsedMs >= WAIT_SAFETY_TIMEOUT_MS ||
          (currentCheck.isFresh && (currentCheck.decision === 'MOVE' || currentCheck.decision === 'SLOW'));

        if (shouldResume) {
          if (coord.waitTimerEvent) {
            coord.waitTimerEvent.remove();
            coord.waitTimerEvent = null;
          }

          const waitedDurationSec = parseFloat((waitElapsedMs / 1000).toFixed(3));
          if (typeof callbacks.onWaitTime === 'function' && waitedDurationSec > 0) {
            callbacks.onWaitTime(robotId, waitedDurationSec);
          }

          coord.waiting = false;
          coord.waitStartedAt = null;
          syncDebugState(robotId);

          moveRobotToNextWaypoint(robotId, waypointIndex);
        }
      }
    });
  };

  // ── Per-waypoint tween with ML Decision Handling ─────────────────────────────
  const moveRobotToNextWaypoint = (robotId, waypointIndex) => {
    const r = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite || r.status !== 'moving') return;

    if (!r.path || waypointIndex >= r.path.length) {
      finishRobotMovement(robotId);
      return;
    }

    const runMode = typeof callbacks.getRunMode === 'function' ? callbacks.getRunMode() : 'BASELINE';
    const { decision: rawDecision, isFresh, raw } = getEffectiveDecision(robotId, runMode);
    const coord = getCoordinationState(robotId);

    let activeDecision = rawDecision;

    // ── REROUTE Handling ───────────────────────────────────────────────────────
    if (activeDecision === 'REROUTE') {
      const now = Date.now();
      const isDuplicate = raw && raw.timestamp && raw.timestamp === coord.lastReroutedDecisionTimestamp;
      const inCooldown = (now - coord.lastRerouteAt) < REROUTE_COOLDOWN_MS;

      if (isDuplicate || inCooldown) {
        // Prevent repeated rerouting on identical decision or within cooldown, but preserve REROUTE in state
        activeDecision = 'MOVE';
        coord.decision = 'REROUTE';
        coord.applied = true;
      } else if (r.destination) {
        const curTileX = (map && typeof map.worldToTileX === 'function')
          ? map.worldToTileX(sprite.x)
          : Math.floor(sprite.x / 32);
        const curTileY = (map && typeof map.worldToTileY === 'function')
          ? map.worldToTileY(sprite.y)
          : Math.floor(sprite.y / 32);
        const destTileX = r.destination.tileX;
        const destTileY = r.destination.tileY;

        const alternatePath = tryCalculateAlternatePath(robotId, curTileX, curTileY, destTileX, destTileY);

        if (alternatePath && alternatePath.length > 1) {
          r.path = alternatePath;
          coord.rerouteCount++;
          coord.lastRerouteAt = now;
          coord.lastReroutedDecisionTimestamp = raw?.timestamp || now;
          coord.decision = 'REROUTE';
          coord.applied = true;
          coord.lastAppliedAt = now;
          syncDebugState(robotId);

          if (typeof callbacks.updatePathVisualization === 'function') {
            callbacks.updatePathVisualization(robotId);
          }
          callbacks.detectFleetConflicts();

          // Proceed on newly calculated alternate route from waypoint 1
          moveRobotToNextWaypoint(robotId, 1);
          return;
        } else {
          // Fallback: If reroute fails or no valid alternate path exists, WAIT
          coord.lastRerouteAt = now;
          activeDecision = 'WAIT';
        }
      }
    }

    // ── WAIT Handling ──────────────────────────────────────────────────────────
    if (activeDecision === 'WAIT') {
      enterWaitState(robotId, waypointIndex, runMode);
      return;
    }

    // ── MOVE / SLOW Handling ───────────────────────────────────────────────────
    const baseSpeed = r.speed || 100;
    let effectiveSpeed = baseSpeed;

    if (activeDecision === 'SLOW') {
      // Reduce to 50% without altering r.speed in UI
      effectiveSpeed = Math.max(10, baseSpeed * 0.5);
    }

    if (coord.decision !== 'REROUTE' || (Date.now() - coord.lastRerouteAt) >= REROUTE_COOLDOWN_MS) {
      coord.decision = activeDecision;
    }
    coord.applied = true;
    coord.waiting = false;
    coord.lastAppliedAt = Date.now();
    syncDebugState(robotId);

    const targetTile = r.path[waypointIndex];
    const targetWorldX = targetTile.worldX !== undefined ? targetTile.worldX : (map.tileToWorldX(targetTile.tileX) + 16);
    const targetWorldY = targetTile.worldY !== undefined ? targetTile.worldY : (map.tileToWorldY(targetTile.tileY) + 16);

    const distance = Math.hypot(sprite.x - targetWorldX, sprite.y - targetWorldY);
    const duration = Math.max(1, (distance / effectiveSpeed) * 1000);

    activeTweens[robotId] = scene.tweens.add({
      targets: sprite,
      x: targetWorldX,
      y: targetWorldY,
      duration: duration,
      ease: 'Linear',
      onUpdate: () => {
        r.x = sprite.x;
        r.y = sprite.y;
      },
      onComplete: () => {
        r.x = targetWorldX;
        r.y = targetWorldY;
        r.start.x = targetWorldX;
        r.start.y = targetWorldY;
        r.start.tileX = targetTile.tileX;
        r.start.tileY = targetTile.tileY;
        if (targetTile.navX !== undefined) {
          r.start.navX = targetTile.navX;
          r.start.navY = targetTile.navY;
        }
        r.previousValidPosition = { x: targetWorldX, y: targetWorldY };

        // Step 4: Report actual pixel distance travelled
        if (typeof callbacks.onSegmentTravelled === 'function' && distance > 0) {
          callbacks.onSegmentTravelled(robotId, distance);
        }

        moveRobotToNextWaypoint(robotId, waypointIndex + 1);
      }
    });
  };

  // ── Start ─────────────────────────────────────────────────────────────────────
  const startRobotMovement = (robotId) => {
    const r = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite) return;

    if (r.status === 'moving') return;

    if (!r.destination || !r.path || r.path.length === 0) return;

    // If already at or within same logical cell
    if (r.path.length <= 1) {
      finishRobotMovement(robotId);
      return;
    }

    const coord = getCoordinationState(robotId);
    coord.waiting = false;
    coord.waitStartedAt = null;
    if (coord.waitTimerEvent) {
      coord.waitTimerEvent.remove();
      coord.waitTimerEvent = null;
    }
    syncDebugState(robotId);

    r.status = 'moving';
    callbacks.updateStatusUI();

    const firstTargetX = r.path[0].worldX !== undefined ? r.path[0].worldX : (map.tileToWorldX(r.path[0].tileX) + 16);
    const firstTargetY = r.path[0].worldY !== undefined ? r.path[0].worldY : (map.tileToWorldY(r.path[0].tileY) + 16);
    const distToFirst = Math.hypot(sprite.x - firstTargetX, sprite.y - firstTargetY);

    let startIndex = 1;
    if (distToFirst > 4) {
      startIndex = 0;
    }

    moveRobotToNextWaypoint(robotId, startIndex);
    callbacks.detectFleetConflicts();
  };

  return { startRobotMovement, moveRobotToNextWaypoint, finishRobotMovement };
}
