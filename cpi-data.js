/**
 * Cloudflare Pages Function: /cpi-data
 * ─────────────────────────────────────────────────────────────────
 * Fetches the latest CPI-U (CUUR0000SA0) monthly data from the
 * BLS Public Data API v1 (no registration key required).
 *
 * Deploy location: /functions/cpi-data.js in your Pages repo.
 * Accessible at:   https://your-site.pages.dev/cpi-data
 *
 * Response shape:
 * {
 *   latestValue:  326.785,       // most recent CPI-U index (1982-84=100)
 *   latestPeriod: "2026-02",     // ISO year-month of latest reading
 *   baseLabel:    "Feb 2026",    // human-readable base period
 *   annualAvgs: {                // annual average CPI-U index values
 *     "1985": 107.6,
 *     ...
 *     "2024": 314.175,
 *     "2025": 319.5,             // estimated (Oct/Nov missing, gov shutdown)
 *   },
 *   fetchedAt: "2026-03-31T..."
 * }
 *
 * Cache: 6 hours (BLS releases monthly, no point fetching more often)
 * ─────────────────────────────────────────────────────────────────
 */

const BLS_API_URL  = 'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0';
const CACHE_SECS   = 21600; // 6 hours

// Hardcoded annual average CPI-U values (BLS CUUR0000SA0, 1982-84=100)
// Used as fallback if BLS API is unavailable
const ANNUAL_AVGS = {
  1985: 107.6,  1986: 109.6,  1987: 113.6,  1988: 118.3,  1989: 124.0,
  1990: 130.7,  1991: 136.2,  1992: 140.3,  1993: 144.5,  1994: 148.2,
  1995: 152.4,  1996: 156.9,  1997: 160.5,  1998: 163.0,  1999: 166.6,
  2000: 172.2,  2001: 177.1,  2002: 179.9,  2003: 184.0,  2004: 188.9,
  2005: 195.3,  2006: 201.6,  2007: 207.342, 2008: 215.303, 2009: 214.537,
  2010: 218.056, 2011: 224.939, 2012: 229.594, 2013: 232.957, 2014: 236.736,
  2015: 237.017, 2016: 240.007, 2017: 245.120, 2018: 251.107, 2019: 255.657,
  2020: 258.811, 2021: 270.970, 2022: 292.655, 2023: 304.702, 2024: 314.175,
  // 2025: estimated — Oct & Nov missing due to federal appropriations lapse
  // Available: Jan(317.671) Feb(319.082) Mar(319.799) Apr(321.221) May(320.084)
  //            Jun(319.267) Jul(320.388) Aug(320.979) Sep(324.800) Dec(319.786)
  2025: 320.308,
};

const FALLBACK_LATEST       = 326.785;  // Feb 2026 CPI-U
const FALLBACK_LATEST_PERIOD = '2026-02';

export async function onRequestGet(context) {
  const cacheKey = new Request('https://gas-proxy-cache/cpi-data');
  const cache    = caches.default;

  // ── Edge cache ──
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('X-Cache', 'HIT');
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
  }

  let latestValue  = FALLBACK_LATEST;
  let latestPeriod = FALLBACK_LATEST_PERIOD;
  let annualAvgs   = { ...ANNUAL_AVGS };
  let fromAPI      = false;

  try {
    // BLS Public API v1 — POST, no key needed (1000 queries/day)
    const blsRes = await fetch(BLS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seriesid: ['CUUR0000SA0'],
        startyear: '2020',
        endyear:   String(new Date().getFullYear()),
      }),
    });

    if (blsRes.ok) {
      const blsJson = await blsRes.json();
      const series  = blsJson?.Results?.series?.[0]?.data;

      if (Array.isArray(series) && series.length > 0) {
        // BLS returns newest-first
        const validRows = series.filter(r => r.value && r.value !== '-');

        // Most recent data point
        const newest = validRows[0];
        latestValue  = parseFloat(newest.value);
        // BLS period format: "M01".."M12" — convert to "YYYY-MM"
        const mo = newest.period.replace('M', '').padStart(2, '0');
        latestPeriod = `${newest.year}-${mo}`;

        // Recompute annual averages from API data for recent years
        const byYear = {};
        for (const row of validRows) {
          if (row.period === 'M13') continue; // M13 = annual avg BLS code
          const yr = parseInt(row.year);
          if (!byYear[yr]) byYear[yr] = [];
          byYear[yr].push(parseFloat(row.value));
        }
        for (const [yr, vals] of Object.entries(byYear)) {
          // Only overwrite if we have a full or near-full year
          if (vals.length >= 10) {
            annualAvgs[parseInt(yr)] = parseFloat(
              (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)
            );
          }
        }
        fromAPI = true;
      }
    }
  } catch (err) {
    console.warn('BLS API error, using fallback:', err.message);
  }

  // ── Format response ──
  const [yr, mo] = latestPeriod.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];
  const baseLabel = `${monthNames[parseInt(mo)-1]} ${yr}`;

  const payload = {
    latestValue,
    latestPeriod,
    baseLabel,
    annualAvgs,
    fromAPI,
    fetchedAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               `public, max-age=${CACHE_SECS}`,
      'X-Cache':                     'MISS',
      'X-CPI-Source':                fromAPI ? 'BLS API v1' : 'Hardcoded fallback',
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
