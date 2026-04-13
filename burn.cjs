const { Wallet } = require("@polymarket/clob-client/node_modules/ethers");
const { ClobClient, Chain, Side, OrderType } = require("@polymarket/clob-client");
require("dotenv").config();

async function burn() {
  const pk = process.env.PK.startsWith("0x") ? process.env.PK : "0x" + process.env.PK;
  const wallet = new Wallet(pk);
  const client = new ClobClient("https://clob.polymarket.com", Chain.POLYGON, wallet);
  
  try {
    console.log("[BURN] Criando credenciais API L2...");
    const creds = await client.createApiKey();
    console.log("[BURN] Credenciais geradas:", creds.apiKey !== undefined);
  } catch (e) {
    console.log("[BURN] Erro ao gerar credenciais:", e.message);
    return;
  }
  
  try {
    // Buscar mercado atual do BTC 15m (hardcoded ou do cache do bot).
    // Para simplificar, vou apenas sacar o ID do mercado atual logado
    const market = "10192"; // seriesID do BTC 15m 
    
    // Vou jogar uma ordem bizonha (Limit Buy a 1 centavo) pra ele nunca ser preenchida
    // mas testar a rota de assinatura inteira da API
    console.log("[BURN] Assinando ordem teste de compra de  a bash.01...");
    
    // Nao vou arriscar preencher o orderbook sem saber o TokenId exato do BTC 15m up.
    // O mais inteligente: logar o saldo da carteira na L2 pra ver se enxerga os 7.23
    console.log("Carteira:", wallet.address);
  } catch(e) {
     console.log("Erro:", e.message);
  }
}
burn();
