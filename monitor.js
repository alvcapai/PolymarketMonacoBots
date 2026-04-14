#!/usr/bin/env node
/**
 * Central de Controle — PolymarketBTCAssistant
 * Monitora agentes em tempo real e permite iniciar/parar via teclado.
 *
 * Uso: node monitor.js
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuração ─────────────────────────────────────────────────────────────

const REFRESH_MS  = 3000;
const THRESHOLD   = 75;       // % de confiança para disparar ordem
const BAR_WIDTH   = 14;
const LOG_LINES   = 6;        // linhas do log a analisar por agente

const AGENTS = [
  {
    name:      "btc-15m",
    timeframe: "btc-15m",
    csv:       "logs/signals-btc-15m.csv",
    // Aceita log manual (stderr redirect) ou PM2
    logs:      ["logs/btc15m.log", "logs/btc15m-err.log"],
    startLog:  "logs/btc15m.log",
  },
  {
    name:      "btc-5m",
    timeframe: "btc-5m",
    csv:       "logs/signals-btc-5m.csv",
    logs:      ["logs/btc5m.log", "logs/btc5m-err.log"],
    startLog:  "logs/btc5m.log",
  },
  {
    name:      "eth-15m",
    timeframe: "eth-15m",
    csv:       "logs/signals-eth-15m.csv",
    logs:      ["logs/eth15m.log", "logs/eth15m-err.log"],
    startLog:  "logs/eth15m.log",
  },
  {
    name:      "eth-5m",
    timeframe: "eth-5m",
    csv:       "logs/signals-eth-5m.csv",
    logs:      ["logs/eth5m.log", "logs/eth5m-err.log"],
    startLog:  "logs/eth5m.log",
  },
];

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const A = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  white:  "\x1b[97m",
  gray:   "\x1b[90m",
};

// ─── Estado global ────────────────────────────────────────────────────────────

let selectedIdx = 0;
let mode        = "view";   // "view" | "confirm-start" | "confirm-stop"
let agentData   = [];
let refreshTimer;

// ─── Utilitários de texto ─────────────────────────────────────────────────────

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s) {
  return stripAnsi(s).length;
}

function pad(s, w) {
  const v = visLen(s);
  return v >= w ? s : s + " ".repeat(w - v);
}

function center(s, w) {
  const v = visLen(s);
  if (v >= w) return s;
  const l = Math.floor((w - v) / 2);
  return " ".repeat(l) + s + " ".repeat(w - v - l);
}

function sw() {
  return Math.max(process.stdout.columns || 80, 72);
}

// ─── Detecção de PM2 ──────────────────────────────────────────────────────────

let _pm2Available = null;

function isPm2Available() {
  if (_pm2Available !== null) return _pm2Available;
  try {
    execSync("pm2 --version", { encoding: "utf8", timeout: 2000, stdio: "pipe" });
    _pm2Available = true;
  } catch {
    _pm2Available = false;
  }
  return _pm2Available;
}

// ─── Leitura de processos ─────────────────────────────────────────────────────

function getRunningPids() {
  // Tenta via PM2 primeiro — env vars não aparecem no ps aux com PM2
  if (isPm2Available()) {
    try {
      const raw  = execSync("pm2 jlist", { encoding: "utf8", timeout: 3000, stdio: "pipe" });
      const list = JSON.parse(raw);
      const map  = {};
      for (const proc of list) {
        const tf = proc.pm2_env?.TIMEFRAME ?? proc.pm2_env?.env?.TIMEFRAME;
        const pid = proc.pid;
        const status = proc.pm2_env?.status;
        if (tf && pid && status === "online") map[tf] = Number(pid);
      }
      return map;
    } catch { /* fallback abaixo */ }
  }

  // Fallback: ps aux para processos iniciados manualmente
  try {
    const out = execSync("ps aux", { encoding: "utf8", timeout: 2000, stdio: "pipe" });
    const map = {};
    for (const line of out.split("\n")) {
      if (!line.includes("node") || !line.includes("src/index")) continue;
      const tfMatch = line.match(/TIMEFRAME=([\w-]+)/);
      const pidStr  = line.trim().split(/\s+/)[1];
      if (tfMatch && pidStr) map[tfMatch[1]] = Number(pidStr);
    }
    return map;
  } catch {
    return {};
  }
}

// ─── Leitura de CSV ───────────────────────────────────────────────────────────

