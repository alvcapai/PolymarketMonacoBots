const fs = require("fs");
const file = "src/index.js";
let code = fs.readFileSync(file, "utf8");

// Decrease threshold from 90 to 75
code = code.replace(/const isExtreme = \(pLongPct >= 90 \|\| pShortPct >= 90\);/g, "const isExtreme = (pLongPct >= 75 || pShortPct >= 75);");
code = code.replace(/const extremeLong = pLongPct >= 90;/g, "const extremeLong = pLongPct >= 75;");

fs.writeFileSync(file, code);
