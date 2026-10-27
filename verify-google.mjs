// Explicit live check: creates a clearly labelled test record, never real contacts.
import assert from 'node:assert/strict';
const url=process.env.SHEETS_URL, key=process.env.SHEETS_API_KEY;
if(!url || !key) throw new Error('Missing private environment settings');
async function call(body) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,key}),signal:AbortSignal.timeout(45000)});
  let data;
  try { data=await response.json(); } catch { throw new Error('Google returned a non-JSON response; check deployment access'); }
  if(!response.ok || !data.ok) throw new Error('Google storage check failed: '+String(data.error||response.status));
  return data;
}
await call({action:'health'});
console.log('Google connection: OK');
if(process.argv.includes('--queue')) {
  const queued=await call({action:'list',kind:'leads',limit:10});
  assert(queued.records.some(r=>r.id==='cloud-queue-test-2026-10-27'),'Cloud queue test has not arrived yet');
  console.log('Deployed Cloudflare Worker delivered queued application to Google: OK');
  process.exit(0);
}
const record={id:'integration-test-2026-10-27',created_at:new Date().toISOString(),chat_id:'TEST',username:'test',name:'ТЕСТ ПОДКЛЮЧЕНИЯ — не клиент',phone:'не настоящий номер',method:'Проверка записи и чтения',status:'Тест'};
await call({action:'append',kind:'leads',records:[record]});
const leads=await call({action:'list',kind:'leads',limit:10});
assert(leads.records.some(r=>r.id===record.id && r.name===record.name));
console.log('Test application saved and read back: OK');
await call({action:'append',kind:'messages',records:[{id:'integration-message-2026-10-27',created_at:record.created_at,chat_id:'TEST',username:'test',type:'text',text:'ТЕСТ ПОДКЛЮЧЕНИЯ — проверка сохранения сообщения'}]});
const messages=await call({action:'list',kind:'messages',limit:10});
assert(messages.records.some(r=>r.id==='integration-message-2026-10-27'));
console.log('Test message saved and read back: OK');
