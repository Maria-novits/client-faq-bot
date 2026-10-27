import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { answer, flushSheets, safeLogText } from './worker.mjs';

test('Telegram webhook: authentication, setup, owner, FAQ and contact delivery', async () => {
  const sql = new DatabaseSync(':memory:');
  const db = {
    prepare(query) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sql.prepare(query).get(...args) || null; },
        async all() { return {results:sql.prepare(query).all(...args)}; },
        async run() { return sql.prepare(query).run(...args); }
      };
      return statement;
    },
    async batch(statements) { return Promise.all(statements.map(s=>s.run())); }
  };
  const env = {DB:db, BOT_TOKEN:'test-only', SETUP_CODE:'test-code-not-real-1234', WEBHOOK_SECRET:'test-webhook-secret',SHEETS_URL:'https://script.google.com/macros/s/test/exec',SHEETS_API_KEY:'test-sheets-secret'};
  const stored={messages:new Map(),leads:new Map()};
  let storageDown=false;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if(String(url).startsWith('https://script.google.com/')) {
      if(storageDown) throw new Error('simulated outage');
      const body=JSON.parse(options.body);
      assert.equal(body.key,env.SHEETS_API_KEY);
      if(body.action==='append') {
        body.records.forEach(r=>stored[body.kind].set(r.id,r));
        return Response.json({ok:true,accepted:body.records.map(r=>r.id)});
      }
      return Response.json({ok:true,records:[...stored[body.kind].values()].reverse().slice(0,5)});
    }
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({method, body});
    return Response.json({ok:true,result:method==='getMe'?{username:'pyatynailcreatorbot'}:true});
  };
  const origin='https://bot.example';
  let sequence=0;
  const message = async (text, chat=42) => {
    const update={update_id:++sequence,message:{message_id:sequence,chat:{id:chat,type:'private'},from:{username:'test_client'},text}};
    const request=()=>new Request(origin+'/telegram',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)});
    return {response:await worker.fetch(request(),env),request};
  };
  try {
    assert.equal((await worker.fetch(new Request(origin+'/telegram',{method:'POST',body:'{}'}),env)).status,403);
    const setupRequest = (source, site, code=env.SETUP_CODE) => new Request(origin+'/setup',{method:'POST',headers:{Origin:source,'Sec-Fetch-Site':site,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code})});
    assert.equal((await worker.fetch(setupRequest('https://foreign.example','cross-site'),env)).status,403);
    assert.equal((await worker.fetch(setupRequest('null','same-origin','wrong-code'),env)).status,403);
    const setup=await worker.fetch(setupRequest('null','same-origin'),env);
    assert.equal(setup.status,200);
    assert.equal(calls.find(c=>c.method==='setWebhook').body.max_connections,1);
    await message('/owner '+env.SETUP_CODE);
    assert.equal([...stored.messages.values()].at(-1).text,'[Команда привязки скрыта]');
    assert.equal((await db.prepare("SELECT value FROM config WHERE key='owner'").first()).value,'42');
    await message('/start',77);
    assert.deepEqual(calls.at(-1).body.reply_markup.keyboard[0].map(x=>x.text),['Запись','Прайс','Адрес']);
    for (const question of ['Запись','Свободные окошки?','Прайс','Сколько стоит?','Адрес','Где вы находитесь?']) {
      const r=await message(question,77);
      assert.equal(r.response.status,200);
      assert.equal(calls.at(-1).body.text,answer(question));
    }
    await message('/contact',77);
    await message('Анна',77);
    await message('нет номера',77);
    assert.match(calls.at(-1).body.text,/распознать/);
    await message('+7 999 123-45-67',77);
    const last=await message('Telegram',77);
    assert.equal(last.response.status,200);
    assert.equal(calls.at(-2).body.chat_id,'42');
    assert.match(calls.at(-2).body.text,/Анна/);
    assert.match(calls.at(-2).body.text,/\+7 999 123-45-67/);
    assert.equal(stored.leads.size,1);
    assert.equal([...stored.leads.values()][0].name,'Анна');
    assert.equal(await db.prepare('SELECT * FROM sessions WHERE chat=?').bind('77').first(),null);
    const count=calls.length;
    await worker.fetch(last.request(),env);
    assert.equal(calls.length,count,'Duplicate update must not send another message');
    await message('/contact',77);
    await message('/cancel',77);
    assert.equal(await db.prepare('SELECT * FROM sessions WHERE chat=?').bind('77').first(),null);
    await message('/leads',77);
    assert.match(calls.at(-1).body.text,/только мастеру/);
    await message('/leads',42);
    assert.match(calls.at(-1).body.text,/Анна/);
    await message('/messages',42);
    assert.notEqual(calls.at(-1).body.text,'Не удалось прочитать Google-таблицу. Попробуйте позже.');
    assert.equal(safeLogText('key '+env.BOT_TOKEN,env),'key [СЕКРЕТ СКРЫТ]');
    storageDown=true;
    assert.equal((await message('Адрес',77)).response.status,200);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sheets_outbox').first()).count,1);
    storageDown=false;
    await flushSheets(env);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sheets_outbox').first()).count,0);
  } finally { globalThis.fetch=originalFetch; sql.close(); }
});
