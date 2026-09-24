/**
 * src/coordination/mlFeatureBuilder.js
 *
 * Unified ARES V2 ML feature builder re-export proxy.
 * Reuses the canonical buildRobotFeatures implementation in src/network/edgeClient.js
 * to ensure a single, consistent feature generation pipeline across the codebase.
 */

export {
  buildRobotFeatures,
  computeDynamicInteractionRadius,
  DIR_CONFIG,
  V2_FEATURE_KEYS,
  mapTaskType,
  normalizeAngle
} from '../network/edgeClient.js';
