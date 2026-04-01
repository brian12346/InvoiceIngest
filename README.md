# InvoiceIngest

Vendor invoice parser and QuickBooks bill builder for Andersen Lifestyle Brands.

Converts vendor PDF invoices into structured QuickBooks bills with an approval workflow before submission.

---

## Project structure

```
InvoiceIngest/
├── vendors/                  # Vendor config files (one JSON per vendor)
│   └── wilson-sporting-goods.json
├── invoices/
│   ├── raw/                  # Drop incoming PDF invoices here
│   └── processed/            # PDFs move here after parsing
├── bills/
│   ├── pending/              # Parsed bills awaiting approval (JSON)
│   └── approved/             # Approved bills ready for QuickBooks (JSON)
├── src/
│   ├── parser.js             # Core invoice parsing engine
│   ├── bill-builder.js       # Maps parsed data → QuickBooks bill format
│   ├── approval.js           # Approval workflow logic
│   └── quickbooks.js         # QuickBooks API client (stub — future)
├── docs/
│   ├── vendor-config-guide.md
│   └── quickbooks-format.md
├── package.json
└── README.md
```

---

## Quick start

```bash
npm install
node src/parser.js invoices/raw/4554852904.pdf
```

This will:
1. Detect the vendor from the invoice
2. Apply the matching vendor config
3. Output a bill JSON to `bills/pending/`
4. Print a summary for review

---

## Workflow

```
PDF invoice → parser.js → bill JSON (pending) → review/approve → QuickBooks
```

1. **Drop** a PDF into `invoices/raw/`
2. **Run** `node src/parser.js invoices/raw/<filename>.pdf`
3. **Review** the output in `bills/pending/`
4. **Approve** by running `node src/approval.js bills/pending/<bill>.json`
5. Bill moves to `bills/approved/` — ready for QuickBooks submission

---

## Adding a new vendor

See `docs/vendor-config-guide.md` for full instructions.

Short version: copy `vendors/wilson-sporting-goods.json`, update the field mappings to match the new vendor's invoice layout, and save as `vendors/<vendor-slug>.json`.

---

## QuickBooks integration

The `src/quickbooks.js` stub is ready for the QuickBooks Online API. See `docs/quickbooks-format.md` for the bill JSON schema QuickBooks expects.

---

## Accounts used

| Line type      | QuickBooks account     |
|----------------|------------------------|
| Merchandise    | Inventory              |
| Shipping       | Shipping & Freight     |
| Prepay discount| Purchase Discounts     |
