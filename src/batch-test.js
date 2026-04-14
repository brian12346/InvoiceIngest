/**
 * batch-test.js — tests parser against all PDFs in a folder
 * Usage: node src/batch-test.js [folder]   (default: invoices/raw)
 */
const fs      = require("fs");
const path    = require("path");
const pdfParse = require("pdf-parse");

function toFloat(s) { return parseFloat(String(s).replace(/,/g,"")); }

function parseLineItems(text) {
  const items = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d[\d,]*)\s+(\d+)\s+EA\s*(WR\S+?)\s+([\d.]+)\s+([\d,]+\.\d+)\s*$/);
    if (!m) continue;
    const ext = toFloat(m[5]);
    items.push({ sku: m[3], qty: parseInt(m[1].replace(/,/g,"")), unit: parseFloat(m[4]), ext });
    // skip description line
    if (i+1 < lines.length) {
      const nxt = lines[i+1].trim();
      if (nxt && !nxt.match(/^\d/) && !nxt.match(/^(EA|UPS|Page|Tracking)/i)) i++;
    }
  }
  return items;
}

function extractTotal(text) {
  const norm = text.replace(/  +/g, " ");
  const m = norm.match(/\bTOTAL\s+([\d,]+\.\d{2})/i);
  return m ? toFloat(m[1]) : null;
}

async function main() {
  const folder = process.argv[2] || path.join(__dirname, "../invoices/raw");
  const pdfs = fs.readdirSync(folder)
    .filter(f => /\.(pdf|PDF)$/.test(f))
    .sort()
    .map(f => path.join(folder, f));

  if (!pdfs.length) { console.log("No PDFs found in", folder); return; }

  console.log(`\nBatch test — ${pdfs.length} invoices\n`);

  let passed = 0, failed = 0;
  const failures = [];

  for (const pdf of pdfs) {
    const name = path.basename(pdf);
    try {
      const data  = await pdfParse(fs.readFileSync(pdf));
      const items = parseLineItems(data.text);
      const stated= extractTotal(data.text);
      const parsed= Math.round(items.reduce((s,i)=>s+i.ext,0)*100)/100;
      const gap   = stated != null ? Math.abs(parsed - stated) : null;
      const ok    = gap != null && gap < 0.02;

      if (ok) {
        passed++;
        console.log(`  ✓  ${name.padEnd(52)} ${items.length} items  $${parsed.toFixed(2)}`);
      } else {
        failed++;
        const status = gap != null ? `gap=$${gap.toFixed(2)}` : "NO TOTAL";
        console.log(`  ✗  ${name.padEnd(52)} ${items.length} items  parsed=$${parsed.toFixed(2)}  stated=$${(stated||0).toFixed(2)}  ${status}`);
        failures.push({ name, items: items.length, parsed, stated, gap });
      }
    } catch (e) {
      failed++;
      console.log(`  ✗  ${name.padEnd(52)} ERROR: ${e.message}`);
      failures.push({ name, items: 0, parsed: 0, stated: 0, gap: 0 });
    }
  }

  console.log(`\n${"─".repeat(75)}`);
  console.log(`Passed: ${passed}/${pdfs.length}   Failed: ${failed}`);
  if (failures.length) {
    console.log(`\nFailed:`);
    failures.forEach(f =>
      console.log(`  ${f.name}: ${f.items} items, gap=$${(f.gap||0).toFixed(2)}`));
  }
}

main().catch(console.error);
