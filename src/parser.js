/**
 * parser-lib.js
 * Coordinate-based PDF parser for Wilson Sporting Goods invoices.
 *
 * Wilson invoices are multi-column PDFs. pdfminer.six's simple text extraction
 * reads columns as vertical strips, mangling the row structure. This parser
 * uses layout analysis to get exact x,y coordinates and reconstructs rows by
 * grouping elements at the same y-position.
 *
 * Column X boundaries (points, confirmed from 4554852904.pdf):
 *   x 0–60:    Qty Shipped
 *   x 60–160:  Qty Backordered
 *   x 160–230: UOM (EA)
 *   x 230–390: Stock Number (SKU)
 *   x 210–390: Description (slightly left of SKU, separate y-row ~9pt below)
 *   x 370–465: Unit Price
 *   x 465–570: Extended Price
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Vendor config
// ---------------------------------------------------------------------------

function loadVendorConfigs() {
  const dir = path.join(__dirname, "../vendors");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
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
// Coordinate-based PDF layout extractor (calls pdfminer via Python subprocess)
// Returns Array<Array<{text, x0, y0}>> — one inner array per page
// ---------------------------------------------------------------------------

const PYTHON_LAYOUT_SCRIPT = `
from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTTextBox, LTTextLine
import json, sys

pdf_path = sys.argv[1]
out_path = sys.argv[2]

laparams = LAParams(line_overlap=0.5, char_margin=2.0, line_margin=0.5, word_margin=0.1)
pages = []
for page_layout in extract_pages(pdf_path, laparams=laparams):
    elements = []
    for element in page_layout:
        if isinstance(element, LTTextBox):
            for line in element:
                if isinstance(line, LTTextLine):
                    txt = line.get_text().strip()
                    if txt:
                        elements.append({
                            'text': txt,
                            'x0': round(line.x0, 1),
                            'y0': round(line.y0, 1)
                        })
    pages.append(elements)

json.dump(pages, open(out_path, 'w'))
`;

function extractLayout(pdfBuffer) {
  const tag     = Date.now();
  const inFile  = path.join(os.tmpdir(), `inv_${tag}.pdf`);
  const outFile = path.join(os.tmpdir(), `inv_${tag}.json`);
  const pyFile  = path.join(os.tmpdir(), `inv_${tag}.py`);
  try {
    fs.writeFileSync(inFile,  pdfBuffer);
    fs.writeFileSync(pyFile,  PYTHON_LAYOUT_SCRIPT);
    execSync(`python3 "${pyFile}" "${inFile}" "${outFile}"`, { timeout: 60000 });
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  } finally {
    [inFile, outFile, pyFile].forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
  }
}

function extractRawText(pdfBuffer) {
  // Fast text extraction for vendor detection (no coordinate overhead)
  const pages = extractLayout(pdfBuffer);
  return pages.flat().map(e => e.text).join("\n");
}

// ---------------------------------------------------------------------------
// Wilson invoice line item parser (coordinate-based)
// ---------------------------------------------------------------------------

function parseWilsonLineItems(pages, config) {
  const colConfig = config.lineItems?.columnBounds || {};

  const COL = {
    qty_ship: colConfig.qty_ship || [0,    60],
    qty_back: colConfig.qty_back || [60,   160],
    sku:      colConfig.sku      || [230,  390],
    unit:     colConfig.unit     || [370,  465],
    ext:      colConfig.ext      || [465,  570],
    desc:     colConfig.desc     || [210,  390],
  };

  const skuPrefixes = config.detection?.skuPrefix || ["WRS", "WRZ", "WR"];
  const skuRe = new RegExp(
    `^(${skuPrefixes.map(p => p.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")).join("|")})[A-Z0-9]+$`
  );
  const priceRe = /^[\d,]+\.\d{2}$/;
  const intRe   = /^\d+$/;

  function inCol(x, range) { return x >= range[0] && x < range[1]; }

  // Group elements by y-position (snap to 2pt grid, merge within ±4pt)
  function buildRowMap(elements) {
    const rows = new Map();
    for (const e of elements) {
      const yk = Math.round(e.y0 / 2) * 2;
      let matched = null;
      for (const [rk] of rows) {
        if (Math.abs(rk - yk) <= 4) { matched = rk; break; }
      }
      const key = matched !== null ? matched : yk;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(e);
    }
    return rows;
  }

  const allItems = [];

  for (const elements of pages) {
    const rowMap   = buildRowMap(elements);
    const pageItems = [];

    // Process rows top-to-bottom, pick out item rows
    for (const [rowY, row] of [...rowMap.entries()].sort((a, b) => b[0] - a[0])) {
      const item = {};
      for (const e of row) {
        const x = e.x0, t = e.text;
        // Combined qty+backorder: "288                     0" (older invoice format)
        // pdfminer merges the two narrow columns into one text element
        const combinedM = /^(\d[\d,]*)\s{3,}(\d[\d,]*)$/.exec(t);
        if (combinedM && x < 100) {
          item.qty  = parseInt(combinedM[1].replace(/,/g, ""), 10);
          item.back = parseInt(combinedM[2].replace(/,/g, ""), 10);
        } else if (inCol(x, COL.qty_ship) && intRe.test(t)) item.qty  = parseInt(t, 10);
        else if (inCol(x, COL.qty_back) && intRe.test(t))   item.back = parseInt(t, 10);
        else if (skuRe.test(t))                              item.sku  = t;
        else if (inCol(x, COL.unit) && priceRe.test(t))     item.unit = parseFloat(t.replace(/,/g, ""));
        else if (inCol(x, COL.ext) && priceRe.test(t))      item.ext  = parseFloat(t.replace(/,/g, ""));
      }
      if (item.sku && item.unit !== undefined && item.ext !== undefined) {
        item.desc = item.sku;   // placeholder, overridden below
        item.rowY = rowY;
        pageItems.push(item);
      }
    }

    // Attach descriptions — desc row sits ~9pt below the item row
    const descCandidates = elements.filter(e =>
      e.x0 >= COL.desc[0] && e.x0 < COL.desc[1] &&
      !skuRe.test(e.text) &&
      !priceRe.test(e.text) &&
      !intRe.test(e.text) &&
      e.text !== "EA" &&
      e.text.length > 3 &&
      !/^(INVOICE|DATE|PURCHASE|TERMS|SHIP|ACCOUNT|Page|Sales|Delivery|Order|Marked|Carton|From|Shipped|Merchandise|Claims|service|payment)/i.test(e.text)
    );

    for (const de of descCandidates) {
      let best = null, bestDist = 999;
      for (const item of pageItems) {
        const dist = item.rowY - de.y0;   // positive = item row is above desc
        if (dist > 0 && dist < 20 && dist < bestDist) {
          bestDist = dist;
          best     = item;
        }
      }
      if (best) best.desc = de.text;
    }

    allItems.push(...pageItems);
  }

  return allItems.map(item => ({
    account:        config.defaultAccount || "Inventory",
    description:    item.desc,
    sku:            item.sku,
    qtyShipped:     item.qty  || 0,
    qtyBackordered: item.back || 0,
    unitPrice:      item.unit,
    extendedPrice:  item.ext,
  }));
}

// ---------------------------------------------------------------------------
// Header extractor (layout-based, page 1)
// ---------------------------------------------------------------------------

function extractHeaderFromLayout(elements) {
  const header  = {};
  const sorted  = [...elements].sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
  const texts   = sorted.map(e => e.text);
  const dateRe  = /^\d{2}\/\d{2}\/\d{4}$/;
  const invNoRe = /^\d{9,12}$/;

  for (let i = 0; i < texts.length; i++) {
    const t   = texts[i];
    const nxt = texts[i + 1] || "";
    if ((t === "INVOICE #" || t === "INVOICE # ") && invNoRe.test(nxt)) {
      header.invoiceNumber = nxt;
    } else if (t === "DATE:" && dateRe.test(nxt)) {
      header.date = nxt;
    } else if (t.includes("PURCHASE ORDER") && nxt && !nxt.startsWith("TERMS") && !nxt.startsWith("ACCOUNT")) {
      header.purchaseOrder = nxt;
    } else if (t.includes("TERMS OF PAYMENT")) {
      const m = t.match(/[-\u2013]\s*(.+)/);
      if (m) header.terms = m[1].trim();
    } else if (t.includes("FREE FREIGHT")) {
      header.freeFreight = true;
    }
  }
  return header;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return str;
}

function parseDueDate(billDate, terms, mapping) {
  const cfg = mapping?.[terms];
  if (!cfg || !billDate) return null;
  const d = new Date(billDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2"));
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + cfg.daysUntilDue);
  return d.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Coordinate-based totals extractor
// Reads FREIGHT, OTHER, TAX, TOTAL from the invoice footer grid.
// Labels appear at x≈437–460, values at x≈490–515.
// ---------------------------------------------------------------------------

function extractTotalsFromLayout(pages) {
  const priceRe = /^[\d,]+\.\d{2}$/;
  const result  = { mdse: null, freight: null, other: null, tax: null, total: null };
  const KEY_MAP = { MDSE:'mdse', FREIGHT:'freight', OTHER:'other', TAX:'tax', TOTAL:'total' };

  for (const elements of pages) {
    const labeled = elements.filter(e =>
      e.x0 > 430 && e.x0 < 470 && KEY_MAP[e.text.toUpperCase().trim()]
    );
    if (!labeled.length) continue;

    for (const lbl of labeled) {
      const key = KEY_MAP[lbl.text.toUpperCase().trim()];
      const vals = elements.filter(e =>
        e.x0 > 490 && e.x0 < 520 &&
        Math.abs(e.y0 - lbl.y0) < 8 &&
        priceRe.test(e.text)
      );
      if (vals.length && result[key] === null) {
        result[key] = parseFloat(vals[0].text.replace(/,/g, ""));
      }
    }
  }
  return result;
}

function parseShipping(pages, cfg, rawText) {
  if (Array.isArray(pages)) {
    const totals = extractTotalsFromLayout(pages);
    const freeKws = cfg && cfg.freeFreightKeywords ? cfg.freeFreightKeywords : ["FREE FREIGHT"];
    const isFree  = freeKws.some(kw => (rawText||"").toUpperCase().includes(kw.toUpperCase()));

    if (isFree && !totals.freight) {
      return { cost: 0, note: "Free freight per invoice", tax: totals.tax||0, other: totals.other||0 };
    }
    if (totals.freight !== null) {
      return { cost: totals.freight, note: "Parsed from invoice totals", tax: totals.tax||0, other: totals.other||0 };
    }
  }
  // Fallback: raw text
  const { freeFreightKeywords = [], defaultCost = 0 } = cfg || {};
  if (freeFreightKeywords.some(kw => (rawText||"").toUpperCase().includes(kw.toUpperCase()))) {
    return { cost: 0, note: "Free freight per invoice", tax: 0, other: 0 };
  }
  const m = (rawText||"").match(/FREIGHT\s+\$?([\d,]+\.\d{2})/i);
  if (m) return { cost: parseFloat(m[1].replace(/,/g,"")), note: "Parsed from text", tax: 0, other: 0 };
  return { cost: defaultCost, note: "Default", tax: 0, other: 0 };
}

function extractInvoiceTotal(pages, rawText) {
  if (Array.isArray(pages)) {
    const totals = extractTotalsFromLayout(pages);
    if (totals.total !== null) return totals.total;
  }
  const norm = (rawText||"").replace(/  +/g, " ");
  const m    = norm.match(/\bTOTAL\s+([\d,]+\.\d{2})/i);
  return m ? parseFloat(m[1].replace(/,/g,"")) : null;
}

// ---------------------------------------------------------------------------
// Main bill assembler — call this with a PDF Buffer and a vendor config
// ---------------------------------------------------------------------------

function assembleBill(pdfBuffer, config) {
  const pages   = extractLayout(pdfBuffer);
  const rawText = pages.flat().map(e => e.text).join("\n");

  const header   = extractHeaderFromLayout(pages[0] || []);
  const terms    = header.terms?.trim() || "";
  const dueDate  = parseDueDate(header.date, terms, config.termsMapping);

  const lineItems = parseWilsonLineItems(pages, config);
  const merch     = Math.round(lineItems.reduce((s, l) => s + l.extendedPrice, 0) * 100) / 100;
  const shipping  = parseShipping(pages, config.shipping, rawText);
  const stated    = extractInvoiceTotal(pages, rawText);
  // Total = merch + freight + tax + other
  const total     = Math.round((merch + (shipping.cost||0) + (shipping.tax||0) + (shipping.other||0)) * 100) / 100;
  const verified  = stated !== null ? Math.abs(total - stated) < 0.02 : null;

  return {
    _meta: {
      vendorId:           config.vendorId,
      parsedAt:           new Date().toISOString(),
      status:             "pending",
      totalVerified:      verified,
      invoiceStatedTotal: stated ?? null,
      itemCount:          lineItems.length,
    },
    vendor:        config.quickbooksVendorName,
    invoiceNumber: header.invoiceNumber,
    billDate:      header.date ? parseDate(header.date) : null,
    dueDate:       dueDate ?? null,
    terms,
    purchaseOrder: header.purchaseOrder,
    memo:          header.purchaseOrder || "",
    freeFreight:   header.freeFreight || false,
    lineItems,
    shipping,
    totals: {
      merchandise:    merch,
      shipping:       shipping.cost,
      tax:            shipping.tax   || 0,
      other:          shipping.other || 0,
      prepayDiscount: 0,
      total,
    },
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
  extractLayout,
  extractRawText,
  extractInvoiceTotal,
  parseShipping,
  parseDueDate,
  parseDate,
};