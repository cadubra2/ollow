require('dotenv').config();
const axios = require('axios');
const Database = require('better-sqlite3');
const db = new Database('conversations.db');
const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const apiHeaders = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
};

const stmt = db.prepare("INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET moskit_id = excluded.moskit_id, name = excluded.name, raw_data = excluded.raw_data, updated_at = datetime('now')");

(async () => {
  let nextToken = '';
  let total = 0;
  let importados = 0;
  while (true) {
    const params = {};
    if (nextToken) params.nextPageToken = nextToken;
    const res = await axios.get(MOSKIT_BASE + '/contacts', { params, headers: apiHeaders, validateStatus: s => s < 500 });
    const contatos = res.data || [];
    if (!contatos.length) break;
    for (const c of contatos) {
      const phones = c.phones || [];
      for (const p of phones) {
        let num = String(p.number || '').replace(/\D/g, '');
        if (num.length >= 10) {
          if (num.length > 13) num = num.slice(-13);
          stmt.run(num, c.id, c.name || '', JSON.stringify(c));
          importados++;
        }
      }
    }
    total += contatos.length;
    const headers = res.headers;
    nextToken = headers['x-moskit-listing-next-page-token'] || headers['x-ollow-listing-next-page-token'] || '';
    if (!nextToken || contatos.length < 10) break;
    if (total % 500 === 0) console.log('  ' + total + ' contatos, ' + importados + ' telefones');
  }
  console.log('Total: ' + total + ' contatos, ' + importados + ' telefones importados');
  const count = db.prepare('SELECT COUNT(*) as t FROM moskit_contacts').get();
  console.log('Total no banco moskit_contacts: ' + count.t);
  db.close();
})();
