/**
 * Cloudflare Pages Function: /daily-price
 * ─────────────────────────────────────────────────────────────────
 * Fetches today's AAA national average retail gasoline price.
 *
 * Strategy (waterfall — tries each in order until one succeeds):
 *  1. EIA Today in Energy page — republishes AAA daily retail price
 *     as static server-rendered HTML. Most reliable for CF Workers.
 *  2. AAA gas prices page — direct scrape with multiple patterns.
 *  3. GasBuddy national average page — additional fallback.
 *
 * Deploy: /functions/daily-price.js → yoursite.pages.dev/daily-price
 *
 * Response:
 * {
 *   price:      4.018,
 *   formatted:  "$4.018",
 *   date:       "2026-03-31",
 *   source:     "AAA",          // or "EIA/AAA", "GasBuddy"
 *   sourceUrl:  "https://...",
 *   fetchedAt:  "2026-03-31T..."
 * }
 * ─────────────────────────────────────────────────────────────────
 */

const CACHE_SECS = 1800; // 30 min edge cache

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Strategy 1: EIA Today in Energy (static HTML, republishes AAA daily) ──
async function tryEIATodayInEnergy() {
  const url = 'https://www.eia.gov/todayinenergy/prices.php';
  const res  = await fetch(url, { headers: HEADERS, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`EIA HTTP ${res.status}`);
  const html = await res.text();

  // EIA table has rows like: "Regular" ... "$4.018"
  // Pattern matches dollar amounts near "Regular" or "All grades" within ~500 chars
  const patterns = [
    // Matches table cell with "Regular" label followed by price in nearby cell
    /[Rr]egular[^$\d]{1,200}\$\s*([\d]+\.[\d]{2,3})/,
    // Matches "Gasoline" section with retail price
    /[Gg]asoline[^$\d]{1,300}\$\s*([\d]+\.[\d]{2,3})/,
    // Broad: any retail price in gas range
    /retail[^$\d]{1,100}\$([\d]+\.[\d]{2,3})/i,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= 2.0 && val <= 8.0) {
        return { price: val, source: 'EIA/AAA', sourceUrl: url };
      }
    }
  }
  throw new Error('EIA: price not found in page');
}

// ── Strategy 2: AAA direct scrape ──
async function tryAAA() {
  const url = 'https://gasprices.aaa.com/';
  const res  = await fetch(url, { headers: HEADERS, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`AAA HTTP ${res.status}`);
  const html = await res.text();

  const patterns = [
    // JSON embedded in page scripts: "national":{"regular":4.018}
    /"national"\s*:\s*\{[^}]*"regular"\s*:\s*([\d]+\.[\d]{2,3})/i,
    // data attribute or span with price
    /national[- ]average[^$\d]{0,200}\$\s*([\d]+\.[\d]{2,3})/i,
    // generic: dollar value near "average"
    /average[^$\d]{0,80}\$([\d]+\.[\d]{2,3})/i,
    // any dollar amount in plausible range (last resort)
    /\$([3-6]\.[\d]{3})/,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= 2.0 && val <= 8.0) {
        return { price: val, source: 'AAA', sourceUrl: url };
      }
    }
  }
  throw new Error('AAA: price not found in page');
}

// ── Strategy 3: GasBuddy national average ──
async function tryGasBuddy() {
  const url = 'https://www.gasbuddy.com/home';
  const res  = await fetch(url, { headers: HEADERS, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`GasBuddy HTTP ${res.status}`);
  const html = await res.text();

  const patterns = [
    /national[^$\d]{0,200}\$\s*([\d]+\.[\d]{2,3})/i,
    /"price"\s*:\s*"?\$?([\d]+\.[\d]{2,3})"?/i,
    /average[^$\d]{0,100}\$([\d]+\.[\d]{2,3})/i,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= 2.0 && val <= 8.0) {
        return { price: val, source: 'GasBuddy', sourceUrl: url };
      }
    }
  }
  throw new Error('GasBuddy: price not found in page');
}

// ── Main handler ──
export async function onRequestGet(context) {
  const cacheKey = new Request('https://gas-proxy-cache/daily-price-v2');
  const cache    = caches.default;

  // Edge cache hit
  const cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    r.headers.set('X-Cache', 'HIT');
    r.headers.set('Access-Control-Allow-Origin', '*');
    return r;
  }

  // Try strategies in waterfall order
  const strategies = [
    { name: 'EIA Today in Energy', fn: tryEIATodayInEnergy },
    { name: 'AAA Direct',          fn: tryAAA },
    { name: 'GasBuddy',            fn: tryGasBuddy },
  ];

  let result   = null;
  const errors = [];

  for (const { name, fn } of strategies) {
    try {
      result = await fn();
      console.log(`[daily-price] Success via ${name}: $${result.price}`);
      break;
    } catch (err) {
      console.warn(`[daily-price] ${name} failed: ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (!result) {
    return new Response(JSON.stringify({
      error:     'All price sources failed',
      details:   errors,
      fetchedAt: new Date().toISOString(),
    }), {
      status: 503,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-store',
      },
    });
  }

  // Build today's date in ET
  const now    = new Date();
  const dateET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [mo, dy, yr] = dateET.split('/');
  const isoDate = `${yr}-${mo}-${dy}`;

  const payload = {
    price:      result.price,
    formatted:  `$${result.price.toFixed(3)}`,
    date:       isoDate,
    source:     result.source,
    sourceUrl:  result.sourceUrl,
    fetchedAt:  now.toISOString(),
    triedSources: errors.length > 0 ? errors : undefined,
  };

  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               `public, max-age=${CACHE_SECS}`,
      'X-Cache':                     'MISS',
      'X-Price-Source':              result.source,
    },
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age':       '86400',
    },
  });
}
