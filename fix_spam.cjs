const fs = require("fs");
const file = "src/index.js";
let code = fs.readFileSync(file, "utf8");

if (!code.includes("tradedTokens.has(targetTokenId)")) {
  code = code.replace(
    /import \{ executeTrade \} from ".\/trade\/executor.js";/,
    "import { executeTrade } from \"./trade/executor.js\";\nconst tradedTokens = new Set();"
  );
  
  code = code.replace(
    /if \(targetTokenId && Number\.isFinite\(Number\(targetPrice\)\)/g,
    "if (targetTokenId && !tradedTokens.has(targetTokenId) && Number.isFinite(Number(targetPrice))"
  );
  
  code = code.replace(
    /await executeTrade\(/g,
    "tradedTokens.add(targetTokenId);\n            await executeTrade("
  );
  
  fs.writeFileSync(file, code);
  console.log("Spam limit fixed.");
} else {
  console.log("Already fixed.");
}
