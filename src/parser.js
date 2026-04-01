/**
 * parser.js
 * Core invoice parsing engine for InvoiceIngest.
 *
 * Usage:
 *   node src/parser.js invoices/raw/<filename>.pdf
 *   node src/parser.js invoices/raw/<filename>.pdf --dry-run
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Vendor config loader
// ---------------------------------------------------------------------------

function loadVendorConfigs() {
  const vendorDir = path.join(__dirname, "../vendors");
  const files = fs.readdirSync(vendorDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(vendorDir, f), "utf8")));
}

function detectVendor(text, configs) {
  for (const config of configs) {
    const keywords = config.detection?.keywords || [];
    if (keywords.some((kw) => text.toUpperCase().includes(kw.toUpperCase()))) {
      return config;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

function extractField(text, label, type = "string") {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*[:\\-]?\\s*([^\\n]+)`, "i");
  const match = text.match(regex);
  if (!match) return null;
  const raw = match[1].trim();
  if (type === "date") return parseDate(raw);
  if (type === "number") return parseFloat(raw.replace(/[^0-9.]/g, ""));
  return raw;
}

function parseDate(str) {
  // Handles MM/DD/YYYY and YYYY-MM-DD
  const mdy = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  const ymd = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return str;
  return str;
}

function parseDueDate(invoiceDate, termsStr, termsMapping) {
  const config = termsMapping?.[termsStr];
  if (!config) return null;
  const d = new Date(invoiceDate);
  d.setDate(d.getDate() + config.daysUntilDue);
  return d.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Line item parser
// ---------------------------------------------------------------------------

function parseLineItems(text, lineConfig, defaultAccount) {
  const lines = text.split("\n");
  const items = [];

  // Pattern: qty  backorder  UOM  SKU  unitPrice  extendedPrice
  // followed by a description line like "RUSH LITE 5 White/Black/R 8"
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+EA\s+(WRS\S+)\s+([\d.]+)\s+([\d.]+)/;
  const descPattern = new RegExp(
    lineConfig.descriptionLine?.pattern || "^(.+)$",
    "i"
  );
  const groups = lineConfig.descriptionLine?.groups || ["description"];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(rowPattern);
    if (!match) continue;

    const [, qtyShipped, qtyBack, sku, unitPrice, extPrice] = match;
    let description = sku;
    let parsedGroups = {};

    // Look ahead for description line
    if (i + 1 < lines.length) {
      const descLine = lines[i + 1].trim();
      const descMatch = descLine.match(descPattern);
      if (descMatch) {
        groups.forEach((g, idx) => {
          parsedGroups[g] = descMatch[idx + 1] || "";
        });
        const template = lineConfig.quickbooksDescription || "{model} {colorway} sz {size}";
        description = template.replace(/\{(\w+)\}/g, (_, k) => parsedGroups[k] || "");
        i++; // consume description line
      }
    }

    items.push({
      account: defaultAccount,
      description,
      sku,
      qtyShipped: parseInt(qtyShipped),
      qtyBackordered: parseInt(qtyBack),
      unitPrice: parseFloat(unitPrice),
      extendedPrice: parseFloat(extPrice),
      ...parsedGroups,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Shipping detector
// ---------------------------------------------------------------------------

function parseShipping(text, shippingConfig) {
  const { freeFreightKeywords = [], defaultCost = 0 } = shippingConfig || {};
  const upper = text.toUpperCase();
  if (freeFreightKeywords.some((kw) => upper.includes(kw.toUpperCase()))) {
    return { cost: 0, note: "Free freight per invoice" };
  }
  // Try to extract a numeric freight amount
  const match = text.match(/FREIGHT\s+\$?([\d,]+\.\d{2})/i);
  if (match) return { cost: parseFloat(match[1].replace(",", "")), note: "Parsed from invoice" };
  return { cost: defaultCost, note: "Default" };
}

// ---------------------------------------------------------------------------
// Bill assembler
// ---------------------------------------------------------------------------

function assembleBill(invoiceText, config) {
  const header = {};
  for (const [fieldKey, fieldDef] of Object.entries(config.headerFields || {})) {
    header[fieldKey] = extractField(invoiceText, fieldDef.label, fieldDef.type);
  }

  const terms = header.terms?.trim() || "";
  const dueDate = parseDueDate(header.date, terms, config.termsMapping);
  const shipping = parseShipping(invoiceText, config.shipping);
  const lineItems = parseLineItems(invoiceText, config.lineItems, config.defaultAccount);
  const merchandise = lineItems.reduce((s, l) => s + l.extendedPrice, 0);

  const bill = {
    _meta: {
      vendorId: config.vendorId,
      parsedAt: new Date().toISOString(),
      status: "pending",
    },
    vendor: config.quickbooksVendorName,
    invoiceNumber: header.invoiceNumber,
    billDate: header.date,
    dueDate: dueDate || null,
    terms,
    purchaseOrder: header.purchaseOrder,
    memo: header.purchaseOrder || "",
    lineItems,
    shipping,
    totals: {
      merchandise: Math.round(merchandise * 100) / 100,
      shipping: shipping.cost,
      prepayDiscount: 0,
      total: Math.round((merchandise + shipping.cost) * 100) / 100,
    },
    accounts: {
      merchandise: config.defaultAccount,
      shipping: config.shippingAccount,
      discount: config.discountAccount,
    },
    notes: config.notes || "",
  };

  return bill;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const pdfPath = args[0];
  const dryRun = args.includes("--dry-run");

  if (!pdfPath) {
    console.error("Usage: node src/parser.js invoices/raw/<filename>.pdf [--dry-run]");
    process.exit(1);
  }

  if (!fs.existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(1);
  }

  console.log(`\nInvoiceIngest — parsing ${path.basename(pdfPath)}\n`);

  // Extract text from PDF using pdf-parse
  let pdfText;
  try {
    const pdfParse = require("pdf-parse");
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    pdfText = data.text;
  } catch (err) {
    console.error("PDF parsing failed:", err.message);
    console.error("Run: npm install");
    process.exit(1);
  }

  // Detect vendor
  const configs = loadVendorConfigs();
  const config = detectVendor(pdfText, configs);

  if (!config) {
    console.error("No vendor config matched this invoice.");
    console.error("Add a new vendor config in vendors/ — see docs/vendor-config-guide.md");
    process.exit(1);
  }

  console.log(`Vendor detected: ${config.vendorName}`);

  // Build bill
  const bill = assembleBill(pdfText, config);

  console.log(`Invoice #: ${bill.invoiceNumber}`);
  console.log(`Bill date: ${bill.billDate}  Due: ${bill.dueDate}`);
  console.log(`Line items: ${bill.lineItems.length}`);
  console.log(`Merchandise: $${bill.totals.merchandise.toFixed(2)}`);
  console.log(`Shipping: $${bill.totals.shipping.toFixed(2)}`);
  console.log(`Total: $${bill.totals.total.toFixed(2)}`);

  if (dryRun) {
    console.log("\n[Dry run — bill not saved]");
    console.log(JSON.stringify(bill, null, 2));
    return;
  }

  // Save to bills/pending/
  const outDir = path.join(__dirname, "../bills/pending");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${bill.invoiceNumber}.json`);
  fs.writeFileSync(outFile, JSON.stringify(bill, null, 2));
  console.log(`\nBill saved to: bills/pending/${bill.invoiceNumber}.json`);
  console.log("Review and run: node src/approval.js bills/pending/" + bill.invoiceNumber + ".json");

  // Move PDF to processed
  const processedDir = path.join(__dirname, "../invoices/processed");
  fs.mkdirSync(processedDir, { recursive: true });
  fs.renameSync(pdfPath, path.join(processedDir, path.basename(pdfPath)));
  console.log(`PDF moved to: invoices/processed/`);
}

main().catch(console.error);