function readCsvLast(filePath) {
  try {
    const content = readFileSync(path.resolve(__dirname, filePath), "utf8").trim();
    const lines   = content.split("\n").filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map(h => h.trim());
    const values  = lines[lines.length - 1].split(",").map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  } catch {
    return null;
  }
}

// ─── Leitura de log ───────────────────────────────────────────────────────────

function bestLogFile(logPaths) {
  // Prefere o arquivo mais recente entre os candidatos
  let best = null;
  let bestMtime = 0;
  for (const p of logPaths) {
    const abs = path.resolve(__dirname, p);
    if (!existsSync(abs)) continue;
    try {
      const mtime = statSync(abs).mtimeMs;
      if (mtime > bestMtime) { bestMtime = mtime; best = abs; }
    } catch { /* ignore */ }
  }
  return best;
}

function readLogTail(logPaths, n = LOG_LINES) {
  const file = bestLogFile(logPaths);
  if (!file) return { lines: [], hasLog: false };
  try {
    const content = readFileSync(file, "utf8");
    const lines   = content.split("\n").filter(Boolean).map(stripAnsi);
    return { lines: lines.slice(-n), hasLog: true };
  } catch {
    return { lines: [], hasLog: false };
  }
}

function lastTradeEvent(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/DISPARANDO|confirmada|FALHA|BLOQUEADO|AVISO|EXECUCAO|MOCK EXECUCAO/.test(l)) {
      let color = "gray";
      if (/DISPARANDO|confirmada|Ordem aceita|sucesso/.test(l))    color = "green";
      else if (/FALHA|ERRO|rejeitou|inválido|ausente/.test(l))     color = "red";
      else if (/BLOQUEADO|AVISO|MOCK/.test(l))                     color = "yellow";
      // Limpar prefixo e truncar
      const clean = l.replace(/^\[AUTO-TRADE\]\s*/, "").replace(/^\[EXECUCAO\]\s*/, "").slice(0, 90);
      return { text: clean, color };
    }
  }
  return null;
}

// ─── Barra de confiança ───────────────────────────────────────────────────────

function confBar(pct) {
  const filled    = Math.round((pct / 100) * BAR_WIDTH);
  const threshPos = Math.round((THRESHOLD / 100) * BAR_WIDTH);
  let bar = "";
  for (let i = 0; i < BAR_WIDTH; i++) {
    if (i === threshPos) {
      bar += A.yellow + "▒" + A.reset;
    } else if (i < filled) {
      bar += (pct >= THRESHOLD ? A.green : A.cyan) + "█" + A.reset;
    } else {
      bar += A.gray + "░" + A.reset;
    }
  }
  return bar;
}

// ─── Coleta de dados ──────────────────────────────────────────────────────────

