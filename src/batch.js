#!/usr/bin/env node
/**
 * batch.js
 * Dry-run the parser against all PDFs in invoices/raw/ and print a summary.
 *
 * Usage:
 *   node src/batch.js                  # dry-run all PDFs in invoices/raw/
 *   node src/batch.js path/to/folder   # dry-run all PDFs in a custom folder
 *   node src/batch.js --save           # parse and save (no dry-run) — use carefully
 */

const fs = require("fs");
const path = require("path");

async function runOne(pdfPath, save) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const args = [path.join(__dirname, "parser.js"), pdfPath];
    if (!save) args.push("--dry-run");

    execFile("node", args, { cwd: path.join(__dirname, "..") }, (err, stdout, stderr) => {
      const output = stdout + stderr;

      // Extract key summary lines
      const vendor   = output.match(/Vendor detected:\s+(.+)/)?.[1]?.trim() || "unknown";
      const invoice  = output.match(/Invoice #:\s+(.+)/)?.[1]?.trim() || "?";
      const items    = output.match(/Line items:\s+(\d+)/)?.[1] || "0";
      const total    = output.match(/Total:\s+\$([\d,.]+)/)?.[1] || "0.00";
      const verified = output.includes("✓ verified")  ? "✓" :
                       output.includes("✗ MISMATCH")  ? "✗ MISMATCH" :
                       output.includes("not found")   ? "?" : "?";
      const errMsg   = err ? "FAILED" : null;

      resolve({ pdfPath, vendor, invoice, items, total, verified, errMsg, fullOutput: output });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const folderArg = args.find(a => !a.startsWith("--"));
  const folder = folderArg
    ? path.resolve(folderArg)
    : path.join(__dirname, "../invoices/raw");

  if (!fs.existsSync(folder)) {
    console.error(`Folder not found: ${folder}`);
    process.exit(1);
  }

  const pdfs = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .map(f => path.join(folder, f));

  if (pdfs.length === 0) {
    console.log(`No PDFs found in ${folder}`);
    console.log("Drop invoice PDFs into invoices/raw/ and re-run.");
    process.exit(0);
  }

  console.log(`\nInvoiceIngest batch ${save ? "parse" : "dry-run"} — ${pdfs.length} file${pdfs.length > 1 ? "s" : ""}\n`);

  const results = [];
  for (const pdf of pdfs) {
    process.stdout.write(`  Processing ${path.basename(pdf)}...`);
    const result = await runOne(pdf, save);
    process.stdout.write(` ${result.verified}\n`);
    results.push(result);
  }

  // Summary table
  const col = (s, n) => String(s).padEnd(n);
  console.log("\n" + "─".repeat(80));
  console.log(
    col("File", 28) +
    col("Invoice #", 16) +
    col("Items", 7) +
    col("Total", 12) +
    "Status"
  );
  console.log("─".repeat(80));

  let allGood = true;
  for (const r of results) {
    const file = path.basename(r.pdfPath).slice(0, 26);
    const status = r.errMsg ? `ERROR: ${r.errMsg}` : r.verified;
    if (r.verified !== "✓" || r.errMsg) allGood = false;
    console.log(
      col(file, 28) +
      col(r.invoice, 16) +
      col(r.items, 7) +
      col("$" + r.total, 12) +
      status
    );
  }

  console.log("─".repeat(80));

  const passed = results.filter(r => r.verified === "✓").length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed  ${failed > 0 ? failed + " need review" : ""}`);

  if (failed > 0) {
    console.log("\nFailed invoices — full output:\n");
    for (const r of results.filter(r => r.verified !== "✓")) {
      console.log(`\n=== ${path.basename(r.pdfPath)} ===`);
      console.log(r.fullOutput.split("\n").slice(0, 15).join("\n"));
    }
  }

  if (!save) {
    console.log("\nTo save all passing bills: node src/batch.js --save");
  }
}

main().catch(console.error);
