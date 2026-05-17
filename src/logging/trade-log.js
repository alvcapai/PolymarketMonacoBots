import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getLogFile() {
  const dateStr = new Date().toISOString().split('T')[0];
  return path.join(DATA_DIR, `trades-${dateStr}.jsonl`);
}

function appendLog(entry) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(getLogFile(), line, 'utf8');
}

export function logTradeEntry(data) {
  appendLog({
    event: 'ENTRY',
    ts: Date.now(),
    ...data
  });
}

export function logTradeExit(data) {
  appendLog({
    event: 'EXIT',
    ts: Date.now(),
    ...data
  });
}
