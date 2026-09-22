# commerce

A small online shop: `customers`, `products`, `orders`, `order_items`. A classic star schema, chosen to prove joins, money formats, ratios, percentiles — and the fan-out trap.

Questions the pack answers: revenue and orders over time with a previous-period comparison; average order value (a derived measure); refund rate as a rate over base rows; revenue by country (a many-to-one join to `customers`); P90 order value.

The trap: `revenue` lives on `orders`, and `category` lives on `products` through `order_items` — a one-to-many hop. Asking for "revenue by category" is refused with `FANOUT_REFUSED`; the pack offers `item_revenue` (at line grain) for that question instead. That refusal is the point: a number that silently multiplies is worse than no number.
