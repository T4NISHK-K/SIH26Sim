/**
 * scratch/test_stepper_run.mjs
 * Test prototype for Stage 4A benchmark harness.
 */
import fs from 'node:fs';
import { createPathfinder } from '../src/navigation/astar.js';
import { createConflictDetector } from '../src/coordination/conflictDetection.js';
import { createMovementController } from '../src/robots/robotMovement.js';
import { buildRobotFeatures, predictRobot } from '../src/network/edgeClient.js';

// Load warehouse map
const tmj = JSON.parse(fs.readFileSync('./map/warehousemap.tmj', 'utf8'));
const roadsLayerData = tmj.layers.find(l => l.name === 'Roads');

const mockMap = {
  width: tmj.width,
  height: tmj.height,
  tileWidth: tmj.tilewidth,
  tileHeight: tmj.tileheight,
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32,
  worldToTileX: (wx) => Math.floor(wx / 32),
  worldToTileY: (wy) => Math.floor(wy / 32)
};

const mockRoadsLayer = {
  getTileAt: (tx, ty) => {
    if (tx < 0 || tx >= tmj.width || ty < 0 || ty >= tmj.height) return null;
    const idx = ty * tmj.width + tx;
    const gid = roadsLayerData.data[idx];
    return gid > 0 ? { index: gid } : null;
  }
};

const pathfinder = createPathfinder(mockMap, mockRoadsLayer);

// Virtual Scene
class VirtualScene {
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

    // Timer events
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

    // Tweens
    for (const tw of Array.from(this.tweensList)) {
      if (tw.isStopped || tw.isCompleted) {
        this.tweensList.delete(tw);
        continue;
      }
      const elapsed = this.virtualTime - tw.startTime;
      const progress = Math.min(1.0, elapsed / tw.duration);

      tw.targets.x = tw.startX + (tw.targetX - tw.startX) * progress;
      tw.targets.y = tw.startY + (tw.targetY - tw.startY) * progress;

      if (typeof tw.onUpdate === 'function') tw.onUpdate();

      if (progress >= 1.0) {
        tw.isCompleted = true;
        this.tweensList.delete(tw);
        if (typeof tw.onComplete === 'function') tw.onComplete();
      }
    }
  }
}

