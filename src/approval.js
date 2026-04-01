/**
 * approval.js
 * Approval workflow for InvoiceIngest bills.
 *
 * Usage:
 *   node src/approval.js bills/pending/<invoice>.json
 *   node src/approval.js bills/pending/<invoice>.json --shipping 45.00
 *   node src/approval.js bills/pending/<invoice>.json --prepay 2 --prepay-date 2026-02-15
 *   node src/approval.js bills/pending/<invoice>.json --reject "needs credit memo first"
 */

const fs = require("fs");
const path = require("path");

function main() {
  const args = process.argv.slice(2);
  const billPath = args[0];

  if (!billPath || !fs.existsSync(billPath)) {
    console.error("Usage: node src/approval.js bills/pending/<invoice>.json [options]");
    console.error("\nOptions:");
    console.error("  --shipping <amount>        Override shipping cost");
    console.error("  --prepay <pct>             Apply prepayment discount %");
    console.error("  --prepay-date <YYYY-MM-DD> Pay-by date for prepay discount");
    console.error("  --reject <reason>          Reject bill with reason");
    process.exit(1);
  }

  const bill = JSON.parse(fs.readFileSync(billPath, "utf8"));
  const rejected = getArg(args, "--reject");

  // --- Rejection ---
  if (rejected) {
    bill._meta.status = "rejected";
    bill._meta.rejectedAt = new Date().toISOString();
    bill._meta.rejectionReason = rejected;
    fs.writeFileSync(billPath, JSON.stringify(bill, null, 2));
    console.log(`Bill ${bill.invoiceNumber} rejected: ${rejected}`);
    return;
  }

  // --- Apply overrides ---
  const shippingOverride = getArg(args, "--shipping");
  if (shippingOverride !== null) {
    const cost = parseFloat(shippingOverride);
    bill.shipping = { cost, note: "Manual override at approval" };
    bill.totals.shipping = cost;
  }

  const prepayPct = getArg(args, "--prepay");
  const prepayDate = getArg(args, "--prepay-date");
  if (prepayPct !== null) {
    const pct = parseFloat(prepayPct);
    const discount = Math.round(bill.totals.merchandise * pct / 100 * 100) / 100;
    bill.totals.prepayDiscount = discount;
    bill._meta.prepayDate = prepayDate || null;
    bill._meta.prepayPct = pct;
    console.log(`Prepay discount applied: ${pct}% = $${discount.toFixed(2)}`);
  }

  // Recalculate total
  bill.totals.total = Math.round(
    (bill.totals.merchandise + bill.totals.shipping - bill.totals.prepayDiscount) * 100
  ) / 100;

  // --- Approve ---
  bill._meta.status = "approved";
  bill._meta.approvedAt = new Date().toISOString();

  // Move to approved/
  const approvedDir = path.join(__dirname, "../bills/approved");
  fs.mkdirSync(approvedDir, { recursive: true });
  const outPath = path.join(approvedDir, path.basename(billPath));
  fs.writeFileSync(outPath, JSON.stringify(bill, null, 2));
  fs.unlinkSync(billPath);

  console.log(`\nBill approved: ${bill.invoiceNumber}`);
  console.log(`Vendor: ${bill.vendor}`);
  console.log(`Total: $${bill.totals.total.toFixed(2)}`);
  console.log(`Due: ${bill.dueDate}`);
  console.log(`\nSaved to: bills/approved/${path.basename(billPath)}`);
  console.log(`\nNext: node src/quickbooks.js bills/approved/${path.basename(billPath)}`);
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

main();
