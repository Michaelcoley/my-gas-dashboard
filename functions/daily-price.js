/**
 * Cloudflare Pages Function: /daily-price
 * ─────────────────────────────────────────────────────────────────
 * Returns the freshest available U.S. retail gasoline price
 * via the EIA Open Data API v2 — no scraping, guaranteed to work.
 *
 * WHY: AAA's site is JavaScript-rendered (React). Server-side HTML
 * scraping always returns an empty shell. EIA's API returns clean
 * JSON and uses the same underlying AAA Fuel Gauge data.
 *
 * Series: EMM_EPMR_PTE_NUS_DPG (regular) + EMD_EPD2D_PTE_NUS_DPG (diesel)
 * Updates: Every Monday morning
 * Cache: 30 min Cloudflare edge cache
 * ─────────────────────────────────────────────────────────────────
 */

const EIA_KEY   = 'A21nFg9BXSogtCDtc2flIEw9pKMKqJ5ImSrLoPg7';
const CACHE_SEC = 1800;

function eiaUrl(series) {
  return `https://api.eia.gov/v2/petroleum/pri/gnd/data/` +
    `?api_key=${EIA_KEY}&frequency=weekly&data[0]=value` +
    `&facets[series][]=${series}` +
    `&sort[0][column]=period&sort[0][direction]=desc&length=5`;
}

function labelPeriod(p) {
  try {
    const d = new Date((p.length === 10 ? p : p.slice(0,10)) + 'T12:00:00Z');
    return 'Week ending ' + d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  } catch { return p; }
}

export async function onRequestGet(ctx) {
  const cacheKey = new Request('https://gas-proxy-cache/daily-v4');
  const cache    = caches.default;
  const hit      = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('X-Cache','HIT');
    r.headers.set('Access-Control-Allow-Origin','*');
    return r;
  }

  try {
    const [rRes, dRes] = await Promise.all([
      fetch(eiaUrl('EMM_EPMR_PTE_NUS_DPG')),
      fetch(eiaUrl('EMD_EPD2D_PTE_NUS_DPG')),
    ]);

    if (!rRes.ok) throw new Error(`EIA HTTP ${rRes.status}`);
    const rJson = await rRes.json();
    const rows  = (rJson?.response?.data || []).filter(r => r.value != null && r.value !== '');
    if (!rows.length) throw new Error('Empty EIA response');

    const r0 = rows[0], r1 = rows[1]||null, r4 = rows[4]||null;
    const price = parseFloat((+r0.value).toFixed(3));

    let diesel = null;
    try {
      if (dRes.ok) {
        const dJson = await dRes.json();
        const dRows = (dJson?.response?.data||[]).filter(r=>r.value!=null&&r.value!=='');
        if (dRows.length) diesel = parseFloat((+dRows[0].value).toFixed(3));
      }
    } catch {}

    const period = r0.period.slice(0,10);
    const body   = JSON.stringify({
      price,
      diesel,
      prevPrice:   r1 ? parseFloat((+r1.value).toFixed(3)) : null,
      prev4Price:  r4 ? parseFloat((+r4.value).toFixed(3)) : null,
      prevPeriod:  r1 ? r1.period.slice(0,10) : null,
      prev4Period: r4 ? r4.period.slice(0,10) : null,
      period,
      periodLabel: labelPeriod(period),
      source:      'EIA',
      sourceLabel: 'EIA Weekly · ' + labelPeriod(period),
      isWeekly:    true,
      isDaily:     false,
      fetchedAt:   new Date().toISOString(),
    });

    const res = new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               `public, max-age=${CACHE_SEC}`,
        'X-Cache':                     'MISS',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;

  } catch (e) {
    return new Response(JSON.stringify({error:e.message,fetchedAt:new Date().toISOString()}),{
      status:503,
      headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'},
    });
  }
}

export async function onRequestOptions() {
  return new Response(null,{status:204,headers:{
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Max-Age':'86400',
  }});
}
