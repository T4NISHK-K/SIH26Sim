/**
 * src/coordination/relevantNeighbours.js
 *
 * Relevant neighbours proxy module.
 * Re-exports the Stage 5C Dynamic Interaction Radius and relevant neighbours
 * filtering functions from src/network/socketClient.js and src/network/edgeClient.js.
 */

export {
  getRelevantNeighbourStates,
  getNeighbourStates,
  getDynamicInteractionRadius,
  computeDynamicInteractionRadius,
  DIR_CONFIG,
  toMetersCoords,
  computeDistanceMeters
} from '../network/socketClient.js';
