/**
 * journals.js — Read and inspect saved journal entries
 *
 * Usage:
 *   node src/journals.js                  # list all journal entries
 *   node src/journals.js <filename>       # show a specific entry
 *   node src/journals.js --failed         # show only failed submissions
 */

const fs   = require("fs");
const path = require("path");

const JOURNALS_DIR = path.join(__dirname, "../journals");

function fmt(n) { return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtDate(s) { return s ? s.slice(0,10) : "—"; }

function listAll(filterStatus) {
  if (!fs.existsSync(JOURNALS_DIR)) {
    console.log("No journals directory found — no bills submitted yet.");
    return;
  }

  const files = fs.readdirSync(JOURNALS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort().reverse();

  if (!files.length) {
    console.log("No journal entries yet.");
    return;
  }

  const entries = files.map(f => {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(JOURNALS_DIR, f), "utf8"));
      return { file: f, ...e };
    } catch(_) { return { file: f, status: "unreadable" }; }
  }).filter(e => !filterStatus || e.status === filterStatus);

  console.log(`\nJournal entries (${entries.length})\n`);
  console.log(
    "File".padEnd(45) +
    "Invoice #".padEnd(16) +
    "Vendor".padEnd(26) +
    "Total".padEnd(12) +
    "Status".padEnd(12) +
    "QBO Bill ID"
  );
  console.log("─".repeat(120));

  entries.forEach(e => {
    const inv   = e.bill?.invoiceNumber || "—";
    const vendor= (e.bill?.vendor || "—").slice(0, 24);
    const total = e.bill?.totals?.total != null ? fmt(e.bill.totals.total) : "—";
    const qboId = e.qboBillId || (e.status === "failed" ? `ERROR: ${(e.error||"").slice(0,30)}` : "—");
    console.log(
      e.file.padEnd(45) +
      inv.padEnd(16) +
      vendor.padEnd(26) +
      total.padEnd(12) +
      (e.status || "—").padEnd(12) +
      qboId
    );
  });
  console.log();
}

function showEntry(filename) {
  const filepath = fs.existsSync(filename)
    ? filename
    : path.join(JOURNALS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    console.error(`File not found: ${filepath}`);
    process.exit(1);
  }

  const e = JSON.parse(fs.readFileSync(filepath, "utf8"));

  console.log(`\nJournal Entry: ${path.basename(filepath)}`);
  console.log("─".repeat(60));
  console.log(`Submitted:     ${e.submittedAt}`);
  console.log(`Status:        ${e.status}`);
  console.log(`Invoice #:     ${e.bill?.invoiceNumber || "—"}`);
  console.log(`Vendor:        ${e.bill?.vendor || "—"}`);
  console.log(`Bill date:     ${fmtDate(e.bill?.billDate)}`);
  console.log(`Due date:      ${fmtDate(e.bill?.dueDate)}`);
  console.log(`Total:         ${fmt(e.bill?.totals?.total || 0)}`);
  console.log(`QBO Bill ID:   ${e.qboBillId || "—"}`);
  console.log(`Attached PDF:  ${e.attachedFilename || "—"}`);

  if (e.status === "failed") {
    console.log(`\nError: ${e.error}`);
  }

  console.log(`\nQBO Payload (${e.qboPayload?.Line?.length || 0} lines):`);
  console.log(JSON.stringify(e.qboPayload, null, 2));

  if (e.paymentPlan?.length) {
    console.log(`\nPayment Plan:`);
    e.paymentPlan.forEach(p => {
      console.log(`  ${p.cardId.padEnd(15)} ${(p.proposedDate||"").padEnd(12)} $${p.amount}`);
    });
  }

  if (e.qboResponse) {
    console.log(`\nQBO Response:`);
    console.log(JSON.stringify(e.qboResponse, null, 2));
  }
  console.log();
}

const args = process.argv.slice(2);
if (args.includes("--failed")) listAll("failed");
else if (args[0] && !args[0].startsWith("--")) showEntry(args[0]);
else listAll();
