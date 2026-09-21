/**
 * ui/dashboardControls.js
 * Wires the visible ARES dashboard controls to existing handlers:
 *   - Top Navigation tabs (Simulation, Robots, Analytics, Scenarios)
 *   - Scenario quick dropdown (using existing scenarioService & onLoadScenario)
 *   - Robots quick dropdown (using existing fleet state & robot selection/addition)
 *   - Mode info icon tooltip
 *
 * Reuses existing functionality. Does NOT modify simulation, movement, coordination, or map logic.
 */

/**
 * Basic HTML escaping for safe text rendering.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Prevent event bubbling to Phaser canvas to avoid map pan/drag interference.
 * @param {HTMLElement} el
 */
function isolateEvent(el) {
  if (!el) return;
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach((evt) => {
    el.addEventListener(evt, (e) => e.stopPropagation());
  });
}

/**
 * Initialize dashboard controls wiring.
 *
 * @param {{
 *   getScenarios: () => Promise<object[]>,
 *   onLoadScenario: (scenario: object) => void,
 *   getRobots: () => Object.<string, object>,
 *   onSelectRobot: (robotId: string) => void,
 *   onAddRobot: () => void,
 *   getSelectedRobotId: () => string|null,
 *   maxRobots: number
 * }} options
 * @returns {{
 *   updateActiveScenario: (name: string|null) => void,
 *   closeAllDropdowns: () => void
 * }}
 */
