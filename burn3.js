import { Wallet } from "ethers";
import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client";
import "dotenv/config";

async function burn() {
  const pk = process.env.PK.startsWith("0x") ? process.env.PK : "0x" + process.env.PK;
  const wallet = new Wallet(pk);
  
  const creds = {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  };

  const client = new ClobClient("https://clob.polymarket.com", Chain.POLYGON, wallet, creds);
  
  try {
    console.log("[BURN] Buscando mercado BTC 15m atual...");
    const res = await fetch("https://gamma-api.polymarket.com/events?series_id=10192&active=true&closed=false");
    const events = await res.json();
    if(!events.length) { console.log("Sem mercado ativo"); return; }
    
    const market = events[0].markets[0]; // The active market
    const upTokenId = JSON.parse(market.clobTokenIds)[0]; // [up, down]
    
    console.log(`[BURN] Token UP encontrado: ${upTokenId}`);
    console.log("[BURN] Enviando ordem Limit $1 a 1 centavo...");
    
    const order = await client.createOrder({
      tokenID: upTokenId,
      side: Side.BUY,
      price: 0.01,
      size: 1, // 1 USDC at 0.01 = 100 shares
      feeRateBps: 0
    });
    
    const resp = await client.postOrder(order, OrderType.GTC);
    console.log("[SUCESSO] Resposta da API:", resp);
    
  } catch(e) {
     console.log("[ERRO] Falha:", e.message);
  }
}
burn();
