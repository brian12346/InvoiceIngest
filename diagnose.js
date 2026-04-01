const pdfParse = require("pdf-parse");
const fs = require("fs");
const data = fs.readFileSync("invoices/raw/4554852904.pdf");

pdfParse(data).then(d => {
  const text = d.text;

  // 1. Show raw text around the first SKU
  const idx = text.indexOf("WRS336360U080");
  console.log("=== 400 chars before first SKU ===");
  console.log(JSON.stringify(text.slice(idx - 400, idx + 200)));

  // 2. How does the page marker look?
  const pageIdx = text.indexOf("Page");
  console.log("\n=== Page marker raw ===");
  console.log(JSON.stringify(text.slice(pageIdx, pageIdx + 40)));

  // 3. How many pages does our split produce?
  const pages = text.split(/Page\s+\d+\s+of[\s\S]{1,5}\d+/);
  console.log("\n=== Page split count:", pages.length, "===");

  // 4. What does qty spacing look like?
  const p1 = pages[1] || pages[0];
  const qtys = [...p1.matchAll(/\s{5,}(\d+)\s*\n\n\s{5,}(\d+)\s*\n\n/g)];
  console.log("=== Qty regex matches on page 1:", qtys.length, "===");

  // 5. Show first 600 chars of page 1 raw
  console.log("\n=== Page 1 first 600 chars ===");
  console.log(JSON.stringify(p1.slice(0, 600)));
});