function fetchAll() {
  const pids = getRunningPids();
  agentData = AGENTS.map(agent => {
    const pid     = pids[agent.timeframe] ?? null;
    const running = pid !== null;
    const csv     = readCsvLast(agent.csv);
    const { lines, hasLog } = readLogTail(agent.logs);
    const event   = lastTradeEvent(lines);

    let longPct = null, shortPct = null, regime = null, signal = null, timeLeft = null;
    if (csv) {
      const u = Number(csv.model_up)   * 100;
      const d = Number(csv.model_down) * 100;
      longPct  = Number.isFinite(u) ? u : null;
      shortPct = Number.isFinite(d) ? d : null;
      regime   = csv.regime || null;
      signal   = csv.signal || null;
      const tl = Number(csv.time_left_min);
      timeLeft = Number.isFinite(tl) ? tl : null;
    }

    return { ...agent, pid, running, longPct, shortPct, regime, signal, timeLeft, event, hasLog };
  });
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function fmtTime(mins) {
  if (mins === null || !Number.isFinite(mins)) return null;
  const total = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} rest.`;
}

function colorText(text, color) {
  const c = { green: A.green, red: A.red, yellow: A.yellow, gray: A.gray, cyan: A.cyan }[color] ?? "";
  return `${c}${text}${A.reset}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const w   = sw();
  const sep = A.dim + "─".repeat(w) + A.reset;
  const now = new Date().toLocaleTimeString("pt-BR");
  const lines = [];

  // ── Cabeçalho ──
  lines.push(A.bold + A.white + "╔" + "═".repeat(w - 2) + "╗" + A.reset);
  lines.push(
    A.bold + A.white + "║" + A.reset +
    center(A.bold + "POLYMARKET BOT — CENTRAL DE CONTROLE" + A.reset, w - 2) +
    A.bold + A.white + "║" + A.reset
  );
  lines.push(
    A.bold + A.white + "║" + A.reset +
    center(A.dim + `Atualizado: ${now}   Refresh: ${REFRESH_MS / 1000}s   Threshold: ${THRESHOLD}%` + A.reset, w - 2) +
    A.bold + A.white + "║" + A.reset
  );
  lines.push(A.bold + A.white + "╚" + "═".repeat(w - 2) + "╝" + A.reset);
  lines.push("");

  // ── Agentes ──
  agentData.forEach((ag, i) => {
    const sel  = i === selectedIdx;
    const mark = sel ? A.bold + A.white + "▶" + A.reset : " ";
    const dot  = ag.running ? A.green + "●" + A.reset : A.gray + "○" + A.reset;

    // Linha de status
    const nameC = ag.running ? A.bold + A.green : A.gray;
    const pidC  = ag.running
      ? A.dim + `PID ${ag.pid}` + A.reset
      : A.gray + "PARADO" + A.reset;
    const regC  = ag.regime ? A.cyan + ag.regime + A.reset : "";
    const timeC = ag.timeLeft !== null ? A.dim + fmtTime(ag.timeLeft) + A.reset : "";

    lines.push(`${mark}${dot} ${nameC}${pad(ag.name, 8)}${A.reset}  ${pidC}   ${regC}   ${timeC}`);

    if (ag.longPct !== null) {
      // Barra LONG
      const lColor = ag.longPct >= THRESHOLD ? A.green : A.cyan;
      const sColor = ag.shortPct >= THRESHOLD ? A.green : A.cyan;
      const lLabel = `${lColor}LONG  ${String(ag.longPct.toFixed(1)).padStart(5)}%${A.reset}`;
      const sLabel = `${sColor}SHORT ${String((ag.shortPct ?? 0).toFixed(1)).padStart(5)}%${A.reset}`;
      lines.push(`   ${lLabel}  ${confBar(ag.longPct)}    ${sLabel}  ${confBar(ag.shortPct ?? 0)}`);

      // Sinal
      if (ag.signal) {
        const sigC = ag.signal.includes("BUY") ? A.green : A.gray;
        lines.push(`   Sinal: ${sigC}${ag.signal}${A.reset}`);
      }
    } else {
      lines.push(A.gray + "   Sem dados de sinal — aguarde o primeiro ciclo." + A.reset);
    }

    // Último evento de trade
    if (ag.event) {
      lines.push(`   ${colorText(ag.event.text, ag.event.color)}`);
    } else if (ag.running && !ag.hasLog) {
      lines.push(A.yellow + `   Aviso: stderr não redirecionado. Reinicie com:` + A.reset);
      lines.push(A.dim   + `   npm run start:${ag.name} 2>${ag.startLog}` + A.reset);
    } else if (!ag.running) {
      lines.push(A.dim + `   — pressione Enter para iniciar —` + A.reset);
    }

    // ── Diálogo de confirmação ──
    if (sel && mode === "confirm-start" && !ag.running) {
      lines.push(`   ${A.bold}${A.yellow}┌──────────────────────────────────────────┐${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}│  Iniciar ${pad(ag.name, 8)}?                        │${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}│  [S] Confirmar     [N] Cancelar           │${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}└──────────────────────────────────────────┘${A.reset}`);
    }
    if (sel && mode === "confirm-stop" && ag.running) {
      lines.push(`   ${A.bold}${A.red}┌────────────────────────────────────────────────┐${A.reset}`);
      lines.push(`   ${A.bold}${A.red}│  Parar ${pad(ag.name + " (PID " + ag.pid + ")?", 41)}│${A.reset}`);
      lines.push(`   ${A.bold}${A.red}│  Ordens abertas NÃO serão canceladas.          │${A.reset}`);
      lines.push(`   ${A.bold}${A.red}│  [S] Confirmar     [N] Cancelar                │${A.reset}`);
      lines.push(`   ${A.bold}${A.red}└────────────────────────────────────────────────┘${A.reset}`);
    }
    if (sel && mode === "confirm-restart" && ag.running) {
      lines.push(`   ${A.bold}${A.yellow}┌────────────────────────────────────────────────┐${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}│  Reiniciar ${pad(ag.name + "?", 37)}│${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}│  [S] Confirmar     [N] Cancelar                │${A.reset}`);
      lines.push(`   ${A.bold}${A.yellow}└────────────────────────────────────────────────┘${A.reset}`);
    }

    lines.push("");
  });

  // ── Rodapé ──
  lines.push(sep);
  const pm2Label = isPm2Available() ? A.green + "PM2" + A.reset : A.yellow + "manual" + A.reset;
  if (mode === "view") {
    lines.push(A.dim + ` ↑ ↓  navegar   Enter = iniciar/parar   R = restart   q = sair   [${A.reset}${pm2Label}${A.dim}]` + A.reset);
  } else {
    lines.push(A.bold + A.yellow + " S = confirmar     N = cancelar" + A.reset);
  }

  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(lines.join("\n") + "\n");
}

