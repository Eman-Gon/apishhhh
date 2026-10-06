import { createMarketplaceClient } from '/demo/client.mjs';
const api = createMarketplaceClient({ baseUrl: location.origin });
const $ = id => document.getElementById(id);
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const number = n => n.toLocaleString('en-US');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let listings = [], providers = [], accounts = [], dashboard, selectedId, busy = false;
function notice(message, error = false) { $('notice').hidden = false; $('notice').className = error ? 'error' : ''; $('notice').textContent = message; }
function expiry(value) {
  const hours = (Date.parse(value) - Date.now()) / 3600000;
  return hours <= 0 ? 'Expired' : hours < 1 ? '< 1 hour' : hours < 48 ? `${Math.floor(hours)} hours` : `${Math.ceil(hours / 24)} days`;
}
function providerName(id) { return providers.find(p => p.id === id)?.name ?? id; }
function renderListings() {
  const term = $('search').value.toLowerCase();
  const rows = listings.filter(l => (!$('provider').value || l.providerId === $('provider').value)
    && ($('status').value === 'all' || l.status === $('status').value)
    && `${l.title} ${l.sellerName}`.toLowerCase().includes(term));
  $('result-count').textContent = rows.length;
  $('listings').innerHTML = rows.length ? rows.map(l => `<tr class="${l.id === selectedId ? 'selected' : ''}"><td><strong>${escape(providerName(l.providerId))}</strong><small>${escape(l.sellerName)}</small></td><td class="numeric">${number(l.availableUnits)}</td><td class="numeric">${money(l.pricePer1000Cents)}</td><td>${expiry(l.expiresAt)}</td><td><span class="tag ${l.status}">${escape(l.status.replace('_', ' '))}</span></td><td><button class="secondary" data-select="${escape(l.id)}">View</button></td></tr>`).join('') : '<tr><td colspan="6">No listings match these filters.</td></tr>';
}
function renderTicket() {
  const l = listings.find(l => l.id === selectedId);
  if (!l) return;
  $('ticket-title').textContent = providerName(l.providerId);
  const canBuy = l.status === 'active' && dashboard?.user.role === 'buyer';
  $('ticket-content').innerHTML = `<div class="ticket-meta"><span>${escape(l.title)}</span><span>Seller <b>${escape(l.sellerName)}</b></span><span><b>${number(l.availableUnits)}</b> units available · ${expiry(l.expiresAt)}</span><span><b>${money(l.pricePer1000Cents)}</b> per 1,000 demo units</span></div><form id="buy-form"><label>Units to purchase<input id="quantity" type="number" min="1" max="${l.availableUnits}" step="1" value="${Math.min(1000, l.availableUnits)}" ${canBuy ? '' : 'disabled'} required></label><div class="total"><span>Demo total</span><strong id="total">—</strong></div><button id="buy" ${canBuy && !busy ? '' : 'disabled'}>${dashboard?.user.role === 'seller' ? 'Switch to a buyer to purchase' : l.status === 'active' ? 'Buy demo usage' : 'Listing unavailable'}</button></form><p class="note">Purchases reserve simulated usage. No money is charged and no provider account is connected.</p>`;
  $('quantity').addEventListener('input', updateTotal);
  $('buy-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canBuy) return;
    const quantity = Number($('quantity').value);
    await perform(async () => {
      const order = await api.buy(l.id, quantity);
      notice(`Purchased ${number(quantity)} ${providerName(l.providerId)} demo units for ${money(order.amountCents)}. Run a task in your usage allocations below.`);
    });
  });
  updateTotal();
}
function updateTotal() {
  const l = listings.find(l => l.id === selectedId);
  const quantity = Number($('quantity')?.value);
  if ($('total')) $('total').textContent = Number.isSafeInteger(quantity) && quantity > 0 ? money(Math.ceil(quantity * l.pricePer1000Cents / 1000)) : '—';
}
function renderDashboard() {
  $('wallet-label').textContent = dashboard.user.role === 'seller' ? 'Demo seller earnings' : 'Demo wallet';
  $('wallet').textContent = money(dashboard.walletCents);
  $('activity-title').textContent = dashboard.user.role === 'seller' ? 'Your sales and earnings' : 'Your usage allocations';
  const orders = dashboard.user.role === 'seller' ? dashboard.sales : dashboard.orders;
  $('orders').innerHTML = orders.length ? orders.slice(0, 15).map(o => {
    const l = listings.find(l => l.id === o.listingId);
    const isExpired = l && Date.parse(l.expiresAt) <= Date.now();
    const canRun = dashboard.user.role === 'buyer' && o.status === 'active' && !isExpired;
    const canRefund = dashboard.user.role === 'buyer' && o.status === 'active';
    return `<article class="order"><div class="order-info"><strong>${escape(providerName(l?.providerId ?? ''))} <span class="tag ${escape(o.status)}">${escape(o.status)}${isExpired && o.status === 'active' ? ' · expired' : ''}</span></strong><p>${number(o.remainingUnits)} / ${number(o.quantity)} units remaining · ${money(o.escrowCents)} unused value</p><p>${dashboard.user.role === 'seller' ? `${money(o.releasedCents - o.platformFeeCents)} earned` : `${money(o.amountCents)} purchased`} · ${money(o.refundedCents)} refunded</p></div>${dashboard.user.role === 'buyer' ? `<div class="order-actions"><button data-run="${escape(o.id)}" ${canRun && !busy ? '' : 'disabled'}>Use ${number(Math.min(1000, o.remainingUnits))} units</button><button class="secondary" data-refund="${escape(o.id)}" ${canRefund && !busy ? '' : 'disabled'}>Refund unused</button></div>` : ''}</article>`;
  }).join('') : '<div class="empty">No purchases yet. Choose a listing to try the flow, or select a seeded account to explore its history.</div>';
}
async function refresh() {
  const [nextListings, nextDashboard, summary] = await Promise.all([api.listings(undefined, 'all'), api.me(), api.summary()]);
  listings = nextListings; dashboard = nextDashboard;
  $('stats').innerHTML = [[summary.activeListingCount, 'Available listings', `${summary.listingCount} total`], [summary.providerCount, 'Example providers', 'all simulated'], [summary.sellerCount, 'Demo sellers', `${summary.buyerCount} buyers`], [summary.orderCount, 'Purchases recorded', `${summary.jobCount} jobs`]].map(([value, label, note]) => `<div class="stat"><span>${label}</span><strong>${number(value)}</strong><small>${note}</small></div>`).join('');
  renderListings(); renderTicket(); renderDashboard();
}
async function perform(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  $('account').disabled = true;
  try { await action(); } catch (error) { notice(error.message, true); }
  finally {
    busy = false; $('account').disabled = false; $('refresh').disabled = false;
    try { await refresh(); } catch (error) { notice(`Could not refresh: ${error.message}`, true); }
  }
}
$('listings').addEventListener('click', event => {
  const button = event.target.closest('[data-select]');
  if (button && !busy) { selectedId = button.dataset.select; renderListings(); renderTicket(); }
});
$('orders').addEventListener('click', async event => {
  const run = event.target.closest('[data-run]');
  const refund = event.target.closest('[data-refund]');
  if (run) await perform(async () => {
    const o = dashboard.orders.find(o => o.id === run.dataset.run);
    const job = await api.runJob(o.id, 'Build a sample pricing page for the hackathon demo', Math.min(1000, o.remainingUnits));
    notice(`${job.output.text} Seller earned ${money(job.sellerPayoutCents)} in demo funds.`);
  });
  else if (refund) await perform(async () => {
    const order = await api.cancelOrder(refund.dataset.refund);
    notice(`Refunded ${money(order.refundedCents)} in unused demo funds.`);
  });
});
for (const key of ['provider', 'status', 'search']) $(key).addEventListener(key === 'search' ? 'input' : 'change', renderListings);
$('refresh').addEventListener('click', () => perform(async () => {}));
$('account').addEventListener('change', () => perform(async () => {
  const account = accounts.find(a => a.id === $('account').value);
  await api.signInDemo(account.role, account.id);
  $('notice').hidden = true;
}));
try {
  [providers, accounts] = await Promise.all([api.providers(), api.accounts()]);
  $('provider').innerHTML += providers.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
  $('account').innerHTML = accounts.map(a => `<option value="${escape(a.id)}">${escape(a.role === 'buyer' ? 'Buyer' : 'Seller')} · ${escape(a.name)}</option>`).join('');
  $('account').value = 'demo-buyer';
  $('connections').innerHTML = providers.map(p => `<article class="provider-card"><h3>${escape(p.name)}</h3><span class="tag">Not connected</span><p>${escape(p.description)}</p></article>`).join('');
  await api.signInDemo('buyer');
  await refresh();
  selectedId = listings.find(l => l.id === 'listing-codex' && l.status === 'active')?.id ?? listings.find(l => l.status === 'active')?.id;
  renderListings(); renderTicket();
} catch (error) { notice(`Could not load the demo: ${error.message}`, true); }
