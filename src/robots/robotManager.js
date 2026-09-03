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

import { DEFAULT_SPEED, ROBOT_DISPLAY_SIZE, ROBOT_CONFIGS } from '../config/constants.js';

/**
 * Scan the Roads layer and return every tile coordinate that has a tile with index > 0.
 *
 * @param {Phaser.Tilemaps.Tilemap} map
 * @param {Phaser.Tilemaps.TilemapLayer} roadsLayer
 * @returns {{ tileX: number, tileY: number }[]}
 */
function getValidRoadTiles(map, roadsLayer) {
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
 * Pick three well-spaced tiles from validRoadTiles so robots don't spawn on
 * top of each other. Mirrors the original spacing logic (Manhattan dist >= 12).
 *
 * @param {{ tileX: number, tileY: number }[]} validRoadTiles
 * @returns {{ tileX: number, tileY: number }[]} exactly three tiles
 */
function pickInitialTiles(validRoadTiles) {
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
 * Create the full robot fleet for the scene.
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
  const validRoadTiles = getValidRoadTiles(map, roadsLayer);
  const initialTiles   = pickInitialTiles(validRoadTiles);

  const robots            = {};
  const robotSprites      = {};
  const destinationMarkers = {};
  const pathGraphics      = {};
  const activeTweens      = {};

  ROBOT_CONFIGS.forEach((cfg, idx) => {
    const tile = initialTiles[idx];
    const wx   = map.tileToWorldX(tile.tileX) + 16;
    const wy   = map.tileToWorldY(tile.tileY) + 16;

    // Robot state object
    robots[cfg.id] = {
      id:       cfg.id,
      x:        wx,
      y:        wy,
      start: {
        x:     wx,
        y:     wy,
        tileX: tile.tileX,
        tileY: tile.tileY
      },
      destination:           null,
      path:                  null,
      speed:                 DEFAULT_SPEED,
      priority:              cfg.priority,
      battery:               100,
      status:                'idle',
      color:                 cfg.color,
      colorHex:              cfg.colorHex,
      previousValidPosition: { x: wx, y: wy }
    };

    // Sprite
    const sprite = scene.add.sprite(wx, wy, 'robots', cfg.frame);
    sprite.setDisplaySize(ROBOT_DISPLAY_SIZE, ROBOT_DISPLAY_SIZE);
    sprite.setDepth(100);
    robotSprites[cfg.id] = sprite;

    // Destination marker graphic (hidden until destination is set)
    const marker = scene.add.graphics();
    marker.setDepth(90);
    marker.setVisible(false);
    destinationMarkers[cfg.id] = marker;

    // Path visualization graphic
    const pathGfx = scene.add.graphics();
    pathGfx.setDepth(85);
    pathGraphics[cfg.id] = pathGfx;

    activeTweens[cfg.id] = null;
  });

  return { robots, robotSprites, destinationMarkers, pathGraphics, activeTweens };
}
