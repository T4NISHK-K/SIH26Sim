/**
 * ui/robotControls.js
 * Responsible for all existing UI wiring:
 *   - updateStatusUI()        – robot name/status badge/start-button state
 *   - selectRobot()           – switches the active robot
 *   - updateConflictPanel()   – populates the Fleet Conflicts DOM panel
 *   - Robot selector button click handlers
 *   - START button click handler
 *
 * The module is stateful: it tracks selectedRobotId internally and exposes
 * getSelectedRobotId() / setSelectedRobotId() so main.js can stay in sync.
 *
 * Do NOT redesign the UI. This is a structural move only.
 */

/**
 * Create the UI controller.
 *
 * @param {Object.<string, object>} robots       – robot state objects
 * @param {Object.<string, Phaser.GameObjects.Sprite>} robotSprites
 * @param {{
 *   startRobotMovement: Function,
 *   onRobotSelected: Function   // (robotId) => void – called after selectRobot()
 * }} callbacks
 * @returns {{
 *   updateStatusUI: Function,
 *   selectRobot: Function,
 *   updateConflictPanel: Function,
 *   getSelectedRobotId: Function,
 *   setSelectedRobotId: Function
 * }}
 */
export function createUIController(robots, robotSprites, callbacks) {

  // Internal selected-robot state for this module
  let selectedRobotId = 'Robot-01';

  // ── Status UI ────────────────────────────────────────────────────────────────
  const updateStatusUI = () => {
    const activeRobot = robots[selectedRobotId];
    if (!activeRobot) return;

    const activeNameEl = document.getElementById('active-robot-name');
    if (activeNameEl) {
      activeNameEl.textContent = activeRobot.id;
      activeNameEl.style.color = activeRobot.colorHex;
    }

    const statusBadge = document.getElementById('status-badge');
    if (statusBadge) {
      const status = (activeRobot.status || 'idle').toUpperCase();
      statusBadge.textContent = status;
      if (status === 'MOVING') {
        statusBadge.style.color = '#fbbf24';
      } else if (status === 'COMPLETED') {
        statusBadge.style.color = '#34d399';
      } else {
        statusBadge.style.color = '#38bdf8';
      }
    }

    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
      if (activeRobot.status === 'moving') {
        startBtn.style.opacity = '0.5';
        startBtn.style.cursor  = 'not-allowed';
      } else {
        startBtn.style.opacity = '1';
        startBtn.style.cursor  = 'pointer';
      }
    }

    // Highlight the active robot's selector button
    const buttons = document.querySelectorAll('.robot-select-btn');
    buttons.forEach((btn) => {
      const rid = btn.getAttribute('data-robot');
      if (rid === selectedRobotId) {
        btn.style.background = activeRobot.colorHex;
        btn.style.color      = '#090d16';
      } else {
        btn.style.background = '#334155';
        btn.style.color      = '#cbd5e1';
      }
    });
  };

  // ── Robot selection ───────────────────────────────────────────────────────────
  const selectRobot = (robotId) => {
    if (!robots[robotId]) return;
    selectedRobotId = robotId;
    updateStatusUI();
    // Notify main.js so it can keep its shortcuts and window.* in sync
    callbacks.onRobotSelected(robotId);
  };

  // ── Fleet Conflicts panel ────────────────────────────────────────────────────
  const updateConflictPanel = (conflicts) => {
    const listEl  = document.getElementById('conflict-list');
    const badgeEl = document.getElementById('conflict-count-badge');
    if (!listEl) return;

    const n = conflicts.length;
    if (badgeEl) {
      badgeEl.textContent    = n;
      badgeEl.style.background = n > 0 ? '#ef4444' : '#334155';
      badgeEl.style.color      = n > 0 ? '#ffffff' : '#94a3b8';
    }

    if (n === 0) {
      listEl.innerHTML = '<span style="color:#64748b;font-style:italic;font-size:11px;">No predicted conflicts</span>';
      return;
    }

    listEl.innerHTML = conflicts.map((c) => {
      if (c.type === 'vertex') {
        return `<div style="background:rgba(239,68,68,.12);border-left:3px solid #ef4444;padding:5px 8px;border-radius:4px;margin-bottom:3px;">
  <div style="font-weight:700;color:#f87171;font-size:11px;">⚠ ${c.robotA} ↔ ${c.robotB}</div>
  <div style="color:#e2e8f0;font-size:11px;margin-top:1px;">Vertex @ (${c.tileX}, ${c.tileY})</div>
  <div style="color:#94a3b8;font-size:10px;">ETA: ${c.timeA}s / ${c.timeB}s (Δ${c.timeDiff}s)</div>
</div>`;
      } else {
        return `<div style="background:rgba(249,115,22,.12);border-left:3px solid #f97316;padding:5px 8px;border-radius:4px;margin-bottom:3px;">
  <div style="font-weight:700;color:#fb923c;font-size:11px;">⚠ ${c.robotA} ↔ ${c.robotB}</div>
  <div style="color:#e2e8f0;font-size:11px;margin-top:1px;">Edge (${c.fromA.tileX},${c.fromA.tileY})↔(${c.toA.tileX},${c.toA.tileY})</div>
  <div style="color:#94a3b8;font-size:10px;">ETA: ~${c.timeA}s / ~${c.timeB}s</div>
</div>`;
      }
    }).join('');
  };

  // ── Button wiring ─────────────────────────────────────────────────────────────

  // Robot selector buttons
  const selectorButtons = document.querySelectorAll('.robot-select-btn');
  selectorButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectRobot(btn.getAttribute('data-robot'));
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  });

  // START button
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.startRobotMovement(selectedRobotId);
    });
    startBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────
  const getSelectedRobotId = () => selectedRobotId;
  const setSelectedRobotId = (id) => { selectedRobotId = id; };

  return {
    updateStatusUI,
    selectRobot,
    updateConflictPanel,
    getSelectedRobotId,
    setSelectedRobotId
  };
}
