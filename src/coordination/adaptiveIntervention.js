/**
 * coordination/adaptiveIntervention.js
 * Adaptive intervention selection layer for AMR fleet coordination.
 *
 * Implements the principle of the LEAST DISRUPTIVE SAFE INTERVENTION:
 * Combines ML recommendation, active trajectory conflicts, temporal feasibility,
 * and estimated delay to select the safest, least disruptive action.
 *
 * Does NOT hard-code robot priority winner/loser rules.
 * Preserves original ML decision alongside final intervention for metrics/debugging.
 */

/**
 * Select the least disruptive safe intervention.
 *
 * @param {object} [params]
 * @param {string} [params.mlDecision="MOVE"] - ML recommended decision (MOVE, SLOW, WAIT, REROUTE)
 * @param {object|null} [params.conflict=null] - Relevant upcoming conflict
 * @param {object|null} [params.temporalAssessment=null] - Temporal feasibility assessment
 * @param {object|null} [params.robotState=null] - Live robot state object
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
  isOtherWaiting = false,
  consecutiveWaitCount = 0
} = {}) {
  const rawMl = mlDecision || 'MOVE';
  const assessment = temporalAssessment || conflict?.temporalAssessment || null;

  // Case 0: No active or upcoming conflict affecting trajectory
  // Conceptual hierarchy: No meaningful conflict → MOVE (suppress unnecessary interventions)
  if (!conflict || !assessment) {
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

  // Deadlock Safety: If robot has already waited for this conflict, avoid repeated WAIT loops
  if (consecutiveWaitCount >= 1) {
    if (!timingPossible) {
      const reason = 'Prior wait did not resolve conflict and timing resolution is impossible; escalating to REROUTE';
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
    } else if (isOtherWaiting || rawMl === 'WAIT') {
      // Release robot to MOVE or SLOW to break deadlock
      const applied = conflictType === 'SAME_DIRECTION' ? 'SLOW' : 'MOVE';
      const reason = `Prior wait completed; releasing with ${applied} to clear conflict`;
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
  }

  // Deadlock Safety: If conflicting robot is ALREADY waiting on this conflict
  if (isOtherWaiting) {
    if (timingPossible) {
      const applied = conflictType === 'SAME_DIRECTION' ? 'SLOW' : 'MOVE';
      const reason = `Conflicting robot is already waiting; proceeding with ${applied} to clear intersection`;
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
    } else {
      const reason = 'Conflicting robot is waiting in deadlock corridor; spatial rerouting required';
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
  }

  // Case A: ML recommends SLOW
  if (rawMl === 'SLOW') {
    if (timingPossible) {
      const reason = 'Temporal separation is feasible; applying SLOW at 50% effective speed';
      return {
        recommendedDecision: rawMl,
        appliedDecision: 'SLOW',
        finalDecision: 'SLOW',
        mlDecision: rawMl,
        reason,
        decisionReason: reason,
        estimatedDelaySec: delaySec,
        rerouteRequired: false
      };
    } else {
      const reason = 'Conflict cannot be safely resolved by timing alone; escalating SLOW to REROUTE';
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
  }

  // Case B: ML recommends WAIT
  if (rawMl === 'WAIT') {
    if (timingPossible) {
      const reason = 'Temporal separation is feasible; applying temporary WAIT';
      return {
        recommendedDecision: rawMl,
        appliedDecision: 'WAIT',
        finalDecision: 'WAIT',
        mlDecision: rawMl,
        reason,
        decisionReason: reason,
        estimatedDelaySec: delaySec,
        rerouteRequired: false
      };
    } else {
      const reason = 'Opposing corridor conflict cannot be resolved by waiting in place; escalating WAIT to REROUTE';
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
  }

  // Case C: ML recommends REROUTE
  if (rawMl === 'REROUTE') {
    if (!timingPossible) {
      // Spatial rerouting is genuinely required
      const reason = 'Spatial rerouting required; conflict cannot be resolved temporally';
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
    } else {
      // Temporal resolution IS possible and safe; suppress unnecessary rerouting
      // Choose least disruptive temporal action:
      // Prefer SLOW when a small speed adjustment (e.g. delay <= 0.6s or same-direction) can safely separate
      // Prefer WAIT when a brief stop is more appropriate (e.g. crossing intersection with larger gap)
      let chosenIntervention = 'WAIT';
      if (conflictType === 'SAME_DIRECTION' || delaySec <= 0.6) {
        chosenIntervention = 'SLOW';
      }

      const reason = `Temporal separation is safely achievable (${delaySec}s); unnecessary reroute suppressed in favor of ${chosenIntervention}`;
      return {
        recommendedDecision: rawMl,
        appliedDecision: chosenIntervention,
        finalDecision: chosenIntervention,
        mlDecision: rawMl,
        reason,
        decisionReason: reason,
        estimatedDelaySec: delaySec,
        rerouteRequired: false
      };
    }
  }

  // Case D: ML recommends MOVE (or any other)
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

  return {
    recommendedDecision: rawMl,
    appliedDecision: rawMl,
    finalDecision: rawMl,
    mlDecision: rawMl,
    reason: 'Nominal MOVE approved',
    decisionReason: 'Nominal MOVE approved',
    estimatedDelaySec: 0,
    rerouteRequired: false
  };
}
