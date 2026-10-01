/**
 * network/socketClient.js
 *
 * STAGE 5C: Real-time Socket.IO edge client for AMR robot state exchange
 * with Dynamic Interaction Radius (DIR) & Relevant-Neighbour Filtering.
 *
 * Responsibilities:
 * - Connects to local Edge Coordinator (http://127.0.0.1:3001) using socket.io-client
 * - Maintains 1 stable connection per simulated robot
 * - Emits STATE_UPDATE payloads with real robot runtime state
 * - Caches incoming NEIGHBOUR_STATE broadcasts from peers
 * - Computes Dynamic Interaction Radius (DIR) using existing ARES V2 parameters
 * - Exposes getRelevantNeighbourStates(robotId) with spatial relevance filtering
 * - Handles ROBOT_DISCONNECTED and stale states safely
 * - Fails safely on network error without crashing simulation or affecting BASELINE
 */

import { io } from 'socket.io-client';
import { DIR_CONFIG, computeDynamicInteractionRadius } from './edgeClient.js';
import logger from '../utils/logger.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001';
export const STALE_TIMEOUT_MS = 10000;

export { DIR_CONFIG, computeDynamicInteractionRadius };

/**
 * Normalizes coordinate objects to meters space.
 * In the warehouse simulation, 1 tile = 32px = 1 meter.
 * Coordinates > 60 in magnitude are in pixel space.
 *
 * @param {{ x?: number, y?: number }} [pos]
 * @returns {{ x: number, y: number }}
 */
export function toMetersCoords(pos) {
  if (!pos) return { x: 0, y: 0 };
  const rawX = typeof pos.x === 'number' ? pos.x : 0;
  const rawY = typeof pos.y === 'number' ? pos.y : 0;

  if (Math.abs(rawX) > 60 || Math.abs(rawY) > 40) {
    return { x: rawX / 32, y: rawY / 32 };
  }
  return { x: rawX, y: rawY };
}

/**
 * Computes Euclidean distance between two positions in meters.
 *
 * @param {{ x: number, y: number }} pos1
 * @param {{ x: number, y: number }} pos2
 * @returns {number}
 */
