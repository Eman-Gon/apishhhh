# apishhhh — credit marketplace backend

A portable backend for the hackathon marketplace. Claude, Codex, and Lovable are **example provider labels only**. All inventory, prices, dollars, jobs, payments, and earnings are simulated. This backend never accesses a provider account or transfers real credits.

The backend lives at this repository's root. No frontend source was present when it was migrated here. The API and browser client are ready to connect to the frontend when it arrives.

## Run

Requires Node.js 22.13 or later with `node:sqlite`. No npm dependencies or provider keys are required.

```sh
npm start
```

Default address: `http://127.0.0.1:8787`. Health: `GET /health`.

SQLite data is stored in `data/market.sqlite` and survives restarts. Set `DATABASE_PATH` to another file to run a separate fresh demo. The seed runs only for an empty database, and credits expire 30 days after that initial seed; restarting does not refresh their expiration.

Copy `.env.example` to `.env` to change the port, database file, or allowed frontend origins. Restart the backend after changing these settings.

```sh
npm test
```

## Included behavior

- Provider catalog: Claude, Codex, Lovable, each marked `simulated`.
- Seller seed listings: 200,000 Codex, 100,000 Claude, and 5,000 Lovable demo units. Pricing is fictional and does not represent provider pricing or conversion rates.
- Buyer starts with $1,000 in simulated funds; seller starts with zero earnings.
- Listings and quotes, purchases, purchased usage allocations, simulated jobs, seller earnings, refund of unused allocations, and cancellation/relisting of unsold inventory.
- A buyer purchases an allocation to simulated seller-side usage. This is not a transfer into the buyer's actual provider account.
- Purchase funds remain in a simulated escrow ledger until jobs consume units. A 10% demo platform fee is deducted from consumed value; unused value is refunded upon cancellation.
- Transactions prevent overselling. Idempotency keys prevent duplicate mutations when a request is retried with the same body.
- Expired listings cannot be purchased, and expired allocations cannot run jobs. Buyers can cancel expired orders for an unused-value refund.
- Cancelling a listing stops new purchases while preserving already purchased allocations until their original expiry.

## Frontend integration

Copy `src/client.mjs` into the frontend, or import it directly where your build permits. It works with standard browser `fetch`; no backend-specific React components are required.

```js
import { createMarketplaceClient } from './client.mjs';

const market = createMarketplaceClient({
  baseUrl: 'http://127.0.0.1:8787',
});

await market.signInDemo('buyer');
const providers = await market.providers();
const listings = await market.listings('codex');
const quote = await market.quote(listings[0].id, 10000);

// Keep the key for this action and reuse it when retrying a failed network request.
const purchaseKey = crypto.randomUUID();
const order = await market.buy(listings[0].id, 10000, purchaseKey);
const job = await market.runJob(order.id, 'Build a landing page', 2500);
const refund = await market.cancelOrder(order.id);
const dashboard = await market.me();

// Use a separate client for the seller view.
const seller = createMarketplaceClient({ baseUrl: 'http://127.0.0.1:8787' });
await seller.signInDemo('seller');
const sellerDashboard = await seller.me();
```

The job returns a labeled simulation receipt, not AI-generated work. `units` is caller-supplied for the demo. Real metering would have to come from an authorized provider integration.

### Connect the finished UI when it arrives

1. Start this API and add the frontend's exact origin to `CORS_ORIGINS`.
2. Replace hardcoded provider and listing arrays with `providers()` and `listings()`.
3. Replace checkout alerts with `quote()` then `buy()`; refresh listings and dashboard after purchase.
4. Connect the task form to `runJob()`. Show `output.text` and remaining allocation.
5. Connect buyer balances, seller earnings, and history to `me()`; all monetary fields are integer cents.
6. Connect cancellation to `cancelOrder()` or `cancelListing()` and refresh affected views.
7. Keep a visible “Demo — simulated credits and payments” label. Do not present balances as provider-verified.

No frontend files need to be replaced. Once its repository is available, its framework, routes, environment variables, and component conventions can be preserved.

## REST contract

All successful responses use `{ "data": ..., "meta": { "mode": "demo" } }`.
Errors use `{ "error": { "code": "...", "message": "..." } }` and an appropriate HTTP status.
Use `Content-Type: application/json` on every POST, including cancellation with `{}`.

| Method | Path | Authentication | Input / purpose |
|---|---|---|---|
| GET | `/health` | None | Database and simulation status |
| GET | `/api/providers` | None | Provider catalog |
| POST | `/api/demo/session` | None | `{ "role": "buyer" }` or `seller`; returns a bearer token |
| GET | `/api/listings` | None | Optional `providerId`; `status=active` (default) or `all` |
| GET | `/api/listings/:id` | None | Listing detail |
| GET | `/api/quote` | None | `listingId` and positive integer `quantity` query parameters |
| GET | `/api/me` | Bearer | Current wallet, inventory, orders, sales, listings, and ledger |
| POST | `/api/listings` | Seller + idempotency key | `providerId`, `title`, `quantity`, `pricePer1000Cents`, `expiresAt` |
| POST | `/api/listings/:id/cancel` | Owner + idempotency key | `{}`; releases unsold inventory |
| POST | `/api/orders` | Buyer + idempotency key | `listingId`, `quantity` |
| GET | `/api/orders/:id` | Buyer who owns order | Order and allocation details |
| POST | `/api/orders/:id/cancel` | Owner + idempotency key | `{}`; refunds unconsumed value |
| POST | `/api/jobs` | Owner + idempotency key | `orderId`, `prompt`, `units` |
| GET | `/api/jobs` | Bearer | Current buyer's last 100 simulation receipts |

Protected requests use `Authorization: Bearer <token>`. Sessions expire after 24 hours. Every mutation except demo session creation requires `Idempotency-Key: <unique-action-id>`. Reusing a key with the same endpoint and JSON body returns the original result; changing the request returns `409 IDEMPOTENCY_CONFLICT`. The original result is a snapshot; fetch the order again for current state. JSON key order must remain stable when manually retrying requests.

Providers are separate inventories. No cross-provider conversion or dollar-equivalence is inferred. Quotes are informational, not reservations; only a successful purchase reserves inventory.

## Local demo boundary

The default bind address is loopback. Demo sessions intentionally allow selection of either seeded persona; this is **not production authentication or seller verification**. Data is shared by everyone choosing that demo persona. Do not expose this server publicly or use sensitive customer prompts in it.

Before a real deployment, replace demo sessions with user authentication and ownership, agree on supported provider/resale integrations, add provider-confirmed inventory reservation and usage metering, and integrate real payment/refund settlement. Also add request limits and production operational controls. Do not turn the simulator into an account-sharing relay and assume that makes provider resale permitted.

`src/providers.mjs` is currently a synchronous simulator. A future live integration needs a durable asynchronous job queue, metering, failure handling, and explicit provider permissions. Substituting an API call inside the SQLite transaction is not an adequate production implementation.

## Files

- `src/schema.sql`: version 1 schema; startup creates missing tables without erasing existing data.
- `src/market.mjs`: transactional inventory, money ledger, allocations, idempotency, and session logic.
- `src/server.mjs`: HTTP routing, JSON validation, origin allowlist, and server startup.
- `src/providers.mjs`: provider labels and explicit simulation adapter.
- `src/client.mjs`: browser-compatible API client for the future frontend.
- `test/market.test.mjs`: business-invariant, persistence, HTTP, and integration tests.
