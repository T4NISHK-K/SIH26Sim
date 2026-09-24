import { createMovementController } from '../src/robots/robotMovement.js';
import { buildRobotFeatures, predictRobot } from '../src/network/edgeClient.js';

console.log('Testing virtual runner concept...');

const mapMock = {
  tileToWorldX: (tx) => tx * 32,
  tileToWorldY: (ty) => ty * 32,
  worldToTileX: (wx) => Math.floor(wx / 32),
  worldToTileY: (wy) => Math.floor(wy / 32)
};

// Virtual scene mock
class VirtualScene {
  constructor() {
    this.virtualTime = 0;
    this.tweensList = new Set();
    this.eventsList = new Set();
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

    // 1. Advance timer events
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

// Quick validation
const scene = new VirtualScene();
const robots = {
  'R1': { id: 'R1', speed: 100, status: 'moving', start: { tileX: 1, tileY: 1 }, x: 48, y: 48, path: [{ tileX: 1, tileY: 1 }, { tileX: 2, tileY: 1 }], destination: { tileX: 2, tileY: 1 } }
};
const sprites = { 'R1': { x: 48, y: 48, setPosition: () => {} } };
const tweens = { 'R1': null };

const ctrl = createMovementController(scene, mapMock, robots, sprites, tweens, {
  updateStatusUI: () => {},
  detectFleetConflicts: () => {},
  getRunMode: () => 'BASELINE'
});

ctrl.moveRobotToNextWaypoint('R1', 1);
console.log('Initial tween created, duration:', tweens['R1']?.duration);

let steps = 0;
while (robots['R1'].status !== 'completed' && steps < 50) {
  scene.step(50);
  steps++;
}

console.log(`Simulation finished in ${steps} steps (${scene.virtualTime}ms), robot status: ${robots['R1'].status}, final x: ${robots['R1'].x}`);
