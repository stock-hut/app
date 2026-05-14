// Vercel serverless function — /api/prices?symbols=RKLB,PLTR,III.L
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const { symbols, range = '1mo' } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  const syms = symbols.split(',').slice(0, 30).join(',');

  try {
    // Fetch quotes
    const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,regularMarketChange,fiftyDayAverage,twoHundredDayAverage`;
    
    const quoteResp = await fetch(quoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com',
        'Origin': 'https://finance.yahoo.com'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!quoteResp.ok) throw new Error(`Yahoo quotes: ${quoteResp.status}`);
    const quoteData = await quoteResp.json();
    const quotes = quoteData?.quoteResponse?.result || [];

    // Fetch spark data for 1W/1M changes + RSI
    const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=${range}&interval=1d`;
    const sparkResp = await fetch(sparkUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.yahoo.com'
      },
      signal: AbortSignal.timeout(8000)
    });

    let sparkMap = {};
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

    // Combine and return
    const result = {};
    quotes.forEach(q => {
      const spark = sparkMap[q.symbol] || {};
      const closes = spark.closes || [];
      
      // Calculate RSI(14)
      let rsi = null;
      if (closes.length >= 15) {
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const diff = closes[i] - closes[i-1];
          if (diff > 0) gains += diff; else losses += Math.abs(diff);
        }
        const avgGain = gains / 14, avgLoss = losses / 14;
        rsi = avgLoss === 0 ? 100 : Math.round(100 - (100 / (1 + avgGain / avgLoss)));
      }

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
        rsi,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=5');
    return res.json({ ok: true, data: result, timestamp: new Date().toISOString() });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
