/**
 * robots/robotManager.js
 * Responsible for creating and initialising the robot fleet:
 *   - Scanning valid road tiles from the Roads layer
 *   - Selecting guaranteed-distinct, well-spaced starting positions
 *   - Constructing per-robot state objects
 *   - Creating Phaser sprites, destination marker graphics, and path graphics
 *
 * Returns all robot state / graphics containers used by the rest of the app.
 */

import { DEFAULT_SPEED, ROBOT_DISPLAY_SIZE, ROBOT_PALETTES } from '../config/constants.js';

/**
 * Scan the Roads layer and return every tile coordinate that has a tile with index > 0.
 *
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Phaser.Tilemaps.TilemapLayer} roadsLayer
 * @returns {{ tileX: number, tileY: number }[]}
 */
export function getValidRoadTiles(map, roadsLayer) {
  const valid = [];
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const tile = roadsLayer.getTileAt(tx, ty);
      if (tile && tile.index > 0) {
        valid.push({ tileX: tx, tileY: ty });
      }
    }
  }
  return valid;
}

/**
 * Pick three well-spaced tiles from validRoadTiles so initial robots don't spawn on
 * top of each other. Mirrors the original spacing logic (Manhattan dist >= 12).
 *
 * @param {{ tileX: number, tileY: number }[]} validRoadTiles
 * @returns {{ tileX: number, tileY: number }[]} exactly three tiles
 */
export function pickInitialTiles(validRoadTiles) {
  const initialTiles = [validRoadTiles[0]];

  // Second tile: at least 12 Manhattan distance from first
  for (let i = 1; i < validRoadTiles.length; i++) {
    const t = validRoadTiles[i];
    const dist = Math.abs(t.tileX - initialTiles[0].tileX) + Math.abs(t.tileY - initialTiles[0].tileY);
    if (dist >= 12) {
      initialTiles.push(t);
      break;
    }
  }

  // Third tile: at least 12 from both previous tiles, scanning from end
  for (let i = validRoadTiles.length - 1; i >= 0; i--) {
    const t = validRoadTiles[i];
    const dist0 = Math.abs(t.tileX - initialTiles[0].tileX) + Math.abs(t.tileY - initialTiles[0].tileY);
    const dist1 = Math.abs(t.tileX - initialTiles[1].tileX) + Math.abs(t.tileY - initialTiles[1].tileY);
    if (dist0 >= 12 && dist1 >= 12) {
      initialTiles.push(t);
      break;
    }
  }

  return initialTiles;
}

/**
 * Pick a spawn tile for a new robot using valid road spawn logic.
 * For the first 3 robots, exact positions match original pickInitialTiles.
 * For subsequent robots, finds an unoccupied road tile with maximal spacing.
 *
 * @param {{ tileX: number, tileY: number }[]} validRoadTiles
 * @param {Object.<string, object>} existingRobots
 * @returns {{ tileX: number, tileY: number }}
 */
function pickSpawnTile(validRoadTiles, existingRobots) {
  const existingList = Object.values(existingRobots);
  const count = existingList.length;

  if (count < 3) {
    const initialTiles = pickInitialTiles(validRoadTiles);
    if (initialTiles[count]) {
      return initialTiles[count];
    }
  }

  // Set of already occupied tiles (current & start)
  const occupied = new Set();
  existingList.forEach((r) => {
    if (r.start) occupied.add(`${r.start.tileX},${r.start.tileY}`);
    if (r.destination) occupied.add(`${r.destination.tileX},${r.destination.tileY}`);
  });

  // Find an unoccupied tile that maximizes minimum distance to existing robots
  let bestTile = null;
  let maxMinDist = -1;

  for (let i = 0; i < validRoadTiles.length; i++) {
    const t = validRoadTiles[i];
    const key = `${t.tileX},${t.tileY}`;
    if (occupied.has(key)) continue;

    let minDist = Infinity;
    for (const r of existingList) {
      const rx = r.start ? r.start.tileX : 0;
      const ry = r.start ? r.start.tileY : 0;
      const d = Math.abs(t.tileX - rx) + Math.abs(t.tileY - ry);
      if (d < minDist) minDist = d;
    }

    if (minDist > maxMinDist) {
      maxMinDist = minDist;
      bestTile = t;
      if (maxMinDist >= 15) break; // Plenty of spacing
    }
  }

  return bestTile || validRoadTiles[0];
}

/**
 * Create empty robot fleet containers. ZERO robots at startup.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Phaser.Tilemaps.TilemapLayer} roadsLayer
 * @returns {{
 *   robots: Object.<string, object>,
 *   robotSprites: Object.<string, Phaser.GameObjects.Sprite>,
 *   destinationMarkers: Object.<string, Phaser.GameObjects.Graphics>,
 *   pathGraphics: Object.<string, Phaser.GameObjects.Graphics>,
 *   activeTweens: Object.<string, Phaser.Tweens.Tween|null>
 * }}
 */
export function createRobots(scene, map, roadsLayer) {
  const robots             = {};
  const robotSprites       = {};
  const destinationMarkers = {};
  const pathGraphics       = {};
  const activeTweens       = {};

  return { robots, robotSprites, destinationMarkers, pathGraphics, activeTweens };
}

// Session-level monotonic robot counter
let nextRobotSeq = 1;

