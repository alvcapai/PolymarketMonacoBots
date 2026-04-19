# Agent Operations Guide

Instruções para agentes verificarem o estado dos bots de trading Polymarket em produção.

> **Atualizado 2026-04-19** — refactor de bugs + melhorias estruturais.
> Principais mudanças de log: `edge=` → `raw_edge= net_edge=`, novo gate
> `price_X_requires_Y_above_max_stake_Z`, linha `[BASIS]` a cada ciclo,
> `counterfactual.csv` novo, MAX_STAKE agora dinâmico.

## Acesso ao servidor

```
ssh claudio@147.79.87.101
```

Logs em: `/home/claudio/workspace/PolymarketBTC15mAssistant/logs/`

---

## 1. Status dos processos (PM2)

```bash
ssh claudio@147.79.87.101 "pm2 list"
```

Processos esperados:

| Nome | Descrição |
|---|---|
| `btc-15m` | Bot BTC 15 minutos |
| `eth-15m` | Bot ETH 15 minutos |
| `PolyBotMock` | Bot mock (não opera dinheiro real) |

Verificar: todos com `status = online`. Se `status = errored` ou `stopped`, o bot caiu.

---

## 2. Bankroll atual

```bash
# BTC
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-out.log | tail -1"

# ETH
ssh claudio@147.79.87.101 "grep 'Bankroll:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-out.log | tail -1"
```

Saída esperada:
```
Bankroll:         $18.07 | cycle 1
```

---

## 3. Tentativas de entrada (ENTER)

```bash
# BTC — todas as tentativas de entrada
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# ETH
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | tail -20"

# Filtrar por data específica (ex: 2026-04-19)
ssh claudio@147.79.87.101 "grep '2026-04-19' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep 'decision=ENTER'"
```

Uma entrada bem-sucedida passa por:
1. `[RISK] ... decision=ENTER` — risk manager aprovou
2. `[AUTO-TRADE] DISPARANDO LONG/SHORT ...` — executor enviou a ordem
3. `[AUTO-TRADE] Ordem confirmada pela API (...)` — confirmado

**Formato do log RISK (pós-refactor):**
```
bankroll=$18.07 | cycle=1 | open_pos=0 | exposure=$0.00 | losing_streak=0 | paused=false |
cycle_ended=false | side=UP | prob_model=0.6457 | prob_market=0.6000 |
raw_edge=0.1000 | net_edge=0.0360 | stake=$1.36 | decision=ENTER | withdrawn=$0.00
```

Nota: `edge=` foi substituído por `raw_edge=` e `net_edge=` (Bug 3). O `net_edge` é o que gateia a entrada.

---

## 4. Apostas executadas (wins/losses)

```bash
# Ordens confirmadas
ssh claudio@147.79.87.101 "grep 'Ordem confirmada' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# Ordens com falha
ssh claudio@147.79.87.101 "grep 'FALHA na ordem' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# Take-profit disparado
ssh claudio@147.79.87.101 "grep 'TAKE-PROFIT\|STOP-LOSS' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"
```

**Formato TAKE-PROFIT (pós-refactor):**
```
[TAKE-PROFIT] TAKE-PROFIT thresh=0.75 token=abc123... cur=0.78 proceeds=$3.90
[TAKE-PROFIT] STOP-LOSS token=abc123... cur=0.08 proceeds=$0.40
```

O stop-loss (novo) vende quando `preço atual ≤ entryPrice × 0.30` e restam ≥ 5 min.

Para ver evolução do bankroll:
```bash
ssh claudio@147.79.87.101 "grep 'bankroll=' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep 'decision=ENTER\|cycle_ended' | tail -30"
```

O CSV de sinais registra todas as decisões:
```bash
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-btc-15m.csv"
```

Colunas: `timestamp, entry_minute, time_left_min, signal, decision_reason, side, prob_model_up, prob_model_down, prob_market_up, prob_market_down, edge_up, edge_down, stake_usd`

---

## 5. Erros do dia

```bash
# Substituir DATA por ex: 2026-04-19
ssh claudio@147.79.87.101 "grep 'DATA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v 'NO_TRADE' | grep -E '\[31m|rejeitou|FALHA|below_floor|fetch failed|Erro'"
```

### Erros comuns e o que significam

