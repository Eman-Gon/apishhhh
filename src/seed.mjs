import { resolve } from 'node:path';
import { createMarket } from './market.mjs';
const market = createMarket(resolve(process.env.DATABASE_PATH ?? './data/market.sqlite'));
try {
  console.log(JSON.stringify({ seed: market.seedDemo(), summary: market.demoSummary() }, null, 2));
} finally { market.close(); }
