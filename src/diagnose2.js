/**
 * diagnose2.js — dumps raw pdf-parse text for first 3 invoices
 * Usage: node src/diagnose2.js /path/to/folder
 */
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");

async function main() {
  const folder = process.argv[2] || "invoices/raw";
  const pdfs = fs.readdirSync(folder)
    .filter(f => /\.(pdf|PDF)$/.test(f))
    .sort()
    .slice(0, 3)  // first 3 only
    .map(f => path.join(folder, f));

  for (const pdf of pdfs) {
    const buf = fs.readFileSync(pdf);
    const data = await pdfParse(buf);
    const text = data.text;
    
    console.log("\n" + "=".repeat(60));
    console.log("FILE:", path.basename(pdf));
    
    // Find first WR occurrence
    const idx = text.indexOf("WR");
    if (idx === -1) {
      console.log("NO WR FOUND — first 500 chars:");
      console.log(JSON.stringify(text.slice(0, 500)));
    } else {
      console.log("WR found at pos", idx, "— 600 chars around it:");
      console.log(JSON.stringify(text.slice(Math.max(0, idx-200), idx+400)));
    }
    
    // Also show what "Extended Price" looks like
    const epIdx = text.indexOf("Extended");
    if (epIdx !== -1) {
      console.log("\nExtended Price context:");
      console.log(JSON.stringify(text.slice(epIdx, epIdx+100)));
    }
  }
}

main().catch(console.error);
