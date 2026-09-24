/**
 * simulation/benchmarkHarness.js
 *
 * Deterministic Paired Benchmark Harness for BASELINE vs ARES V2 Simulation.
 *
 * Design Principles:
 *   - Deep-clones ONE deterministic initial scenario state into:
 *       Run A: BASELINE (ML coordination disabled)
 *       Run B: ARES (ML coordination enabled via V2 XGBoost)
 *   - Identical starting positions, destinations, speeds, priorities, map, movement parameters.
 *   - Continuous, deterministic virtual physics stepping (default dt = 50ms).
 *   - Strict event transition counting for collisions (< 1.0m) and near-collisions ([1.0m, 1.5m)).
 *   - Inter-robot minimum separation tracking across complete runs.
 *   - Deadlock detection based on mutual WAIT states and wait safety timeouts.
 *   - Actual simulation state telemetry for distance, wait time, energy proxy, completion time.
 *   - Signed percentage differences with zero subjective labels.
 *   - Machine-readable JSON output and clean text comparison tables.
 */

import crypto from 'node:crypto';
import { createPathfinder } from '../navigation/astar.js';
import { createConflictDetector } from '../coordination/conflictDetection.js';
import { createMovementController } from '../robots/robotMovement.js';
import { buildRobotFeatures, predictRobot } from '../network/edgeClient.js';

// Physical constants (meters / pixels)
export const TILE_SIZE_PX = 32.0;
export const METERS_TO_PX = 32.0;
export const PX_TO_METERS = 1.0 / 32.0;

export const COLLISION_THRESHOLD_M = 1.0;
export const NEAR_COLLISION_THRESHOLD_M = 1.5;
export const V_MAX_MPS = 2.0;
export const WAIT_SAFETY_TIMEOUT_MS = 3000;

/**
 * Deep-clone an object or array via JSON serialization.
 * Ensures complete reference isolation between paired runs.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Compute a deterministic SHA-256 hash of the canonical initial scenario state.
 * Guarantees identical hash for paired runs starting from identical conditions.
 *
 * @param {object} scenario
 * @returns {string}
 */
