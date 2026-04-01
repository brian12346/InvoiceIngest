# Vendor config guide

Each vendor needs one JSON file in `vendors/`. The parser auto-detects which config to use based on keywords in the invoice text.

---

## Minimal config

```json
{
  "vendorId": "my-vendor",
  "vendorName": "My Vendor Inc.",
  "quickbooksVendorName": "My Vendor Inc.",
  "defaultAccount": "Inventory",
  "shippingAccount": "Shipping & Freight",
  "discountAccount": "Purchase Discounts",

  "detection": {
    "keywords": ["MY VENDOR INC", "myvendor@email.com"]
  },

  "headerFields": {
    "invoiceNumber": { "label": "Invoice No", "type": "string" },
    "date": { "label": "Invoice Date", "type": "date", "format": "MM/DD/YYYY" },
    "terms": { "label": "Terms", "type": "string" }
  },

  "termsMapping": {
    "Net 30": { "daysUntilDue": 30, "prepayDiscount": null }
  },

  "shipping": {
    "detectionKeywords": ["FREIGHT", "SHIPPING"],
    "freeFreightKeywords": ["FREE FREIGHT", "NO CHARGE"],
    "defaultCost": 0
  },

  "lineItems": {
    "columns": {
      "qtyShipped": "Qty",
      "stockNumber": "Item #",
      "unitPrice": "Price",
      "extendedPrice": "Total"
    },
    "quickbooksDescription": "{description}"
  }
}
```

---

## Field reference

### `detection.keywords`
Strings that uniquely identify this vendor in any invoice text. Use vendor name, email domain, or account number prefix. Case-insensitive.

### `detection.skuPrefix`
Optional array of SKU prefixes (e.g. `["WRS"]`) for additional matching confidence.

### `headerFields`
Maps semantic field names → the exact label text in the invoice PDF.

| type | behavior |
|------|----------|
| `string` | Returns raw text after the label |
| `date` | Parses and normalizes to YYYY-MM-DD |
| `number` | Strips `$`, `,` and returns float |

### `termsMapping`
Maps payment term strings to due date logic and optional prepay discounts.

```json
"2/10 Net 30": {
  "daysUntilDue": 30,
  "prepayDiscount": { "pct": 2, "withinDays": 10 }
}
```

### `lineItems.columns`
Map the semantic column names to whatever your vendor labels them. Required columns:
- `qtyShipped`
- `stockNumber`
- `unitPrice`
- `extendedPrice`

Optional: `qtyBackordered`, `uom`

### `lineItems.descriptionLine`
If the item description appears on a separate line below the SKU row, provide a regex `pattern` with named capture groups.

```json
"descriptionLine": {
  "pattern": "^(MODEL \\S+) (.+?) (\\d+(?:\\.\\d)?)$",
  "groups": ["model", "colorway", "size"]
}
```

### `lineItems.quickbooksDescription`
Template string for the QuickBooks line description. Use `{groupName}` from the `groups` array.

---

## Testing a new config

```bash
node src/parser.js invoices/raw/<new-invoice>.pdf --dry-run
```

This runs the parser without saving anything — lets you verify field extraction before committing.
