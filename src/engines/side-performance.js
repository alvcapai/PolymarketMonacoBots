import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_PATH = path.join(__dirname, '..', '..', '.side-performance.json');
const WINDOW_SIZE = 20;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { Up: [], Down: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recordOutcome(side, won) {
  const normSide = side.toLowerCase() === 'up' ? 'Up' : 'Down';
  const state = loadState();
  state[normSide] = state[normSide] || [];
  state[normSide].push({ won: !!won, ts: Date.now() });
  if (state[normSide].length > WINDOW_SIZE) state[normSide].shift();
  saveState(state);
}

export function getSideWinRate(side) {
  const normSide = side.toLowerCase() === 'up' ? 'Up' : 'Down';
  const state = loadState();
  const arr = state[normSide] || [];
  if (arr.length < 10) return { rate: null, sample: arr.length };
  const wins = arr.filter(x => x.won).length;
  return { rate: wins / arr.length, sample: arr.length };
}
