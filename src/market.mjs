import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { providers, simulateJob } from './providers.mjs';
import { seedRichDemo } from './seed-data.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const id = prefix => `${prefix}_${randomUUID()}`;
const integer = (value, name, max = 1_000_000_000) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    fail(400, 'INVALID_INPUT', `${name} must be an integer between 1 and ${max}.`);
  return value;
};
function string(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(400, 'INVALID_INPUT', `${name} must be nonempty text of at most ${max} characters.`);
  return value.trim();
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_INPUT', 'Expected a JSON object.');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(400, 'INVALID_INPUT', `Unexpected field: ${key}`);
}

export function createMarket(path = ':memory:', { now = () => new Date(), seed = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) { db.close(); throw new Error('Database is newer than this backend.'); }
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const timestamp = () => now().toISOString();
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  if (seed && !get('SELECT id FROM users LIMIT 1')) transaction(() => {
    run('INSERT INTO users VALUES (?, ?, ?, ?)', 'demo-seller', 'Demo seller', 'seller', 0);
    run('INSERT INTO users VALUES (?, ?, ?, ?)', 'demo-buyer', 'Demo buyer', 'buyer', 100_000);
    run('INSERT INTO users VALUES (?, ?, ?, ?)', 'platform', 'Marketplace', 'platform', 0);
    const expiry = new Date(now().getTime() + 30 * 86400000).toISOString();
    const quantities = { codex: 200_000, claude: 100_000, lovable: 5_000 };
    const prices = { codex: 100, claude: 250, lovable: 2000 };
    for (const p of providers) {
      run('INSERT INTO providers VALUES (?, ?, ?, ?)', p.id, p.name, p.product, p.description);
      if (!(p.id in quantities)) continue;
      run('INSERT INTO inventory VALUES (?, ?, ?, ?)', 'demo-seller', p.id, 0, expiry);
      run('INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        `listing-${p.id}`, 'demo-seller', p.id, `${quantities[p.id].toLocaleString('en-US')} ${p.name} demo credits`,
        quantities[p.id], quantities[p.id], prices[p.id], expiry, timestamp(), 'active');
    }
  });
  // Backfill catalog additions for existing databases without resetting user data.
  if (seed) transaction(() => {
    for (const p of providers) run('INSERT OR IGNORE INTO providers VALUES (?, ?, ?, ?)', p.id, p.name, p.product, p.description);
  });

  const listingView = l => ({
    id: l.id, sellerId: l.seller_id, sellerName: get('SELECT name FROM users WHERE id=?', l.seller_id)?.name,
    providerId: l.provider_id, title: l.title,
    quantity: l.quantity, availableUnits: l.available_units, pricePer1000Cents: l.price_per_1000_cents,
    currency: 'USD', expiresAt: l.expires_at, createdAt: l.created_at,
    status: l.status === 'cancelled' ? 'cancelled' : l.expires_at <= timestamp() ? 'expired' : l.available_units === 0 ? 'sold_out' : 'active',
    demo: true,
  });
  const orderView = o => ({
    id: o.id, listingId: o.listing_id, buyerId: o.buyer_id, quantity: o.quantity,
    remainingUnits: o.remaining_units, amountCents: o.amount_cents, releasedCents: o.released_cents,
    refundedCents: o.refunded_cents, escrowCents: o.amount_cents - o.released_cents - o.refunded_cents,
    platformFeeCents: o.fee_cents, status: o.status, createdAt: o.created_at, demo: true,
  });
  const ownedOrder = (user, orderId) => {
    const order = get('SELECT * FROM orders WHERE id=? AND buyer_id=?', orderId, user.id);
    if (!order) fail(404, 'NOT_FOUND', 'Order not found.');
    return order;
  };
  function movement(userId, orderId, kind, amount) {
    run('UPDATE users SET wallet_cents=wallet_cents+? WHERE id=?', amount, userId);
    run('INSERT INTO ledger(user_id, order_id, kind, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)', userId, orderId, kind, amount, timestamp());
  }
  function mutate(user, key, scope, body, fn) {
    if (typeof key !== 'string' || !/^[\w.:-]{1,128}$/.test(key))
      fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header (1–128 letters, digits, _, ., :, or -).');
    const fingerprint = hash(JSON.stringify({ scope, body }));
    return transaction(() => {
      const existing = get('SELECT * FROM idempotency WHERE actor_id=? AND key=?', user.id, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different request.');
        return JSON.parse(existing.response_json);
      }
      const result = fn();
      run('INSERT INTO idempotency VALUES (?, ?, ?, ?)', user.id, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  function activeListing(listingId) {
    const l = get('SELECT * FROM listings WHERE id=?', listingId);
    if (!l) fail(404, 'NOT_FOUND', 'Listing not found.');
    if (l.status !== 'active' || l.expires_at <= timestamp()) fail(409, 'LISTING_UNAVAILABLE', 'Listing is cancelled or expired.');
    return l;
  }
  function quote(listingId, quantity) {
    integer(quantity, 'quantity');
    const l = activeListing(listingId);
    if (quantity > l.available_units) fail(409, 'INSUFFICIENT_INVENTORY', 'Not enough units remain.');
    return { listingId, quantity, amountCents: Math.ceil(quantity * l.price_per_1000_cents / 1000), currency: 'USD', expiresAt: l.expires_at, demo: true };
  }
  return {
    close: () => db.close(),
    health: () => ({ mode: 'demo', database: 'ready', providerCallsEnabled: false, realPaymentsEnabled: false }),
    providers: () => providers.map(p => ({ ...p, integrationStatus: 'simulated', liveConnectionSupported: false, unit: 'demo_credit', transferable: false })),
    seedDemo: () => seedRichDemo(db, now()),
    demoAccounts: () => all("SELECT id, name, role FROM users WHERE role IN ('buyer', 'seller') ORDER BY CASE WHEN id LIKE 'demo-%' THEN 0 ELSE 1 END, role, name"),
    demoSummary() {
      const rows = all('SELECT * FROM listings').map(listingView);
      return {
        demo: true, providerCount: providers.length,
        sellerCount: get("SELECT count(*) AS n FROM users WHERE role='seller'").n,
        buyerCount: get("SELECT count(*) AS n FROM users WHERE role='buyer'").n,
        listingCount: rows.length, activeListingCount: rows.filter(l => l.status === 'active').length,
        orderCount: get('SELECT count(*) AS n FROM orders').n,
        jobCount: get('SELECT count(*) AS n FROM jobs').n,
        escrowCents: get('SELECT coalesce(sum(amount_cents-released_cents-refunded_cents), 0) AS n FROM orders').n,
        providers: providers.map(p => ({ id: p.id, name: p.name,
          listingCount: rows.filter(l => l.providerId === p.id).length,
          activeListingCount: rows.filter(l => l.providerId === p.id && l.status === 'active').length,
          availableUnits: rows.filter(l => l.providerId === p.id && l.status === 'active').reduce((sum, l) => sum + l.availableUnits, 0),
          integrationStatus: 'simulated' })),
        readiness: { persistence: true, transactionalCheckout: true, refunds: true, liveProviders: false, realPayments: false, productionAuth: false },
      };
    },
    session(body) {
      fields(body, ['role', 'userId']);
      if (!['buyer', 'seller'].includes(body.role)) fail(400, 'INVALID_INPUT', 'role must be buyer or seller.');
      const userId = body.userId === undefined ? `demo-${body.role}` : string(body.userId, 'userId');
      const user = get('SELECT id, name, role FROM users WHERE id=? AND role=?', userId, body.role);
      if (!user) fail(400, 'INVALID_INPUT', 'Choose an existing demo account with the matching role.');
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(now().getTime() + 24 * 3600000).toISOString();
      run('DELETE FROM sessions WHERE expires_at<=?', timestamp());
      run('INSERT INTO sessions VALUES (?, ?, ?)', hash(token), userId, expiresAt);
      return { token, expiresAt, user, demo: true };
    },
    authenticate(header) {
      if (!header?.startsWith('Bearer ')) fail(401, 'UNAUTHORIZED', 'A demo session is required.');
      const u = get('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', hash(header.slice(7)), timestamp());
      if (!u) fail(401, 'UNAUTHORIZED', 'Session is invalid or expired.');
      return u;
    },
    listings(providerId, status = 'active') {
      if (providerId && !providers.some(p => p.id === providerId)) fail(400, 'INVALID_INPUT', 'Unknown provider.');
      if (!['active', 'all'].includes(status)) fail(400, 'INVALID_INPUT', 'status must be active or all.');
      const rows = providerId ? all('SELECT * FROM listings WHERE provider_id=? ORDER BY created_at DESC', providerId) : all('SELECT * FROM listings ORDER BY created_at DESC');
      return rows.map(listingView).filter(l => status === 'all' || l.status === 'active');
    },
    listing(listingId) {
      const l = get('SELECT * FROM listings WHERE id=?', listingId);
      if (!l) fail(404, 'NOT_FOUND', 'Listing not found.');
      return listingView(l);
    },
    quote,
    dashboard(user) {
      const current = get('SELECT * FROM users WHERE id=?', user.id);
      return {
        user: { id: current.id, name: current.name, role: current.role }, walletCents: current.wallet_cents, currency: 'USD', demo: true,
        inventory: all('SELECT * FROM inventory WHERE seller_id=?', user.id).map(i => ({ providerId: i.provider_id, unlistedUnits: i.unlisted_units, expiresAt: i.expires_at })),
        listings: all('SELECT * FROM listings WHERE seller_id=? ORDER BY created_at DESC', user.id).map(listingView),
        orders: all('SELECT * FROM orders WHERE buyer_id=? ORDER BY created_at DESC', user.id).map(orderView),
        sales: all('SELECT o.* FROM orders o JOIN listings l ON o.listing_id=l.id WHERE l.seller_id=? ORDER BY o.created_at DESC', user.id).map(orderView),
        ledger: all('SELECT kind, amount_cents AS amountCents, order_id AS orderId, created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', user.id),
      };
    },
    createListing(user, body, key) {
      fields(body, ['providerId', 'title', 'quantity', 'pricePer1000Cents', 'expiresAt']);
      if (user.role !== 'seller') fail(403, 'FORBIDDEN', 'Only the demo seller can create listings.');
      string(body.providerId, 'providerId'); string(body.title, 'title');
      integer(body.quantity, 'quantity'); integer(body.pricePer1000Cents, 'pricePer1000Cents', 1_000_000);
      if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) fail(400, 'INVALID_INPUT', 'expiresAt must be an ISO timestamp.');
      const expiresAt = new Date(body.expiresAt).toISOString();
      return mutate(user, key, 'create-listing', body, () => {
        const inventory = get('SELECT * FROM inventory WHERE seller_id=? AND provider_id=?', user.id, body.providerId);
        if (!inventory) fail(400, 'INVALID_INPUT', 'No inventory exists for this provider.');
        if (expiresAt <= timestamp() || expiresAt > inventory.expires_at) fail(400, 'INVALID_EXPIRATION', 'Expiration must be in the future and no later than the inventory expiration.');
        if (inventory.unlisted_units < body.quantity) fail(409, 'INSUFFICIENT_INVENTORY', 'Not enough unlisted units. Cancel an existing listing to release unsold units.');
        const listingId = id('listing');
        run('UPDATE inventory SET unlisted_units=unlisted_units-? WHERE seller_id=? AND provider_id=?', body.quantity, user.id, body.providerId);
        run('INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', listingId, user.id, body.providerId, body.title.trim(), body.quantity, body.quantity, body.pricePer1000Cents, expiresAt, timestamp(), 'active');
        return listingView(get('SELECT * FROM listings WHERE id=?', listingId));
      });
    },
    cancelListing(user, listingId, key) {
      return mutate(user, key, `cancel-listing:${listingId}`, {}, () => {
        const l = get('SELECT * FROM listings WHERE id=? AND seller_id=?', listingId, user.id);
        if (!l) fail(404, 'NOT_FOUND', 'Listing not found.');
        if (l.status === 'cancelled') return listingView(l);
        run('UPDATE inventory SET unlisted_units=unlisted_units+? WHERE seller_id=? AND provider_id=?', l.available_units, user.id, l.provider_id);
        run("UPDATE listings SET available_units=0, status='cancelled' WHERE id=?", listingId);
        return listingView(get('SELECT * FROM listings WHERE id=?', listingId));
      });
    },
    purchase(user, body, key) {
      fields(body, ['listingId', 'quantity']); string(body.listingId, 'listingId'); integer(body.quantity, 'quantity');
      if (user.role !== 'buyer') fail(403, 'FORBIDDEN', 'Only the demo buyer can purchase usage.');
      return mutate(user, key, 'purchase', body, () => {
        const q = quote(body.listingId, body.quantity);
        const l = get('SELECT * FROM listings WHERE id=?', body.listingId);
        if (l.seller_id === user.id) fail(409, 'SELF_PURCHASE', 'You cannot purchase your own listing.');
        const wallet = get('SELECT wallet_cents FROM users WHERE id=?', user.id);
        if (wallet.wallet_cents < q.amountCents) fail(409, 'INSUFFICIENT_FUNDS', 'The demo wallet has insufficient funds.');
        const orderId = id('order');
        run('UPDATE listings SET available_units=available_units-? WHERE id=?', body.quantity, body.listingId);
        run('INSERT INTO orders(id, listing_id, buyer_id, quantity, remaining_units, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', orderId, body.listingId, user.id, body.quantity, body.quantity, q.amountCents, 'active', timestamp());
        movement(user.id, orderId, 'purchase', -q.amountCents);
        return orderView(get('SELECT * FROM orders WHERE id=?', orderId));
      });
    },
    order: (user, orderId) => orderView(ownedOrder(user, orderId)),
    runJob(user, body, key) {
      fields(body, ['orderId', 'prompt', 'units']); string(body.orderId, 'orderId'); string(body.prompt, 'prompt', 8000); integer(body.units, 'units');
      return mutate(user, key, 'run-job', body, () => {
        const o = ownedOrder(user, body.orderId);
        if (o.status !== 'active') fail(409, 'ORDER_INACTIVE', 'This order is no longer active.');
        const l = get('SELECT * FROM listings WHERE id=?', o.listing_id);
        if (l.expires_at <= timestamp()) fail(409, 'CREDITS_EXPIRED', 'These demo credits expired. Cancel the order to refund unused allocation.');
        if (body.units > o.remaining_units) fail(409, 'INSUFFICIENT_ALLOCATION', 'The job exceeds your remaining purchased units.');
        const output = simulateJob(l.provider_id, body.prompt, body.units);
        const remaining = o.remaining_units - body.units;
        const consumed = o.quantity - remaining;
        // Cumulative integer rounding makes chunked jobs settle to the same total.
        const released = Number(BigInt(o.amount_cents) * BigInt(consumed) / BigInt(o.quantity));
        const fees = Math.floor(released / 10);
        const sellerPayout = released - o.released_cents - (fees - o.fee_cents);
        movement(l.seller_id, o.id, 'usage_payout', sellerPayout);
        movement('platform', o.id, 'platform_fee', fees - o.fee_cents);
        run('UPDATE orders SET remaining_units=?, released_cents=?, fee_cents=?, status=? WHERE id=?', remaining, released, fees, remaining ? 'active' : 'completed', o.id);
        const jobId = id('job');
        run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)', jobId, o.id, user.id, body.units, body.prompt, JSON.stringify(output), timestamp());
        return { id: jobId, orderId: o.id, providerId: l.provider_id, status: 'completed', units: body.units, output, sellerPayoutCents: sellerPayout, order: orderView(get('SELECT * FROM orders WHERE id=?', o.id)), demo: true };
      });
    },
    jobs(user) {
      return all('SELECT * FROM jobs WHERE buyer_id=? ORDER BY created_at DESC LIMIT 100', user.id).map(j => ({ id: j.id, orderId: j.order_id, units: j.units, output: JSON.parse(j.output), createdAt: j.created_at, status: 'completed', demo: true }));
    },
    cancelOrder(user, orderId, key) {
      return mutate(user, key, `cancel-order:${orderId}`, {}, () => {
        const o = ownedOrder(user, orderId);
        if (o.status === 'cancelled') return orderView(o);
        if (o.status === 'completed') fail(409, 'ORDER_INACTIVE', 'Completed usage cannot be refunded.');
        const refund = o.amount_cents - o.released_cents;
        const l = get('SELECT * FROM listings WHERE id=?', o.listing_id);
        if (l.status === 'active') run('UPDATE listings SET available_units=available_units+? WHERE id=?', o.remaining_units, l.id);
        else run('UPDATE inventory SET unlisted_units=unlisted_units+? WHERE seller_id=? AND provider_id=?', o.remaining_units, l.seller_id, l.provider_id);
        movement(user.id, o.id, 'refund', refund);
        run("UPDATE orders SET status='cancelled', remaining_units=0, refunded_cents=? WHERE id=?", refund, o.id);
        return orderView(get('SELECT * FROM orders WHERE id=?', o.id));
      });
    },
  };
}
