/**
 * scratch/run_stage4a_benchmark.mjs
 *
 * Stage 4A Deterministic Baseline vs ARES Benchmark Runner.
 * Executes paired runs on identical initial scenario states across 4 representative scenarios.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runPairedBenchmark,
  formatComparisonTable
} from '../src/simulation/benchmarkHarness.js';

// Load warehouse map TMJ
const tmjPath = path.resolve('map/warehousemap.tmj');
const mapData = JSON.parse(fs.readFileSync(tmjPath, 'utf8'));

console.log('='.repeat(70));
console.log('STAGE 4A: DETERMINISTIC BASELINE VS ARES BENCHMARK');
console.log('='.repeat(70));
console.log(`Map: ${tmjPath}`);
console.log(`Dimensions: ${mapData.width}x${mapData.height} tiles (32px/tile, 1m/tile)`);
console.log('');

// ── Deterministic Scenario Definitions ──────────────────────────────────────

const scenarios = [
  {
    name: 'Scenario 1: Head-On Corridor Conflict',
    description: 'Two AMRs traveling in opposite directions along a single shared 64px corridor (Y=28)',
    robots: [
      {
        robotId: 'R1-East',
        start: { tileX: 10, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 100,
        priority: 1,
        battery: 90,
        task: 'General Transport'
      },
      {
        robotId: 'R2-West',
        start: { tileX: 35, tileY: 28 },
        destination: { tileX: 10, tileY: 28 },
        speed: 100,
        priority: 1,
        battery: 90,
        task: 'General Transport'
      }
    ]
  },
  {
    name: 'Scenario 2: Crossing Intersection Conflict',
    description: 'Two AMRs converging perpendicularly at intersection (25, 28) with different priority levels',
    robots: [
      {
        robotId: 'R1-CrossH',
        start: { tileX: 15, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 85,
        task: 'Express Delivery'
      },
      {
        robotId: 'R2-CrossV',
        start: { tileX: 25, tileY: 18 },
        destination: { tileX: 25, tileY: 38 },
        speed: 100,
        priority: 1,
        battery: 85,
        task: 'General Transport'
      }
    ]
  },
  {
    name: 'Scenario 3: Same-Direction Following Conflict',
    description: 'Lead AMR and faster pursuing AMR in single corridor Y=28 with velocity differential',
    robots: [
      {
        robotId: 'R1-Lead',
        start: { tileX: 20, tileY: 28 },
        destination: { tileX: 40, tileY: 28 },
        speed: 70,
        priority: 1,
        battery: 75,
        task: 'Heavy Haul'
      },
      {
        robotId: 'R2-Pursuer',
        start: { tileX: 10, tileY: 28 },
        destination: { tileX: 40, tileY: 28 },
        speed: 130,
        priority: 2,
        battery: 95,
        task: 'Urgent Dispatch'
      }
    ]
  },
  {
    name: 'Scenario 4: 4-Robot Congested Intersection',
    description: 'Four AMRs simultaneously converging on intersection (25, 28) from all four directions',
    robots: [
      {
        robotId: 'R1-West',
        start: { tileX: 15, tileY: 28 },
        destination: { tileX: 35, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 80,
        task: 'Express Transport'
      },
      {
        robotId: 'R2-North',
        start: { tileX: 25, tileY: 18 },
        destination: { tileX: 25, tileY: 38 },
        speed: 100,
        priority: 1,
        battery: 85,
        task: 'General Transport'
      },
      {
        robotId: 'R3-East',
        start: { tileX: 35, tileY: 28 },
        destination: { tileX: 15, tileY: 28 },
        speed: 100,
        priority: 2,
        battery: 80,
        task: 'Express Transport'
      },
      {
        robotId: 'R4-South',
        start: { tileX: 25, tileY: 38 },
        destination: { tileX: 25, tileY: 18 },
        speed: 100,
        priority: 1,
        battery: 85,
        task: 'General Transport'
      }
    ]
  }
];

// Run benchmarks
const allResults = [];

for (const scenario of scenarios) {
  console.log(`Running benchmark: ${scenario.name}...`);
  console.log(`  Description: ${scenario.description}`);
  console.log(`  Fleet size: ${scenario.robots.length} robots`);

  const result = await runPairedBenchmark(scenario, {
    mapData,
    dtMs: 50,
    maxSimulationSec: 60,
    telemetryIntervalMs: 200
  });

  allResults.push(result);

  console.log('');
  console.log(formatComparisonTable(result));
  console.log('');
}

// Save machine-readable JSON output
const outputPath = path.resolve('scratch/benchmark_results.json');
fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2), 'utf8');
console.log(`Machine-readable benchmark results saved to: ${outputPath}`);
console.log('='.repeat(70));
