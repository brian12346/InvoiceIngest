/**
 * parser-lib.js
 * Shared parsing functions used by both parser.js (CLI) and server.js (API).
 */

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Vendor config
// ---------------------------------------------------------------------------

function loadVendorConfigs() {
  const dir = path.join(__dirname, "../vendors");
  return fs.readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function detectVendor(text, configs) {
  for (const c of configs) {
    const kws = c.detection?.keywords || [];
    if (kws.some(kw => text.toUpperCase().includes(kw.toUpperCase()))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function extractField(text, label, type = "string") {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`${esc}\\s*[:\\-]?\\s*([^\\n]+)`, "i"));
  if (!m) return null;
  const raw = m[1].trim();
  if (type === "date")   return parseDate(raw);
  if (type === "number") return parseFloat(raw.replace(/[^0-9.]/g, ""));
  return raw;
}

function parseDate(str) {
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  return str;
}

function parseDueDate(invoiceDate, terms, mapping) {
  const cfg = mapping?.[terms];
  if (!cfg) return null;
  const d = new Date(invoiceDate);
  d.setDate(d.getDate() + cfg.daysUntilDue);
  return d.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Line item parser
//
// pdf-parse renders each Wilson invoice row as a single line:
//   "   288   0 EAWRZ4005GR   3.05   878.40\nPRO OVERGRIP...\n"
// ---------------------------------------------------------------------------

function parseLineItems(text, lineConfig, defaultAccount) {
  const allItems = [];
  const lines = text.split("\n");

  const skuPrefix = lineConfig?.skuPrefix || "WR";
  const descPattern = lineConfig?.descriptionLine?.pattern
    ? new RegExp(lineConfig.descriptionLine.pattern, "i") : null;
  const groups   = lineConfig?.descriptionLine?.groups || ["model", "colorway", "size"];
  const descTmpl = lineConfig?.quickbooksDescription || "{model} {colorway} sz {size}";

  const rowRegex = new RegExp(
    `^\\s*(\\d[\\d,]*)\\s+(\\d+)\\s+EA\\s*(${skuPrefix}\\S+?)\\s+([\\d.]+)\\s+([\\d,]+\\.\\d+)\\s*$`
  );

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rowRegex);
    if (!m) continue;

    const [, qtyRaw, backRaw, sku, unitRaw, extRaw] = m;
    const qty          = parseInt(qtyRaw.replace(/,/g, ""));
    const backorder    = parseInt(backRaw);
    const unitPrice    = parseFloat(unitRaw);
    const extendedPrice = parseFloat(extRaw.replace(/,/g, ""));

    let description = sku;
    const parsedGroups = {};

    if (i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next.length > 0 && !next.match(/^\d/) && !next.match(/^(EA|UPS|Page|Tracking)/i)) {
        if (descPattern) {
          const dm = next.match(descPattern);
          if (dm) {
            groups.forEach((g, idx) => { parsedGroups[g] = dm[idx + 1] || ""; });
            description = descTmpl.replace(/\{(\w+)\}/g, (_, k) => parsedGroups[k] || "");
          } else {
            description = next;
          }
        } else {
          description = next;
        }
        i++;
      }
    }

    allItems.push({
      account: defaultAccount,
      description,
      sku,
      qtyShipped:     qty,
      qtyBackordered: backorder,
      unitPrice,
      extendedPrice,
      ...parsedGroups,
    });
  }

  return allItems;
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

function parseShipping(text, cfg) {
  const { freeFreightKeywords = [], defaultCost = 0 } = cfg || {};
  if (freeFreightKeywords.some(kw => text.toUpperCase().includes(kw.toUpperCase()))) {
    return { cost: 0, note: "Free freight per invoice" };
  }
  const m = text.match(/FREIGHT\s+\$?([\d,]+\.\d{2})/i);
  if (m) return { cost: parseFloat(m[1].replace(/,/g,"")), note: "Parsed from invoice" };
  return { cost: defaultCost, note: "Default" };
}

// ---------------------------------------------------------------------------
// Invoice total
// ---------------------------------------------------------------------------

function extractInvoiceTotal(text) {
  const norm = text.replace(/  +/g, " ");
  const m = norm.match(/\bTOTAL\s+([\d,]+\.\d{2})/i);
  return m ? parseFloat(m[1].replace(/,/g,"")) : null;
}

// ---------------------------------------------------------------------------
// Bill assembler
// ---------------------------------------------------------------------------

function assembleBill(invoiceText, config) {
  const header = {};
  for (const [key, def] of Object.entries(config.headerFields || {})) {
    header[key] = extractField(invoiceText, def.label, def.type);
  }

  const terms     = header.terms?.trim() || "";
  const dueDate   = parseDueDate(header.date, terms, config.termsMapping);
  const shipping  = parseShipping(invoiceText, config.shipping);
  const lineItems = parseLineItems(invoiceText, config.lineItems, config.defaultAccount);
  const merch     = Math.round(lineItems.reduce((s, l) => s + l.extendedPrice, 0) * 100) / 100;

  const stated   = extractInvoiceTotal(invoiceText);
  const total    = Math.round((merch + shipping.cost) * 100) / 100;
  const verified = stated !== null ? Math.abs(total - stated) < 0.02 : null;

  return {
    _meta: {
      vendorId: config.vendorId,
      parsedAt: new Date().toISOString(),
      status:   "pending",
      totalVerified:       verified,
      invoiceStatedTotal:  stated ?? null,
    },
    vendor:        config.quickbooksVendorName,
    invoiceNumber: header.invoiceNumber,
    billDate:      header.date,
    dueDate:       dueDate ?? null,
    terms,
    purchaseOrder: header.purchaseOrder,
    memo:          header.purchaseOrder || "",
    lineItems,
    shipping,
    totals: { merchandise: merch, shipping: shipping.cost, prepayDiscount: 0, total },
    accounts: {
      merchandise: config.defaultAccount,
      shipping:    config.shippingAccount,
      discount:    config.discountAccount,
    },
    notes: config.notes || "",
  };
}

module.exports = {
  loadVendorConfigs,
  detectVendor,
  assembleBill,
  parseLineItems,
  parseShipping,
  extractInvoiceTotal,
  extractField,
  parseDate,
};
