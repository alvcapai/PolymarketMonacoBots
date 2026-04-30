#!/bin/bash
LOG_FILE="/home/ubuntu/.openclaw/workspace/projects/PolymarketBTC15mAssistant/logs/btc15m-err.log"
LAST_CHECK="/home/ubuntu/.openclaw/workspace/projects/PolymarketBTC15mAssistant/.last_check.txt"

# Pega o número da última linha processada
last_line=$(cat $LAST_CHECK 2>/dev/null || echo 0)
current_line=$(wc -l < "$LOG_FILE")

# Se o arquivo foi rotacionado (é menor que a última contagem), reseta
if [ "$current_line" -lt "$last_line" ]; then
    last_line=0
fi

# Busca falhas nas novas linhas
new_errors=$(tail -n +$((last_line + 1)) "$LOG_FILE" | grep -E "FALHA|order_version_mismatch")

if [ -n "$new_errors" ]; then
    echo "$(date): $new_errors" >> /home/ubuntu/.openclaw/workspace/projects/PolymarketBTC15mAssistant/alertas_bot.log
fi

echo "$current_line" > "$LAST_CHECK"
