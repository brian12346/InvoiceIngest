# QuickBooks Online bill format

Reference for the QBO Bill API payload that InvoiceIngest generates.

API docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill

---

## Bill payload structure

```json
{
  "VendorRef": { "name": "Wilson Sporting Goods" },
  "APAccountRef": { "name": "Accounts Payable (A/P)" },
  "TxnDate": "2026-02-05",
  "DueDate": "2026-04-06",
  "DocNumber": "4554852904",
  "Memo": "Rush 5 Men",
  "PrivateNote": "Internal notes here",
  "TotalAmt": 8116.56,
  "Line": [
    {
      "Id": "1",
      "DetailType": "ItemBasedExpenseLineDetail",
      "Amount": 62.40,
      "Description": "Rush Lite 5 White/Black/R sz 8",
      "ItemBasedExpenseLineDetail": {
        "ItemRef": { "name": "Rush Lite 5 White/Black/R sz 8", "value": "WRS336360U080" },
        "Qty": 1,
        "UnitPrice": 62.40,
        "AccountBasedExpenseLineDetail": {
          "AccountRef": { "name": "Inventory" }
        }
      }
    }
  ]
}
```

---

## Line detail types

| DetailType | Use for |
|------------|---------|
| `ItemBasedExpenseLineDetail` | Merchandise with SKU/qty/price |
| `AccountBasedExpenseLineDetail` | Shipping, discounts, fees |

---

## Account names

These must match your QuickBooks chart of accounts exactly (case-sensitive):

| Purpose | Account name |
|---------|--------------|
| Merchandise | `Inventory` |
| Shipping | `Shipping & Freight` |
| Prepay discount | `Purchase Discounts` |
| Accounts payable | `Accounts Payable (A/P)` |

---

## Grouping strategy

By default InvoiceIngest creates one line per SKU. For invoices with many sizes (like Wilson shoe orders), you can pass `--group` to `bill-builder.js` to collapse to model-level lines. This reduces a 63-line bill to ~8 lines.

```bash
node src/bill-builder.js bills/pending/4554852904.json --group
```
