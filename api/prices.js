// Vercel serverless function — /api/prices?symbols=RKLB,PLTR,III.L
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const syms = symbols.split(',').slice(0, 30).join(',');

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };

  try {
    // Step 1 — get a crumb + cookie from Yahoo
    const cookieResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: HEADERS,
      signal: AbortSignal.timeout(6000),
    });

    let crumb = '';
    let cookieHeader = '';

    if (cookieResp.ok) {
      crumb = await cookieResp.text();
      const setCookies = cookieResp.headers.get('set-cookie') || '';
      // Extract A3 or similar session cookie
      const cookieMatch = setCookies.match(/A3=[^;]+/);
      if (cookieMatch) cookieHeader = cookieMatch[0];
    }

    // If crumb fetch failed, try alternate crumb endpoint
    if (!crumb) {
      const altResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: HEADERS,
        signal: AbortSignal.timeout(6000),
      });
      if (altResp.ok) {
        crumb = await altResp.text();
        const setCookies = altResp.headers.get('set-cookie') || '';
        const cookieMatch = setCookies.match(/A3=[^;]+/);
        if (cookieMatch) cookieHeader = cookieMatch[0];
      }
    }

    const authHeaders = {
      ...HEADERS,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };

    // Step 2 — fetch quotes
    const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,regularMarketChange,fiftyDayAverage,twoHundredDayAverage`;

    const quoteResp = await fetch(quoteUrl, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8000),
    });

    if (!quoteResp.ok) {
      // Try v8 chart API as fallback for individual symbols
      return await fallbackChartAPI(syms, authHeaders, res);
    }

    const quoteData = await quoteResp.json();
    const quotes = quoteData?.quoteResponse?.result || [];

    if (!quotes.length) {
      return await fallbackChartAPI(syms, authHeaders, res);
    }

    // Step 3 — fetch spark data for 1W/1M changes + RSI
    const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=1mo&interval=1d&crumb=${encodeURIComponent(crumb)}`;
    let sparkMap = {};

    try {
      const sparkResp = await fetch(sparkUrl, {
        headers: authHeaders,
        signal: AbortSignal.timeout(8000),
      });
      if (sparkResp.ok) {
        const sparkData = await sparkResp.json();
        const sparks = sparkData?.spark?.result || [];
        sparks.forEach(s => {
          const closes = s?.response?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
          if (closes.length > 1) {
            const now = closes[closes.length - 1];
            const w1ago = closes[Math.max(0, closes.length - 6)];
            const m1ago = closes[0];
            sparkMap[s.symbol] = {
              closes,
              change1w: w1ago ? ((now - w1ago) / w1ago * 100) : null,
              change1m: m1ago ? ((now - m1ago) / m1ago * 100) : null,
            };
          }
        });
      }
    } catch(e) {}

    // Step 4 — combine
    const result = buildResult(quotes, sparkMap);
    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=5');
    return res.json({ ok: true, data: result, timestamp: new Date().toISOString() });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// Fallback: use v8 chart API per symbol (works without crumb for many symbols)
async function fallbackChartAPI(syms, headers, res) {
  const symbols = syms.split(',');
  const result = {};

  await Promise.all(symbols.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1mo`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta || {};
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
      const now = closes[closes.length - 1];
      const w1ago = closes[Math.max(0, closes.length - 6)];
      const m1ago = closes[0];
      const rsi = calcRSI(closes, 14);

      result[sym] = {
        price: meta.regularMarketPrice || now,
        change: meta.regularMarketChangePercent,
        changeAmt: null,
        volume: meta.regularMarketVolume,
        pe: null,
        high52: meta.fiftyTwoWeekHigh,
        low52: meta.fiftyTwoWeekLow,
        name: meta.shortName || meta.longName || sym,
        ma50: null,
        ma200: null,
        change1w: w1ago ? ((now - w1ago) / w1ago * 100) : null,
        change1m: m1ago ? ((now - m1ago) / m1ago * 100) : null,
        sparkData: closes.slice(-30),
        rsi,
      };
    } catch(e) {}
  }));

  return res.json({ ok: true, data: result, timestamp: new Date().toISOString(), source: 'chart' });
}

function buildResult(quotes, sparkMap) {
  const result = {};
  quotes.forEach(q => {
    const spark = sparkMap[q.symbol] || {};
    const closes = spark.closes || [];
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
      sparkData: closes.slice(-30),
      rsi: calcRSI(closes, 14),
    };
  });
  return result;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return Math.round(100 - (100 / (1 + avgGain / avgLoss)));
}