// ─── Ações ────────────────────────────────────────────────────────────────────

function startAgent(agent) {
  if (isPm2Available()) {
    try {
      execSync(`pm2 start ecosystem.config.cjs --only ${agent.name}`, {
        cwd: __dirname, encoding: "utf8", stdio: "pipe", timeout: 5000,
      });
      return;
    } catch { /* fallback abaixo */ }
  }
  // Fallback: spawn direto
  mkdirSync(path.resolve(__dirname, "logs"), { recursive: true });
  const logAbs = path.resolve(__dirname, agent.startLog);
  const fd     = openSync(logAbs, "a");
  const env    = { ...process.env, TIMEFRAME: agent.timeframe };
  const child  = spawn("node", ["src/index.js"], {
    cwd: __dirname, env, stdio: ["ignore", "ignore", fd], detached: true,
  });
  child.unref();
}

function stopAgent(agent) {
  if (isPm2Available()) {
    try {
      execSync(`pm2 stop ${agent.name}`, {
        cwd: __dirname, encoding: "utf8", stdio: "pipe", timeout: 5000,
      });
      return;
    } catch { /* fallback abaixo */ }
  }
  if (!agent.pid) return;
  try { process.kill(agent.pid, "SIGTERM"); } catch { /* já encerrado */ }
}

function restartAgent(agent) {
  if (isPm2Available()) {
    try {
      execSync(`pm2 restart ${agent.name}`, {
        cwd: __dirname, encoding: "utf8", stdio: "pipe", timeout: 5000,
      });
      return;
    } catch { /* fallback abaixo */ }
  }
  stopAgent(agent);
  setTimeout(() => startAgent(agent), 1000);
}

// ─── Teclado ──────────────────────────────────────────────────────────────────

function handleKey(buf) {
  const key = buf.toString();

  // Ctrl+C = sair sempre
  if (key === "\x03") return exit();

  if (mode === "view") {
    if (key === "\x1b[A" || key === "k") {          // ↑
      selectedIdx = (selectedIdx - 1 + AGENTS.length) % AGENTS.length;
      fetchAll(); render();
    } else if (key === "\x1b[B" || key === "j") {   // ↓
      selectedIdx = (selectedIdx + 1) % AGENTS.length;
      fetchAll(); render();
    } else if (key === "\r" || key === "\n") {       // Enter
      const ag = agentData[selectedIdx];
      mode = ag.running ? "confirm-stop" : "confirm-start";
      render();
    } else if (key === "r" || key === "R") {         // Restart
      const ag = agentData[selectedIdx];
      if (ag.running) {
        mode = "confirm-restart";
        render();
      }
    } else if (key === "q" || key === "Q") {
      exit();
    }
    return;
  }

  // Modos de confirmação
  if (key === "s" || key === "S") {
    const ag = agentData[selectedIdx];
    if (mode === "confirm-start"   && !ag.running) startAgent(ag);
    if (mode === "confirm-stop"    &&  ag.running) stopAgent(ag);
    if (mode === "confirm-restart" &&  ag.running) restartAgent(ag);
    mode = "view";
    setTimeout(() => { fetchAll(); render(); }, 1200);
  } else if (key === "n" || key === "N" || key === "\x1b") {
    mode = "view";
    render();
  }
}

// ─── Ciclo de vida ────────────────────────────────────────────────────────────

function exit() {
  clearInterval(refreshTimer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(A.green + "Monitor encerrado.\n" + A.reset);
  process.exit(0);
}

function main() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleKey);

  fetchAll();
  render();

  refreshTimer = setInterval(() => {
    if (mode === "view") { fetchAll(); render(); }
  }, REFRESH_MS);
}

main();
