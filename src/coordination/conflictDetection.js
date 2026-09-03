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

import { CONFLICT_TIME_THRESHOLD } from '../config/constants.js';

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
  // Builds robotState.timePath – an ordered list of { tileX, tileY, time }
  // where `time` is cumulative seconds from the robot's current position.
  // Does NOT touch robotState.path.
  const buildTimeParameterizedPath = (robotId) => {
    const r = robots[robotId];
    if (!r || !r.path || r.path.length === 0) {
      if (r) r.timePath = null;
      return null;
    }
    const timePath = [];
    let t = 0.0;
    timePath.push({ tileX: r.path[0].tileX, tileY: r.path[0].tileY, time: 0.0 });
    for (let i = 1; i < r.path.length; i++) {
      const prev = r.path[i - 1];
      const curr = r.path[i];
      const px = map.tileToWorldX(prev.tileX) + 16;
      const py = map.tileToWorldY(prev.tileY) + 16;
      const cx = map.tileToWorldX(curr.tileX) + 16;
      const cy = map.tileToWorldY(curr.tileY) + 16;
      const dist = Phaser.Math.Distance.Between(px, py, cx, cy);
      t += dist / (r.speed || 100);
      timePath.push({ tileX: curr.tileX, tileY: curr.tileY, time: parseFloat(t.toFixed(3)) });
    }
    r.timePath = timePath;
    return timePath;
  };

  // ── 2. VERTEX CONFLICT DETECTOR ─────────────────────────────────────────────
  // Returns conflicts where robotA and robotB occupy the exact same tile
  // within CONFLICT_TIME_THRESHOLD seconds of each other.
  const detectVertexConflicts = (idA, idB) => {
    const rA = robots[idA];
    const rB = robots[idB];
    if (!rA?.timePath || !rB?.timePath) return [];
    const found = [];
    for (const nA of rA.timePath) {
      for (const nB of rB.timePath) {
        if (nA.tileX === nB.tileX && nA.tileY === nB.tileY) {
          const dt = Math.abs(nA.time - nB.time);
          if (dt <= CONFLICT_TIME_THRESHOLD) {
            found.push({
              type: 'vertex',
              robotA: idA, robotB: idB,
              tileX: nA.tileX, tileY: nA.tileY,
              timeA: parseFloat(nA.time.toFixed(2)),
              timeB: parseFloat(nB.time.toFixed(2)),
              timeDiff: parseFloat(dt.toFixed(2))
            });
          }
        }
      }
    }
    return found;
  };

  // ── 3. EDGE CONFLICT DETECTOR ────────────────────────────────────────────────
  // Returns conflicts where robotA traverses edge A→B while robotB traverses
  // B→A, and both traversal intervals overlap within the safety threshold.
  const detectEdgeConflicts = (idA, idB) => {
    const rA = robots[idA];
    const rB = robots[idB];
    if (!rA?.timePath || !rB?.timePath) return [];
    if (rA.timePath.length < 2 || rB.timePath.length < 2) return [];
    const found = [];
    for (let i = 1; i < rA.timePath.length; i++) {
      const fromA = rA.timePath[i - 1];
      const toA   = rA.timePath[i];
      for (let j = 1; j < rB.timePath.length; j++) {
        const fromB = rB.timePath[j - 1];
        const toB   = rB.timePath[j];
        // Opposite traversal of the same edge?
        if (fromA.tileX === toB.tileX && fromA.tileY === toB.tileY &&
            toA.tileX === fromB.tileX && toA.tileY === fromB.tileY) {
          // Do the traversal time-intervals overlap (with threshold slack)?
          const overlap =
            fromA.time <= toB.time   + CONFLICT_TIME_THRESHOLD &&
            fromB.time <= toA.time   + CONFLICT_TIME_THRESHOLD;
          if (overlap) {
            found.push({
              type: 'edge',
              robotA: idA, robotB: idB,
              fromA: { tileX: fromA.tileX, tileY: fromA.tileY },
              toA:   { tileX: toA.tileX,   tileY: toA.tileY },
              fromB: { tileX: fromB.tileX, tileY: fromB.tileY },
              toB:   { tileX: toB.tileX,   tileY: toB.tileY },
              timeA: parseFloat(((fromA.time + toA.time) / 2).toFixed(2)),
              timeB: parseFloat(((fromB.time + toB.time) / 2).toFixed(2))
            });
          }
        }
      }
    }
    return found;
  };

  // ── 4. CONFLICT VISUALIZER ───────────────────────────────────────────────────
  // Draws warning markers on the Phaser canvas. Never modifies map tiles.
  const renderConflicts = () => {
    conflictGraphics.clear();
    if (!conflicts || conflicts.length === 0) return;

    for (const c of conflicts) {
      if (c.type === 'vertex') {
        const wx = map.tileToWorldX(c.tileX) + 16;
        const wy = map.tileToWorldY(c.tileY) + 16;
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
        const ax = map.tileToWorldX(c.fromA.tileX) + 16;
        const ay = map.tileToWorldY(c.fromA.tileY) + 16;
        const bx = map.tileToWorldX(c.toA.tileX)   + 16;
        const by = map.tileToWorldY(c.toA.tileY)   + 16;
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
    getConflicts
  };
}
