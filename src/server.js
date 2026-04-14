/**
 * server.js — InvoiceIngest local API server
 *
 * Exposes the parser as an HTTP API so the web frontend can
 * trigger reparsing by POSTing a PDF to /api/parse.
 *
 * Usage:
 *   node src/server.js          # starts on port 3000
 *   PORT=4000 node src/server.js
 */

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");

const PORT = parseInt(process.env.PORT || "3000", 10);

// Inline the bill assembly logic from parser.js so we don't need
// a separate process — just require the shared functions.
const {
  loadVendorConfigs,
  detectVendor,
  assembleBill,
} = require("./parser-lib");

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleParse(req, res) {
  // Collect the PDF body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const pdfBuffer = Buffer.concat(chunks);

  if (!pdfBuffer.length) {
    return jsonError(res, 400, "No PDF body received");
  }

  // Write to a temp file so pdf-parse can read it
  const tmpPath = path.join(os.tmpdir(), `invoice-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, pdfBuffer);

  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(pdfBuffer);
    const pdfText = data.text;

    const configs = loadVendorConfigs();
    const config  = detectVendor(pdfText, configs);

    if (!config) {
      return jsonError(res, 422, "No vendor config matched this invoice. Add a vendor config first.");
    }

    const bill = assembleBill(pdfText, config);
    jsonOK(res, bill);

  } catch (err) {
    jsonError(res, 500, "Parse failed: " + err.message);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch(_) {}
  }
}

function handleHealth(res) {
  jsonOK(res, { status: "ok", version: "1.0.0" });
}

// ---------------------------------------------------------------------------
// Journal entry storage
// ---------------------------------------------------------------------------

const JOURNALS_DIR = path.join(__dirname, "../journals");

function ensureJournalsDir() {
  if (!fs.existsSync(JOURNALS_DIR)) fs.mkdirSync(JOURNALS_DIR, { recursive: true });
}

function saveJournalEntry(entry) {
  ensureJournalsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const invoiceNum = entry.bill?.invoiceNumber || "unknown";
  const filename = `${timestamp}_${invoiceNum}.json`;
  const filepath = path.join(JOURNALS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
  return { filename, filepath };
}

function listJournalEntries() {
  ensureJournalsDir();
  return fs.readdirSync(JOURNALS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse()
    .map(f => {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(JOURNALS_DIR, f), "utf8"));
        return {
          filename: f,
          submittedAt: entry.submittedAt,
          invoiceNumber: entry.bill?.invoiceNumber,
          vendor: entry.bill?.vendor,
          total: entry.bill?.totals?.total,
          qboBillId: entry.qboResponse?.Bill?.Id || null,
          status: entry.status,
        };
      } catch(_) { return { filename: f, error: "Could not read" }; }
    });
}

// ---------------------------------------------------------------------------
// Submit handler — builds QBO payload, posts to QBO, saves journal entry
// ---------------------------------------------------------------------------

async function handleSubmit(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch(e) {
    return jsonError(res, 400, "Invalid JSON body");
  }

  const { bill, qboPayload, paymentPlan, attachedFilename } = body;

  if (!bill || !qboPayload) {
    return jsonError(res, 400, "Missing required fields: bill, qboPayload");
  }

  // Build the full journal entry — saved regardless of QBO success
  const journalEntry = {
    submittedAt: new Date().toISOString(),
    submittedBy: "InvoiceIngest",
    status: "pending",
    attachedFilename: attachedFilename || null,
    bill,
    qboPayload,          // Raw payload sent to QuickBooks
    paymentPlan: paymentPlan || [],
    qboResponse: null,   // Filled in after QBO call
    error: null,
  };

  // Attempt QBO submission if credentials are configured
  const qboResult = await submitToQBO(qboPayload);

  if (qboResult.success) {
    journalEntry.status = "submitted";
    journalEntry.qboResponse = qboResult.data;
    journalEntry.qboBillId = qboResult.data?.Bill?.Id || null;
  } else {
    journalEntry.status = "failed";
    journalEntry.error = qboResult.error;
  }

  // Always save the journal entry — even if QBO failed
  const { filename } = saveJournalEntry(journalEntry);

  if (qboResult.success) {
    jsonOK(res, {
      success: true,
      journalFile: filename,
      qboBillId: journalEntry.qboBillId,
      message: "Bill submitted to QuickBooks and journal entry saved.",
    });
  } else {
    // Return 200 so the frontend can read the error — not a server crash
    jsonOK(res, {
      success: false,
      journalFile: filename,
      error: qboResult.error,
      message: "Journal entry saved. QBO submission failed — check credentials or try again.",
    });
  }
}

// ---------------------------------------------------------------------------
// QBO submission (stub — replace with OAuth + real API call)
// ---------------------------------------------------------------------------

async function submitToQBO(qboPayload) {
  // Check for credentials
  const envPath = path.join(__dirname, "../.env");
  if (!fs.existsSync(envPath)) {
    return { success: false, error: "No .env file -- QBO credentials not configured. See docs/quickbooks-format.md" };
  }

  const env = {};
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && v.length) env[k.trim()] = v.join("=").trim();
  });

  if (!env.QBO_ACCESS_TOKEN || !env.QBO_REALM_ID) {
    return { success: false, error: "QBO_ACCESS_TOKEN or QBO_REALM_ID not set in .env" };
  }

  const baseUrl = env.QBO_SANDBOX === "true"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${env.QBO_REALM_ID}/bill`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.QBO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ Bill: qboPayload }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `QBO API ${response.status}: ${errText}` };
    }

    const data = await response.json();
    return { success: true, data };

  } catch(err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Journal list handler
// ---------------------------------------------------------------------------

function handleJournals(res) {
  jsonOK(res, { journals: listJournalEntries() });
}

function serveStatic(req, res) {
  const safePath = req.url === "/" ? "/index.html" : req.url;

  // Look in ../app/ first, then project root, then current dir
  const candidates = [
    path.join(__dirname, "../app", safePath),
    path.join(__dirname, "..", safePath),
    path.join(__dirname, safePath),
  ];
  const filePath = candidates.find(p => fs.existsSync(p));

  if (!filePath) {
    res.writeHead(404); res.end("Not found: " + safePath); return;
  }

  const ext = path.extname(filePath);
  const mime = { ".html":"text/html", ".js":"application/javascript",
                 ".css":"text/css", ".json":"application/json" }[ext] || "text/plain";
  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS — allow requests from the local file:// origin and localhost
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];

  if (req.method === "POST" && url === "/api/parse")   return handleParse(req, res);
  if (req.method === "POST" && url === "/api/submit")  return handleSubmit(req, res);
  if (req.method === "GET"  && url === "/api/journals") return handleJournals(req, res);
  if (req.method === "GET"  && url === "/api/health")  return handleHealth(res);
  if (req.method === "GET")                             return serveStatic(req, res);

  res.writeHead(405); res.end("Method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nInvoiceIngest server running at http://localhost:${PORT}`);
  console.log(`  App:    http://localhost:${PORT}/`);
  console.log(`  Parse:  POST http://localhost:${PORT}/api/parse`);
  console.log(`  Health: GET  http://localhost:${PORT}/api/health\n`);
  console.log("Open the app in your browser, then attach a PDF and click Reparse.\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 node src/server.js`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOK(res, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function jsonError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
