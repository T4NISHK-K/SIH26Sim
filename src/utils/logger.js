/**
 * src/utils/logger.js
 *
 * Lightweight centralized structured runtime logger for ARES Edge-AI coordination pipeline.
 * Observational only — never modifies simulation or coordination behavior.
 */

export let DEBUG_LOGS = true;

export function setDebugLogs(enabled) {
  DEBUG_LOGS = Boolean(enabled);
  if (typeof window !== 'undefined') {
    window.DEBUG_LOGS = DEBUG_LOGS;
  }
}

if (typeof window !== 'undefined') {
  window.DEBUG_LOGS = DEBUG_LOGS;
  window.setDebugLogs = setDebugLogs;
}

// Memory for state-change deduplication and throttling
const lastLogTimes = new Map();
const lastLoggedStates = new Map();

function formatMessage(category, message, data) {
  const cat = String(category || 'LOG').toUpperCase();
  let base = `[${cat}] ${message}`;
  if (data !== undefined && data !== null) {
    if (typeof data === 'object') {
      try {
        base += ` ${JSON.stringify(data)}`;
      } catch {
        base += ` [Object]`;
      }
    } else {
      base += ` ${data}`;
    }
  }
  return base;
}

export const logger = {
  info(category, message, data) {
    console.log(formatMessage(category, message, data));
  },

  warn(category, message, data) {
    console.warn(formatMessage(category, message, data));
  },

  error(category, message, data) {
    console.error(formatMessage(category, message, data));
  },

  debug(category, message, data) {
    const isEnabled = (typeof window !== 'undefined' && typeof window.DEBUG_LOGS === 'boolean')
      ? window.DEBUG_LOGS
      : DEBUG_LOGS;
    if (!isEnabled) return;
    console.log(formatMessage(category, message, data));
  },

  /**
   * Log only when the message/state for a given unique key changes.
   */
  stateChange(key, category, message, data) {
    const formatted = formatMessage(category, message, data);
    const prev = lastLoggedStates.get(key);
    if (prev !== formatted) {
      lastLoggedStates.set(key, formatted);
      console.log(formatted);
      return true;
    }
    return false;
  },

  /**
   * Throttle logging for a key to at most once per intervalMs, or immediately if value changes.
   */
  throttled(key, intervalMs, category, message, data) {
    const now = Date.now();
    const lastTime = lastLogTimes.get(key) || 0;
    const formatted = formatMessage(category, message, data);
    const prev = lastLoggedStates.get(key);

    if (prev !== formatted || (now - lastTime >= intervalMs)) {
      lastLogTimes.set(key, now);
      lastLoggedStates.set(key, formatted);
      console.log(formatted);
      return true;
    }
    return false;
  }
};

export default logger;