| Erro | Causa | Ação |
|---|---|---|
| `price_X_requires_Y_above_max_stake_Z` | Token caro para o bankroll atual. minViableStake (5 shares × preço) > maxStake (5% do bankroll). Gate #10.5 bloqueou antes de enviar a ordem. | Normal — o bot protege o capital. Quando o bankroll crescer o trade fica viável. |
| `net_edge_X_out_of_range_0.03_0.5` | Edge líquido (após taxas+slippage) abaixo de 0.03 ou raw edge acima de 0.50. | Normal — sinal fraco ou mercado óbvio. |
| `not enough balance / allowance` | Saldo USDC insuficiente na carteira. | Fazer depósito. |
| `bankroll_X_below_floor_Y` | Bankroll caiu abaixo de $15. Ciclo encerrado, novas entradas bloqueadas. | Verificar bankroll e repor se necessário. |
| `could not run the execution` | Erro genérico transitório da API Polymarket. | Transitório — o bot tenta novamente. |
| `fetch failed` (Binance) | Erro de rede ao buscar klines. | Transitório — o bot se recupera. |
| `replacement fee too low` / `GS026` | Erro no contrato Safe ao resgatar posição. | Não afeta apostas novas. |
| `Size (X) lower than the minimum: 5` | **Não deve mais ocorrer** após Bug 2. Se aparecer, o gate #10.5 não recebeu o preço correto. | Reportar — indica bug no call site de decideEntry. |

---

## 6. Linha [BASIS] (novo — Improvement 5)

A cada ciclo o bot loga a diferença entre o preço Binance e Chainlink:

```
[BASIS] binance=94823.45 chainlink=94801.20 basis=22.25 stddev=11.40 vwapMargin=0.00
```

- `basis` = preço Binance − preço Chainlink (pode ser positivo ou negativo)
- `stddev` = desvio padrão dos últimos 30 ciclos
- `vwapMargin` = 0 quando stddev ≤ $25; caso contrário = `0.5 × stddev`

Se `vwapMargin > 0`, o bot exige que o preço esteja mais distante do VWAP antes de contar como sinal +2. Isso evita falsos sinais quando Binance e Chainlink divergem.

Para checar se o basis está anômalo:
```bash
ssh claudio@147.79.87.101 "grep '\[BASIS\]' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -10"
```

---

## 7. Verificar se um ajuste de código funcionou

Após um deploy/restart, verificar:

**a) Confirmar que o código novo está rodando:**
```bash
ssh claudio@147.79.87.101 "cd /home/claudio/workspace/PolymarketBTC15mAssistant && git log --oneline -5"
```

**b) Confirmar uptime do bot (quando foi reiniciado):**
```bash
ssh claudio@147.79.87.101 "pm2 list"
```

**c) Verificar tentativas de entrada e execuções:**
```bash
ssh claudio@147.79.87.101 "grep '2026-04-19' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -E 'decision=ENTER|AUTO-TRADE|FALHA|below_floor'"
```

Se não houve tentativas de entrada, o net_edge não atingiu o threshold — o ajuste ainda não pôde ser validado.

---

## 8. Estado atual completo (snapshot rápido)

```bash
ssh claudio@147.79.87.101 "
echo '=== PM2 STATUS ==='
pm2 list

echo ''
echo '=== BANKROLL BTC ==='
grep 'Bankroll:\|Exposure:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-out.log | tail -2

echo ''
echo '=== BANKROLL ETH ==='
grep 'Bankroll:\|Exposure:' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-out.log | tail -2

echo ''
echo '=== ULTIMA DECISAO BTC ==='
grep 'decision=' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -1

echo ''
echo '=== ULTIMA DECISAO ETH ==='
grep 'decision=' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | tail -1

echo ''
echo '=== BASIS RECENTE (BTC) ==='
grep '\[BASIS\]' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -3

echo ''
echo '=== ERROS HOJE (BTC) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|fetch failed|Erro' | grep -v '^\s*$'

echo ''
echo '=== ERROS HOJE (ETH) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|fetch failed|Erro' | grep -v '^\s*$'
"
```

---

## 9. Referência de arquivos de log

| Arquivo | Conteúdo |
|---|---|
| `btc15m-out.log` | Dashboard visual do bot BTC (bankroll, indicadores, decisão atual) |
| `btc15m-err.log` | Log detalhado: decisões RISK, execuções, basis, erros |
| `eth15m-out.log` | Dashboard visual do bot ETH |
| `eth15m-err.log` | Log detalhado ETH |
| `signals-btc-15m.csv` | Histórico de todos os sinais e decisões BTC em CSV |
| `signals-eth-15m.csv` | Histórico de todos os sinais e decisões ETH em CSV |
| `counterfactual.csv` | **Novo** — uma linha por ciclo com probModel, probMarket, rawEdge, netEdge, gate que bloqueou, stake hipotético. Preencher `actual_settled_outcome` manualmente após settlement para calibrar o modelo. |
