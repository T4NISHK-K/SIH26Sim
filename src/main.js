/**
 * main.js
 * Entry point and scene orchestrator for the Warehouse Robot Fleet Simulation.
 *
 * Responsibilities:
 *   - Configure and launch the Phaser game
 *   - Implement the Phaser Scene lifecycle (preload / create)
 *   - Initialise every module and wire their callbacks together
 *   - Set up camera pan / zoom
 *   - Expose window.* debug handles (preserved from original)
 *
 * Implementation details live in the imported modules.
 */

import Phaser from 'phaser';

import { preloadWarehouseAssets, createWarehouseMap }       from './map/warehouseLoader.js';
import { createRobots }                                      from './robots/robotManager.js';
import { createPathfinder }                                  from './navigation/astar.js';
import { createPathVisualizer, createDestinationMarkerUpdater } from './navigation/pathVisualizer.js';
import { createConflictDetector }                            from './coordination/conflictDetection.js';
import { createMovementController }                          from './robots/robotMovement.js';
import { setupRobotDrag }                                    from './robots/robotDrag.js';
import { createUIController }                                from './ui/robotControls.js';
import { CONFLICT_TIME_THRESHOLD }                           from './config/constants.js';

// ─────────────────────────────────────────────────────────────────────────────
class WarehouseScene extends Phaser.Scene {
  constructor() {
    super('WarehouseScene');
  }

  // ── Preload ──────────────────────────────────────────────────────────────────
  preload() {
    preloadWarehouseAssets(this);
  }

