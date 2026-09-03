/**
 * config/constants.js
 * Shared compile-time constants for the Warehouse Robot Fleet Simulation.
 * Import from here instead of scattering magic numbers throughout the codebase.
 */

// ─── Tile / display dimensions ────────────────────────────────────────────────
export const TILE_SIZE = 32;
export const ROBOT_DISPLAY_SIZE = 64;

// ─── Robot defaults ───────────────────────────────────────────────────────────
export const DEFAULT_SPEED = 100; // pixels per second

// ─── Conflict detection ───────────────────────────────────────────────────────
// Two robots occupying the same tile within this window (seconds) is a conflict.
export const CONFLICT_TIME_THRESHOLD = 0.75;

// ─── Robot fleet configuration ────────────────────────────────────────────────
// Each entry drives sprite frame selection, priority, and path/UI colour.
export const ROBOT_CONFIGS = [
  { id: 'Robot-01', frame: 0, priority: 1, color: 0x00e5ff, colorHex: '#00e5ff' },
  { id: 'Robot-02', frame: 1, priority: 2, color: 0xf59e0b, colorHex: '#f59e0b' },
  { id: 'Robot-03', frame: 2, priority: 3, color: 0xd946ef, colorHex: '#d946ef' }
];

// ─── Tileset texture keys (must match Phaser load.image keys) ─────────────────
export const TILESET_KEYS = [
  'roads', 'roads2', 'roads3',
  'walls', 'wall2',
  'buildings',
  'areas',
  'object',
  'rooms', 'rooms2'
];

// ─── TSX source-filename → Phaser cache key mapping ──────────────────────────
export const TSX_KEY_MAP = {
  'tilesets/roads.tsx':     'roads_tsx',
  'tilesets/roads2.tsx':    'roads2_tsx',
  'tilesets/roads3.tsx':    'roads3_tsx',
  'tilesets/walls.tsx':     'walls_tsx',
  'tilesets/wall2.tsx':     'wall2_tsx',
  'tilesets/buildings.tsx': 'buildings_tsx',
  'tilesets/areas.tsx':     'areas_tsx',
  'tilesets/object.tsx':    'object_tsx',
  'tilesets/rooms.tsx':     'rooms_tsx',
  'tilesets/rooms2.tsx':    'rooms2_tsx'
};
