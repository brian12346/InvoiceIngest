/**
 * quickbooks.js
 * QuickBooks Online API client for InvoiceIngest.
 *
 * Status: STUB — ready for QBO OAuth + API integration.
 *
 * Usage (once configured):
 *   node src/quickbooks.js bills/approved/<invoice>.json
 *
 * Setup:
 *   1. Create a QBO app at https://developer.intuit.com
 *   2. Copy your Client ID + Secret to .env (see .env.example)
 *   3. Run: node src/quickbooks.js --auth   (one-time OAuth flow)
 *   4. Then submit bills normally
 */

const fs = require("fs");
const path = require("path");
const { toQuickBooksBill } = require("./bill-builder");

// ---------------------------------------------------------------------------
// Config — loaded from .env
// ---------------------------------------------------------------------------

function loadConfig() {
  const envPath = path.join(__dirname, "../.env");
  if (!fs.existsSync(envPath)) {
    console.error(".env file not found. Copy .env.example and fill in your QBO credentials.");
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  const env = {};
  for (const line of lines) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length) env[k.trim()] = rest.join("=").trim();
  }
  return {
    clientId: env.QBO_CLIENT_ID,
    clientSecret: env.QBO_CLIENT_SECRET,
    realmId: env.QBO_REALM_ID,
    accessToken: env.QBO_ACCESS_TOKEN,
    refreshToken: env.QBO_REFRESH_TOKEN,
    sandbox: env.QBO_SANDBOX === "true",
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function baseUrl(sandbox) {
  return sandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

async function createBill(qboBill, config) {
  const url = `${baseUrl(config.sandbox)}/v3/company/${config.realmId}/bill`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ Bill: qboBill }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO API error ${response.status}: ${err}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const billPath = args[0];

  if (!billPath) {
    console.error("Usage: node src/quickbooks.js bills/approved/<invoice>.json");
    process.exit(1);
  }

  if (!fs.existsSync(billPath)) {
    console.error(`File not found: ${billPath}`);
    process.exit(1);
  }

  const bill = JSON.parse(fs.readFileSync(billPath, "utf8"));

  if (bill._meta?.status !== "approved") {
    console.error("Bill is not approved. Run approval.js first.");
    process.exit(1);
  }

  console.log(`\nSubmitting bill ${bill.invoiceNumber} to QuickBooks...`);

  // TODO: Remove stub block once QBO credentials are configured
  const STUB = true;
  if (STUB) {
    console.log("\n[STUB MODE] QuickBooks submission not yet configured.");
    console.log("To enable:");
    console.log("  1. Copy .env.example to .env");
    console.log("  2. Add your QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID");
    console.log("  3. Run: node src/quickbooks.js --auth");
    console.log("\nQBO bill payload preview:");
    const qboBill = toQuickBooksBill(bill);
    console.log(JSON.stringify(qboBill, null, 2).slice(0, 800) + "\n...");
    return;
  }

  try {
    const config = loadConfig();
    const qboBill = toQuickBooksBill(bill);
    const result = await createBill(qboBill, config);

    console.log(`Bill created in QuickBooks!`);
    console.log(`QBO Bill ID: ${result.Bill?.Id}`);
    console.log(`Total: $${result.Bill?.TotalAmt}`);

    // Mark as submitted
    bill._meta.status = "submitted";
    bill._meta.submittedAt = new Date().toISOString();
    bill._meta.qboBillId = result.Bill?.Id;
    fs.writeFileSync(billPath, JSON.stringify(bill, null, 2));
  } catch (err) {
    console.error("Submission failed:", err.message);
    process.exit(1);
  }
}

module.exports = { createBill, toQuickBooksBill };

if (require.main === module) main().catch(console.error);
