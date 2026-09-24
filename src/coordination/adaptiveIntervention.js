/**
 * coordination/adaptiveIntervention.js
 * Adaptive intervention selection layer for AMR fleet coordination.
 *
 * Implements:
 * 1. Least disruptive safe intervention.
 * 2. Priority-aware conflict arbitration (HIGH/CRITICAL proceeds when safe; LOWER yields).
 * 3. Dynamic tie-breaking for equal priority (TTC, arrival time, distance to conflict zone, ETA).
 * 4. Fleet Progress Guarantee: NEVER allow all robots in a conflict group to WAIT simultaneously.
 * 5. Same-direction following: local headway control (lead MOVE, follower SLOW, brief WAIT if close).
 * 6. Repeated WAIT breaker: prevents infinite WAIT loops.
 * 7. Preservation of ML decisions for transparency and metrics.
 */

/**
 * Convert robot priority (number 1..4 or string LOW..CRITICAL) to a numeric rank.
 *
 * @param {object|number|string|null} robotOrPriority
 * @returns {number} 1 (LOW), 2 (MEDIUM), 3 (HIGH), 4 (CRITICAL)
 */
export function getRobotPriorityRank(robotOrPriority) {
  if (!robotOrPriority) return 1;
  const p = (typeof robotOrPriority === 'object') ? robotOrPriority.priority : robotOrPriority;
  if (typeof p === 'number') {
    return p;
  }
  if (typeof p === 'string') {
    const s = p.trim().toUpperCase();
    if (s === 'CRITICAL') return 4;
    if (s === 'HIGH') return 3;
    if (s === 'MEDIUM') return 2;
    if (s === 'LOW') return 1;
    const num = parseInt(s, 10);
    if (!isNaN(num)) return num;
  }
  return 1;
}

/**
 * Determine which robot in a conflict pair has the right to progress and which yields.
 *
 * Uses:
 * 1. Physical corridor geometry for SAME_DIRECTION (lead robot in front progresses, follower yields).
 * 2. Task Priority rank for crossing / intersection conflicts.
 * 3. Dynamic arrival time / distance to conflict zone / ETA / ID tie-breaker for same priority.
 *
 * @param {object|null} robotState - Self robot state
 * @param {object|null} otherRobotState - Other robot state
 * @param {object|null} conflict - Conflict descriptor
 * @returns {{ isSelfProgressing: boolean, arbitrationReason: string, rankSelf: number, rankOther: number }}
 */
export function arbitrateConflictRoles(robotState, otherRobotState, conflict) {
  const rankSelf = getRobotPriorityRank(robotState);
  const rankOther = otherRobotState ? getRobotPriorityRank(otherRobotState) : rankSelf;

  const conflictType = conflict?.conflictType || conflict?.temporalAssessment?.conflictType;
  const isRobotA = Boolean(conflict && robotState && conflict.robotA === robotState.id);
  const timeSelf = conflict ? (isRobotA ? conflict.timeA : conflict.timeB) : null;
  const timeOther = conflict ? (isRobotA ? conflict.timeB : conflict.timeA) : null;

  // In SAME_DIRECTION following, physical corridor geometry dictates headway:
  // The lead robot in front must progress (MOVE) to clear the route, and trailing robot yields (SLOW/WAIT)
  if (conflictType === 'SAME_DIRECTION') {
    if (typeof timeSelf === 'number' && typeof timeOther === 'number' && Math.abs(timeSelf - timeOther) > 0.05) {
      const isLead = timeSelf < timeOther;
      return {
        isSelfProgressing: isLead,
        arbitrationReason: isLead
          ? 'Same-direction following: lead robot proceeds to clear corridor'
          : 'Same-direction following: trailing robot yields for headway separation',
        rankSelf,
        rankOther
      };
    }
  }

  // 1. Task Priority arbitration for genuine crossing / intersection conflicts
  if (rankSelf > rankOther) {
    return {
      isSelfProgressing: true,
      arbitrationReason: `Priority arbitration: self (rank ${rankSelf}) has higher priority than other (rank ${rankOther})`,
      rankSelf,
      rankOther
    };
  }
  if (rankSelf < rankOther) {
    return {
      isSelfProgressing: false,
      arbitrationReason: `Priority arbitration: self (rank ${rankSelf}) yielding to higher priority other (rank ${rankOther})`,
      rankSelf,
      rankOther
    };
  }

  // 2. Same Priority: Use dynamic runtime state
  // Arrival time comparison
  if (typeof timeSelf === 'number' && typeof timeOther === 'number' && Math.abs(timeSelf - timeOther) > 0.05) {
    if (timeSelf < timeOther) {
      return {
        isSelfProgressing: true,
        arbitrationReason: `Dynamic tie-break: self arrives earlier at conflict point (${timeSelf}s vs ${timeOther}s)`,
        rankSelf,
        rankOther
      };
    } else {
      return {
        isSelfProgressing: false,
        arbitrationReason: `Dynamic tie-break: other arrives earlier at conflict point (${timeOther}s vs ${timeSelf}s)`,
        rankSelf,
        rankOther
      };
    }
  }

  // Distance to conflict point (only if real otherRobotState coordinates exist)
  if (conflict && otherRobotState && (conflict.tileX !== undefined || conflict.navX !== undefined)) {
    const cx = conflict.tileX !== undefined ? conflict.tileX : conflict.navX;
    const cy = conflict.tileY !== undefined ? conflict.tileY : conflict.navY;
    const sx = robotState ? (robotState.start?.tileX ?? robotState.x ?? 0) : 0;
    const sy = robotState ? (robotState.start?.tileY ?? robotState.y ?? 0) : 0;
    const ox = otherRobotState.start?.tileX ?? otherRobotState.x ?? 0;
    const oy = otherRobotState.start?.tileY ?? otherRobotState.y ?? 0;
    const distSelf = Math.hypot(cx - sx, cy - sy);
    const distOther = Math.hypot(cx - ox, cy - oy);

    if (Math.abs(distSelf - distOther) > 0.2) {
      if (distSelf < distOther) {
        return {
          isSelfProgressing: true,
          arbitrationReason: `Dynamic tie-break: self is closer to conflict zone (${distSelf.toFixed(1)}m vs ${distOther.toFixed(1)}m)`,
          rankSelf,
          rankOther
        };
      } else {
        return {
          isSelfProgressing: false,
          arbitrationReason: `Dynamic tie-break: other is closer to conflict zone (${distOther.toFixed(1)}m vs ${distSelf.toFixed(1)}m)`,
          rankSelf,
          rankOther
        };
      }
    }
  }

  // Deterministic tie-breaker by ID
  const selfId = robotState?.id || '';
  const otherId = otherRobotState?.id || (conflict ? (isRobotA ? conflict.robotB : conflict.robotA) : '');
  const idWon = selfId < otherId;
  return {
    isSelfProgressing: idWon,
    arbitrationReason: `Deterministic ID tie-breaker: ${idWon ? selfId : otherId} granted right-of-way`,
    rankSelf,
    rankOther
  };
}

