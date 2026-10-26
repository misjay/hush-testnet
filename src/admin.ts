// Operator commands. Usage:
//   npm run settle -- list                      markets with open positions
//   npm run settle -- <marketId> yes|no|void    settle one market by hand (Zcash-native markets, voids)
import { config } from './config.ts';
import { openDb } from './db.ts';
import { settleMarket, type Outcome } from './settle.ts';

const [cmd, outcome] = process.argv.slice(2);
const db = openDb(config.dbPath);

if (!cmd || cmd === 'list') {
  const rows = db.prepare(`
    SELECT m.id, m.source, m.question, m.end_date, m.resolved, COUNT(p.id) AS open
    FROM markets m JOIN positions p ON p.market_id = m.id AND p.status = 'open'
    GROUP BY m.id ORDER BY m.end_date`).all() as any[];
  if (!rows.length) console.log('No markets have open positions.');
  for (const r of rows) console.log(`${r.id.padEnd(28)} ${r.source.padEnd(10)} ends ${String(r.end_date).slice(0, 10)}  open ${r.open}  ${r.question}`);
} else {
  if (!['yes', 'no', 'void'].includes(outcome)) {
    console.error('Give an outcome: yes, no or void. Example: npm run settle -- native-shielded-30 yes');
    process.exit(1);
  }
  const r = settleMarket(db, cmd, outcome as Outcome);
  console.log(`Settled ${r.marketId} as ${r.outcome}: ${r.won} won, ${r.lost} lost, ${r.refunded} refunded, $${(r.paid / 1e6).toFixed(2)} paid out.`);
}