  // ── Create ───────────────────────────────────────────────────────────────────
  create() {

    // 1. Build the Tiled map (custom TSX loader)
    const { map, roadsLayer, floorLayer, buildingsLayer } = createWarehouseMap(this);

    // 2. Create the robot fleet (sprites, state, graphics containers)
    const { robots, robotSprites, destinationMarkers, pathGraphics, activeTweens } =
      createRobots(this, map, roadsLayer);

    // ── Selected-robot shortcut (kept for quick access in callbacks) ────────────
    let selectedRobotId = 'Robot-01';

    // 3. Path visualizer + destination marker drawer
    const { updatePathVisualization }  = createPathVisualizer(map, robots, pathGraphics);
    const { updateDestinationMarker }  = createDestinationMarkerUpdater(robots, destinationMarkers);

    // 4. A* pathfinder
    const { findPath } = createPathfinder(map, roadsLayer);

    // ── recalculateRobotPath needs conflict detection, declared before it ──────
    //    Forward-reference resolved by JS closure ordering below.

    // 5. Conflict detection — needs updateConflictPanel from UI controller.
    //    We break the ordering loop by wiring updateConflictPanel via a wrapper
    //    that is populated after the UI controller is created.
    let updateConflictPanelFn = () => {};

    const {
      conflictGraphics,
      detectFleetConflicts,
      buildTimeParameterizedPath,
      detectVertexConflicts,
      detectEdgeConflicts,
      getConflicts
    } = createConflictDetector(this, map, robots, {
      updateConflictPanel: (conflicts) => updateConflictPanelFn(conflicts)
    });

    // ── recalculateRobotPath: ties pathfinder + visualizer + conflict ──────────
    const recalculateRobotPath = (robotId) => {
      const r      = robots[robotId];
      const sprite = robotSprites[robotId];
      if (!r || !sprite) return;

      if (!r.destination) {
        r.path = null;
        updatePathVisualization(robotId);
        return;
      }

      const startTileX = map.worldToTileX(sprite.x);
      const startTileY = map.worldToTileY(sprite.y);
      const path = findPath(startTileX, startTileY, r.destination.tileX, r.destination.tileY);
      r.path = path;
      updatePathVisualization(robotId);
      detectFleetConflicts();
    };

    // ── setRobotDestination ───────────────────────────────────────────────────
    const setRobotDestination = (robotId, tileX, tileY) => {
      const r = robots[robotId];
      if (!r || r.status === 'moving') return false;

      const roadTile = roadsLayer.getTileAt(tileX, tileY);
      if (roadTile && roadTile.index > 0) {
        const destX = map.tileToWorldX(tileX) + 16;
        const destY = map.tileToWorldY(tileY) + 16;
        r.destination = { x: destX, y: destY, tileX, tileY };
        if (r.status === 'completed') r.status = 'idle';
        uiController.updateStatusUI();
        updateDestinationMarker(robotId);
        recalculateRobotPath(robotId);
        return true;
      }
      return false;
    };

    // 6. Movement controller
    const { startRobotMovement, moveRobotToNextWaypoint, finishRobotMovement } =
      createMovementController(this, map, robots, robotSprites, activeTweens, {
        updateStatusUI:      () => uiController.updateStatusUI(),
        detectFleetConflicts
      });

    // 7. UI controller
    const uiController = createUIController(robots, robotSprites, {
      startRobotMovement,
      onRobotSelected: (robotId) => {
        selectedRobotId        = robotId;
        window.selectedRobotId = robotId;
        window.robotState      = robots[robotId];
      }
    });

    // Now that uiController exists, wire the conflict panel callback
    updateConflictPanelFn = (conflicts) => uiController.updateConflictPanel(conflicts);

    // 8. Drag handling
    const { isDraggingRef, wasDraggingRef, resetDragState } =
      setupRobotDrag(this, map, roadsLayer, robots, robotSprites, {
        selectRobot:         (id) => uiController.selectRobot(id),
        updateStatusUI:      ()   => uiController.updateStatusUI(),
        recalculateRobotPath
      });

    // ── Initial pass ──────────────────────────────────────────────────────────
    detectFleetConflicts();

    console.log('Warehouse map loaded successfully:', {
      dimensions:    `${map.width}x${map.height} tiles (${map.widthInPixels}x${map.heightInPixels} px)`,
      tilesetsCount: map.tilesets.length,
      layers:        { floor: !!floorLayer, roads: !!roadsLayer, buildings: !!buildingsLayer }
    });

    // 9. Camera setup: fit whole map, then enable pan + wheel zoom
    const camera      = this.cameras.main;
    const mapWidthPx  = map.widthInPixels;
    const mapHeightPx = map.heightInPixels;

    const calculateFitZoom = () => {
      const zoomX = this.scale.width  / mapWidthPx;
      const zoomY = this.scale.height / mapHeightPx;
      return Math.min(zoomX, zoomY) * 0.92;
    };

    const fitZoom = calculateFitZoom();
    camera.setZoom(fitZoom);
    camera.centerOn(mapWidthPx / 2, mapHeightPx / 2);

    let isDragging    = false;
    let pointerDownPos = { x: 0, y: 0 };

    this.input.on('pointerdown', (pointer, currentlyOver) => {
      pointerDownPos.x = pointer.x;
      pointerDownPos.y = pointer.y;
      if (!currentlyOver || currentlyOver.length === 0) {
        isDragging = true;
      }
    });

    this.input.on('pointerup', (pointer, currentlyOver) => {
      const dragDistance = Phaser.Math.Distance.Between(
        pointerDownPos.x, pointerDownPos.y, pointer.x, pointer.y
      );
      const isRobotInteraction =
        wasDraggingRef.value ||
        (currentlyOver && currentlyOver.some((obj) => Object.values(robotSprites).includes(obj)));

      isDragging = false;
      resetDragState();

      // Only process destination selection on clean background click
      if (dragDistance <= 6 && !isRobotInteraction) {
        const worldPoint = camera.getWorldPoint(pointer.x, pointer.y);
        setRobotDestination(
          uiController.getSelectedRobotId(),
          map.worldToTileX(worldPoint.x),
          map.worldToTileY(worldPoint.y)
        );
      }
    });

    this.input.on('pointermove', (pointer) => {
      if (!isDraggingRef.value && (pointer.isDown || isDragging)) {
        camera.scrollX -= (pointer.x - pointer.prevPosition.x) / camera.zoom;
        camera.scrollY -= (pointer.y - pointer.prevPosition.y) / camera.zoom;
      }
    });

    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      const zoomFactor = 1.15;
      let newZoom = deltaY > 0 ? camera.zoom / zoomFactor : camera.zoom * zoomFactor;
      newZoom = Phaser.Math.Clamp(newZoom, fitZoom * 0.5, 3.5);
      camera.setZoom(newZoom);
    });

    this.scale.on('resize', (gameSize) => {
      camera.setSize(gameSize.width, gameSize.height);
      const newFitZoom = calculateFitZoom();
      camera.setZoom(newFitZoom);
      camera.centerOn(mapWidthPx / 2, mapHeightPx / 2);
    });

    // ── window.* debug exports (preserved from original) ─────────────────────
    window.robots                    = robots;
    window.robotSprites              = robotSprites;
    window.robotState                = robots['Robot-01'];
    window.selectedRobotId           = selectedRobotId;
    window.CONFLICT_TIME_THRESHOLD   = CONFLICT_TIME_THRESHOLD;
    window.conflicts                 = getConflicts();
    window.buildTimeParameterizedPath = buildTimeParameterizedPath;
    window.detectVertexConflicts     = detectVertexConflicts;
    window.detectEdgeConflicts       = detectEdgeConflicts;
    window.detectFleetConflicts      = detectFleetConflicts;
    window.findPath                  = findPath;
    window.recalculateRobotPath      = recalculateRobotPath;
    window.recalculatePath           = () => recalculateRobotPath(uiController.getSelectedRobotId());
    window.startRobotMovement        = startRobotMovement;
    window.setRobotDestination       = setRobotDestination;
    window.setDestination            = (tileX, tileY) =>
      setRobotDestination(uiController.getSelectedRobotId(), tileX, tileY);
    window.selectRobot               = (id) => uiController.selectRobot(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width:  window.innerWidth,
  height: window.innerHeight,
  pixelArt:    true,
  roundPixels: true,
  scale: {
    mode:       Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  backgroundColor: '#1e1e24',
  scene: [WarehouseScene]
};

new Phaser.Game(config);
