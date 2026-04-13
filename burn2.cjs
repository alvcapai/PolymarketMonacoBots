const { Wallet } = require("@polymarket/clob-client/node_modules/ethers");
const { ClobClient, Chain, Side, OrderType } = require("@polymarket/clob-client");
require("dotenv").config();

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
    console.log("[BURN] Consultando saldo e status do cliente...");
    // O SDK v2 as vezes precisa forcar uma chamada que requeira Auth L2 pra gente ter ctz que nao deu 401
    // createOrder eh offline (EIP-712), postOrder eh a batida na porta REST. 
    
    const marketTokenId = "10192"; // mock temporario apenas pra gerar a struct do EIP712
    
    console.log("[BURN] Construindo ordem dummy...");
    const order = await client.createOrder({
      tokenID: "94086791387057229994275499851278174589636235829999316794545713096352579372630", // UP fake
      side: Side.BUY,
      price: 0.01,
      size: 1, // 
      feeRateBps: 0
    });
    
    console.log("[BURN] Enviando ordem Limit  a 1 centavo via REST API L2 com credenciais do .env...");
    const resp = await client.postOrder(order, OrderType.GTC);
    console.log("[SUCESSO] Ordem enviada. Response:", resp);
    
  } catch(e) {
     console.log("[ERRO L2] Falha na API da Polymarket:", e.message);
  }
}
burn();
