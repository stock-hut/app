// Vercel cron job — runs daily at 21:00 UK time (20:00 UTC)
// Calculates portfolio value and saves snapshot to Supabase

export const config = {
  maxDuration: 30
};

const SUPABASE_URL = 'https://wmuywxaglwcfqceppxll.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OWNER_ID = 'b2961b17-7626-4c90-9691-ecb8deca7ad8';
const BASELINE = 49423; // 2026 financial year start value
const FX_USD_GBP = 0.746;

export default async function handler(req, res) {
  // Allow manual trigger via GET with secret, or automated cron
  const isManual = req.query.trigger === process.env.CRON_SECRET;
  const isCron = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  if (!isManual && !isCron && req.method !== 'GET') {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  try {
    // 1 — Get all open trades for the owner
    const tradesResp = await fetch(
      `${SUPABASE_URL}/rest/v1/trades?user_id=eq.${OWNER_ID}&select=*&order=trade_date.asc`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const trades = await tradesResp.json();
    if (!trades || !trades.length) {
      return res.json({ ok: false, error: 'No trades found' });
    }

    // 2 — Calculate open positions
    const positions = {};
    trades.forEach(t => {
      const key = `${t.symbol}|${t.account}`;
      const isUK = t.symbol.endsWith('.L');
      const currency = isUK ? 'GBX' : 'USD';
      const price = parseFloat(t.price || 0);
      const shares = parseFloat(t.shares || 0);
      const priceGBP = currency === 'GBX' ? price / 100 : price * FX_USD_GBP;
      const totalGBP = shares * priceGBP;

      if (!positions[key]) positions[key] = { symbol: t.symbol, shares: 0, costBasis: 0, currency };
      if (t.action?.toLowerCase() === 'buy') {
        positions[key].shares += shares;
        positions[key].costBasis += totalGBP;
      } else if (t.action?.toLowerCase() === 'sell') {
        const prev = positions[key].shares;
        if (prev > 0) positions[key].costBasis -= positions[key].costBasis * (shares / prev);
        positions[key].shares -= shares;
      }
    });

    // Remove closed positions
    Object.keys(positions).forEach(k => {
      if (positions[k].shares <= 0.001) delete positions[k];
    });

    // 3 — Get live prices
    const symbols = [...new Set(Object.values(positions).map(p => p.symbol))];
    const priceResp = await fetch(
      `https://stockhut.co/api/prices?symbols=${symbols.join(',')}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const priceData = await priceResp.json();
    const prices = priceData?.data || {};

    // 4 — Calculate total portfolio value
    let totalValue = 0;
    Object.values(positions).forEach(p => {
      const raw = prices[p.symbol]?.price;
      if (!raw) return;
      const priceGBP = p.currency === 'GBX' ? raw / 100 : raw * FX_USD_GBP;
      totalValue += priceGBP * p.shares;
    });
    totalValue = Math.round(totalValue);

    // 5 — Get current cash balance from latest snapshot
    const cashResp = await fetch(
      `${SUPABASE_URL}/rest/v1/portfolio_snapshots?user_id=eq.${OWNER_ID}&select=cash_balance&order=snapshot_date.desc&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const cashData = await cashResp.json();
    const cashBalance = cashData?.[0]?.cash_balance || 0;

    // 6 — Build snapshot record
    const today = new Date();
    const snapshotDate = today.toISOString().slice(0, 10);
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayOfWeek = dayNames[today.getDay()];

    // Week number from 5 Jan 2026 (week 1)
    const weekStart = new Date('2026-01-05');
    const weekNum = Math.floor((today - weekStart) / (7 * 24 * 60 * 60 * 1000)) + 1;

    const gainVsBaseline = totalValue + cashBalance - BASELINE;

    // 7 — Upsert snapshot (handles duplicate dates)
    const upsertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/portfolio_snapshots`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          user_id: OWNER_ID,
          snapshot_date: snapshotDate,
          total_value: totalValue,
          cash_balance: cashBalance,
          gain_vs_baseline: gainVsBaseline,
          week_number: weekNum,
          day_of_week: dayOfWeek,
          notes: `Auto snapshot ${snapshotDate} ${dayOfWeek}`
        })
      }
    );

    if (!upsertResp.ok) {
      const err = await upsertResp.text();
      return res.status(500).json({ ok: false, error: err });
    }

    return res.json({
      ok: true,
      date: snapshotDate,
      day: dayOfWeek,
      week: weekNum,
      totalValue,
      cashBalance,
      gainVsBaseline,
      positionCount: Object.keys(positions).length
    });

  } catch(err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
