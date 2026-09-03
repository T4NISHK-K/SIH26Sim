/**
 * robots/robotMovement.js
 * Responsible for all robot movement:
 *   - startRobotMovement()        – validates state, sets status, launches tween chain
 *   - moveRobotToNextWaypoint()   – per-waypoint tween using speed-based duration
 *   - finishRobotMovement()       – snaps to destination, updates state, fires callbacks
 *
 * Movement algorithm is preserved verbatim from the original main.js.
 * Do NOT rewrite or alter movement behaviour.
 */

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
 *   detectFleetConflicts: Function
 * }} callbacks
 * @returns {{
 *   startRobotMovement: Function,
 *   moveRobotToNextWaypoint: Function,
 *   finishRobotMovement: Function
 * }}
 */
export function createMovementController(scene, map, robots, robotSprites, activeTweens, callbacks) {

  // ── Finish ────────────────────────────────────────────────────────────────────
  const finishRobotMovement = (robotId) => {
    const r      = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite) return;

    activeTweens[robotId] = null;
    if (r.destination) {
      const finalX     = r.destination.x;
      const finalY     = r.destination.y;
      const finalTileX = r.destination.tileX;
      const finalTileY = r.destination.tileY;

      sprite.setPosition(finalX, finalY);
      r.x           = finalX;
      r.y           = finalY;
      r.start.x     = finalX;
      r.start.y     = finalY;
      r.start.tileX = finalTileX;
      r.start.tileY = finalTileY;
      r.previousValidPosition = { x: finalX, y: finalY };
    }

    r.status = 'completed';
    callbacks.updateStatusUI();
    // Refresh conflicts now that this robot has finished moving
    callbacks.detectFleetConflicts();
  };

  // ── Per-waypoint tween ────────────────────────────────────────────────────────
  const moveRobotToNextWaypoint = (robotId, waypointIndex) => {
    const r      = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite || r.status !== 'moving') return;

    if (!r.path || waypointIndex >= r.path.length) {
      finishRobotMovement(robotId);
      return;
    }

    const targetTile  = r.path[waypointIndex];
    const targetWorldX = map.tileToWorldX(targetTile.tileX) + 16;
    const targetWorldY = map.tileToWorldY(targetTile.tileY) + 16;

    const distance = Phaser.Math.Distance.Between(sprite.x, sprite.y, targetWorldX, targetWorldY);
    const speed    = r.speed || 100;
    const duration = Math.max(1, (distance / speed) * 1000);

    activeTweens[robotId] = scene.tweens.add({
      targets:  sprite,
      x:        targetWorldX,
      y:        targetWorldY,
      duration: duration,
      ease:     'Linear',
      onUpdate: () => {
        r.x = sprite.x;
        r.y = sprite.y;
      },
      onComplete: () => {
        r.x           = targetWorldX;
        r.y           = targetWorldY;
        r.start.x     = targetWorldX;
        r.start.y     = targetWorldY;
        r.start.tileX = targetTile.tileX;
        r.start.tileY = targetTile.tileY;
        r.previousValidPosition = { x: targetWorldX, y: targetWorldY };

        moveRobotToNextWaypoint(robotId, waypointIndex + 1);
      }
    });
  };

  // ── Start ─────────────────────────────────────────────────────────────────────
  const startRobotMovement = (robotId) => {
    const r      = robots[robotId];
    const sprite = robotSprites[robotId];
    if (!r || !sprite) return;

    if (r.status === 'moving') return;

    if (!r.destination || !r.path || r.path.length === 0) return;

    const currentTileX = map.worldToTileX(sprite.x);
    const currentTileY = map.worldToTileY(sprite.y);

    if (r.destination.tileX === currentTileX && r.destination.tileY === currentTileY) {
      r.status = 'completed';
      callbacks.updateStatusUI();
      return;
    }

    r.status = 'moving';
    callbacks.updateStatusUI();
    // Re-run conflict detection when movement starts
    callbacks.detectFleetConflicts();

    let startIndex = 1;
    if (r.path[0].tileX !== currentTileX || r.path[0].tileY !== currentTileY) {
      startIndex = 0;
    }

    moveRobotToNextWaypoint(robotId, startIndex);
  };

  return { startRobotMovement, moveRobotToNextWaypoint, finishRobotMovement };
}