export function computeDistanceMeters(pos1, pos2) {
  const p1 = toMetersCoords(pos1);
  const p2 = toMetersCoords(pos2);
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

export class RobotSocketClient {
  constructor(robotId, options = {}) {
    this.robotId = robotId;
    this.serverUrl = options.serverUrl || DEFAULT_SERVER_URL;
    this.socket = null;
    this.connected = false;
    this.neighbourStates = new Map(); // peerRobotId -> peerState
    this.latestState = null;
    this.hasWarnedError = false;

    this.connect();
  }

  connect() {
    if (this.socket) return;

    try {
      this.socket = io(this.serverUrl, {
        query: { robotId: this.robotId },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 3000,
        forceNew: true
      });

      this.socket.on('connect', () => {
        this.connected = true;
        this.hasWarnedError = false;
        logger.info('SOCKET', `${this.robotId} connected`);
      });

      this.socket.on('disconnect', () => {
        this.connected = false;
        logger.info('SOCKET', `${this.robotId} disconnected`);
      });

      this.socket.on('connect_error', (err) => {
        this.connected = false;
        if (!this.hasWarnedError) {
          logger.warn('SOCKET', `${this.robotId} connection error: ${err.message}`);
          this.hasWarnedError = true;
        }
      });

      this.socket.on('NEIGHBOUR_STATE', (data) => {
        if (data && data.robotId && data.robotId !== this.robotId) {
          this.neighbourStates.set(data.robotId, {
            ...data,
            localReceivedAt: Date.now()
          });
          logger.debug('SOCKET', `${this.robotId} received NEIGHBOUR_STATE from ${data.robotId}`);
        }
      });

      this.socket.on('ROBOT_DISCONNECTED', (data) => {
        if (data && data.robotId) {
          this.neighbourStates.delete(data.robotId);
          logger.info('SOCKET', `${this.robotId} removed disconnected robot ${data.robotId}`);
        }
      });
    } catch (err) {
      this.connected = false;
      if (!this.hasWarnedError) {
        logger.error('SOCKET', `${this.robotId} error creating socket: ${err.message}`);
        this.hasWarnedError = true;
      }
    }
  }

  isConnected() {
    return Boolean(this.socket && this.socket.connected);
  }

  getLatestState() {
    return this.latestState;
  }

  sendState(state, ackCallback = null) {
    try {
      const payload = {
        robotId: this.robotId,
        x: state.x,
        y: state.y,
        speed: state.speed,
        heading: state.heading !== undefined ? state.heading : 0,
        battery: state.battery !== undefined ? state.battery : 100,
        task: state.task !== undefined ? state.task : 'General Transport',
        priority: state.priority !== undefined ? state.priority : 1,
        status: state.status || 'IDLE',
        destination: state.destination !== undefined ? state.destination : null,
        timestamp: state.timestamp || Date.now()
      };

      // Store latest local state for spatial DIR calculation
      this.latestState = { ...payload };

      if (!this.socket || !this.socket.connected) {
        if (typeof ackCallback === 'function') {
          ackCallback({ success: false, error: 'Socket not connected' });
        }
        return false;
      }

      logger.debug('SOCKET', `${this.robotId} STATE_UPDATE`);

      if (typeof ackCallback === 'function') {
        this.socket.emit('STATE_UPDATE', payload, ackCallback);
      } else {
        this.socket.emit('STATE_UPDATE', payload);
      }
      return true;
    } catch (err) {
      logger.warn('SOCKET', `Failed to emit STATE_UPDATE for ${this.robotId}: ${err.message}`);
      if (typeof ackCallback === 'function') {
        ackCallback({ success: false, error: err.message });
      }
      return false;
    }
  }

  /**
   * Returns all cached raw neighbour states (Stage 5B behavior preserved).
   * @returns {Object.<string, object>}
   */
  getNeighbourStates() {
    return Object.fromEntries(this.neighbourStates);
  }

  /**
   * Computes the Dynamic Interaction Radius (DIR) in meters for this robot.
   *
   * @param {object} [customState]
   * @returns {number}
   */
  getDynamicInteractionRadius(customState = null) {
    const myState = customState || this.latestState;
    if (!myState) {
      return DIR_CONFIG.R_MIN;
    }

    const myPos = toMetersCoords(myState);
    const speedMps = typeof myState.speed === 'number'
      ? (myState.speed > 10 ? myState.speed / 100 : myState.speed)
      : 1.0;

    const now = Date.now();
    let rho = 0;

    for (const [peerId, peer] of this.neighbourStates.entries()) {
      if (!peer || peerId === this.robotId) continue;
      const lastSeen = peer.localReceivedAt || peer.timestamp || 0;
      if (now - lastSeen > STALE_TIMEOUT_MS) continue;
      if (peer.status && String(peer.status).toLowerCase() === 'completed') continue;

      const peerPos = toMetersCoords(peer);
      const distM = Math.hypot(peerPos.x - myPos.x, peerPos.y - myPos.y);
      if (distM <= DIR_CONFIG.DENSITY_RADIUS) {
        rho++;
      }
    }

    return computeDynamicInteractionRadius(speedMps, rho);
  }

  /**
   * Filters and returns only neighbours that are spatially relevant within the
   * robot's Dynamic Interaction Radius (Stage 5C).
   *
   * @param {object} [customState]
   * @returns {Object.<string, object>}
   */
  getRelevantNeighbourStates(customState = null) {
    const myState = customState || this.latestState;
    if (!myState) {
      return {};
    }

    const myPos = toMetersCoords(myState);
    const speedMps = typeof myState.speed === 'number'
      ? (myState.speed > 10 ? myState.speed / 100 : myState.speed)
      : 1.0;

    const now = Date.now();
    const candidateNeighbours = [];

    // 1. Gather active, non-stale, non-self candidate peers
    for (const [peerId, peer] of this.neighbourStates.entries()) {
      if (!peer || peerId === this.robotId) continue;

      // Filter out stale peers
      const lastSeen = peer.localReceivedAt || peer.timestamp || 0;
      if (now - lastSeen > STALE_TIMEOUT_MS) {
        continue;
      }

      // Filter out completed robots
      if (peer.status && String(peer.status).toLowerCase() === 'completed') {
        continue;
      }

      const peerPos = toMetersCoords(peer);
      const distM = Math.hypot(peerPos.x - myPos.x, peerPos.y - myPos.y);

      candidateNeighbours.push({
        peerId,
        peer,
        distM
      });
    }

    // 2. Measure local density rho within DENSITY_RADIUS (8.0m)
    let rho = 0;
    for (const item of candidateNeighbours) {
      if (item.distM <= DIR_CONFIG.DENSITY_RADIUS) {
        rho++;
      }
    }

    // 3. Compute Dynamic Interaction Radius
    const dirRadius = computeDynamicInteractionRadius(speedMps, rho);

    // 4. Retain only neighbours strictly within the DIR
    const relevant = {};
    for (const item of candidateNeighbours) {
      if (item.distM <= dirRadius) {
        relevant[item.peerId] = {
          ...item.peer,
          distance_to_robot_m: Number(item.distM.toFixed(3)),
          interaction_radius_m: Number(dirRadius.toFixed(2))
        };
      }
    }

    // Observational logging (throttled to avoid console flooding)
    logger.throttled(
      `${this.robotId}-DIR`,
      2000,
      'DIR',
      `${this.robotId} radius=${dirRadius.toFixed(1)}m density=${rho}`
    );

    const relKeys = Object.keys(relevant);
    logger.throttled(
      `${this.robotId}-NEIGHBOUR`,
      2000,
      'NEIGHBOUR',
      `${this.robotId} relevant=[${relKeys.join(',')}]`
    );

    return relevant;
  }

  disconnect() {
    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch (err) {
        // Safe cleanup
      }
      this.socket = null;
      this.connected = false;
    }
    this.neighbourStates.clear();
  }
}

