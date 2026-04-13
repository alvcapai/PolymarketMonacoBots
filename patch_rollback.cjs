const fs = require("fs");
const file = "src/trade/executor.js";
let code = fs.readFileSync(file, "utf8");

// Restaura a lógica original do getApiCreds (exigindo as chaves do .env)
code = code.replace(
  /return \(key && secret && passphrase\) \? \{ key, secret, passphrase \} : undefined;/,
  "if (!key || !secret || !passphrase) {\n    throw new Error(\"Missing Polymarket L2 API credentials in .env\");\n  }\n\n  return { key, secret, passphrase };"
);

// Remove a funca maluca initClobClient que criava chaves on-the-fly e falhava 400 Bad Request
const originalGetClobClient = `
export function getClobClient() {
  if (clobClientInstance) return clobClientInstance;

  const wallet = new Wallet(normalizePrivateKey(process.env.PK));
  const creds = getApiCreds();

  clobClientInstance = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
  return clobClientInstance;
}
`;

code = code.replace(/export async function initClobClient\(\) \{[\s\S]*?return clobClientInstance;\n\}/, originalGetClobClient);
code = code.replace(/const clobClient = await initClobClient\(\);/, "const clobClient = getClobClient();");

fs.writeFileSync(file, code);
