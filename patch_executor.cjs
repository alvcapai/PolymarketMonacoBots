const fs = require("fs");
const file = "src/trade/executor.js";
let code = fs.readFileSync(file, "utf8");

// Remove a exigencia das 3 chaves de API do arquivo .env
code = code.replace(/if \(!key \|\| !secret \|\| !passphrase\) \{[\s\S]*?throw new Error\("Missing Polymarket L2 API credentials in .env"\);\n  \}/, "");
// Modifica o getApiCreds pra só retornar caso as vars existam ou fallback undefined
code = code.replace(/return \{ key, secret, passphrase \};/, "return (key && secret && passphrase) ? { key, secret, passphrase } : undefined;");

// Se nao tiver creds, usa a assinatura L2 (CreateApiKey)
const initLogic = `
export async function initClobClient() {
  if (clobClientInstance) return clobClientInstance;
  const wallet = new Wallet(normalizePrivateKey(process.env.PK));
  const creds = getApiCreds();
  
  clobClientInstance = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
  
  if (!creds) {
    try {
      console.log(\"[INIT] Gerando/Derivando L2 API Credentials via Wallet Signature...\");
      await clobClientInstance.createApiKey();
      console.log(\"[INIT] Credenciais L2 geradas com sucesso!\");
    } catch (e) {
      console.log(\"[ERRO INIT] Nao foi possivel derivar a L2 Key:\", e.message);
    }
  }
  return clobClientInstance;
}
`;

code = code.replace(/export function getClobClient\(\) \{[\s\S]*?return clobClientInstance;\n\}/, initLogic);
code = code.replace(/const clobClient = getClobClient\(\);/, "const clobClient = await initClobClient();");

fs.writeFileSync(file, code);
