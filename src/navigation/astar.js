/**
 * navigation/astar.js
 * A* pathfinding on the Roads layer (4-directional, Manhattan heuristic, cost = 1).
 *
 * The Roads layer is the ONLY walkability source. A tile is walkable if and only if
 * roadsLayer.getTileAt(tileX, tileY) returns a tile with index > 0.
 *
 * Algorithm details (DO NOT change):
 *   - 4-direction movement (Up, Down, Left, Right)
 *   - Uniform cost = 1 per step
 *   - Manhattan distance heuristic
 *   - Bounds checking included
 *   - Returns null when target is unreachable
 */

/**
 * Factory — captures map and roadsLayer once, returns the pathfinding functions.
 *
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Phaser.Tilemaps.TilemapLayer} roadsLayer
 * @returns {{ findPath: Function, isRoadWalkable: Function }}
 */
export function createPathfinder(map, roadsLayer) {

  /**
   * Return true if (tx, ty) is within map bounds and has a road tile.
   *
   * @param {number} tx
   * @param {number} ty
   * @returns {boolean}
   */
  const isRoadWalkable = (tx, ty) => {
    if (tx < 0 || tx >= map.width || ty < 0 || ty >= map.height) return false;
    const tile = roadsLayer.getTileAt(tx, ty);
    return !!(tile && tile.index > 0);
  };

  /**
   * Run A* from (startTileX, startTileY) to (targetTileX, targetTileY).
   *
   * @param {number} startTileX
   * @param {number} startTileY
   * @param {number} targetTileX
   * @param {number} targetTileY
   * @returns {{ tileX: number, tileY: number }[] | null}
   */
  const findPath = (startTileX, startTileY, targetTileX, targetTileY) => {
    if (!isRoadWalkable(startTileX, startTileY) || !isRoadWalkable(targetTileX, targetTileY)) {
      return null;
    }

    if (startTileX === targetTileX && startTileY === targetTileY) {
      return [{ tileX: startTileX, tileY: startTileY }];
    }

    const keyOf    = (x, y) => `${x},${y}`;
    const heuristic = (x, y) => Math.abs(x - targetTileX) + Math.abs(y - targetTileY);

    const openSet  = [{ x: startTileX, y: startTileY, f: heuristic(startTileX, startTileY) }];
    const cameFrom = new Map();
    const gScore   = new Map();
    gScore.set(keyOf(startTileX, startTileY), 0);

    const directions = [
      { dx: 0,  dy: -1 }, // Up
      { dx: 0,  dy:  1 }, // Down
      { dx: -1, dy:  0 }, // Left
      { dx:  1, dy:  0 }  // Right
    ];

    while (openSet.length > 0) {
      // Find node with lowest f score
      let lowestIdx = 0;
      for (let i = 1; i < openSet.length; i++) {
        if (openSet[i].f < openSet[lowestIdx].f) lowestIdx = i;
      }

      const current    = openSet.splice(lowestIdx, 1)[0];
      const currentKey = keyOf(current.x, current.y);

      // Goal reached — reconstruct path
      if (current.x === targetTileX && current.y === targetTileY) {
        const path = [];
        let curr = current;
        while (curr) {
          path.unshift({ tileX: curr.x, tileY: curr.y });
          curr = cameFrom.get(keyOf(curr.x, curr.y));
        }
        return path;
      }

      const currentG = gScore.get(currentKey) ?? Infinity;

      for (const dir of directions) {
        const nx = current.x + dir.dx;
        const ny = current.y + dir.dy;

        if (!isRoadWalkable(nx, ny)) continue;

        const neighborKey  = keyOf(nx, ny);
        const tentativeG   = currentG + 1;

        if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
          cameFrom.set(neighborKey, { x: current.x, y: current.y });
          gScore.set(neighborKey, tentativeG);
          const f = tentativeG + heuristic(nx, ny);
          if (!openSet.some((n) => n.x === nx && n.y === ny)) {
            openSet.push({ x: nx, y: ny, f });
          }
        }
      }
    }

    return null; // Target unreachable
  };

  return { findPath, isRoadWalkable };
}