/**
 * Select the least disruptive safe intervention.
 *
 * @param {object} [params]
 * @param {string} [params.mlDecision="MOVE"] - ML recommended decision (MOVE, SLOW, WAIT, REROUTE)
 * @param {object|null} [params.conflict=null] - Relevant upcoming conflict
 * @param {object|null} [params.temporalAssessment=null] - Temporal feasibility assessment
 * @param {object|null} [params.robotState=null] - Live robot state object
 * @param {object|null} [params.otherRobotState=null] - Conflicting other robot state object
 * @param {boolean} [params.isOtherWaiting=false] - Whether other robot is currently waiting
 * @param {number} [params.consecutiveWaitCount=0] - Number of consecutive waits for this robot
 * @returns {{
 *   recommendedDecision: string,
 *   appliedDecision: string,
 *   finalDecision: string,
 *   mlDecision: string,
 *   reason: string,
 *   decisionReason: string,
 *   estimatedDelaySec: number,
 *   rerouteRequired: boolean
 * }}
 */
export function selectAdaptiveIntervention({
  mlDecision = 'MOVE',
  conflict = null,
  temporalAssessment = null,
  robotState = null,
  otherRobotState = null,
  isOtherWaiting = false,
  consecutiveWaitCount = 0
} = {}) {
  const rawMl = mlDecision || 'MOVE';
  const assessment = temporalAssessment || conflict?.temporalAssessment || null;

  // Case 0: No active conflict affecting trajectory or conflicting peer is already completed
  if (!conflict || !assessment || otherRobotState?.status === 'completed') {
    if (rawMl === 'SLOW') {
      const reason = 'Dynamic proximity model recommended SLOW; honored for local headway control';
      return {
        recommendedDecision: rawMl,
        appliedDecision: 'SLOW',
        finalDecision: 'SLOW',
        mlDecision: rawMl,
        reason,
        decisionReason: reason,
        estimatedDelaySec: 0,
        rerouteRequired: false
      };
    }
    const reason = 'No active conflict affecting upcoming trajectory; nominal movement';
    return {
      recommendedDecision: rawMl,
      appliedDecision: 'MOVE',
      finalDecision: 'MOVE',
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: 0,
      rerouteRequired: false
    };
  }

  const timingPossible = Boolean(assessment.timingResolutionPossible);
  const delaySec = typeof assessment.estimatedDelaySec === 'number' ? assessment.estimatedDelaySec : 0;
  const conflictType = assessment.conflictType || conflict.conflictType || 'UNKNOWN';

  // ── 1. Spatial Corridor Conflict (Opposing Corridors) ────────────────────────
  // When opposing traversal of a narrow corridor cannot be solved temporally
  if (!timingPossible) {
    const reason = 'Spatial conflict ahead cannot be resolved temporally; escalating to REROUTE for collision safety';
    return {
      recommendedDecision: rawMl,
      appliedDecision: 'REROUTE',
      finalDecision: 'REROUTE',
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: true
    };
  }

  // ── 2. Repeated WAIT Safety Cap / Anti-Deadlock ──────────────────────────────
  // If robot has already waited for this interaction, force re-evaluation rather
  // than accepting another blind WAIT loop.
  if (consecutiveWaitCount >= 1) {
    // Timing is possible: release robot to MOVE or SLOW to break deadlock
    const applied = conflictType === 'SAME_DIRECTION' ? 'SLOW' : 'MOVE';
    const reason = `Prior wait completed; releasing with ${applied} to clear conflict and break deadlock`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: applied,
      finalDecision: applied,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: false
    };
  }

  // ── 3. Progress Guarantee when Conflicting Robot is ALREADY Waiting ──────────
  if (isOtherWaiting) {
    const applied = conflictType === 'SAME_DIRECTION' ? 'SLOW' : 'MOVE';
    const reason = `Conflicting robot is already waiting; proceeding with ${applied} to clear conflict zone`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: applied,
      finalDecision: applied,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: false
    };
  }

  const isRobotA = Boolean(conflict && robotState && conflict.robotA === robotState.id);
  const timeSelf = conflict ? (isRobotA ? conflict.timeA : conflict.timeB) : null;
  const timeOther = conflict ? (isRobotA ? conflict.timeB : conflict.timeA) : null;

  // ── 4. Single-Robot / Missing Peer Context ───────────────────────────────────
  // If conflicting partner is not in fleet dictionary AND arrival times are missing,
  // honor ML decision directly without forcing arbitration
  if (!otherRobotState && (typeof timeSelf !== 'number' || typeof timeOther !== 'number')) {
    const reason = `Single robot evaluation: ML recommended ${rawMl} honored`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: rawMl,
      finalDecision: rawMl,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: false
    };
  }

  // ── 5. Multi-Robot Arbitration: Determine Roles ──────────────────────────────
  const { isSelfProgressing, arbitrationReason } = arbitrateConflictRoles(robotState, otherRobotState, conflict);

  // ── 6. Progress Guarantee for Designated Progressing Robot ───────────────────
  // If this robot has right-of-way (higher priority or earlier arrival in tie-break),
  // it MUST NOT WAIT. If ML recommended SLOW, honor SLOW; otherwise grant MOVE.
  if (isSelfProgressing) {
    const progressingAction = (rawMl === 'SLOW') ? 'SLOW' : 'MOVE';
    const reason = `${arbitrationReason}; progressing robot granted ${progressingAction} to clear conflict zone`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: progressingAction,
      finalDecision: progressingAction,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: 0,
      rerouteRequired: false
    };
  }

  // ── 7. Yielding Robot Adjustment ─────────────────────────────────────────────
  // This robot is the designated yielding partner. It adjusts its speed or waits
  // until the progressing robot clears the conflict zone.
  if (conflictType === 'SAME_DIRECTION') {
    // Following interaction: maintain safe headway by slowing down,
    // or brief WAIT if separation is unsafe (ML recommends WAIT and delay > 0.6s)
    const followingAction = (rawMl === 'WAIT' && delaySec > 0.6) ? 'WAIT' : 'SLOW';
    const reason = `${arbitrationReason}; following robot applying ${followingAction} for local headway separation`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: followingAction,
      finalDecision: followingAction,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: false
    };
  }

  if (conflictType === 'CROSSING') {
    // Intersection interaction: yield with WAIT, or SLOW if ML recommended SLOW and delay is minor
    const safetyIntervention = (rawMl === 'SLOW' && delaySec <= 0.6) ? 'SLOW' : 'WAIT';
    const reason = `${arbitrationReason}; yielding robot applying ${safetyIntervention} at intersection until conflict zone is cleared`;
    return {
      recommendedDecision: rawMl,
      appliedDecision: safetyIntervention,
      finalDecision: safetyIntervention,
      mlDecision: rawMl,
      reason,
      decisionReason: reason,
      estimatedDelaySec: delaySec,
      rerouteRequired: false
    };
  }

  // Head-on at junction or other resolvable conflict
  const fallbackIntervention = (rawMl === 'SLOW' && delaySec <= 0.6) ? 'SLOW' : 'WAIT';
  const reason = `${arbitrationReason}; yielding robot applying ${fallbackIntervention}`;
  return {
    recommendedDecision: rawMl,
    appliedDecision: fallbackIntervention,
    finalDecision: fallbackIntervention,
    mlDecision: rawMl,
    reason,
    decisionReason: reason,
    estimatedDelaySec: delaySec,
    rerouteRequired: false
  };
}
