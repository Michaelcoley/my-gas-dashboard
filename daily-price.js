/**
 * Cloudflare Pages Function: /daily-price
 * ─────────────────────────────────────────────────────────────────
 * Proxies the AAA Fuel Gauge Report daily national average retail
 * gasoline price and returns clean JSON to the dashboard HTML.
 *
 * Deploy location: /functions/daily-price.js in your Pages repo.
 * Accessible at:   https://your-site.pages.dev/daily-price
 *
 * Response shape:
 * {
 *   price:      4.018,          // national avg, regular unleaded
 *   formatted:  "$4.018",
 *   date:       "2026-03-31",   // ISO date string (today)
 *   source:     "AAA",
 *   sourceUrl:  "https://gasprices.aaa.com/",
 *   fetchedAt:  "2026-03-31T14:22:00.000Z"
 * }
 *
 * Cache: Cloudflare edge cache for 30 minutes so AAA is not hammered.
 * ─────────────────────────────────────────────────────────────────
 */

const AAA_URL     = 'https://gasprices.aaa.com/';
const CACHE_SECS  = 1800; // 30 minutes

export async function onRequestGet(context) {
  const cacheKey = new Request('https://gas-proxy-cache/daily-price');
  const cache    = caches.default;

  // ── Try Cloudflare edge cache first ──
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('X-Cache', 'HIT');
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
  }

  try {
    // ── Fetch AAA page ──
    const aaa = await fetch(AAA_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GasPriceDashboard/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      cf: { cacheTtl: 0 }, // bypass CF cache on the outbound leg
    });

    if (!aaa.ok) {
      throw new Error(`AAA returned HTTP ${aaa.status}`);
    }

    const html = await aaa.text();

    // ── Parse the national average price ──
    // AAA renders: "Today's AAA National Average $4.018" in multiple places.
    // We try multiple patterns in order of specificity.
    let price = null;

    const patterns = [
      // Pattern 1: price inside a dedicated price-display element
      /class="[^"]*price-display[^"]*"[^>]*>\s*\$?([\d]+\.[\d]{2,3})/i,
      // Pattern 2: "National Average" followed by dollar amount
      /national\s+average[^$]*\$([\d]+\.[\d]{2,3})/i,
      // Pattern 3: generic dollar amount near "average"
      /average[^$\d]{0,60}\$([\d]+\.[\d]{2,3})/i,
      // Pattern 4: any dollar value in the $2–$9 range (fallback)
      /\$([3-6]\.[\d]{2,3})/,
    ];

    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        const val = parseFloat(m[1]);
        if (val >= 1.5 && val <= 10) { // sanity bounds
          price = val;
          break;
        }
      }
    }

    if (!price) {
      throw new Error('Could not parse price from AAA page');
    }

    // ── Build today's date string (ET, where AAA is based) ──
    const now    = new Date();
    const dateET = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const [m2, d2, y2] = dateET.split('/');
    const isoDate = `${y2}-${m2}-${d2}`;

    const payload = {
      price,
      formatted:  `$${price.toFixed(3)}`,
      date:       isoDate,
      source:     'AAA',
      sourceUrl:  AAA_URL,
      fetchedAt:  now.toISOString(),
    };

    const body = JSON.stringify(payload);

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               `public, max-age=${CACHE_SECS}`,
        'X-Cache':                     'MISS',
        'X-Price-Source':              'AAA Fuel Gauge Report',
      },
    });

    // Store in Cloudflare edge cache
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;

  } catch (err) {
    // ── Graceful error — client falls back to EIA weekly ──
    return new Response(
      JSON.stringify({
        error:     err.message,
        source:    'AAA',
        fetchedAt: new Date().toISOString(),
      }),
      {
        status: 503,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'no-store',
        },
      }
    );
  }
}

// Handle preflight CORS
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
