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
import { createRobots, addRobotToFleet, removeRobotFromFleet, restoreFleet } from './robots/robotManager.js';
import { createPathfinder }                                  from './navigation/astar.js';
import { createPathVisualizer, createDestinationMarkerUpdater } from './navigation/pathVisualizer.js';
import { createConflictDetector }                            from './coordination/conflictDetection.js';
import { createMovementController }                          from './robots/robotMovement.js';
import { setupRobotDrag }                                    from './robots/robotDrag.js';
import { createUIController }                                from './ui/robotControls.js';
import { setupMapControls }                                   from './ui/mapControls.js';
import { CONFLICT_TIME_THRESHOLD, MAX_ROBOTS }               from './config/constants.js';
import { scenarioService }                                   from './scenarios/scenarioService.js';
import { scenarioRepository }                                from './scenarios/scenarioRepository.js';
import { createScenarioManager }                             from './ui/scenarioManager.js';

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

    // 2. Create the robot fleet (starts empty with zero robots)
    const containers = createRobots(this, map, roadsLayer);
    const { robots, robotSprites, destinationMarkers, pathGraphics, activeTweens } = containers;

    // ── Selected-robot shortcut (starts null with 0 robots) ─────────────────────
    let selectedRobotId = null;

    // 3. Path visualizer + destination marker drawer
    const { updatePathVisualization }  = createPathVisualizer(map, robots, pathGraphics);
    const { updateDestinationMarker }  = createDestinationMarkerUpdater(robots, destinationMarkers);

    // 4. A* pathfinder on logical navigation graph
    const {
      findPath,
      physicalToLogical,
      logicalToPhysical,
      logicalToWorld,
      worldToLogical,
      isLogicalWalkable,
      isRoadWalkable
    } = createPathfinder(map, roadsLayer);

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
      if (!robotId) return;
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
      if (!robotId) return false;
      const r = robots[robotId];
      if (!r || r.status === 'moving') return false;

      const roadTile = roadsLayer.getTileAt(tileX, tileY);
      if (roadTile && roadTile.index > 0) {
        let destX = map.tileToWorldX(tileX) + 16;
        let destY = map.tileToWorldY(tileY) + 16;
        let navX  = tileX;
        let navY  = tileY;

        const logicalNode = physicalToLogical(tileX, tileY);
        if (logicalNode) {
          destX = logicalNode.worldX;
          destY = logicalNode.worldY;
          navX  = logicalNode.navX;
          navY  = logicalNode.navY;
        }

        r.destination = { x: destX, y: destY, tileX, tileY, navX, navY };
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

    // 7. Drag handling
    const { isDraggingRef, wasDraggingRef, resetDragState, registerRobotDrag } =
      setupRobotDrag(this, map, roadsLayer, robots, robotSprites, {
        selectRobot:         (id) => uiController.selectRobot(id),
        updateStatusUI:      ()   => uiController.updateStatusUI(),
        recalculateRobotPath,
        physicalToLogical
      });

    // 8. UI controller
    const uiController = createUIController(robots, robotSprites, {
      startRobotMovement,
      onRobotSelected: (robotId) => {
        selectedRobotId        = robotId;
        window.selectedRobotId = robotId;
        window.robotState      = robotId ? (robots[robotId] || null) : null;
      },
      onAddRobot: () => {
        const currentCount = Object.keys(robots).length;
        if (currentCount >= MAX_ROBOTS) return;

        const newRobotId = addRobotToFleet(this, map, roadsLayer, containers, { physicalToLogical });

        // Register drag handling for the newly created sprite
        registerRobotDrag(newRobotId);

        // Re-render selector and fleet count
        uiController.renderRobotSelector();
        uiController.updateFleetCounter();

        // If first robot or no robot currently selected, auto-select new robot
        if (!uiController.getSelectedRobotId()) {
          uiController.selectRobot(newRobotId);
        }

        // Re-evaluate fleet conflicts
        detectFleetConflicts();

        // Update debug window references
        window.robots          = robots;
        window.robotSprites    = robotSprites;
        window.conflicts       = getConflicts();
        const curId            = uiController.getSelectedRobotId();
        window.selectedRobotId = curId;
        window.robotState      = curId ? (robots[curId] || null) : null;
      },
      onRemoveRobot: (robotId) => {
        removeRobotFromFleet(robotId, containers);

        // Re-evaluate fleet conflicts
        detectFleetConflicts();

        // Update debug window references
        window.robots          = robots;
        window.robotSprites    = robotSprites;
        window.conflicts       = getConflicts();
        const curId            = uiController.getSelectedRobotId();
        window.selectedRobotId = curId;
        window.robotState      = curId ? (robots[curId] || null) : null;
      },
      onSpeedChanged: (robotId) => {
        // Recalculate time-parameterized prediction and fleet conflicts without altering path geometry
        detectFleetConflicts();
        window.conflicts = getConflicts();
      },
      onPriorityChanged: (robotId) => {
        detectFleetConflicts();
        window.conflicts = getConflicts();
      }
    });

    // Now that uiController exists, wire the conflict panel callback
    updateConflictPanelFn = (conflicts) => uiController.updateConflictPanel(conflicts);

    // ── Scenario Manager ──────────────────────────────────────────────────────
    const scenarioManager = createScenarioManager({
      getScenarios: () => scenarioService.getScenarios(),
      onSaveScenario: async (name) => {
        const saved = await scenarioService.saveCurrentScenario(name, robots);
        return saved;
      },
      onUpdateScenario: async (id, name) => {
        const updated = await scenarioService.updateScenario(id, name, robots);
        return updated;
      },
      onLoadScenario: (scenario) => {
        if (!scenario || !Array.isArray(scenario.robots)) return;

        // 1. Stop any currently moving robots
        Object.keys(activeTweens).forEach((id) => {
          if (activeTweens[id] && typeof activeTweens[id].stop === 'function') {
            try {
              activeTweens[id].stop();
            } catch (err) {
              console.warn(`Error stopping tween for ${id}:`, err);
            }
          }
          activeTweens[id] = null;
        });

        // 2. Restore the saved robot fleet
        const restoredIds = restoreFleet(this, containers, scenario.robots);

        // 3. Re-register drag handling for each restored robot sprite
        restoredIds.forEach((id) => {
          registerRobotDrag(id);
        });

        // 4. Recreate destination markers & recalculate navigation paths
        restoredIds.forEach((id) => {
          updateDestinationMarker(id);
          recalculateRobotPath(id);
        });

        // 5. Refresh conflict detection
        detectFleetConflicts();

        // 6. Refresh dashboard metrics/UI
        uiController.renderRobotSelector();
        uiController.updateFleetCounter();

        // 7. Select the first robot if fleet is non-empty
        const targetSelectId = restoredIds.length > 0 ? restoredIds[0] : null;
        uiController.selectRobot(targetSelectId);

        // 8. Update debug window references
        window.robots          = robots;
        window.robotSprites    = robotSprites;
        window.conflicts       = getConflicts();
        window.selectedRobotId = targetSelectId;
        window.robotState      = targetSelectId ? (robots[targetSelectId] || null) : null;
      },
      onDeleteScenario: async (id) => {
        return await scenarioService.deleteScenario(id);
      }
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

    // Viewport boundaries: prevent camera from panning far outside warehouse map
    const boundMargin = 128; // ~4 tiles buffer
    camera.setBounds(
      -boundMargin,
      -boundMargin,
      mapWidthPx + boundMargin * 2,
      mapHeightPx + boundMargin * 2
    );

    // Dynamic zoom limits relative to current fit zoom
    const getMinZoom = () => calculateFitZoom() * 0.85;
    const getMaxZoom = () => calculateFitZoom() * 4.0;
    const ZOOM_STEP  = 1.25;

    const zoomIn = () => {
      const targetZoom = Phaser.Math.Clamp(camera.zoom * ZOOM_STEP, getMinZoom(), getMaxZoom());
      camera.setZoom(targetZoom);
    };

    const zoomOut = () => {
      const targetZoom = Phaser.Math.Clamp(camera.zoom / ZOOM_STEP, getMinZoom(), getMaxZoom());
      camera.setZoom(targetZoom);
    };

    const resetView = () => {
      const currentFitZoom = calculateFitZoom();
      camera.setZoom(currentFitZoom);
      camera.centerOn(mapWidthPx / 2, mapHeightPx / 2);
    };

    // Wire interactive DOM map controls (+, −, Reset)
    setupMapControls({
      onZoomIn: zoomIn,
      onZoomOut: zoomOut,
      onResetView: resetView
    });

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
        const currentId = uiController.getSelectedRobotId();
        if (currentId && robots[currentId]) {
          const worldPoint = camera.getWorldPoint(pointer.x, pointer.y);
          setRobotDestination(
            currentId,
            map.worldToTileX(worldPoint.x),
            map.worldToTileY(worldPoint.y)
          );
        }
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
      const minZoom = getMinZoom();
      const maxZoom = getMaxZoom();
      let newZoom = deltaY > 0 ? camera.zoom / zoomFactor : camera.zoom * zoomFactor;
      newZoom = Phaser.Math.Clamp(newZoom, minZoom, maxZoom);

      if (newZoom !== camera.zoom) {
        const worldPointBefore = camera.getWorldPoint(pointer.x, pointer.y);
        camera.setZoom(newZoom);
        const worldPointAfter = camera.getWorldPoint(pointer.x, pointer.y);
        camera.scrollX += worldPointBefore.x - worldPointAfter.x;
        camera.scrollY += worldPointBefore.y - worldPointAfter.y;
      }
    });

    this.scale.on('resize', (gameSize) => {
      camera.setSize(gameSize.width, gameSize.height);
      const newFitZoom = calculateFitZoom();
      camera.setZoom(newFitZoom);
      camera.centerOn(mapWidthPx / 2, mapHeightPx / 2);
      camera.setBounds(
        -boundMargin,
        -boundMargin,
        mapWidthPx + boundMargin * 2,
        mapHeightPx + boundMargin * 2
      );
    });

    // ── window.* debug exports (preserved from original) ─────────────────────
    window.robots                    = robots;
    window.robotSprites              = robotSprites;
    window.robotState                = selectedRobotId ? (robots[selectedRobotId] || null) : null;
    window.selectedRobotId           = selectedRobotId;
    window.CONFLICT_TIME_THRESHOLD   = CONFLICT_TIME_THRESHOLD;
    window.MAX_ROBOTS                = MAX_ROBOTS;
    window.conflicts                 = getConflicts();
    window.buildTimeParameterizedPath = buildTimeParameterizedPath;
    window.detectVertexConflicts     = detectVertexConflicts;
    window.detectEdgeConflicts       = detectEdgeConflicts;
    window.detectFleetConflicts      = detectFleetConflicts;
    window.findPath                  = findPath;
    window.physicalToLogical         = physicalToLogical;
    window.logicalToPhysical         = logicalToPhysical;
    window.logicalToWorld            = logicalToWorld;
    window.isLogicalWalkable         = isLogicalWalkable;
    window.recalculateRobotPath      = recalculateRobotPath;
    window.recalculatePath           = () => {
      const id = uiController.getSelectedRobotId();
      if (id) recalculateRobotPath(id);
    };
    window.startRobotMovement        = startRobotMovement;
    window.setRobotDestination       = setRobotDestination;
    window.setDestination            = (tileX, tileY) => {
      const id = uiController.getSelectedRobotId();
      if (id) setRobotDestination(id, tileX, tileY);
    };
    window.selectRobot               = (id) => uiController.selectRobot(id);
    window.removeRobot               = (id) => uiController.removeRobot(id);
    window.zoomIn                    = zoomIn;
    window.zoomOut                   = zoomOut;
    window.resetView                 = resetView;
    window.scenarioService           = scenarioService;
    window.scenarioRepository        = scenarioRepository;
    window.scenarioManager           = scenarioManager;
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
