import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);

// In-memory fleet state object: robotId -> state & features
const fleetState = new Map();

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
      predictorReady: isPredictorReady
    });
  }

  // GET /fleet
  if (req.method === 'GET' && url.pathname === '/fleet') {
    return sendJson(res, 200, {
      fleet: Object.fromEntries(fleetState)
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EDGE-COORDINATOR] Server running on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => {
  if (predictorProc) {
    predictorProc.kill();
  }
  process.exit(0);
});
