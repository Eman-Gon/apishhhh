import { providers, simulateJob } from './providers.mjs';

export const RICH_SEED_NAME = 'marketplace-rich-v1';
const sellerNames = ['Pivot Again Labs', 'Dead Sprint Studio', 'Ship Tomorrow', 'Runway Leftovers', 'Weekend Builders', 'Quiet Launch Co', 'Side Quest Systems', 'Draft Seven', 'Coffee Budget Labs', 'Almost Funded', 'Late Checkout', 'Spare Cycle Studio', 'Tiny Demo Factory', 'Never Shipped Inc', 'Sunday Deploy', 'Prototype Club', 'Half Built Labs', 'Night Shift Tools', 'Version Zero', 'Open Tab Studio', 'Pitch Deck Only', 'Last Minute Labs', 'Out of Stealth', 'One More Feature'];
const buyerNames = ['Indie Builder', 'Weekend Hacker', 'Launch Team', 'Research Desk', 'Student Studio', 'Prototype Crew', 'Design Partner', 'Batch Runner', 'App Workshop', 'Demo Day Team', 'Small Tools Co', 'Midnight Maker'];
const titles = ['Closing the laptop sale', 'Leftover launch budget', 'Deadline approaching', 'Prototype surplus', 'Weekend build stash', 'Unused sprint balance', 'Spare project allowance', 'Last-minute demo fuel'];
const prompts = ['Draft a demo onboarding screen', 'Summarize fictional support tickets', 'Outline a sample landing page', 'Write test cases for a toy app', 'Review a fictional product brief', 'Plan a demo search workflow'];

/** Additive, versioned demo fixtures. Never deletes or resets existing records. */
export function seedRichDemo(db, now = new Date()) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const iso = hours => new Date(now.getTime() + hours * 3600000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT name FROM seed_runs WHERE name=?').get(RICH_SEED_NAME)) {
      db.exec('COMMIT');
      return { applied: false, seed: RICH_SEED_NAME, message: 'Already seeded; existing balances and expirations preserved.' };
    }
    for (let i = 0; i < sellerNames.length; i++) {
      const sellerId = `seed-seller-${i + 1}`;
      run('INSERT INTO users VALUES (?, ?, ?, ?)', sellerId, sellerNames[i], 'seller', 0);
      for (const p of providers) run('INSERT INTO inventory VALUES (?, ?, ?, ?)', sellerId, p.id, 2_000_000, iso(90 * 24));
    }
    for (let i = 0; i < buyerNames.length; i++) run('INSERT INTO users VALUES (?, ?, ?, ?)', `seed-buyer-${i + 1}`, buyerNames[i], 'buyer', 10_000_000);
    const move = (userId, orderId, kind, amount, time) => {
      run('UPDATE users SET wallet_cents=wallet_cents+? WHERE id=?', amount, userId);
      run('INSERT INTO ledger(user_id, order_id, kind, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)', userId, orderId, kind, amount, time);
    };
    let orders = 0, jobs = 0;
    for (let pIndex = 0; pIndex < providers.length; pIndex++) {
      const p = providers[pIndex];
      for (let i = 0; i < 20; i++) {
        const listingId = `seed-${p.id}-${String(i + 1).padStart(2, '0')}`;
        const sellerId = `seed-seller-${(i + pIndex * 3) % sellerNames.length + 1}`;
        const buyerId = `seed-buyer-${(i + pIndex) % buyerNames.length + 1}`;
        const quantity = p.id === 'lovable' ? [500, 1000, 2500, 5000][i % 4] : [10000, 25000, 50000, 100000, 200000, 500000][i % 6];
        const price = p.id === 'lovable' ? [800, 1200, 1600, 2000][i % 4] : [25, 40, 65, 90, 125, 200][(i + pIndex) % 6];
        const expired = i === 16 || i === 17;
        const cancelledListing = i >= 18;
        const expiresAt = iso(expired ? -24 : [2, 8, 24, 48, 72, 168, 336, 720][i % 8]);
        run('INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', listingId, sellerId, p.id, `${p.name} · ${titles[i % titles.length]}`, quantity, quantity, price, expiresAt, iso(-168 + i), 'active');
        run('UPDATE inventory SET unlisted_units=unlisted_units-? WHERE seller_id=? AND provider_id=?', quantity, sellerId, p.id);

        // Six clean listings, partial allocations, completed and active sell-outs,
        // an expired allocation, a refunded order, and a cancelled listing with a live allocation.
        if ((i >= 6 && i <= 16) || i === 19) {
          const purchased = i >= 12 && i <= 15 ? quantity : Math.floor(quantity / 2);
          const consumed = [10, 12, 15].includes(i) ? purchased : Math.max(1, Math.floor(purchased / 4));
          const cancelledOrder = i === 11;
          const amount = Math.ceil(purchased * price / 1000);
          const released = Number(BigInt(amount) * BigInt(consumed) / BigInt(purchased));
          const fee = Math.floor(released / 10);
          const refund = cancelledOrder ? amount - released : 0;
          const remaining = cancelledOrder ? 0 : purchased - consumed;
          const status = cancelledOrder ? 'cancelled' : remaining ? 'active' : 'completed';
          const orderId = `order-${listingId}`;
          run('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', orderId, listingId, buyerId, purchased, remaining, amount, released, refund, fee, status, iso(-48));
          run('UPDATE listings SET available_units=available_units-? WHERE id=?', cancelledOrder ? consumed : purchased, listingId);
          move(buyerId, orderId, 'purchase', -amount, iso(-48));
          move(sellerId, orderId, 'usage_payout', released - fee, iso(-36));
          move('platform', orderId, 'platform_fee', fee, iso(-36));
          if (refund) move(buyerId, orderId, 'refund', refund, iso(-32));
          const prompt = prompts[(i + pIndex) % prompts.length];
          run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)', `job-${listingId}`, orderId, buyerId, consumed, prompt, JSON.stringify(simulateJob(p.id, prompt, consumed)), iso(-36));
          orders++; jobs++;
        }
        if (cancelledListing) {
          const { available_units: unsold } = db.prepare('SELECT available_units FROM listings WHERE id=?').get(listingId);
          run('UPDATE inventory SET unlisted_units=unlisted_units+? WHERE seller_id=? AND provider_id=?', unsold, sellerId, p.id);
          run("UPDATE listings SET available_units=0, status='cancelled' WHERE id=?", listingId);
        }
      }
    }
    run('INSERT INTO seed_runs VALUES (?, ?)', RICH_SEED_NAME, now.toISOString());
    db.exec('COMMIT');
    return { applied: true, seed: RICH_SEED_NAME, sellersAdded: sellerNames.length, buyersAdded: buyerNames.length, listingsAdded: providers.length * 20, ordersAdded: orders, jobsAdded: jobs };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
