import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ApiError, createMarket } from './market.mjs';

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];
const invalid = (status, code, message) => { throw new ApiError(status, code, message); };

async function readBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
    invalid(415, 'JSON_REQUIRED', 'Use Content-Type: application/json.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32768) invalid(413, 'BODY_TOO_LARGE', 'Request body exceeds 32 KB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { invalid(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
}

export function createApi({ market = createMarket(), origins = DEFAULT_ORIGINS } = {}) {
  const allowedOrigins = new Set(origins);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    try {
      const origin = req.headers.origin;
      if (origin) {
        const loopbackOrigins = [`http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`];
        if (!allowedOrigins.has(origin) && !loopbackOrigins.includes(origin)) invalid(403, 'ORIGIN_NOT_ALLOWED', 'This frontend origin is not configured.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      const key = req.headers['idempotency-key'];
      let result;
      let status = 200;
      if (method === 'GET' && path === '/health') result = market.health();
      else if (method === 'GET' && path === '/api/providers') result = market.providers();
      else if (method === 'GET' && path === '/api/demo/accounts') result = market.demoAccounts();
      else if (method === 'GET' && path === '/api/demo/summary') result = market.demoSummary();
      else if (method === 'GET' && path === '/api/listings') result = market.listings(url.searchParams.get('providerId'), url.searchParams.get('status') ?? 'active');
      else if (method === 'GET' && /^\/api\/listings\/[^/]+$/.test(path)) result = market.listing(path.split('/')[3]);
      else if (method === 'GET' && path === '/api/quote') result = market.quote(url.searchParams.get('listingId'), Number(url.searchParams.get('quantity')));
      else if (method === 'POST' && path === '/api/demo/session') { result = market.session(await readBody(req)); status = 201; }
      else {
        const user = market.authenticate(req.headers.authorization);
        if (method === 'GET' && path === '/api/me') result = market.dashboard(user);
        else if (method === 'GET' && path === '/api/jobs') result = market.jobs(user);
        else if (method === 'GET' && /^\/api\/orders\/[^/]+$/.test(path)) result = market.order(user, path.split('/')[3]);
        else if (method === 'POST' && path === '/api/listings') { result = market.createListing(user, await readBody(req), key); status = 201; }
        else if (method === 'POST' && path === '/api/orders') { result = market.purchase(user, await readBody(req), key); status = 201; }
        else if (method === 'POST' && path === '/api/jobs') { result = market.runJob(user, await readBody(req), key); status = 201; }
        else if (method === 'POST' && /^\/api\/listings\/[^/]+\/cancel$/.test(path)) {
          const body = await readBody(req);
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) invalid(400, 'INVALID_INPUT', 'Send an empty JSON object.');
          result = market.cancelListing(user, path.split('/')[3], key);
        } else if (method === 'POST' && /^\/api\/orders\/[^/]+\/cancel$/.test(path)) {
          const body = await readBody(req);
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) invalid(400, 'INVALID_INPUT', 'Send an empty JSON object.');
          result = market.cancelOrder(user, path.split('/')[3], key);
        } else invalid(404, 'NOT_FOUND', 'Route not found.');
      }
      send(status, { data: result, meta: { mode: 'demo' } });
    } catch (error) {
      const isKnown = error instanceof ApiError;
      if (!isKnown) console.error('API error:', error);
      send(isKnown ? error.status : 500, { error: { code: isKnown ? error.code : 'INTERNAL_ERROR', message: isKnown ? error.message : 'An unexpected server error occurred.' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, market };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const market = createMarket(resolve(process.env.DATABASE_PATH ?? './data/market.sqlite'));
  const { server } = createApi({ market, origins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_ORIGINS });
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`Demo marketplace API: http://${host}:${port}\nSQLite persistence enabled. Provider calls and payments are simulated.`));
  server.on('error', error => { console.error(error.message); market.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { market.close(); process.exit(0); });
    server.closeIdleConnections();
  });
}