// Module-level active client registry: robotId -> RobotSocketClient
const activeClients = new Map();

export function getOrCreateRobotSocket(robotId, options = {}) {
  if (!robotId) return null;
  let client = activeClients.get(robotId);
  if (!client) {
    client = new RobotSocketClient(robotId, options);
    activeClients.set(robotId, client);
  }
  return client;
}

export function createRobotSocketClient(robotId, options = {}) {
  return getOrCreateRobotSocket(robotId, options);
}

export function disconnectRobotSocket(robotId) {
  if (!robotId) return;
  const client = activeClients.get(robotId);
  if (client) {
    client.disconnect();
    activeClients.delete(robotId);
  }
}

export function disconnectAllRobotSockets() {
  for (const client of activeClients.values()) {
    client.disconnect();
  }
  activeClients.clear();
}

/**
 * Returns raw neighbour states (Stage 5B behavior).
 */
export function getNeighbourStates(robotId = null) {
  if (robotId) {
    const client = activeClients.get(robotId);
    return client ? client.getNeighbourStates() : {};
  }
  const aggregated = {};
  for (const client of activeClients.values()) {
    Object.assign(aggregated, client.getNeighbourStates());
  }
  return aggregated;
}

/**
 * Returns spatially filtered relevant neighbours inside the Dynamic Interaction Radius (Stage 5C).
 *
 * @param {string} robotId
 * @param {object} [customRobotState]
 * @returns {Object.<string, object>}
 */
export function getRelevantNeighbourStates(robotId, customRobotState = null) {
  if (!robotId) return {};
  const client = activeClients.get(robotId);
  return client ? client.getRelevantNeighbourStates(customRobotState) : {};
}

/**
 * Returns current Dynamic Interaction Radius in meters for a robot.
 *
 * @param {string} robotId
 * @param {object} [customRobotState]
 * @returns {number}
 */
export function getDynamicInteractionRadius(robotId, customRobotState = null) {
  if (!robotId) return DIR_CONFIG.R_MIN;
  const client = activeClients.get(robotId);
  return client ? client.getDynamicInteractionRadius(customRobotState) : DIR_CONFIG.R_MIN;
}

export function getActiveSocketClients() {
  return activeClients;
}