// Deep clone helper
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Pair key helper
function getPairKey(idA, idB) {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

async function runSimulation(scenarioRobots, runMode, maxSimulationSec = 60) {
  // Deep clone initial state
  const fleetData = deepClone(scenarioRobots);

  // Global window state
  globalThis.window = {
    robotDecisionState: {},
    robotMovementDecisionState: {},
    edgeDecisionStats: { totalPredictions: 0, move: 0, slow: 0, wait: 0, reroute: 0 }
  };

  const scene = new VirtualScene();
  const robots = {};
  const sprites = {};
  const activeTweens = {};

  for (const r of fleetData) {
    const startTileX = r.start.tileX;
    const startTileY = r.start.tileY;
    const initialPath = pathfinder.findPath(startTileX, startTileY, r.destination.tileX, r.destination.tileY) || [];

    const startWorldX = mockMap.tileToWorldX(startTileX) + 16;
    const startWorldY = mockMap.tileToWorldY(startTileY) + 16;

    robots[r.robotId] = {
      id: r.robotId,
      speed: r.speed,
      priority: r.priority,
      battery: r.battery,
      task: r.task,
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
      setPosition: function(x, y) { this.x = x; this.y = y; }
    };
    activeTweens[r.robotId] = null;
  }

  // Conflict detector
  const conflictDetector = createConflictDetector(scene, mockMap, robots, {
    updateConflictPanel: () => {}
  });

  // Track metrics
  let collisionEvents = 0;
  let nearCollisionEvents = 0;
  let minSeparationM = Infinity;
  let deadlockCount = 0;
  const activeCollisions = new Set();
  const activeNearCollisions = new Set();
  const trackedDeadlocks = new Set();

  let totalReroutes = 0;

  const movementController = createMovementController(scene, mockMap, robots, sprites, activeTweens, {
    updateStatusUI: () => {},
    detectFleetConflicts: () => conflictDetector.detectFleetConflicts(),
    getRunMode: () => runMode,
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

  const dtMs = 50;
  const maxSteps = (maxSimulationSec * 1000) / dtMs;
  let step = 0;
  const telemetryIntervalMs = 200;
  let lastTelemetryTime = -telemetryIntervalMs;

  while (step < maxSteps) {
    const currentTimeSec = scene.virtualTime / 1000;

    // Check completion condition
    const activeRobots = Object.values(robots).filter(r => r.status !== 'completed');
    if (activeRobots.length === 0) {
      break;
    }

    // Telemetry & ML prediction in OPTIMIZED mode
    if (runMode === 'OPTIMIZED' && (scene.virtualTime - lastTelemetryTime >= telemetryIntervalMs)) {
      lastTelemetryTime = scene.virtualTime;
      const conflicts = conflictDetector.getConflicts();
      for (const r of activeRobots) {
        // Sync robot position with sprite
        r.x = sprites[r.id].x;
        r.y = sprites[r.id].y;
        const features = buildRobotFeatures(r, robots, conflicts, mockMap);
        try {
          const res = await predictRobot(features);
          if (res && res.action) {
            window.robotDecisionState[r.id] = {
              decision: res.action,
              confidence: res.confidence !== undefined ? res.confidence : 1.0,
              timestamp: Date.now()
            };
          }
        } catch (e) {
          // Fallback handled by movement controller
        }
      }
    }

    // Step simulation physics
    scene.step(dtMs);

    // Sync robot coordinates from sprites
    for (const r of Object.values(robots)) {
      if (sprites[r.id]) {
        r.x = sprites[r.id].x;
        r.y = sprites[r.id].y;
      }
    }

    // Evaluate pair distances across active robots
    const robotList = Object.values(robots).filter(r => r.status !== 'completed');
    for (let i = 0; i < robotList.length; i++) {
      for (let j = i + 1; j < robotList.length; j++) {
        const rA = robotList[i];
        const rB = robotList[j];
        const pairKey = getPairKey(rA.id, rB.id);

        const distPx = Math.hypot(rA.x - rB.x, rA.y - rB.y);
        const distM = distPx / 32.0;

        if (distM < minSeparationM) {
          minSeparationM = distM;
        }

        // Collision transition (< 1.0m)
        if (distM < 1.0) {
          if (!activeCollisions.has(pairKey)) {
            collisionEvents++;
            activeCollisions.add(pairKey);
          }
        } else {
          activeCollisions.delete(pairKey);
        }

        // Near-collision transition (< 1.5m)
        if (distM < 1.5) {
          if (!activeNearCollisions.has(pairKey)) {
            nearCollisionEvents++;
            activeNearCollisions.add(pairKey);
          }
        } else {
          activeNearCollisions.delete(pairKey);
        }

        // Deadlock check (mutual WAIT)
        const stateA = window.robotMovementDecisionState?.[rA.id];
        const stateB = window.robotMovementDecisionState?.[rB.id];
        if (stateA?.waiting && stateB?.waiting) {
          if (!trackedDeadlocks.has(pairKey)) {
            deadlockCount++;
            trackedDeadlocks.add(pairKey);
          }
        } else {
          trackedDeadlocks.delete(pairKey);
        }
      }
    }

    // Check single robot wait timeout deadlocks (stuck waiting >= 3.0s)
    for (const r of robotList) {
      const state = window.robotMovementDecisionState?.[r.id];
      if (state?.waiting && state.waitStartTime && (Date.now() - state.waitStartTime >= 3000)) {
        const dKey = `timeout:${r.id}`;
        if (!trackedDeadlocks.has(dKey)) {
          deadlockCount++;
          trackedDeadlocks.add(dKey);
        }
      }
    }

    step++;
  }

  // Count reroutes from robotMovementDecisionState
  for (const rId of Object.keys(robots)) {
    const s = window.robotMovementDecisionState?.[rId];
    if (s && s.rerouteCount) {
      totalReroutes += s.rerouteCount;
    }
  }

  const allRobots = Object.values(robots);
  const totalRobots = allRobots.length;
  const completedMissions = allRobots.filter(r => r.status === 'completed').length;
  const totalWaitTimeSec = allRobots.reduce((acc, r) => acc + (r.totalWaitTimeSec || 0), 0);
  const avgWaitTimeSec = totalRobots > 0 ? parseFloat((totalWaitTimeSec / totalRobots).toFixed(3)) : 0;
  const totalDistanceM = parseFloat((allRobots.reduce((acc, r) => acc + (r.travelledDistancePx || 0), 0) / 32.0).toFixed(3));

  // Energy proxy: sum_i (dist_i * (1.0 + 0.2 * (v_i / V_MAX)) + 0.05 * wait_i)
  const V_MAX = 2.0; // m/s
  let totalEnergyProxy = 0;
  for (const r of allRobots) {
    const d_m = (r.travelledDistancePx || 0) / 32.0;
    const v_mps = (r.speed || 100) / 100.0;
    const w_sec = r.totalWaitTimeSec || 0;
    const energy = d_m * (1.0 + 0.2 * (v_mps / V_MAX)) + 0.05 * w_sec;
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

// Test deterministic head-on scenario
const testScenario = [
  {
    robotId: 'R1',
    start: { tileX: 10, tileY: 28 },
    destination: { tileX: 35, tileY: 28 },
    speed: 100,
    priority: 1,
    battery: 100,
    task: 'General Transport'
  },
  {
    robotId: 'R2',
    start: { tileX: 35, tileY: 28 },
    destination: { tileX: 10, tileY: 28 },
    speed: 100,
    priority: 1,
    battery: 100,
    task: 'General Transport'
  }
];

console.log('Running BASELINE test run...');
const baselineResults = await runSimulation(testScenario, 'BASELINE');
console.log('BASELINE results:', baselineResults);

console.log('Running ARES test run...');
const aresResults = await runSimulation(testScenario, 'OPTIMIZED');
console.log('ARES results:', aresResults);
