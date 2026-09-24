import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const STALE_TIMEOUT_MS = Number(process.env.STALE_TIMEOUT_MS || 10000);

// In-memory fleet state object: robotId -> state & features (for legacy HTTP telemetry)
const fleetState = new Map();

// Real-time Robot Registry: robotId -> { robotId, socketId, connectedAt, lastSeen, lastSeenMs, state }
const robotRegistry = new Map();

// Socket to Robot mapping: socket.id -> robotId
const socketToRobot = new Map();

// Helper to check if robot state is stale
function isRobotStale(robotId, timeoutMs = STALE_TIMEOUT_MS) {
  const record = robotRegistry.get(robotId);
  if (!record) return true;
  return (Date.now() - (record.lastSeenMs || 0)) > timeoutMs;
}

// Validator for incoming STATE_UPDATE payload
function validateStateUpdate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'Payload must be a non-null object' };
  }

  // robotId exists
  if (typeof payload.robotId !== 'string' || !payload.robotId.trim()) {
    return { valid: false, error: 'Missing or invalid robotId' };
  }

  // x/y are finite numbers
  if (typeof payload.x !== 'number' || !Number.isFinite(payload.x)) {
    return { valid: false, error: 'Coordinate x must be a finite number' };
  }
  if (typeof payload.y !== 'number' || !Number.isFinite(payload.y)) {
    return { valid: false, error: 'Coordinate y must be a finite number' };
  }

  // speed is finite and non-negative
  if (typeof payload.speed !== 'number' || !Number.isFinite(payload.speed) || payload.speed < 0) {
    return { valid: false, error: 'Speed must be a non-negative finite number' };
  }

  // battery is numeric
  if (typeof payload.battery !== 'number' || !Number.isFinite(payload.battery)) {
    return { valid: false, error: 'Battery must be a numeric value' };
  }

  // priority is valid (non-empty string or finite number)
  const isPriorityValid = (typeof payload.priority === 'number' && Number.isFinite(payload.priority)) ||
                          (typeof payload.priority === 'string' && payload.priority.trim().length > 0);
  if (!isPriorityValid) {
    return { valid: false, error: 'Priority must be a valid number or non-empty string' };
  }

  // status is valid
  if (typeof payload.status !== 'string' || !payload.status.trim()) {
    return { valid: false, error: 'Status must be a non-empty string' };
  }

  // destination is valid (null, valid string, or object with finite coords if provided)
  const isDestValid = payload.destination === null ||
    (typeof payload.destination === 'string' && payload.destination.trim().length > 0) ||
    (typeof payload.destination === 'object' && payload.destination !== null &&
      (!('x' in payload.destination) || Number.isFinite(payload.destination.x)) &&
      (!('y' in payload.destination) || Number.isFinite(payload.destination.y)) &&
      (!('tileX' in payload.destination) || Number.isFinite(payload.destination.tileX)) &&
      (!('tileY' in payload.destination) || Number.isFinite(payload.destination.tileY))
    );
  if (!isDestValid) {
    return { valid: false, error: 'Destination must be null, a non-empty string, or an object with finite coordinates' };
  }

  // timestamp is valid
  const isTimestampValid = (typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp) && payload.timestamp > 0) ||
                           (typeof payload.timestamp === 'string' && !isNaN(Date.parse(payload.timestamp)));
  if (!isTimestampValid) {
    return { valid: false, error: 'Timestamp must be a positive number or valid ISO date string' };
  }

  return { valid: true };
}

// Persistent Python predictor child process
let predictorProc = null;
const requestQueue = [];
let isPredictorReady = false;

function spawnPredictor() {
  const predictorPath = path.join(__dirname, 'predictor.py');
  predictorProc = spawn('python', ['-u', predictorPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: path.join(__dirname, '..')
  });

  let stdoutBuffer = '';

  predictorProc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Retain incomplete trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const current = requestQueue.shift();
      if (current) {
        try {
          const parsed = JSON.parse(trimmed);
          current.resolve(parsed);
        } catch (err) {
          current.reject(new Error(`Failed to parse predictor output: ${err.message}`));
        }
      }
    }
  });

  predictorProc.on('error', (err) => {
    console.error('[Predictor ERROR]', err.message);
  });

  predictorProc.on('exit', (code) => {
    console.warn(`[Predictor] Python process exited with code ${code}`);
    isPredictorReady = false;
    predictorProc = null;

    // Fail any waiting requests
    while (requestQueue.length > 0) {
      const item = requestQueue.shift();
      item.reject(new Error('Predictor process exited unexpectedly'));
    }
  });

  isPredictorReady = true;
  console.log('[Predictor] Spawned persistent Python predictor');
}

