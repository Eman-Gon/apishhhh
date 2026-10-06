import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createMarket } from '../src/market.mjs';
import { createApi } from '../src/server.mjs';
import { createMarketplaceClient } from '../src/client.mjs';

function setup(t, options) {
  const market = createMarket(':memory:', options);
  t.after(() => market.close());
  const user = role => market.authenticate(`Bearer ${market.session({ role }).token}`);
  return { market, buyer: user('buyer'), seller: user('seller') };
}
const errorCode = code => error => error.code === code;

test('buy, run a partial job, and refund conserves demo money and credit units', t => {
  const { market, buyer, seller } = setup(t);
  const order = market.purchase(buyer, { listingId: 'listing-codex', quantity: 10_000 }, 'buy-1');
  assert.equal(order.amountCents, 1000);
  assert.equal(market.listing('listing-codex').availableUnits, 190_000);
  assert.equal(market.dashboard(seller).walletCents, 0);
  const job = market.runJob(buyer, { orderId: order.id, prompt: 'Build a test app', units: 2500 }, 'job-1');
  assert.equal(job.output.providerCalled, false);
  assert.equal(job.order.remainingUnits, 7500);
  assert.equal(job.order.escrowCents, 750);
  assert.equal(job.sellerPayoutCents, 225);
  assert.equal(job.order.platformFeeCents, 25);
  const cancelled = market.cancelOrder(buyer, order.id, 'cancel-1');
  assert.equal(cancelled.refundedCents, 750);
  assert.equal(cancelled.escrowCents, 0);
  assert.equal(market.dashboard(buyer).walletCents + market.dashboard(seller).walletCents + cancelled.platformFeeCents, 100_000);
  assert.equal(market.listing('listing-codex').availableUnits + job.units, 200_000);
  market.cancelOrder(buyer, order.id, 'cancel-again');
  assert.equal(market.dashboard(buyer).walletCents, 99_750);
});

test('idempotency prevents duplicate charges and rejects mismatched reuse', t => {
  const { market, buyer } = setup(t);
  const body = { listingId: 'listing-claude', quantity: 1000 };
  const first = market.purchase(buyer, body, 'same');
  assert.deepEqual(market.purchase(buyer, body, 'same'), first);
  assert.equal(market.dashboard(buyer).orders.length, 1);
  assert.throws(() => market.purchase(buyer, { ...body, quantity: 2000 }, 'same'), errorCode('IDEMPOTENCY_CONFLICT'));
  const jobBody = { orderId: first.id, prompt: 'Demo task', units: 1000 };
  const job = market.runJob(buyer, jobBody, 'same-job');
  assert.deepEqual(market.runJob(buyer, jobBody, 'same-job'), job);
  assert.equal(market.jobs(buyer).length, 1);
});

test('invalid quantities, overuse, insufficient wallet, and ownership are enforced', t => {
  const { market, buyer, seller } = setup(t);
  assert.throws(() => market.purchase(buyer, { listingId: 'listing-codex', quantity: -1 }, 'bad'), errorCode('INVALID_INPUT'));
  assert.throws(() => market.purchase(buyer, { listingId: 'listing-codex', quantity: 200001 }, 'too-many'), errorCode('INSUFFICIENT_INVENTORY'));
  assert.throws(() => market.purchase(seller, { listingId: 'listing-codex', quantity: 1 }, 'seller-buy'), errorCode('FORBIDDEN'));
  const order = market.purchase(buyer, { listingId: 'listing-codex', quantity: 100 }, 'buy');
  assert.throws(() => market.order(seller, order.id), errorCode('NOT_FOUND'));
  assert.throws(() => market.cancelOrder(seller, order.id, 'steal'), errorCode('NOT_FOUND'));
  assert.throws(() => market.runJob(buyer, { orderId: order.id, prompt: 'Demo', units: 101 }, 'overuse'), errorCode('INSUFFICIENT_ALLOCATION'));
  assert.equal(market.order(buyer, order.id).remainingUnits, 100);
  market.cancelListing(seller, 'listing-lovable', 'cancel-listing');
  const listing = market.createListing(seller, { providerId: 'lovable', title: 'Expensive demo', quantity: 5000, pricePer1000Cents: 1_000_000, expiresAt: market.dashboard(seller).inventory.find(i => i.providerId === 'lovable').expiresAt }, 'expensive');
  assert.throws(() => market.purchase(buyer, { listingId: listing.id, quantity: 5000 }, 'too-expensive'), errorCode('INSUFFICIENT_FUNDS'));
  assert.equal(market.listing(listing.id).availableUnits, 5000);
});

