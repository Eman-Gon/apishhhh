PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  wallet_cents INTEGER NOT NULL DEFAULT 0 CHECK(wallet_cents >= 0)
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  seller_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  unlisted_units INTEGER NOT NULL CHECK(unlisted_units >= 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (seller_id, provider_id)
);
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL REFERENCES providers(id), title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  available_units INTEGER NOT NULL CHECK(available_units >= 0),
  price_per_1000_cents INTEGER NOT NULL CHECK(price_per_1000_cents > 0),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'cancelled'))
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  remaining_units INTEGER NOT NULL CHECK(remaining_units >= 0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  released_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  CHECK(released_cents + refunded_cents <= amount_cents)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  buyer_id TEXT NOT NULL REFERENCES users(id), units INTEGER NOT NULL CHECK(units > 0),
  prompt TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  actor_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
  PRIMARY KEY(actor_id, key)
);
CREATE INDEX IF NOT EXISTS listing_provider ON listings(provider_id, status);
CREATE INDEX IF NOT EXISTS order_buyer ON orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS job_buyer ON jobs(buyer_id, created_at);
CREATE TABLE IF NOT EXISTS seed_runs (
  name TEXT PRIMARY KEY, completed_at TEXT NOT NULL
);
PRAGMA user_version = 2;