// Predict features using predictor.py
function getPrediction(features) {
  return new Promise((resolve, reject) => {
    if (!predictorProc) {
      spawnPredictor();
    }

    const timeout = setTimeout(() => {
      const idx = requestQueue.findIndex((item) => item.resolve === resolve);
      if (idx !== -1) {
        requestQueue.splice(idx, 1);
        reject(new Error('Prediction request timed out after 5000ms'));
      }
    }, 5000);

    requestQueue.push({
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    });

    predictorProc.stdin.write(JSON.stringify(features) + '\n');
  });
}

// Start predictor process initially
spawnPredictor();

// Helper to send JSON responses with CORS headers
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Helper to parse JSON body from incoming request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.socket.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'local-edge-coordinator',
      port: PORT,
      uptime: process.uptime(),
      fleetCount: fleetState.size,
      activeRobotsCount: robotRegistry.size,
      socketClientsCount: io.engine ? io.engine.clientsCount : 0,
      predictorReady: isPredictorReady
    });
  }

  // GET /fleet
  if (req.method === 'GET' && url.pathname === '/fleet') {
    return sendJson(res, 200, {
      fleet: Object.fromEntries(fleetState)
    });
  }

  // GET /edge/robots - inspection endpoint for real-time edge robot state
  if (req.method === 'GET' && url.pathname === '/edge/robots') {
    const now = Date.now();
    const robots = {};
    for (const [rId, record] of robotRegistry.entries()) {
      robots[rId] = {
        ...record,
        isStale: (now - (record.lastSeenMs || 0)) > STALE_TIMEOUT_MS
      };
    }
    return sendJson(res, 200, {
      count: robotRegistry.size,
      staleTimeoutMs: STALE_TIMEOUT_MS,
      robots
    });
  }

  // POST /telemetry - update fleet state
  if (req.method === 'POST' && url.pathname === '/telemetry') {
    try {
      const body = await parseBody(req);
      const robotId = body.robotId || body.id;
      if (!robotId) {
        return sendJson(res, 400, { error: 'Missing robotId in telemetry' });
      }
      fleetState.set(robotId, {
        ...body,
        updatedAt: Date.now()
      });
      return sendJson(res, 200, { status: 'recorded', robotId });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /predict - predict decision using ML model
  if (req.method === 'POST' && url.pathname === '/predict') {
    try {
      const body = await parseBody(req);
      const robotId = body.robotId || body.id;
      const features = body.features || body;

      // Maintain in-memory fleet state
      if (robotId) {
        fleetState.set(robotId, {
          ...features,
          updatedAt: Date.now()
        });
      }

      const result = await getPrediction(features);

      return sendJson(res, 200, {
        robotId: robotId || null,
        decision: result.decision,
        confidence: result.confidence,
        ...(result.error ? { error: result.error } : {})
      });
    } catch (err) {
      return sendJson(res, 500, {
        decision: 'WAIT',
        confidence: 0.0,
        error: err.message
      });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
});

// Attach Socket.IO to the HTTP server
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  const initialRobotId = socket.handshake.query?.robotId || socket.handshake.auth?.robotId;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  if (initialRobotId && typeof initialRobotId === 'string' && initialRobotId.trim()) {
    const rId = initialRobotId.trim();
    socketToRobot.set(socket.id, rId);
    let record = robotRegistry.get(rId);
    if (!record) {
      record = {
        robotId: rId,
        socketId: socket.id,
        connectedAt: nowIso,
        lastSeen: nowIso,
        lastSeenMs: nowMs,
        state: null
      };
      robotRegistry.set(rId, record);
    } else {
      record.socketId = socket.id;
      record.lastSeen = nowIso;
      record.lastSeenMs = nowMs;
    }
  }

  // Client explicit registration event
  socket.on('REGISTER', (data, ack) => {
    try {
      const robotId = data?.robotId;
      if (!robotId || typeof robotId !== 'string' || !robotId.trim()) {
        if (typeof ack === 'function') ack({ success: false, error: 'Invalid robotId' });
        return;
      }
      const rId = robotId.trim();
      socketToRobot.set(socket.id, rId);
      const regIso = new Date().toISOString();
      const regMs = Date.now();
      let record = robotRegistry.get(rId);
      if (!record) {
        record = {
          robotId: rId,
          socketId: socket.id,
          connectedAt: regIso,
          lastSeen: regIso,
          lastSeenMs: regMs,
          state: null
        };
        robotRegistry.set(rId, record);
      } else {
        record.socketId = socket.id;
        record.lastSeen = regIso;
        record.lastSeenMs = regMs;
      }
      if (typeof ack === 'function') ack({ success: true, robotId: rId });
    } catch (err) {
      console.error('[Socket.IO] Error in REGISTER handler:', err.message);
      if (typeof ack === 'function') ack({ success: false, error: err.message });
    }
  });

  // STATE_UPDATE event
  socket.on('STATE_UPDATE', (payload, ack) => {
    try {
      const validation = validateStateUpdate(payload);
      if (!validation.valid) {
        console.warn(`[Socket.IO] Rejected malformed STATE_UPDATE from socket ${socket.id}: ${validation.error}`);
        if (typeof ack === 'function') ack({ success: false, error: validation.error });
        return;
      }

      const rId = payload.robotId.trim();
      const updateIso = new Date().toISOString();
      const updateMs = Date.now();

      socketToRobot.set(socket.id, rId);

      let record = robotRegistry.get(rId);
      if (!record) {
        record = {
          robotId: rId,
          socketId: socket.id,
          connectedAt: updateIso,
          lastSeen: updateIso,
          lastSeenMs: updateMs,
          state: null
        };
        robotRegistry.set(rId, record);
      } else {
        record.socketId = socket.id;
        record.lastSeen = updateIso;
        record.lastSeenMs = updateMs;
      }

      // Store isolated state in registry
      record.state = {
        robotId: rId,
        x: payload.x,
        y: payload.y,
        speed: payload.speed,
        heading: payload.heading !== undefined ? payload.heading : 0,
        battery: payload.battery,
        task: payload.task !== undefined ? payload.task : null,
        priority: payload.priority,
        status: payload.status,
        destination: payload.destination,
        timestamp: payload.timestamp
      };

      // Broadcast received state to connected clients as NEIGHBOUR_STATE
      socket.broadcast.emit('NEIGHBOUR_STATE', record.state);

      if (typeof ack === 'function') {
        ack({ success: true, robotId: rId });
      }
    } catch (err) {
      console.error(`[Socket.IO] Error handling STATE_UPDATE from socket ${socket.id}:`, err.message);
      if (typeof ack === 'function') {
        ack({ success: false, error: 'Internal server error processing state update' });
      }
    }
  });

  // HEARTBEAT event
  socket.on('HEARTBEAT', (data, ack) => {
    try {
      const rId = data?.robotId || socketToRobot.get(socket.id);
      if (rId && robotRegistry.has(rId)) {
        const record = robotRegistry.get(rId);
        record.lastSeen = new Date().toISOString();
        record.lastSeenMs = Date.now();
        if (typeof ack === 'function') ack({ success: true, robotId: rId, lastSeen: record.lastSeen });
      } else if (typeof ack === 'function') {
        ack({ success: false, error: 'Robot not registered' });
      }
    } catch (err) {
      console.error('[Socket.IO] Error handling HEARTBEAT:', err.message);
      if (typeof ack === 'function') ack({ success: false, error: err.message });
    }
  });

  // DISCONNECT handling
  socket.on('disconnect', (reason) => {
    try {
      const robotId = socketToRobot.get(socket.id);
      if (robotId) {
        robotRegistry.delete(robotId);
        socketToRobot.delete(socket.id);
        io.emit('ROBOT_DISCONNECTED', { robotId });
        console.log(`[Socket.IO] Robot disconnected: ${robotId} (${reason})`);
      }
    } catch (err) {
      console.error('[Socket.IO] Error handling disconnect:', err.message);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EDGE-COORDINATOR] Server running on http://127.0.0.1:${PORT} (Socket.IO enabled)`);
});

process.on('SIGINT', () => {
  if (predictorProc) {
    predictorProc.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (predictorProc) {
    predictorProc.kill();
  }
  process.exit(0);
});

export { server, io, robotRegistry, socketToRobot, validateStateUpdate, isRobotStale, STALE_TIMEOUT_MS };

