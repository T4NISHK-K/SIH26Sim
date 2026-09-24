import { mapTaskType } from '../src/network/edgeClient.js';
import fs from 'node:fs';

const file = fs.readFileSync('./src/network/edgeClient.js', 'utf8');
const lines = file.split('\n');
const line = lines.find(l => l.includes('CHARGE') && l.includes('includes'));
console.log('Line:', line);
for (let i = 0; i < line.length; i++) {
  console.log(`char[${i}] = ${line[i]} (code ${line.charCodeAt(i)})`);
}