/**
 * Dynamically add a robot to the fleet in place.
 * Mutates the shared containers passed in.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Phaser.Tilemaps.TilemapLayer} roadsLayer
 * @param {{
 *   robots: Object.<string, object>,
 *   robotSprites: Object.<string, Phaser.GameObjects.Sprite>,
 *   destinationMarkers: Object.<string, Phaser.GameObjects.Graphics>,
 *   pathGraphics: Object.<string, Phaser.GameObjects.Graphics>,
 *   activeTweens: Object.<string, Phaser.Tweens.Tween|null>
 * }} containers
 * @returns {string} newly created robotId
 */
export function addRobotToFleet(scene, map, roadsLayer, containers, options = {}) {
  const validRoadTiles = getValidRoadTiles(map, roadsLayer);
  const seqNum         = nextRobotSeq++;
  const robotId        = `Robot-${String(seqNum).padStart(2, '0')}`;

  const paletteIndex   = (seqNum - 1) % ROBOT_PALETTES.length;
  const palette        = ROBOT_PALETTES[paletteIndex];
  const priority       = seqNum;

  const tile = pickSpawnTile(validRoadTiles, containers.robots);
  let wx     = map.tileToWorldX(tile.tileX) + 16;
  let wy     = map.tileToWorldY(tile.tileY) + 16;
  let navX   = tile.tileX;
  let navY   = tile.tileY;

  if (options && options.physicalToLogical) {
    const logicalNode = options.physicalToLogical(tile.tileX, tile.tileY);
    if (logicalNode) {
      wx   = logicalNode.worldX;
      wy   = logicalNode.worldY;
      navX = logicalNode.navX;
      navY = logicalNode.navY;
    }
  }

  // 1. Robot state object
  const robot = {
    id:       robotId,
    x:        wx,
    y:        wy,
    start: {
      x:     wx,
      y:     wy,
      tileX: tile.tileX,
      tileY: tile.tileY,
      navX:  navX,
      navY:  navY
    },
    destination:           null,
    path:                  null,
    speed:                 DEFAULT_SPEED,
    priority:              priority,
    battery:               100,
    task:                  'General Transport',
    status:                'idle',
    color:                 palette.color,
    colorHex:              palette.colorHex,
    previousValidPosition: { x: wx, y: wy }
  };
  containers.robots[robotId] = robot;

  // 2. Sprite
  const sprite = scene.add.sprite(wx, wy, 'robots', palette.frame);
  sprite.setDisplaySize(ROBOT_DISPLAY_SIZE, ROBOT_DISPLAY_SIZE);
  sprite.setDepth(100);
  containers.robotSprites[robotId] = sprite;

  // 3. Destination marker graphic
  const marker = scene.add.graphics();
  marker.setDepth(90);
  marker.setVisible(false);
  containers.destinationMarkers[robotId] = marker;

  // 4. Path visualization graphic
  const pathGfx = scene.add.graphics();
  pathGfx.setDepth(85);
  containers.pathGraphics[robotId] = pathGfx;

  // 5. Active tween slot
  containers.activeTweens[robotId] = null;

  return robotId;
}

/**
 * Safely remove a robot from the fleet and destroy all associated Phaser objects.
 * Null-safe: only cleans up objects that exist and have not been destroyed.
 * Mutates shared collections by deleting entries (preserving container references).
 *
 * @param {string} robotId
 * @param {{
 *   robots: Object.<string, object>,
 *   robotSprites: Object.<string, Phaser.GameObjects.Sprite>,
 *   destinationMarkers: Object.<string, Phaser.GameObjects.Graphics>,
 *   pathGraphics: Object.<string, Phaser.GameObjects.Graphics>,
 *   activeTweens: Object.<string, Phaser.Tweens.Tween|null>
 * }} containers
 */
export function removeRobotFromFleet(robotId, containers) {
  if (!robotId || !containers.robots || !containers.robots[robotId]) return;

  // 1. Stop active tween if one exists and is active
  if (containers.activeTweens && containers.activeTweens[robotId]) {
    try {
      const tween = containers.activeTweens[robotId];
      if (tween && typeof tween.stop === 'function') {
        tween.stop();
      }
    } catch (err) {
      console.warn(`[robotManager] Error stopping tween for ${robotId}:`, err);
    }
    delete containers.activeTweens[robotId];
  }

  // 2. Destroy Phaser sprite if not already destroyed
  if (containers.robotSprites && containers.robotSprites[robotId]) {
    const sprite = containers.robotSprites[robotId];
    if (sprite && typeof sprite.destroy === 'function' && sprite.scene) {
      sprite.destroy();
    }
    delete containers.robotSprites[robotId];
  }

  // 3. Destroy destination marker graphics
  if (containers.destinationMarkers && containers.destinationMarkers[robotId]) {
    const marker = containers.destinationMarkers[robotId];
    if (marker && typeof marker.destroy === 'function' && marker.scene) {
      marker.destroy();
    }
    delete containers.destinationMarkers[robotId];
  }

  // 4. Destroy path visualization graphics
  if (containers.pathGraphics && containers.pathGraphics[robotId]) {
    const pathGfx = containers.pathGraphics[robotId];
    if (pathGfx && typeof pathGfx.destroy === 'function' && pathGfx.scene) {
      pathGfx.destroy();
    }
    delete containers.pathGraphics[robotId];
  }

  // 5. Remove robot state object
  if (containers.robots) {
    delete containers.robots[robotId];
  }
}
