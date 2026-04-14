# Guia de Operações — Múltiplos Agentes em Simultâneo

Como verificar quais bots estão rodando e acompanhar os logs em tempo real.

---

## 1. Ver quais agentes estão ativos agora

```bash
# Lista todos os processos node com seus argumentos e TIMEFRAME
ps aux | grep "node src/index" | grep -v grep
```

Saída esperada quando há múltiplos agentes rodando:

```
alv  12345  ... TIMEFRAME=btc-15m node src/index.js
alv  12346  ... TIMEFRAME=btc-5m  node src/index.js
alv  12347  ... TIMEFRAME=eth-15m node src/index.js
```

Para ver só os PIDs e os timeframes de forma limpa:

```bash
ps aux | grep "node src/index" | grep -v grep \
  | awk '{for(i=1;i<=NF;i++) if($i~/TIMEFRAME/) print $2, $i}'
```

---

## 2. Logs em tempo real — modo manual (sem PM2)

Se cada agente foi iniciado em um terminal separado com redirecionamento de stderr:

```bash
# Terminal 1 — iniciar BTC 15m
npm run start:btc15m 2>logs/btc15m.log

# Terminal 2 — iniciar BTC 5m
npm run start:btc5m 2>logs/btc5m.log

# Terminal 3 — iniciar ETH 15m
npm run start:eth15m 2>logs/eth15m.log

# Terminal 4 — iniciar ETH 5m
npm run start:eth5m 2>logs/eth5m.log
```

Acompanhar todos os logs ao mesmo tempo num único terminal:

```bash
tail -f logs/btc15m.log logs/btc5m.log logs/eth15m.log logs/eth5m.log
```

O `tail -f` com múltiplos arquivos prefixa cada linha com o nome do arquivo:

```
==> logs/btc15m.log <==
[AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 57.1% / SHORT 42.9% — sem ordem.

==> logs/eth15m.log <==
[AUTO-TRADE] DISPARANDO ordem LONG [REAL] — confiança 62.3% | tamanho $3.00 | ...
```

Filtrar apenas os eventos importantes (ordens disparadas, falhas, bloqueios):

```bash
tail -f logs/*.log | grep --line-buffered -E "DISPARANDO|FALHA|BLOQUEADO|AVISO|confirmada|LOOP"
```

---

## 3. Modo recomendado para produção — PM2

PM2 gerencia os processos, reinicia em caso de crash, e mantém logs persistentes com rotação automática.

### Instalar PM2

```bash
npm install -g pm2
```

### Criar o arquivo de configuração

Crie o arquivo `ecosystem.config.cjs` na raiz do projeto:

```js
module.exports = {
  apps: [
    {
      name: "btc-15m",
      script: "src/index.js",
      interpreter: "node",
      env: { TIMEFRAME: "btc-15m", NODE_ENV: "production" },
      error_file: "logs/btc15m-err.log",
      out_file:   "logs/btc15m-out.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "btc-5m",
      script: "src/index.js",
      interpreter: "node",
      env: { TIMEFRAME: "btc-5m", NODE_ENV: "production" },
      error_file: "logs/btc5m-err.log",
      out_file:   "logs/btc5m-out.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "eth-15m",
      script: "src/index.js",
      interpreter: "node",
      env: { TIMEFRAME: "eth-15m", NODE_ENV: "production" },
      error_file: "logs/eth15m-err.log",
      out_file:   "logs/eth15m-out.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "eth-5m",
      script: "src/index.js",
      interpreter: "node",
      env: { TIMEFRAME: "eth-5m", NODE_ENV: "production" },
      error_file: "logs/eth5m-err.log",
      out_file:   "logs/eth5m-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
```

> **Importante**: o arquivo `.env` do projeto ainda é carregado pelo `dotenv` — variáveis definidas no `ecosystem.config.cjs` sobrepõem o `.env` apenas se tiverem o mesmo nome.

### Comandos do dia a dia

```bash
# Iniciar todos os agentes
pm2 start ecosystem.config.cjs

# Iniciar apenas um agente
pm2 start ecosystem.config.cjs --only btc-15m

# Ver status de todos
pm2 list

# Ver status resumido
pm2 status

# Parar um agente
pm2 stop btc-5m

# Reiniciar um agente
pm2 restart eth-15m

# Parar todos
pm2 stop all

# Deletar todos da lista do PM2
pm2 delete all
```

### Logs em tempo real com PM2

```bash
# Todos os agentes ao mesmo tempo (stdout + stderr)
pm2 logs

# Apenas os logs de decisão de trade (stderr) de todos
pm2 logs --err

# Apenas um agente
pm2 logs btc-15m
pm2 logs btc-15m --err

# Últimas 100 linhas + streaming
pm2 logs --lines 100

# Filtrar só eventos de trade relevantes
pm2 logs --err --raw | grep --line-buffered -E "DISPARANDO|FALHA|BLOQUEADO|confirmada"
```

### Fazer o PM2 sobreviver a reboots

```bash
pm2 save               # salva a lista atual de processos
pm2 startup            # gera o comando para instalar o serviço de boot
# (copie e execute o comando que o pm2 startup imprimir)
```

---

## 4. Tabela de referência rápida

| Objetivo | Sem PM2 | Com PM2 |
|---|---|---|
| Ver agentes ativos | `ps aux \| grep "node src/index"` | `pm2 list` |
| Log de um agente | `tail -f logs/btc15m.log` | `pm2 logs btc-15m --err` |
| Log de todos | `tail -f logs/*.log` | `pm2 logs --err` |
| Filtrar só trades | `grep -E "DISPARANDO\|FALHA" logs/*.log` | `pm2 logs --err --raw \| grep -E "DISPARANDO\|FALHA"` |
| Parar um agente | `kill <PID>` | `pm2 stop btc-15m` |
| Restart em crash | manual | automático |
| Logs persistentes | redirecionamento manual | automático com rotação |

---

## 5. Identificar o agente no log

Cada linha de log não inclui o timeframe por padrão — ao usar `tail -f` com múltiplos arquivos, o próprio nome do arquivo identifica o agente:

```
==> logs/btc15m-err.log <==
[AUTO-TRADE] DISPARANDO ordem LONG [REAL] — confiança 61.4% ...

==> logs/eth15m-err.log <==
[AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 55.2% ...
```

Com PM2, o prefixo é o nome da app:

```
btc-15m  | [AUTO-TRADE] DISPARANDO ordem LONG [REAL] — confiança 61.4% ...
eth-15m  | [AUTO-TRADE] Confiança abaixo do threshold 60% — LONG 55.2% ...
```