export function setupDashboardControls(options) {
  const {
    getScenarios,
    onLoadScenario,
    getRobots,
    onSelectRobot,
    onAddRobot,
    getSelectedRobotId,
    maxRobots = 8
  } = options;

  let activeScenarioName = null;

  // ── 1. Top Navigation Tabs Wiring ──────────────────────────────────────────
  const navTabs = document.querySelectorAll('.header-nav-tab');

  const setActiveNavTab = (clickedTab, targetSectionId) => {
    navTabs.forEach((tab) => tab.classList.remove('header-nav-tab--active'));
    clickedTab.classList.add('header-nav-tab--active');

    if (targetSectionId) {
      const targetEl = document.getElementById(targetSectionId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // Subtle focus indicator on the target card
        targetEl.classList.add('section-nav-focus');
        setTimeout(() => {
          targetEl.classList.remove('section-nav-focus');
        }, 1200);
      }
    }
  };

  const navTabMap = [
    { id: 'nav-tab-simulation', target: 'map-workspace' },
    { id: 'nav-tab-robots',     target: 'robot-config-section' },
    { id: 'nav-tab-analytics',  target: 'comparison-section' },
    { id: 'nav-tab-scenarios',  target: 'scenarios-section' }
  ];

  navTabMap.forEach(({ id, target }) => {
    const tabEl = document.getElementById(id);
    if (!tabEl) return;
    isolateEvent(tabEl);
    tabEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveNavTab(tabEl, target);
    });
  });

  // ── 2. Scenario Dropdown Wiring ────────────────────────────────────────────
  const scenarioSelector = document.getElementById('scenario-quick-selector');
  const scenarioValEl = document.getElementById('scenario-quick-val');
  const scenarioMenuEl = document.getElementById('scenario-dropdown-menu');

  const closeScenarioDropdown = () => {
    if (scenarioMenuEl) {
      scenarioMenuEl.style.display = 'none';
      if (scenarioSelector) scenarioSelector.setAttribute('aria-expanded', 'false');
    }
  };

  const openScenarioDropdown = async () => {
    if (!scenarioMenuEl) return;
    closeFleetDropdown();

    scenarioMenuEl.innerHTML = '<div class="dropdown-item dropdown-empty">Loading scenarios...</div>';
    scenarioMenuEl.style.display = 'flex';
    if (scenarioSelector) scenarioSelector.setAttribute('aria-expanded', 'true');

    try {
      const scenarios = (await getScenarios()) || [];
      if (scenarios.length === 0) {
        scenarioMenuEl.innerHTML = '<div class="dropdown-item dropdown-empty">No saved scenarios</div>';
        return;
      }

      scenarioMenuEl.innerHTML = scenarios.map((sc) => {
        const count = sc.robots ? sc.robots.length : 0;
        const isCurrent = sc.name === activeScenarioName;
        return `
          <div class="dropdown-item ${isCurrent ? 'active' : ''}" data-scenario-id="${sc.id}">
            <span class="dropdown-item-title">${escapeHtml(sc.name)}</span>
            <span class="dropdown-item-meta">${count} ${count === 1 ? 'robot' : 'robots'}</span>
          </div>
        `;
      }).join('');

      // Wire scenario items
      scenarioMenuEl.querySelectorAll('.dropdown-item[data-scenario-id]').forEach((item) => {
        isolateEvent(item);
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const scId = item.getAttribute('data-scenario-id');
          const sc = scenarios.find((s) => s.id === scId);
          if (sc) {
            activeScenarioName = sc.name;
            if (scenarioValEl) scenarioValEl.textContent = sc.name;
            closeScenarioDropdown();
            if (typeof onLoadScenario === 'function') {
              onLoadScenario(sc);
            }
          }
        });
      });
    } catch (err) {
      console.warn('[DashboardControls] Failed to load scenarios:', err);
      scenarioMenuEl.innerHTML = '<div class="dropdown-item dropdown-empty">Failed to load scenarios</div>';
    }
  };

  if (scenarioSelector) {
    isolateEvent(scenarioSelector);
    scenarioSelector.addEventListener('click', (e) => {
      e.stopPropagation();
      if (scenarioMenuEl && scenarioMenuEl.style.display === 'flex') {
        closeScenarioDropdown();
      } else {
        openScenarioDropdown();
      }
    });

    scenarioSelector.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        scenarioSelector.click();
      } else if (e.key === 'Escape') {
        closeScenarioDropdown();
      }
    });
  }

  // ── 3. Robots Dropdown Wiring ──────────────────────────────────────────────
  const fleetCountBox = document.getElementById('fleet-count-box');
  const fleetMenuEl = document.getElementById('fleet-dropdown-menu');

  const closeFleetDropdown = () => {
    if (fleetMenuEl) {
      fleetMenuEl.style.display = 'none';
      if (fleetCountBox) fleetCountBox.setAttribute('aria-expanded', 'false');
    }
  };

  const openFleetDropdown = () => {
    if (!fleetMenuEl) return;
    closeScenarioDropdown();

    const robots = getRobots() || {};
    const robotIds = Object.keys(robots);
    const count = robotIds.length;
    const currentSelectedId = typeof getSelectedRobotId === 'function' ? getSelectedRobotId() : null;

    let html = '';

    if (count > 0) {
      html += robotIds.map((id) => {
        const r = robots[id];
        if (!r) return '';
        const isSelected = id === currentSelectedId;
        const status = (r.status || 'idle').toUpperCase();
        return `
          <div class="dropdown-item ${isSelected ? 'active' : ''}" data-robot-id="${id}">
            <div class="dropdown-item-left">
              <span class="dropdown-dot" style="background: ${r.colorHex || '#222'};"></span>
              <span class="dropdown-item-title">${id}</span>
            </div>
            <span class="dropdown-item-badge badge-${(r.status || 'idle').toLowerCase()}">${status}</span>
          </div>
        `;
      }).join('');
    } else {
      html += '<div class="dropdown-item dropdown-empty">No robots in fleet</div>';
    }

    if (count < maxRobots) {
      html += `
        <div class="dropdown-item dropdown-item-action" data-action="add-robot">
          <span class="dropdown-action-icon">+</span>
          <span>Add Robot to Fleet (${count}/${maxRobots})</span>
        </div>
      `;
    }

    fleetMenuEl.innerHTML = html;
    fleetMenuEl.style.display = 'flex';
    if (fleetCountBox) fleetCountBox.setAttribute('aria-expanded', 'true');

    // Wire robot selection items
    fleetMenuEl.querySelectorAll('.dropdown-item[data-robot-id]').forEach((item) => {
      isolateEvent(item);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const rid = item.getAttribute('data-robot-id');
        closeFleetDropdown();
        if (typeof onSelectRobot === 'function') {
          onSelectRobot(rid);
        }
      });
    });

    // Wire add robot item
    const addActionItem = fleetMenuEl.querySelector('.dropdown-item[data-action="add-robot"]');
    if (addActionItem) {
      isolateEvent(addActionItem);
      addActionItem.addEventListener('click', (e) => {
        e.stopPropagation();
        closeFleetDropdown();
        if (typeof onAddRobot === 'function') {
          onAddRobot();
        }
      });
    }
  };

  if (fleetCountBox) {
    isolateEvent(fleetCountBox);
    fleetCountBox.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fleetMenuEl && fleetMenuEl.style.display === 'flex') {
        closeFleetDropdown();
      } else {
        openFleetDropdown();
      }
    });

    fleetCountBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fleetCountBox.click();
      } else if (e.key === 'Escape') {
        closeFleetDropdown();
      }
    });
  }

  // ── 4. Info Icon Tooltips & Click Feedback ─────────────────────────────────
  const modeInfoIcon = document.getElementById('mode-info-icon');
  if (modeInfoIcon) {
    isolateEvent(modeInfoIcon);
    modeInfoIcon.title = 'Select the coordination mode for the simulation.';
    modeInfoIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      // Provide subtle visual pulse on title click
      modeInfoIcon.style.transform = 'scale(1.2)';
      setTimeout(() => {
        modeInfoIcon.style.transform = '';
      }, 200);
    });
  }

  const cardInfoIcon = document.querySelector('.card-info-icon');
  if (cardInfoIcon) {
    isolateEvent(cardInfoIcon);
    cardInfoIcon.title = 'Select the coordination mode for the simulation.';
  }

  // ── 5. Global Click & Key Listeners to Close Dropdowns ─────────────────────
  window.addEventListener('click', () => {
    closeScenarioDropdown();
    closeFleetDropdown();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeScenarioDropdown();
      closeFleetDropdown();
    }
  });

  return {
    updateActiveScenario: (name) => {
      activeScenarioName = name;
      if (scenarioValEl) {
        scenarioValEl.textContent = name || 'Select Scenario';
      }
    },
    closeAllDropdowns: () => {
      closeScenarioDropdown();
      closeFleetDropdown();
    }
  };
}
