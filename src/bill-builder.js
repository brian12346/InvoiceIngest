/**
 * bill-builder.js
 * Maps a parsed InvoiceIngest bill JSON → QuickBooks Online bill format.
 *
 * Usage (standalone):
 *   node src/bill-builder.js bills/pending/<invoice>.json
 *
 * Or import and call toQuickBooksBill(bill) directly.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// QuickBooks bill format
// Reference: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill
// ---------------------------------------------------------------------------

/**
 * Convert an InvoiceIngest bill object to QuickBooks Online bill payload.
 * @param {object} bill  - Parsed bill from parser.js
 * @param {object} opts  - Optional overrides
 * @returns {object}     - QBO-ready Bill payload
 */
function toQuickBooksBill(bill, opts = {}) {
  const lines = [];
  let lineNum = 1;

  // Merchandise line items
  for (const item of bill.lineItems) {
    lines.push({
      Id: String(lineNum++),
      DetailType: "ItemBasedExpenseLineDetail",
      Amount: item.extendedPrice,
      Description: item.description,
      ItemBasedExpenseLineDetail: {
        ItemRef: {
          name: item.description,
          value: item.sku,
        },
        Qty: item.qtyShipped,
        UnitPrice: item.unitPrice,
        AccountBasedExpenseLineDetail: {
          AccountRef: { name: bill.accounts.merchandise },
        },
      },
    });
  }

  // Shipping line (if non-zero)
  if (bill.totals.shipping > 0) {
    lines.push({
      Id: String(lineNum++),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: bill.totals.shipping,
      Description: "Shipping & Freight",
      AccountBasedExpenseLineDetail: {
        AccountRef: { name: bill.accounts.shipping },
      },
    });
  }

  // Prepay discount (if non-zero, as negative line)
  if (bill.totals.prepayDiscount > 0) {
    lines.push({
      Id: String(lineNum++),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: -bill.totals.prepayDiscount,
      Description: "Prepayment discount",
      AccountBasedExpenseLineDetail: {
        AccountRef: { name: bill.accounts.discount },
      },
    });
  }

  const qboBill = {
    VendorRef: { name: bill.vendor },
    APAccountRef: { name: "Accounts Payable (A/P)" },
    TxnDate: bill.billDate,
    DueDate: bill.dueDate,
    DocNumber: bill.invoiceNumber,
    PrivateNote: bill.notes || "",
    Memo: bill.memo || bill.purchaseOrder || "",
    TotalAmt: bill.totals.total,
    Line: lines,
  };

  return qboBill;
}

// ---------------------------------------------------------------------------
// Group line items (optional — reduces line count in QuickBooks)
// ---------------------------------------------------------------------------

/**
 * Collapse individual size/SKU lines into model-level summary lines.
 * Useful when QuickBooks bill line limits are a concern.
 */
function groupLinesByModel(lineItems) {
  const groups = {};
  for (const item of lineItems) {
    const key = item.model || item.description;
    if (!groups[key]) {
      groups[key] = { ...item, qtyShipped: 0, extendedPrice: 0, skus: [] };
    }
    groups[key].qtyShipped += item.qtyShipped;
    groups[key].extendedPrice += item.extendedPrice;
    groups[key].skus.push(item.sku);
  }
  return Object.values(groups).map((g) => ({
    ...g,
    description: g.model || g.description,
    sku: g.skus.join(", "),
    unitPrice: null,
  }));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const billPath = args[0];
  const grouped = args.includes("--group");

  if (!billPath) {
    console.error("Usage: node src/bill-builder.js bills/pending/<invoice>.json [--group]");
    process.exit(1);
  }

  const bill = JSON.parse(fs.readFileSync(billPath, "utf8"));

  if (grouped) {
    bill.lineItems = groupLinesByModel(bill.lineItems);
    console.log(`Grouped to ${bill.lineItems.length} model-level lines`);
  }

  const qboBill = toQuickBooksBill(bill);

  const outPath = billPath.replace(".json", ".qbo.json");
  fs.writeFileSync(outPath, JSON.stringify(qboBill, null, 2));
  console.log(`QuickBooks bill written to: ${outPath}`);
  console.log(`Total: $${bill.totals.total.toFixed(2)}  Lines: ${qboBill.Line.length}`);
}

module.exports = { toQuickBooksBill, groupLinesByModel };

if (require.main === module) main();
