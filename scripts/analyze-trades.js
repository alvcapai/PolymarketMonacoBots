#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log("Data directory not found.");
    return;
  }

  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('trades-') && f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log("No trade logs found in new format.");
    return;
  }

  const latestFile = files.sort().pop();
  console.log(`Analyzing: ${latestFile}\n`);

  const filePath = path.join(DATA_DIR, latestFile);
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let totalWinPnl = 0;
  let totalLossPnl = 0;

  const sideStats = { Up: { pnl: 0, count: 0 }, Down: { pnl: 0, count: 0 } };
  const reasonStats = {};

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'EXIT') {
        totalTrades++;
        totalPnl += entry.pnlUsdc || 0;

        if (entry.pnlUsdc > 0) {
          wins++;
          totalWinPnl += entry.pnlUsdc;
        } else {
          losses++;
          totalLossPnl += entry.pnlUsdc || 0;
        }

        const side = entry.side === 'UP' ? 'Up' : (entry.side === 'DOWN' ? 'Down' : entry.side);
        if (sideStats[side]) {
          sideStats[side].pnl += entry.pnlUsdc || 0;
          sideStats[side].count++;
        }

        const reason = entry.reason || 'unknown';
        if (!reasonStats[reason]) reasonStats[reason] = { pnl: 0, count: 0 };
        reasonStats[reason].pnl += entry.pnlUsdc || 0;
        reasonStats[reason].count++;
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const avgWin = wins > 0 ? totalWinPnl / wins : 0;
  const avgLoss = losses > 0 ? Math.abs(totalLossPnl / losses) : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 0;

  console.log(`=== Overall Summary ===`);
  console.log(`Total Trades : ${totalTrades}`);
  console.log(`Win Rate     : ${winRate.toFixed(1)}% (${wins} W / ${losses} L)`);
  console.log(`Total P&L    : $${totalPnl.toFixed(2)}`);
  console.log(`Avg Win      : $${avgWin.toFixed(2)}`);
  console.log(`Avg Loss     : -$${avgLoss.toFixed(2)}`);
  console.log(`Reward/Risk  : ${rr.toFixed(2)}:1\n`);

  console.log(`=== P&L by Side ===`);
  for (const [side, stat] of Object.entries(sideStats)) {
    console.log(`${side.padEnd(6)}: $${stat.pnl.toFixed(2)} (${stat.count} trades)`);
  }
  console.log('');

  console.log(`=== P&L by Exit Reason ===`);
  for (const [reason, stat] of Object.entries(reasonStats)) {
    console.log(`${reason.padEnd(30)}: $${stat.pnl.toFixed(2)} (${stat.count} trades)`);
  }
}

main().catch(console.error);
