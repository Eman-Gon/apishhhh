/** Browser-compatible integration helper. No provider credentials are needed. */
export function createMarketplaceClient({ baseUrl = 'http://127.0.0.1:8787', token: initialToken } = {}) {
  let token = initialToken;
  async function request(path, { method = 'GET', body, key } = {}) {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error?.message ?? 'Request failed');
      error.code = payload.error?.code;
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }
  const post = (path, body, key = crypto.randomUUID()) => request(path, { method: 'POST', body, key });
  return {
    async signInDemo(role, userId) {
      const session = await request('/api/demo/session', { method: 'POST', body: { role, ...(userId ? { userId } : {}) } });
      token = session.token;
      return session;
    },
    setToken(value) { token = value; },
    providers: () => request('/api/providers'),
    accounts: () => request('/api/demo/accounts'),
    summary: () => request('/api/demo/summary'),
    listings: (providerId, status = 'active') => request(`/api/listings?${new URLSearchParams({ ...(providerId ? { providerId } : {}), status })}`),
    listing: listingId => request(`/api/listings/${encodeURIComponent(listingId)}`),
    quote: (listingId, quantity) => request(`/api/quote?${new URLSearchParams({ listingId, quantity: String(quantity) })}`),
    me: () => request('/api/me'),
    createListing: (listing, key) => post('/api/listings', listing, key),
    cancelListing: (listingId, key) => post(`/api/listings/${encodeURIComponent(listingId)}/cancel`, {}, key),
    buy: (listingId, quantity, key) => post('/api/orders', { listingId, quantity }, key),
    order: orderId => request(`/api/orders/${encodeURIComponent(orderId)}`),
    runJob: (orderId, prompt, units, key) => post('/api/jobs', { orderId, prompt, units }, key),
    cancelOrder: (orderId, key) => post(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {}, key),
    jobs: () => request('/api/jobs'),
  };
}