export function computeScenarioHash(scenario) {
  const canonical = {
    name: scenario.name,
    robots: (scenario.robots || []).map((r) => ({
      robotId: r.robotId,
      start: { tileX: r.start.tileX, tileY: r.start.tileY },
      destination: { tileX: r.destination.tileX, tileY: r.destination.tileY },
      speed: r.speed,
      priority: r.priority,
      battery: r.battery,
      task: r.task
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Generate a canonical unordered pair key for two robot IDs.
 * Guarantees that pair(A, B) === pair(B, A).
 *
 * @param {string} idA
 * @param {string} idB
 * @returns {string}
 */
export function getPairKey(idA, idB) {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/**
 * Lightweight virtual scene mock for deterministic headless stepping.
 */
export class VirtualSimulationScene {
  constructor() {
    this.virtualTime = 0;
    this.tweensList = new Set();
    this.eventsList = new Set();
    this.add = {
      graphics: () => ({
        setDepth: () => {},
        clear: () => {},
        lineStyle: () => {},
        fillStyle: () => {},
        strokeRect: () => {},
        fillRect: () => {},
        lineBetween: () => {},
        strokeCircle: () => {},
        fillCircle: () => {}
      })
    };
  }

  get tweens() {
    return {
      add: (config) => {
        const tween = {
          targets: config.targets,
          startX: config.targets.x,
          startY: config.targets.y,
          targetX: config.x,
          targetY: config.y,
          duration: config.duration,
          startTime: this.virtualTime,
          onUpdate: config.onUpdate,
          onComplete: config.onComplete,
          isCompleted: false,
          isStopped: false,
          stop: () => { tween.isStopped = true; }
        };
        this.tweensList.add(tween);
        return tween;
      }
    };
  }

  get time() {
    return {
      addEvent: (config) => {
        const evt = {
          delay: config.delay,
          loop: Boolean(config.loop),
          callback: config.callback,
          lastTriggered: this.virtualTime,
          isRemoved: false,
          remove: () => {
            evt.isRemoved = true;
            this.eventsList.delete(evt);
          }
        };
        this.eventsList.add(evt);
        return evt;
      }
    };
  }

  step(dtMs) {
    this.virtualTime += dtMs;

    // 1. Process timer events
    for (const evt of Array.from(this.eventsList)) {
      if (evt.isRemoved) continue;
      if (this.virtualTime - evt.lastTriggered >= evt.delay) {
        evt.lastTriggered = this.virtualTime;
        if (typeof evt.callback === 'function') {
          evt.callback();
        }
        if (!evt.loop) {
          this.eventsList.delete(evt);
        }
      }
    }

    // 2. Advance tweens
    for (const tw of Array.from(this.tweensList)) {
      if (tw.isStopped || tw.isCompleted) {
        this.tweensList.delete(tw);
        continue;
      }

      const elapsed = this.virtualTime - tw.startTime;
      const progress = Math.min(1.0, elapsed / tw.duration);

      tw.targets.x = tw.startX + (tw.targetX - tw.startX) * progress;
      tw.targets.y = tw.startY + (tw.targetY - tw.startY) * progress;

      if (typeof tw.onUpdate === 'function') {
        tw.onUpdate();
      }

      if (progress >= 1.0) {
        tw.isCompleted = true;
        this.tweensList.delete(tw);
        if (typeof tw.onComplete === 'function') {
          tw.onComplete();
        }
      }
    }
  }
}

/**
 * Builds mock map and roads layer matching Phaser Tilemap interfaces from TMJ data.
 *
 * @param {object} tmj
 * @returns {{ map: object, roadsLayer: object }}
 */
export function buildMapFromTMJ(tmj) {
  const roadsLayerData = (tmj.layers || []).find((l) => l.name === 'Roads');
  if (!roadsLayerData) {
    throw new Error('Warehouse map TMJ missing Roads layer');
  }

  const map = {
    width: tmj.width,
    height: tmj.height,
    tileWidth: tmj.tilewidth,
    tileHeight: tmj.tileheight,
    tileToWorldX: (tx) => tx * TILE_SIZE_PX,
    tileToWorldY: (ty) => ty * TILE_SIZE_PX,
    worldToTileX: (wx) => Math.floor(wx / TILE_SIZE_PX),
    worldToTileY: (wy) => Math.floor(wy / TILE_SIZE_PX)
  };

  const roadsLayer = {
    getTileAt: (tx, ty) => {
      if (tx < 0 || tx >= tmj.width || ty < 0 || ty >= tmj.height) return null;
      const idx = ty * tmj.width + tx;
      const gid = roadsLayerData.data[idx];
      return gid > 0 ? { index: gid } : null;
    }
  };

  return { map, roadsLayer };
}

/**
 * Executes a single simulation run under the specified mode.
 *
 * @param {object} scenario
 * @param {'BASELINE'|'OPTIMIZED'} mode
 * @param {object} [options]
 * @returns {Promise<object>} Run metrics and trace
 */
export async function runSimulation(scenario, mode, options = {}) {
  const dtMs = options.dtMs || 50;
  const maxSimulationSec = options.maxSimulationSec || 60;
  const telemetryIntervalMs = options.telemetryIntervalMs || 200;
  const mapData = options.mapData;

  if (!mapData) {
    throw new Error('runSimulation requires mapData (TMJ object)');
  }

  const { map, roadsLayer } = buildMapFromTMJ(mapData);
  const pathfinder = createPathfinder(map, roadsLayer);

  // Deep clone initial robots state to guarantee isolation
  const initialFleet = deepClone(scenario.robots);

  // Initialize global window state for the run
  globalThis.window = {
    robotDecisionState: {},
    robotMovementDecisionState: {},
    edgeDecisionStats: { totalPredictions: 0, move: 0, slow: 0, wait: 0, reroute: 0 }
  };

  const scene = new VirtualSimulationScene();
  const robots = {};
  const sprites = {};
  const activeTweens = {};

  for (const r of initialFleet) {
    const startTileX = r.start.tileX;
    const startTileY = r.start.tileY;
    const initialPath = pathfinder.findPath(startTileX, startTileY, r.destination.tileX, r.destination.tileY) || [];

    const startWorldX = map.tileToWorldX(startTileX) + 16;
    const startWorldY = map.tileToWorldY(startTileY) + 16;

    robots[r.robotId] = {
      id: r.robotId,
      speed: typeof r.speed === 'number' ? r.speed : 100,
      priority: typeof r.priority === 'number' ? r.priority : 1,
      battery: typeof r.battery === 'number' ? r.battery : 100,
      task: r.task || 'General Transport',
      start: { ...r.start },
      destination: { ...r.destination },
      path: deepClone(initialPath),
      status: 'idle',
      x: startWorldX,
      y: startWorldY,
      timePath: null,
      travelledDistancePx: 0,
      totalWaitTimeSec: 0,
      completedAt: null
    };

    sprites[r.robotId] = {
      x: startWorldX,
      y: startWorldY,
      setPosition: function (x, y) { this.x = x; this.y = y; }
    };
    activeTweens[r.robotId] = null;
  }

  // Conflict detector
  const conflictDetector = createConflictDetector(scene, map, robots, {
    updateConflictPanel: () => {}
  });

  // Stateful transition tracking for pair collisions and near-collisions
  // Pair state: 'SAFE' (>= 1.5m), 'NEAR' (1.0m to < 1.5m), 'COLLISION' (< 1.0m)
  const pairStates = new Map();
  let collisionEvents = 0;
  let nearCollisionEvents = 0;
  let minSeparationM = Infinity;

  // Deadlock tracking
  const activeMutualWaitPairs = new Set();
  const activeTimeoutRobots = new Set();
  let deadlockCount = 0;

  const movementController = createMovementController(scene, map, robots, sprites, activeTweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => conflictDetector.detectFleetConflicts(),
    getRunMode: () => mode,
    getConflicts: () => conflictDetector.getConflicts(),
    findPath: (sx, sy, tx, ty, blocked) => pathfinder.findPath(sx, sy, tx, ty, blocked),
    onSegmentTravelled: (robotId, distancePx) => {
      if (robots[robotId]) robots[robotId].travelledDistancePx += distancePx;
    },
    onRobotCompleted: (robotId) => {
      if (robots[robotId]) {
        robots[robotId].completedAt = scene.virtualTime / 1000;
      }
    },
    onWaitTime: (robotId, durationSec) => {
      if (robots[robotId]) robots[robotId].totalWaitTimeSec += durationSec;
    }
  });

  // Start movement for all robots
  for (const robotId of Object.keys(robots)) {
    movementController.startRobotMovement(robotId);
  }

  const maxSteps = (maxSimulationSec * 1000) / dtMs;
  let step = 0;
  let lastTelemetryTime = -telemetryIntervalMs;

  while (step < maxSteps) {
    const activeRobots = Object.values(robots).filter((r) => r.status !== 'completed');
    if (activeRobots.length === 0) {
      break;
    }

    // Telemetry & ML inference (OPTIMIZED mode only)
    if (mode === 'OPTIMIZED' && (scene.virtualTime - lastTelemetryTime >= telemetryIntervalMs)) {
      lastTelemetryTime = scene.virtualTime;
      const conflicts = conflictDetector.getConflicts();
      for (const r of activeRobots) {
        r.x = sprites[r.id].x;
        r.y = sprites[r.id].y;
        const features = buildRobotFeatures(r, robots, conflicts, map);
        try {
          const res = await predictRobot(r.id, features);
          if (res && res.decision) {
            window.robotDecisionState[r.id] = {
              decision: res.decision,
              confidence: res.confidence !== undefined ? res.confidence : 1.0,
              timestamp: res.timestamp || Date.now()
            };
          }
        } catch (e) {
          // Fallback handled safely by movement controller
        }
      }
    }

    // Advance virtual physics
    scene.step(dtMs);

    // Sync robot positions from sprites
    for (const r of Object.values(robots)) {
      if (sprites[r.id]) {
        r.x = sprites[r.id].x;
        r.y = sprites[r.id].y;
      }
    }

    // Pairwise metric evaluation
    const currentActive = Object.values(robots).filter((r) => r.status !== 'completed');
    for (let i = 0; i < currentActive.length; i++) {
      for (let j = i + 1; j < currentActive.length; j++) {
        const rA = currentActive[i];
        const rB = currentActive[j];
        const pairKey = getPairKey(rA.id, rB.id);

        const distPx = Math.hypot(rA.x - rB.x, rA.y - rB.y);
        const distM = distPx * PX_TO_METERS;

        if (distM < minSeparationM) {
          minSeparationM = distM;
        }

        const prevState = pairStates.get(pairKey) || 'SAFE';

        if (distM < COLLISION_THRESHOLD_M) {
          // Transition into collision (< 1.0m)
          if (prevState !== 'COLLISION') {
            collisionEvents++;
            if (prevState === 'SAFE') {
              // Direct jump from SAFE into COLLISION also counts near-collision entry
              nearCollisionEvents++;
            }
            pairStates.set(pairKey, 'COLLISION');
          }
        } else if (distM < NEAR_COLLISION_THRESHOLD_M) {
          // In near-collision band [1.0m, 1.5m)
          if (prevState === 'SAFE') {
            nearCollisionEvents++;
            pairStates.set(pairKey, 'NEAR');
          } else if (prevState === 'COLLISION') {
            // Separating back out of collision into near-collision
            pairStates.set(pairKey, 'NEAR');
          }
        } else {
          // Safe separation (>= 1.5m)
          pairStates.set(pairKey, 'SAFE');
        }

        // Mutual WAIT deadlock detection
        const stateA = window.robotMovementDecisionState?.[rA.id];
        const stateB = window.robotMovementDecisionState?.[rB.id];
        if (stateA?.waiting && stateB?.waiting) {
          if (!activeMutualWaitPairs.has(pairKey)) {
            deadlockCount++;
            activeMutualWaitPairs.add(pairKey);
          }
        } else {
          activeMutualWaitPairs.delete(pairKey);
        }
      }
    }

    // Single-robot wait timeout deadlock detection
    for (const r of currentActive) {
      const state = window.robotMovementDecisionState?.[r.id];
      if (state?.waiting && state.waitStartTime && (Date.now() - state.waitStartTime >= WAIT_SAFETY_TIMEOUT_MS)) {
        if (!activeTimeoutRobots.has(r.id)) {
          deadlockCount++;
          activeTimeoutRobots.add(r.id);
        }
      } else {
        activeTimeoutRobots.delete(r.id);
      }
    }

    step++;
  }

  // Count reroutes from movement state
  let totalReroutes = 0;
  for (const rId of Object.keys(robots)) {
    const s = window.robotMovementDecisionState?.[rId];
    if (s && s.rerouteCount) {
      totalReroutes += s.rerouteCount;
    }
  }

  const allRobots = Object.values(robots);
  const totalRobots = allRobots.length;
  const completedMissions = allRobots.filter((r) => r.status === 'completed').length;
  const totalWaitTimeSec = allRobots.reduce((acc, r) => acc + (r.totalWaitTimeSec || 0), 0);
  const avgWaitTimeSec = totalRobots > 0 ? parseFloat((totalWaitTimeSec / totalRobots).toFixed(3)) : 0;
  const totalDistanceM = parseFloat((allRobots.reduce((acc, r) => acc + (r.travelledDistancePx || 0), 0) * PX_TO_METERS).toFixed(3));

  // Energy proxy: sum_i (dist_i * (1.0 + 0.2 * (v_i / V_MAX)) + 0.05 * wait_i)
  let totalEnergyProxy = 0;
  for (const r of allRobots) {
    const d_m = (r.travelledDistancePx || 0) * PX_TO_METERS;
    const v_mps = (r.speed || 100) / 100.0;
    const w_sec = r.totalWaitTimeSec || 0;
    const energy = d_m * (1.0 + 0.2 * (v_mps / V_MAX_MPS)) + 0.05 * w_sec;
    totalEnergyProxy += energy;
  }
  totalEnergyProxy = parseFloat(totalEnergyProxy.toFixed(3));

  const totalSimulationTimeSec = parseFloat((scene.virtualTime / 1000).toFixed(3));

  return {
    collision_events: collisionEvents,
    near_collision_events: nearCollisionEvents,
    minimum_separation_m: minSeparationM === Infinity ? 99.0 : parseFloat(minSeparationM.toFixed(3)),
    deadlocks: deadlockCount,
    average_wait_time_sec: avgWaitTimeSec,
    total_distance_m: totalDistanceM,
    energy_proxy: totalEnergyProxy,
    missions_completed: completedMissions,
    task_completion_time_sec: totalSimulationTimeSec,
    reroute_count: totalReroutes
  };
}

/**
 * Compute signed percentage difference between baseline and ARES.
 * Formula: ((ares - baseline) / baseline) * 100
 * Returns null if baseline === 0 (undefined division).
 *
 * @param {number} baselineVal
 * @param {number} aresVal
 * @returns {number|null}
 */
export function calculatePercentageDifference(baselineVal, aresVal) {
  if (baselineVal === 0 && aresVal === 0) return 0;
  if (baselineVal === 0) return null;
  const pct = ((aresVal - baselineVal) / baselineVal) * 100;
  return parseFloat(pct.toFixed(2));
}

/**
 * Format percentage difference as a signed string without subjective judgment.
 *
 * @param {number|null} diff
 * @returns {string}
 */
export function formatPercentageDifference(diff) {
  if (diff === null) return 'N/A';
  if (diff === 0) return '0.00%';
  return diff > 0 ? `+${diff.toFixed(2)}%` : `${diff.toFixed(2)}%`;
}

/**
 * Executes a deterministic paired benchmark for a given scenario.
 *
 * @param {object} scenario - Scenario object containing canonical `robots` list
 * @param {object} options - Execution options including `mapData`
 * @returns {Promise<object>} Complete paired benchmark result
 */
export async function runPairedBenchmark(scenario, options = {}) {
  if (!scenario || !scenario.robots || !Array.isArray(scenario.robots)) {
    throw new Error('Invalid scenario: must contain robots array');
  }

  // Deep-clone exact initial scenario for Run A and Run B
  const initialScenarioA = {
    name: scenario.name,
    robots: deepClone(scenario.robots)
  };
  const initialScenarioB = {
    name: scenario.name,
    robots: deepClone(scenario.robots)
  };

  // Run A: BASELINE (ML disabled)
  const baselineResults = await runSimulation(initialScenarioA, 'BASELINE', options);

  // Run B: ARES (ML enabled)
  const aresResults = await runSimulation(initialScenarioB, 'OPTIMIZED', options);

  // Calculate percentage differences
  const diffs = {
    collision_events: calculatePercentageDifference(baselineResults.collision_events, aresResults.collision_events),
    near_collision_events: calculatePercentageDifference(baselineResults.near_collision_events, aresResults.near_collision_events),
    minimum_separation_m: calculatePercentageDifference(baselineResults.minimum_separation_m, aresResults.minimum_separation_m),
    deadlocks: calculatePercentageDifference(baselineResults.deadlocks, aresResults.deadlocks),
    average_wait_time_sec: calculatePercentageDifference(baselineResults.average_wait_time_sec, aresResults.average_wait_time_sec),
    total_distance_m: calculatePercentageDifference(baselineResults.total_distance_m, aresResults.total_distance_m),
    energy_proxy: calculatePercentageDifference(baselineResults.energy_proxy, aresResults.energy_proxy),
    missions_completed: calculatePercentageDifference(baselineResults.missions_completed, aresResults.missions_completed),
    task_completion_time_sec: calculatePercentageDifference(baselineResults.task_completion_time_sec, aresResults.task_completion_time_sec),
    reroute_count: calculatePercentageDifference(baselineResults.reroute_count, aresResults.reroute_count)
  };

  const initialStateHash = computeScenarioHash(scenario);

  return {
    scenario: scenario.name,
    scenarioName: scenario.name,
    initial_state_hash: initialStateHash,
    timestamp: new Date().toISOString(),
    baseline: baselineResults,
    ares: aresResults,
    differencesPct: diffs
  };
}

/**
 * Format benchmark results into a concise text comparison table.
 *
 * @param {object} benchmarkResult
 * @returns {string} Formatted table
 */
export function formatComparisonTable(benchmarkResult) {
  const b = benchmarkResult.baseline;
  const a = benchmarkResult.ares;
  const d = benchmarkResult.differencesPct;

  const rows = [
    ['Collision events', b.collision_events, a.collision_events, formatPercentageDifference(d.collision_events)],
    ['Near-collision events', b.near_collision_events, a.near_collision_events, formatPercentageDifference(d.near_collision_events)],
    ['Minimum separation (m)', b.minimum_separation_m.toFixed(3), a.minimum_separation_m.toFixed(3), formatPercentageDifference(d.minimum_separation_m)],
    ['Deadlocks', b.deadlocks, a.deadlocks, formatPercentageDifference(d.deadlocks)],
    ['Average wait (s)', b.average_wait_time_sec.toFixed(3), a.average_wait_time_sec.toFixed(3), formatPercentageDifference(d.average_wait_time_sec)],
    ['Total distance (m)', b.total_distance_m.toFixed(3), a.total_distance_m.toFixed(3), formatPercentageDifference(d.total_distance_m)],
    ['Energy proxy', b.energy_proxy.toFixed(3), a.energy_proxy.toFixed(3), formatPercentageDifference(d.energy_proxy)],
    ['Missions completed', b.missions_completed, a.missions_completed, formatPercentageDifference(d.missions_completed)],
    ['Completion time (s)', b.task_completion_time_sec.toFixed(3), a.task_completion_time_sec.toFixed(3), formatPercentageDifference(d.task_completion_time_sec)],
    ['Reroutes', b.reroute_count, a.reroute_count, formatPercentageDifference(d.reroute_count)]
  ];

  const colWidths = [26, 16, 16, 16];
  const header = ['METRIC'.padEnd(colWidths[0]), 'BASELINE'.padEnd(colWidths[1]), 'ARES'.padEnd(colWidths[2]), 'DIFFERENCE'.padEnd(colWidths[3])].join(' ');
  const divider = '-'.repeat(colWidths.reduce((a, b) => a + b, 0) + 3);

  const formattedRows = rows.map((r) => {
    return [
      String(r[0]).padEnd(colWidths[0]),
      String(r[1]).padEnd(colWidths[1]),
      String(r[2]).padEnd(colWidths[2]),
      String(r[3]).padEnd(colWidths[3])
    ].join(' ');
  });

  return [
    `SCENARIO: ${benchmarkResult.scenario || benchmarkResult.scenarioName}`,
    `INITIAL STATE HASH: ${benchmarkResult.initial_state_hash || 'N/A'}`,
    divider,
    header,
    divider,
    ...formattedRows,
    divider
  ].join('\n');
}

/**
 * Format all scenario results into a single concise multi-scenario table:
 * Scenario | Metric | BASELINE | ARES | Difference
 *
 * @param {Array<object>} benchmarkResults
 * @returns {string}
 */
export function formatSummaryTable(benchmarkResults) {
  const colWidths = [28, 24, 12, 12, 14];
  const header = [
    'Scenario'.padEnd(colWidths[0]),
    'Metric'.padEnd(colWidths[1]),
    'BASELINE'.padEnd(colWidths[2]),
    'ARES'.padEnd(colWidths[3]),
    'Difference'.padEnd(colWidths[4])
  ].join(' ');
  const divider = '-'.repeat(colWidths.reduce((a, b) => a + b, 0) + 4);

  const lines = [divider, header, divider];

  for (const res of benchmarkResults) {
    const scName = res.scenario || res.scenarioName;
    const b = res.baseline;
    const a = res.ares;
    const d = res.differencesPct;

    const metricRows = [
      ['Collision events', String(b.collision_events), String(a.collision_events), formatPercentageDifference(d.collision_events)],
      ['Near-collision events', String(b.near_collision_events), String(a.near_collision_events), formatPercentageDifference(d.near_collision_events)],
      ['Min separation (m)', b.minimum_separation_m.toFixed(3), a.minimum_separation_m.toFixed(3), formatPercentageDifference(d.minimum_separation_m)],
      ['Deadlocks', String(b.deadlocks), String(a.deadlocks), formatPercentageDifference(d.deadlocks)],
      ['Average wait (s)', b.average_wait_time_sec.toFixed(3), a.average_wait_time_sec.toFixed(3), formatPercentageDifference(d.average_wait_time_sec)],
      ['Total distance (m)', b.total_distance_m.toFixed(3), a.total_distance_m.toFixed(3), formatPercentageDifference(d.total_distance_m)],
      ['Energy proxy', b.energy_proxy.toFixed(3), a.energy_proxy.toFixed(3), formatPercentageDifference(d.energy_proxy)],
      ['Missions completed', `${b.missions_completed}/${scName.includes('5') ? 5 : (scName.includes('3') ? 3 : 4)}`, `${a.missions_completed}/${scName.includes('5') ? 5 : (scName.includes('3') ? 3 : 4)}`, formatPercentageDifference(d.missions_completed)],
      ['Completion time (s)', b.task_completion_time_sec.toFixed(3), a.task_completion_time_sec.toFixed(3), formatPercentageDifference(d.task_completion_time_sec)],
      ['Reroutes', String(b.reroute_count), String(a.reroute_count), formatPercentageDifference(d.reroute_count)]
    ];

    metricRows.forEach((row, idx) => {
      const scenarioCol = idx === 0 ? scName : '';
      lines.push([
        scenarioCol.padEnd(colWidths[0]),
        row[0].padEnd(colWidths[1]),
        row[1].padEnd(colWidths[2]),
        row[2].padEnd(colWidths[3]),
        row[3].padEnd(colWidths[4])
      ].join(' '));
    });
    lines.push(divider);
  }

  return lines.join('\n');
}
