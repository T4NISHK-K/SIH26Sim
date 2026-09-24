/**
 * scratch/run_stage4c_benchmark.mjs
 *
 * STAGE 4C: FINAL DETERMINISTIC BASELINE VS ARES BENCHMARK
 *
 * Runs deterministic paired BASELINE vs ARES benchmarks on identical initial scenario states:
 *   1. SAME_DIRECTION / FOLLOWING (3 robots)
 *   2. HEAD_ON (3 robots)
 *   3. INTERSECTION / CROSSING (3 robots)
 *   4. CONGESTION (5 robots)
 *   5. MIXED_TRAFFIC (5 robots)
 *
 * Automatically manages local Edge Coordinator backend (server/index.js) with
 * persistent Python XGBoost model inference for the ARES run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  runPairedBenchmark,
  formatComparisonTable,
  formatSummaryTable
} from '../src/simulation/benchmarkHarness.js';
import { connectEdge } from '../src/network/edgeClient.js';

// Setup minimal global environment for Node.js
globalThis.window = globalThis.window || {
  edgeConnected: false,
  robotDecisionState: {},
  edgeDecisionStats: { totalPredictions: 0, move: 0, slow: 0, wait: 0, reroute: 0 }
};

// Load warehouse map TMJ
const tmjPath = path.resolve('map/warehousemap.tmj');
const mapData = JSON.parse(fs.readFileSync(tmjPath, 'utf8'));

console.log('='.repeat(80));
console.log('STAGE 4C: FINAL DETERMINISTIC BASELINE VS ARES BENCHMARK');
console.log('='.repeat(80));
console.log(`Map: ${tmjPath}`);
console.log(`Dimensions: ${mapData.width}x${mapData.height} tiles (32px/tile, 1m/tile)`);
console.log('');

// ── Ensure Local Edge Coordinator Backend with V2 XGBoost is Active ──────────
let serverProc = null;
const isAlreadyUp = await connectEdge('http://127.0.0.1:3001');

if (!isAlreadyUp) {
  console.log('[Setup] Starting local edge coordinator server (server/index.js)...');
  serverProc = spawn('node', ['server/index.js'], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProc.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`  [Server] ${msg}`);
  });
  serverProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`  [Server ERR] ${msg}`);
  });

  // Poll until backend health check passes
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await connectEdge('http://127.0.0.1:3001')) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    console.error('[Setup] Warning: Could not connect to edge coordinator on port 3001. Proceeding with fallback.');
  } else {
    console.log('[Setup] Edge coordinator with V2 XGBoost model online and ready.\n');
  }
} else {
  console.log('[Setup] Edge coordinator backend already running on port 3001.\n');
}

function cleanup() {
  if (serverProc) {
    console.log('\n[Teardown] Shutting down spawned edge coordinator process...');
    serverProc.kill();
    serverProc = null;
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ── 5 Scenario Definitions ───────────────────────────────────────────────────

const scenarios = [
  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: SAME_DIRECTION / FOLLOWING (3 robots)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Scenario 1: SAME_DIRECTION / FOLLOWING (3 robots)',
    description: 'Lead, middle, and faster pursuing AMRs traveling in single corridor Y=28 with velocity differential',
    robots: [
      {
        robotId: 'R1-Lead',
        start: { tileX: 22, tileY: 28 },
        destination: { tileX: 45, tileY: 28 },
        speed: 70,
        priority: 1,
        battery: 80,
        task: 'Heavy Haul'
      },
      {
        robotId: 'R2-Mid',
        start: { tileX: 16, tileY: 28 },
        destination: { tileX: 45, tileY: 28 },
        speed: 100,
        priority: 1,
        battery: 85,
        task: 'General Transport'
      },
      {
        robotId: 'R3-Trail',
        start: { tileX: 10, tileY: 28 },
        destination: { tileX: 45, tileY: 28 },
        speed: 130,
        priority: 2,
        battery: 90,
        task: 'Urgent Dispatch'
      }
    ]
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: HEAD_ON (3 robots)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Scenario 2: HEAD_ON (3 robots)',
    description: 'Opposing traffic along single shared corridor Y=28: 2 Eastbound robots meeting 1 Westbound robot head-on',
    robots: [
      {
        robotId: 'R1-East',
        start: { tileX: 12, tileY: 28 },
        destination: { tileX: 38, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'Express Delivery'
      },
      {
        robotId: 'R2-West',
        start: { tileX: 38, tileY: 28 },
        destination: { tileX: 12, tileY: 28 },
        speed: 100,
        priority: 1,
        battery: 85,
        task: 'General Transport'
      },
      {
        robotId: 'R3-East2',
        start: { tileX: 8, tileY: 28 },
        destination: { tileX: 38, tileY: 28 },
        speed: 100,
        priority: 1,
        battery: 80,
        task: 'General Transport'
      }
    ]
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: INTERSECTION / CROSSING (3 robots)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Scenario 3: INTERSECTION / CROSSING (3 robots)',
    description: 'Three AMRs converging simultaneously on perpendicular intersection (25, 28) from West, North, and South',
    robots: [
      {
        robotId: 'R1-CrossH',
        start: { tileX: 15, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 100,
        priority: 3,
        battery: 90,
        task: 'Express Dispatch'
      },
      {
        robotId: 'R2-CrossV-S',
        start: { tileX: 25, tileY: 18 },
        destination: { tileX: 25, tileY: 38 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'Standard Transport'
      },
      {
        robotId: 'R3-CrossV-N',
        start: { tileX: 25, tileY: 38 },
        destination: { tileX: 25, tileY: 18 },
        speed: 100,
        priority: 1,
        battery: 80,
        task: 'Routine Transit'
      }
    ]
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: CONGESTION (5 robots)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Scenario 4: CONGESTION (5 robots)',
    description: 'Five AMRs simultaneously converging on central hub (25, 28) from all four cardinal approaches plus trailing queue',
    robots: [
      {
        robotId: 'R1-West',
        start: { tileX: 15, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 100,
        priority: 3,
        battery: 85,
        task: 'Express Delivery'
      },
      {
        robotId: 'R2-East',
        start: { tileX: 35, tileY: 28 },
        destination: { tileX: 15, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'General Transport'
      },
      {
        robotId: 'R3-North',
        start: { tileX: 25, tileY: 18 },
        destination: { tileX: 25, tileY: 38 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'Standard Transfer'
      },
      {
        robotId: 'R4-South',
        start: { tileX: 25, tileY: 38 },
        destination: { tileX: 25, tileY: 18 },
        speed: 100,
        priority: 1,
        battery: 80,
        task: 'Routine Patrol'
      },
      {
        robotId: 'R5-WestTrail',
        start: { tileX: 11, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 110,
        priority: 1,
        battery: 90,
        task: 'Urgent Dispatch'
      }
    ]
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 5: MIXED_TRAFFIC (5 robots)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Scenario 5: MIXED_TRAFFIC (5 robots)',
    description: 'Heterogeneous fleet with isolated aisle transport, intersection crossing, convoy following, and turning merge traffic',
    robots: [
      {
        robotId: 'R1-Solo',
        start: { tileX: 8, tileY: 10 },
        destination: { tileX: 8, tileY: 26 },
        speed: 100,
        priority: 1,
        battery: 95,
        task: 'Solo Aisle Transfer'
      },
      {
        robotId: 'R2-CrossH',
        start: { tileX: 16, tileY: 28 },
        destination: { tileX: 36, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'Crossing East'
      },
      {
        robotId: 'R3-CrossV',
        start: { tileX: 25, tileY: 18 },
        destination: { tileX: 25, tileY: 38 },
        speed: 100,
        priority: 1,
        battery: 80,
        task: 'Crossing South'
      },
      {
        robotId: 'R4-FollowH',
        start: { tileX: 10, tileY: 28 },
        destination: { tileX: 36, tileY: 28 },
        speed: 120,
        priority: 2,
        battery: 90,
        task: 'Following East'
      },
      {
        robotId: 'R5-Turn',
        start: { tileX: 25, tileY: 38 },
        destination: { tileX: 36, tileY: 28 },
        speed: 100,
        priority: 3,
        battery: 85,
        task: 'Junction Merge'
      }
    ]
  }
];

// ── Execute Benchmark Runs ───────────────────────────────────────────────────

const allResults = [];

try {
  for (const scenario of scenarios) {
    console.log(`\nRunning paired benchmark: ${scenario.name}...`);
    console.log(`  Description: ${scenario.description}`);
    console.log(`  Fleet size: ${scenario.robots.length} robots`);

    const result = await runPairedBenchmark(scenario, {
      mapData,
      dtMs: 50,
      maxSimulationSec: 75,
      telemetryIntervalMs: 200
    });

    allResults.push(result);
    console.log('\n' + formatComparisonTable(result));
  }

  // Multi-scenario comprehensive summary table
  console.log('\n' + '='.repeat(90));
  console.log('STAGE 4C COMPREHENSIVE BENCHMARK SUMMARY TABLE');
  console.log('='.repeat(90));
  console.log(formatSummaryTable(allResults));
  console.log('='.repeat(90));

  // Machine-readable JSON output
  const outputPath = path.resolve('scratch/benchmark_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2), 'utf8');
  console.log(`\nMachine-readable benchmark results saved to: ${outputPath}`);

} catch (err) {
  console.error('\n[Error executing benchmark]:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}
