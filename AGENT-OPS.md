# Agent Operations Guide

Instruções para agentes verificarem o estado dos bots de trading Polymarket em produção.

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

Campos: `bankroll atual`, `ciclo`. Exposure e open positions também aparecem na mesma seção do out.log.

---

## 3. Tentativas de entrada (ENTER)

```bash
# BTC — todas as tentativas de entrada
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# ETH
ssh claudio@147.79.87.101 "grep 'decision=ENTER' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | tail -20"

# Filtrar por data específica (ex: 2026-04-16)
ssh claudio@147.79.87.101 "grep '2026-04-16' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep 'decision=ENTER'"
```

Uma entrada bem-sucedida passa por:
1. `[RISK] ... decision=ENTER` — risk manager aprovou
2. `[EXECUCAO] Apostando $X em BUY/SELL ...` — executor enviou a ordem
3. `[EXECUCAO] Ordem aceita pela API. Resposta: {...success:true}` — confirmado

---

## 4. Apostas executadas (wins/losses)

```bash
# Ordens aceitas
ssh claudio@147.79.87.101 "grep 'Ordem aceita' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"

# Ordens rejeitadas
ssh claudio@147.79.87.101 "grep 'rejeitou\|FALHA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | tail -20"
```

Para ver wins/losses verificar a evolução do bankroll ao longo do tempo:
```bash
ssh claudio@147.79.87.101 "grep 'bankroll=' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep 'decision=ENTER\|cycle_ended' | tail -30"
```

O arquivo de sinais CSV também registra todas as decisões:
```bash
ssh claudio@147.79.87.101 "tail -20 /home/claudio/workspace/PolymarketBTC15mAssistant/logs/signals-btc-15m.csv"
```

Colunas: `timestamp, entry_minute, time_left_min, signal, decision_reason, side, prob_model_up, prob_model_down, prob_market_up, prob_market_down, edge_up, edge_down, stake_usd`

---

## 5. Erros do dia

```bash
# Substituir DATA por ex: 2026-04-16
ssh claudio@147.79.87.101 "grep 'DATA' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v 'NO_TRADE' | grep -E '\[31m|rejeitou|FALHA|below_floor|fetch failed|Erro'"
```

### Erros comuns e o que significam

| Erro | Causa | Ação |
|---|---|---|
| `Size (X) lower than the minimum: 5` | Stake gerou menos de 5 shares. Preço muito alto para o stake configurado. | Verificar `MAX_STAKE` — deve cobrir 5 shares ao preço atual |
| `not enough balance / allowance` | Saldo USDC insuficiente na carteira | Fazer depósito |
| `bankroll_X_below_floor_Y` | Bankroll caiu abaixo do piso de segurança. Ciclo encerrado, novas entradas bloqueadas. | Verificar bankroll e repor se necessário |
| `could not run the execution` | Erro genérico transitório da API Polymarket | Transitório — o bot tenta novamente |
| `fetch failed` (Binance) | Erro de rede ao buscar preço spot | Transitório — o bot se recupera |
| `replacement fee too low` / `replacement transaction underpriced` | Gas price insuficiente para substituir tx pendente no redeem | Erro no redeem, não afeta apostas novas |
| `GS026` (execution reverted) | Erro no contrato Safe ao resgatar posição | Erro no redeem, não afeta apostas novas |
| `this.signer._signTypedData is not a function` | Incompatibilidade de versão do signer | Bug de código — reportar |

---

## 6. Verificar se um ajuste de código funcionou

Após um deploy/restart, verificar:

**a) Confirmar que o código novo está rodando:**
```bash
ssh claudio@147.79.87.101 "cd /home/claudio/workspace/PolymarketBTC15mAssistant && git log --oneline -3"
```

**b) Confirmar uptime do bot (quando foi reiniciado):**
```bash
ssh claudio@147.79.87.101 "pm2 list"
```
O campo `uptime` mostra há quanto tempo o processo está rodando.

**c) Verificar se houve tentativas de entrada após o restart e se foram aceitas:**
```bash
# Ver tudo de hoje: entradas, execuções, erros (excluindo spam NO_TRADE)
ssh claudio@147.79.87.101 "grep '2026-04-16' /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -E 'decision=ENTER|EXECUCAO|FALHA|rejeitou|below_floor'"
```

Se não houve tentativas de entrada, o modelo não atingiu o threshold — o ajuste ainda não pôde ser validado na prática.

---

## 7. Estado atual completo (snapshot rápido)

Comando all-in-one para checar tudo de uma vez:

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
echo '=== ERROS HOJE (BTC) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/btc15m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|fetch failed|Erro' | grep -v '^\s*$'

echo ''
echo '=== ERROS HOJE (ETH) ==='
grep \$(date +%Y-%m-%d) /home/claudio/workspace/PolymarketBTC15mAssistant/logs/eth15m-err.log | grep -v NO_TRADE | grep -E '\[31m|FALHA|below_floor|fetch failed|Erro' | grep -v '^\s*$'
"
```

---

## 8. Referência de arquivos de log

| Arquivo | Conteúdo |
|---|---|
| `btc15m-out.log` | Dashboard visual do bot BTC (bankroll, indicadores, decisão atual) |
| `btc15m-err.log` | Log detalhado: decisões RISK, execuções, erros |
| `eth15m-out.log` | Dashboard visual do bot ETH |
| `eth15m-err.log` | Log detalhado ETH |
| `signals-btc-15m.csv` | Histórico de todos os sinais e decisões BTC em CSV |
| `signals-eth-15m.csv` | Histórico de todos os sinais e decisões ETH em CSV |
