/**
 * simulation/runSession.js
 * Manages the runtime session state that is SEPARATE from the persisted Scenario.
 *
 * Architecture:
 *   Saved Scenario (Supabase)  ──LOAD──▶  Runtime Session  ──▶  robot movement/state
 *
 * The saved Scenario is NEVER mutated by runtime changes.
 * All runtime state lives here in memory only.
 *
 * Run status lifecycle:
 *   IDLE  →  RUNNING  →  COMPLETED
 *   IDLE  ← (load same scenario again resets to fresh IDLE session)
 */

/** @typedef {"IDLE"|"RUNNING"|"COMPLETED"} RunStatus */

/**
 * Create a deep copy of a robot snapshot to prevent shared mutable references
 * between the saved scenario and the runtime fleet.
 *
 * @param {object} snapshot
 * @returns {object}
 */
function deepCopySnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    robotId:     snapshot.robotId,
    start:       snapshot.start       ? { ...snapshot.start }       : null,
    destination: snapshot.destination ? { ...snapshot.destination } : null,
    speed:       snapshot.speed,
    priority:    snapshot.priority,
    battery:     snapshot.battery,
    task:        snapshot.task,
    color:       snapshot.color,
    colorHex:    snapshot.colorHex,
    frame:       snapshot.frame !== undefined ? snapshot.frame : 0
  };
}

/**
 * Generate a unique session ID.
 * @returns {string}
 */
function generateSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "session-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
}

/**
 * Create a new runtime session from a persisted scenario.
 * Deep-copies all robot snapshots so the runtime session owns immutable initial state
 * that cannot be accidentally shared with the live robot objects.
 *
 * @param {string}   scenarioId      - The source scenario UUID (from Supabase)
 * @param {object[]} robotSnapshots  - scenario.robots array (canonical initial state)
 * @returns {{
 *   scenarioId:       string,
 *   sessionId:        string,
 *   status:           RunStatus,
 *   initialSnapshots: object[],
 *   startedAt:        string|null,
 *   completedAt:      string|null
 * }}
 */
export function createRunSession(scenarioId, robotSnapshots = []) {
  const initialSnapshots = robotSnapshots.map(deepCopySnapshot).filter(Boolean);

  return {
    scenarioId,
    sessionId:       generateSessionId(),
    status:          "IDLE",
    initialSnapshots,
    startedAt:       null,
    completedAt:     null
  };
}

/**
 * Transition a run session to RUNNING.
 * Safe to call multiple times — only transitions from IDLE or COMPLETED.
 *
 * @param {object} session
 * @returns {object} mutated session (same reference)
 */
export function startRunSession(session) {
  if (!session) return session;
  if (session.status === "IDLE" || session.status === "COMPLETED") {
    session.status    = "RUNNING";
    session.startedAt = new Date().toISOString();
    session.completedAt = null;
  }
  return session;
}

/**
 * Transition a run session to COMPLETED.
 * Called when all robots have finished their journeys.
 *
 * @param {object} session
 * @returns {object} mutated session (same reference)
 */
export function completeRunSession(session) {
  if (!session) return session;
  if (session.status === "RUNNING") {
    session.status      = "COMPLETED";
    session.completedAt = new Date().toISOString();
  }
  return session;
}

/**
 * Check whether all robots in the live fleet have completed their journeys.
 * A run is complete when at least one robot is "completed" and no robot is still "moving".
 *
 * @param {Object.<string, object>} robots - Live runtime robot state map
 * @returns {boolean}
 */
export function areAllRobotsFinished(robots) {
  const list = Object.values(robots || {});
  return list.length > 0 && list.every((r) => r.status === "completed");
}

/**
 * Return true when a run is actively executing (prevents scenario save-changes).
 *
 * @param {object|null} session
 * @returns {boolean}
 */
export function isRunActive(session) {
  return session !== null && session !== undefined && session.status === "RUNNING";
}
