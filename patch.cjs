const fs = require("fs");
const file = "src/trade/executor.js";
let code = fs.readFileSync(file, "utf8");

const injection = `
  if (TRADE_MOCK_MODE) {
    const { appendFileSync } = require("fs");
    const record = { ts: Date.now(), tokenId, side: \BUY\, usdcSize, shareSize, price: limitPrice, prob: probabilityPct };
    appendFileSync("mock_trades.jsonl", JSON.stringify(record) + "\\n");
    
    return {
      success: true,
      mock: true,
      tokenId,
      side: \BUY\,
      usdcSize,
      shareSize,
      price: limitPrice,
      probability: probabilityPct
    };
  }
`;

code = code.replace(/if \(TRADE_MOCK_MODE\) \{[\s\S]*?return \{[\s\S]*?\};\n  \}/m, injection.trim());
fs.writeFileSync(file, code);
