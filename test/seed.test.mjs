import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createMarket } from '../src/market.mjs';
import { createApi } from '../src/server.mjs';
import { createMarketplaceClient } from '../src/client.mjs';

test('large seed is additive, varied, and conserves balances and inventory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apishhhh-rich-'));
  const path = join(dir, 'market.sqlite');
  const now = () => new Date('2026-10-06T12:00:00Z');
  const market = createMarket(path, { now });
  let db;
  try {
    const token = market.session({ role: 'buyer' }).token;
    const buyer = market.authenticate(`Bearer ${token}`);
    const priorOrder = market.purchase(buyer, { listingId: 'listing-codex', quantity: 1000 }, 'before-seed');
    const seed = market.seedDemo();
    assert.equal(seed.listingsAdded, 160);
    assert.equal(seed.ordersAdded, 96);
    assert.equal(seed.jobsAdded, 96);
    assert.equal(market.demoSummary().listingCount, 163);
    assert.equal(market.demoSummary().sellerCount, 25);
    assert.equal(market.demoSummary().buyerCount, 13);
    assert.equal(market.demoSummary().activeListingCount, 99);
    assert.equal(market.order(buyer, priorOrder.id).quantity, 1000);
    assert.equal(market.dashboard(buyer).walletCents, 99900);
    const before = market.demoSummary();
    assert.equal(market.seedDemo().applied, false);
    assert.deepEqual(market.demoSummary(), before);
    db = new DatabaseSync(path);
    const amount = sql => db.prepare(sql).get().n;
    assert.equal(amount('SELECT sum(wallet_cents) AS n FROM users') + before.escrowCents, 120_100_000);
    assert.equal(amount("SELECT wallet_cents AS n FROM users WHERE id='platform'"), amount('SELECT sum(fee_cents) AS n FROM orders'));
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const baseUnits = { codex: 200000, claude: 100000, lovable: 5000 };
    for (const provider of market.providers()) {
      const unlisted = db.prepare('SELECT sum(unlisted_units) AS n FROM inventory WHERE provider_id=?').get(provider.id).n ?? 0;
      const listed = db.prepare('SELECT sum(available_units) AS n FROM listings WHERE provider_id=?').get(provider.id).n ?? 0;
      const allocated = db.prepare('SELECT sum(o.remaining_units) AS n FROM orders o JOIN listings l ON o.listing_id=l.id WHERE l.provider_id=?').get(provider.id).n ?? 0;
      const consumed = db.prepare('SELECT sum(j.units) AS n FROM jobs j JOIN orders o ON j.order_id=o.id JOIN listings l ON o.listing_id=l.id WHERE l.provider_id=?').get(provider.id).n ?? 0;
      assert.equal(unlisted + listed + allocated + consumed, 48_000_000 + (baseUnits[provider.id] ?? 0), provider.id);
      const states = new Set(market.listings(provider.id, 'all').map(l => l.status));
      assert.deepEqual(states, new Set(['active', 'sold_out', 'expired', 'cancelled']));
      assert.equal(provider.liveConnectionSupported, false);
    }
  } finally { db?.close(); market.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('seeded personas have separate orders and cannot impersonate a mismatched role', () => {
  const market = createMarket();
  try {
    market.seedDemo();
    const as = (role, userId) => market.authenticate(`Bearer ${market.session({ role, userId }).token}`);
    const first = as('buyer', 'seed-buyer-1');
    const second = as('buyer', 'seed-buyer-2');
    const order = market.dashboard(first).orders[0];
    assert.ok(order);
    assert.throws(() => market.order(second, order.id), error => error.code === 'NOT_FOUND');
    assert.throws(() => market.session({ role: 'seller', userId: 'seed-buyer-1' }), error => error.code === 'INVALID_INPUT');
    assert.throws(() => market.session({ role: 'buyer', userId: 'platform' }), error => error.code === 'INVALID_INPUT');
    assert.equal(market.demoAccounts().length, 38);
  } finally { market.close(); }
});

test('demo stats and same-origin transactions are available', async t => {
  const market = createMarket();
  market.seedDemo();
  const { server } = createApi({ market });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(() => { market.close(); resolve(); }); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(`${baseUrl}/api/demo/session`, { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'buyer', userId: 'seed-buyer-1' }) });
  assert.equal(session.status, 201);
  const client = createMarketplaceClient({ baseUrl });
  await client.signInDemo('buyer', 'seed-buyer-1');
  assert.equal((await client.accounts()).length, 38);
  assert.equal((await client.summary()).orderCount, 96);
  const listing = (await client.listings('chatgpt'))[0];
  const order = await client.buy(listing.id, 100);
  assert.equal((await client.runJob(order.id, 'Try a simulated task', 100)).output.providerCalled, false);
});
