export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  // Clean and validate symbols
  const rawSyms = symbols.split(',').slice(0, 40).map(s => s.trim()).filter(Boolean);

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };

  // Get crumb
  let crumb = '', cookieHeader = '';
  try {
    const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: HEADERS, signal: AbortSignal.timeout(5000)
    });
    if (cr.ok) {
      crumb = await cr.text();
      const sc = cr.headers.get('set-cookie') || '';
      const cm = sc.match(/A3=[^;]+/);
      if (cm) cookieHeader = cm[0];
    }
  } catch(e) {}

  const authHeaders = { ...HEADERS, ...(cookieHeader ? { Cookie: cookieHeader } : {}) };

  // Try batch first, fall back to individual chart calls
  const result = await fetchBatch(rawSyms, crumb, authHeaders);

  // For any missing symbols, try individual chart API
  const missing = rawSyms.filter(s => !result[s]);
  if (missing.length > 0) {
    await Promise.all(missing.map(async (sym) => {
      const data = await fetchChart(sym, authHeaders);
      if (data) result[sym] = data;
    }));
  }

  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=5');
  return res.json({ ok: true, data: result, timestamp: new Date().toISOString() });
}

async function fetchBatch(syms, crumb, headers) {
  const result = {};
  try {
    const symStr = syms.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symStr}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,regularMarketChange,fiftyDayAverage,twoHundredDayAverage`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return result;
    const data = await r.json();
    const quotes = data?.quoteResponse?.result || [];

    // Fetch spark for 1W/1M/RSI
    let sparkMap = {};
    try {
      const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symStr}&range=1mo&interval=1d&crumb=${encodeURIComponent(crumb)}`;
      const sr = await fetch(sparkUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (sr.ok) {
        const sd = await sr.json();
        (sd?.spark?.result || []).forEach(s => {
          const closes = s?.response?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
          if (closes.length > 1) {
            const now = closes[closes.length-1], w1 = closes[Math.max(0,closes.length-6)], m1 = closes[0];
            sparkMap[s.symbol] = {
              closes,
              change1w: w1 ? (now-w1)/w1*100 : null,
              change1m: m1 ? (now-m1)/m1*100 : null,
            };
          }
        });
      }
    } catch(e) {}

    quotes.forEach(q => {
      const spark = sparkMap[q.symbol] || {};
      result[q.symbol] = {
        price: q.regularMarketPrice,
        change: q.regularMarketChangePercent,
        changeAmt: q.regularMarketChange,
        volume: q.regularMarketVolume,
        pe: q.trailingPE,
        high52: q.fiftyTwoWeekHigh,
        low52: q.fiftyTwoWeekLow,
        name: q.shortName || q.symbol,
        ma50: q.fiftyDayAverage,
        ma200: q.twoHundredDayAverage,
        change1w: spark.change1w ?? null,
        change1m: spark.change1m ?? null,
        sparkData: (spark.closes || []).slice(-30),
        rsi: calcRSI(spark.closes || [], 14),
      };
    });
  } catch(e) {}
  return result;
}

async function fetchChart(sym, headers) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1mo`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta || {};
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
    if (!meta.regularMarketPrice && !closes.length) return null;
    const now = closes[closes.length-1] || meta.regularMarketPrice;
    const w1 = closes[Math.max(0,closes.length-6)];
    const m1 = closes[0];
    return {
      price: meta.regularMarketPrice || now,
      change: meta.regularMarketChangePercent || null,
      changeAmt: null,
      volume: meta.regularMarketVolume || null,
      pe: null,
      high52: meta.fiftyTwoWeekHigh || null,
      low52: meta.fiftyTwoWeekLow || null,
      name: meta.shortName || meta.longName || sym,
      ma50: null, ma200: null,
      change1w: w1 ? (now-w1)/w1*100 : null,
      change1m: m1 ? (now-m1)/m1*100 : null,
      sparkData: closes.slice(-30),
      rsi: calcRSI(closes, 14),
    };
  } catch(e) { return null; }
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses+=Math.abs(d);
  }
  const ag=gains/period, al=losses/period;
  if (al===0) return 100;
  return Math.round(100-(100/(1+ag/al)));
}