test('listing cancellation releases unsold inventory without breaking existing orders', t => {
  const { market, buyer, seller } = setup(t);
  const order = market.purchase(buyer, { listingId: 'listing-codex', quantity: 1000 }, 'purchase');
  market.cancelListing(seller, 'listing-codex', 'remove-listing');
  assert.equal(market.dashboard(seller).inventory.find(i => i.providerId === 'codex').unlistedUnits, 199000);
  market.runJob(buyer, { orderId: order.id, prompt: 'Still valid', units: 500 }, 'run');
  market.cancelOrder(buyer, order.id, 'refund');
  const inventory = market.dashboard(seller).inventory.find(i => i.providerId === 'codex');
  assert.equal(inventory.unlistedUnits, 199500);
  market.createListing(seller, { providerId: 'codex', quantity: 199500, title: 'Relisted demo balance', pricePer1000Cents: 50, expiresAt: inventory.expiresAt }, 'relist');
  assert.equal(market.dashboard(seller).inventory.find(i => i.providerId === 'codex').unlistedUnits, 0);
});

test('expired credits cannot be bought or used, but unused funds can be refunded', t => {
  let instant = new Date('2026-10-05T12:00:00Z');
  const { market, buyer } = setup(t, { now: () => instant });
  const order = market.purchase(buyer, { listingId: 'listing-codex', quantity: 1000 }, 'buy');
  instant = new Date('2026-11-05T12:00:00Z');
  assert.equal(market.listing('listing-codex').status, 'expired');
  assert.equal(market.listings().length, 0);
  assert.throws(() => market.purchase(buyer, { listingId: 'listing-codex', quantity: 1 }, 'late-buy'), errorCode('LISTING_UNAVAILABLE'));
  assert.throws(() => market.runJob(buyer, { orderId: order.id, prompt: 'Too late', units: 1 }, 'late-job'), errorCode('CREDITS_EXPIRED'));
  assert.equal(market.cancelOrder(buyer, order.id, 'refund').refundedCents, 100);
  assert.equal(market.dashboard(buyer).walletCents, 100_000);
});

test('rounding of multiple small jobs settles to the purchase amount', t => {
  const { market, buyer, seller } = setup(t);
  const order = market.purchase(buyer, { listingId: 'listing-claude', quantity: 7 }, 'buy');
  for (let i = 0; i < 7; i++) market.runJob(buyer, { orderId: order.id, prompt: 'Small task', units: 1 }, `job-${i}`);
  const final = market.order(buyer, order.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.escrowCents, 0);
  assert.equal(final.releasedCents, order.amountCents);
  assert.equal(market.dashboard(seller).walletCents + final.platformFeeCents, order.amountCents);
});

test('balances, sessions, and idempotency survive a database restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credit-market-test-'));
  let market;
  try {
    const path = join(dir, 'market.sqlite');
    market = createMarket(path);
    const { token } = market.session({ role: 'buyer' });
    const user = market.authenticate(`Bearer ${token}`);
    const body = { listingId: 'listing-codex', quantity: 2000 };
    const order = market.purchase(user, body, 'persist');
    market.close(); market = createMarket(path);
    const restoredUser = market.authenticate(`Bearer ${token}`);
    assert.deepEqual(market.purchase(restoredUser, body, 'persist'), order);
    assert.equal(market.listing('listing-codex').availableUnits, 198000);
    assert.equal(market.dashboard(restoredUser).walletCents, 99800);
  } finally { market?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP API and integration client complete the flow; concurrent checkouts cannot oversell', async t => {
  const { market } = setup(t);
  const { server } = createApi({ market });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createMarketplaceClient({ baseUrl });
  const session = await client.signInDemo('buyer');
  assert.equal((await client.providers()).length, 8);
  const outcomes = await Promise.allSettled([
    client.buy('listing-codex', 150000, 'race-1'),
    client.buy('listing-codex', 150000, 'race-2'),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'rejected').reason.code, 'INSUFFICIENT_INVENTORY');
  const order = outcomes.find(o => o.status === 'fulfilled').value;
  await client.runJob(order.id, 'Implement a button', 1000);
  const refunded = await client.cancelOrder(order.id);
  assert.equal(refunded.refundedCents, 14900);
  assert.equal((await client.me()).walletCents, 99900);
  assert.equal((await client.jobs()).length, 1);
  const blocked = await fetch(`${baseUrl}/api/demo/session`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'seller' }) });
  assert.equal(blocked.status, 403);
  const missingAuth = await fetch(`${baseUrl}/api/me`);
  assert.equal(missingAuth.status, 401);
  const noKey = await fetch(`${baseUrl}/api/orders`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: 'listing-codex', quantity: 10 }) });
  assert.equal((await noKey.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const badJson = await fetch(`${baseUrl}/api/demo/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
});
