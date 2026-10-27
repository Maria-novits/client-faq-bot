// Cloudflare Worker. Secrets belong in the Cloudflare dashboard, never here.
const FAQ = {
  "dates": "Для записи доступны даты с 1 января по 1 апреля 2027 года, время — с 10:00 до 21:00. Чтобы согласовать конкретное время, отправьте /contact. Заявка не означает подтверждённую запись.",
  "prices": "Наш прайс:\n• Наращивание до длины 3 включительно — 2 500 ₽.\n• Наращивание длины 4 — 2 800 ₽.\n• Наращивание большей длины — от 2 800 до 4 000 ₽, зависит от длины.\n• Коррекция гелем — 2 000 ₽.\n• Снятие материала — 500 ₽.\n• Дизайн одного ногтя — 50 ₽ (фольга, втирка, градиент, мрамор, поталь).",
  "address": "Наш адрес: г. Пятигорск, ул. Московская, 56.",
  "fallback": "Пока я умею отвечать только на эти вопросы: свободные даты, стоимость и адрес. Оставьте свои контакты, мы скоро свяжемся с Вами. Отправьте /contact: я спрошу имя, номер телефона и предпочтительный способ связи — звонок или сообщение (WhatsApp, Telegram)."
};
const MENU = { keyboard: [[{text:'Запись'}, {text:'Прайс'}, {text:'Адрес'}]], resize_keyboard:true };
export function answer(text = '') {
  const t = text.toLowerCase().replaceAll('ё','е');
  if (/цен|стоим|прайс|сколько|наращив|коррекц|сняти|дизайн/.test(t)) return FAQ.prices;
  if (/адрес|находит|находят|где|добраться/.test(t)) return FAQ.address;
  if (/дат|окош|окна|время|свобод|когда|запис/.test(t)) return FAQ.dates;
  return FAQ.fallback;
}
async function api(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    signal:AbortSignal.timeout(15000)
  });
  const result = await r.json();
  if (!r.ok || !result.ok) throw new Error('Telegram request failed');
  return result.result;
}
async function init(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (chat TEXT PRIMARY KEY, step TEXT NOT NULL, name TEXT, phone TEXT, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS processed (id INTEGER PRIMARY KEY, expires INTEGER NOT NULL)')
  ]);
}
function sheetsEnabled(env) { return Boolean(env.SHEETS_URL && env.SHEETS_API_KEY); }
async function initOutbox(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS sheets_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)').run();
}
export function safeLogText(text, env) {
  let value=String(text || '');
  if (/^\s*\/owner(?:@\w+)?(?:\s|$)/i.test(value)) return '[Команда привязки скрыта]';
  for (const secret of [env.BOT_TOKEN,env.SETUP_CODE,env.WEBHOOK_SECRET,env.SHEETS_API_KEY]) {
    if (secret) value=value.split(secret).join('[СЕКРЕТ СКРЫТ]');
  }
  return value.slice(0,8000);
}
async function sheetRequest(env, body) {
  const url=new URL(env.SHEETS_URL);
  if(url.origin!=='https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search) throw new Error('Invalid Sheets endpoint');
  const r=await fetch(url.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,key:env.SHEETS_API_KEY}),redirect:'follow',signal:AbortSignal.timeout(20000)});
  const data=await r.json();
  if(!r.ok || data.ok!==true) throw new Error('Sheets unavailable');
  return data;
}
async function queueRecord(env,kind,record) {
  await env.DB.prepare('INSERT OR IGNORE INTO sheets_outbox (id,kind,payload) VALUES (?,?,?)').bind(record.id,kind,JSON.stringify(record)).run();
}
export async function flushSheets(env) {
  if(!sheetsEnabled(env)) return;
  await initOutbox(env.DB);
  const {results}=await env.DB.prepare('SELECT id,kind,payload FROM sheets_outbox ORDER BY rowid LIMIT 20').all();
  for(const kind of ['messages','leads']) {
    const rows=results.filter(r=>r.kind===kind);
    if(!rows.length) continue;
    const result=await sheetRequest(env,{action:'append',kind,records:rows.map(r=>JSON.parse(r.payload))});
    if(!Array.isArray(result.accepted)) throw new Error('Missing acknowledgement');
    const accepted=new Set(result.accepted);
    const deletes=rows.filter(r=>accepted.has(r.id)).map(r=>env.DB.prepare('DELETE FROM sheets_outbox WHERE id=?').bind(r.id));
    if(deletes.length) await env.DB.batch(deletes);
  }
}
async function attemptFlush(env) { try { await flushSheets(env); } catch { /* Keep pending records; no sensitive logging. */ } }
const setupPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Подключение Telegram-бота</title><body style="max-width:600px;margin:60px auto;padding:20px;font:18px system-ui"><h1>Подключение бота</h1><p>Токен сюда вводить не нужно. Он хранится в закрытых настройках Cloudflare.</p><form method="post" action="/setup"><label>Секретный код настройки <input type="password" name="code" required minlength="16" autocomplete="off"></label><p><button>Подключить Telegram</button></p></form></body></html>`;
function response(text, status=200, html=false) {
  return new Response(text,{status,headers:{'Content-Type':html?'text/html; charset=utf-8':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"}});
}
export default {
  async scheduled(event,env,ctx) { ctx.waitUntil(attemptFlush(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method==='GET' && url.pathname==='/setup') return response(setupPage,200,true);
    if (request.method==='GET') return response('Telegram FAQ bot.');
    if (!env.BOT_TOKEN || !env.SETUP_CODE || env.SETUP_CODE.length<16 || !env.WEBHOOK_SECRET || !env.DB) return response('Настройка ещё не завершена.',503);
    try {
      if (url.pathname==='/setup' && request.method==='POST') {
        const origin = request.headers.get('Origin');
        // A same-origin form can send Origin: null under no-referrer policy.
        // The setup code remains mandatory; explicit foreign origins are rejected.
        if ((origin && origin !== 'null' && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return response('Forbidden',403);
        const form = await request.formData();
        if (form.get('code')!==env.SETUP_CODE) return response('Неверный код.',403);
        await init(env.DB);
        const me = await api(env,'getMe',{});
        if (me.username?.toLowerCase()!=='pyatynailcreatorbot') return response('Токен относится к другому боту. Проверьте BOT_TOKEN.',400);
        await api(env,'setWebhook',{url:`${url.origin}/telegram`, secret_token:env.WEBHOOK_SECRET, max_connections:1, allowed_updates:['message'], drop_pending_updates:false});
        await api(env,'setMyCommands',{commands:[{command:'start',description:'Вопросы и ответы'},{command:'contact',description:'Оставить контакты мастеру'},{command:'cancel',description:'Отменить ввод контактов'}]});
        return response('Telegram подключён! Откройте @pyatynailcreatorbot и отправьте /owner, пробел, затем ваш секретный код настройки. После подтверждения отправьте /start.');
      }
      if (url.pathname!=='/telegram' || request.method!=='POST') return response('Not found',404);
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.WEBHOOK_SECRET) return response('Forbidden',403);
      const u = await request.json();
      if (!Number.isSafeInteger(u.update_id)) return response('Bad request',400);
      const done = await env.DB.prepare('SELECT id FROM processed WHERE id=?').bind(u.update_id).first();
      if (done) return response('OK');
      const m=u.message;
      if(sheetsEnabled(env)) {
        await initOutbox(env.DB);
        if(m?.chat?.type==='private') {
          const type=m.text?'text':m.contact?'contact':m.photo?'photo':m.voice?'voice':m.document?'document':'other';
          const raw=m.text || m.caption || (m.contact?`Контакт: ${m.contact.first_name || ''} ${m.contact.phone_number || ''}`:`[${type}]`);
          await queueRecord(env,'messages',{id:`message:${u.update_id}`,created_at:new Date((m.date||Math.floor(Date.now()/1000))*1000).toISOString(),chat_id:String(m.chat.id),username:m.from?.username||'',type,text:safeLogText(raw,env)});
        }
      }
      if (m?.chat?.type==='private') await handleMessage(m,env);
      const now=Math.floor(Date.now()/1000);
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO processed (id,expires) VALUES (?,?)').bind(u.update_id,now+172800),
        env.DB.prepare('DELETE FROM processed WHERE expires < ?').bind(now),
        env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now)
      ]);
      if(sheetsEnabled(env)) {
        if(ctx) ctx.waitUntil(attemptFlush(env)); else await attemptFlush(env);
      }
      return response('OK');
    } catch {
      // Never log request bodies, phone numbers, setup codes, tokens or API URLs.
      return response('Временная ошибка. Повторите позже.',500);
    }
  }
};
async function handleMessage(m,env) {
  const db=env.DB, id=String(m.chat.id), text=String(m.text||'').trim();
  const send=(chat,t)=>api(env,'sendMessage',{chat_id:chat,text:t,reply_markup:MENU});
  const now=Math.floor(Date.now()/1000);
  let owner=await db.prepare("SELECT value FROM config WHERE key='owner'").first();
  if (!owner && text===`/owner ${env.SETUP_CODE}`) {
    await db.prepare("INSERT OR IGNORE INTO config (key,value) VALUES ('owner',?)").bind(id).run();
    owner=await db.prepare("SELECT value FROM config WHERE key='owner'").first();
    if(owner.value===id) await send(id,'Готово! Заявки будут приходить вам в этот чат. Отправьте /start для проверки бота.');
    return;
  }
  if (!owner) { await send(id,'Бот пока настраивается. Пожалуйста, зайдите позже.'); return; }
  if(text==='/leads' || text==='/messages') {
    if(id!==owner.value) { await send(id,'Просмотр данных доступен только мастеру.'); return; }
    if(!sheetsEnabled(env)) { await send(id,'Google-таблица ещё не подключена.'); return; }
    try {
      await attemptFlush(env);
      const kind=text==='/leads'?'leads':'messages';
      const result=await sheetRequest(env,{action:'list',kind,limit:5});
      if(!Array.isArray(result.records)) throw new Error('Invalid result');
      const lines=result.records.map(r=>kind==='leads'?`${r.created_at}\n${r.name}, ${r.phone}\n${r.method}\nСтатус: ${r.status}`:`${r.created_at} · ${r.username || r.chat_id}\n${r.text}`);
      await send(id,lines.length?lines.join('\n\n').slice(0,3900):'В таблице пока нет данных.');
    } catch { await send(id,'Не удалось прочитать Google-таблицу. Попробуйте позже.'); }
    return;
  }
  if (text==='/start' || text==='/cancel') {
    await db.prepare('DELETE FROM sessions WHERE chat=?').bind(id).run();
    await send(id,'Здравствуйте! Выберите «Запись», «Прайс» или «Адрес». Чтобы оставить имя и телефон для связи с мастером, отправьте /contact. Сообщения и заявки сохраняются в закрытой таблице мастера. Для отмены ввода: /cancel.');
    return;
  }
  if (text==='/contact' || text==='Оставить контакты') {
    await db.prepare("INSERT INTO sessions (chat,step,name,phone,expires) VALUES (?,'name','','',?) ON CONFLICT(chat) DO UPDATE SET step='name',name='',phone='',expires=excluded.expires").bind(id,now+86400).run();
    await send(id,'Отправляя контакты, вы передаёте их мастеру для связи по заявке. Как вас зовут? Для отмены: /cancel.'); return;
  }
  const s=await db.prepare('SELECT * FROM sessions WHERE chat=? AND expires>?').bind(id,now).first();
  if (!s) { await send(id,answer(text)); return; }
  if (s.step==='name') {
    if(text.length<2 || text.length>100) { await send(id,'Напишите имя текстом, от 2 до 100 символов.'); return; }
    await db.prepare("UPDATE sessions SET name=?,step='phone',expires=? WHERE chat=?").bind(text,now+86400,id).run();
    await send(id,'Напишите номер телефона с кодом страны, например +7 999 123-45-67.'); return;
  }
  if (s.step==='phone') {
    const phone=String(m.contact?.phone_number||text), digits=phone.replace(/\D/g,'');
    if(!/^\+?[\d\s()\-]{10,25}$/.test(phone) || digits.length<10 || digits.length>15) { await send(id,'Не удалось распознать номер. Напишите его с кодом страны.'); return; }
    await db.prepare("UPDATE sessions SET phone=?,step='method',expires=? WHERE chat=?").bind(phone,now+86400,id).run();
    await send(id,'Как удобнее связаться: звонок, сообщение в WhatsApp или сообщение в Telegram?'); return;
  }
  if(!/звон|сообщ|whats|ватс|вацап|телег|telegram/i.test(text) || text.length>200) { await send(id,'Укажите способ связи: звонок, WhatsApp или Telegram.'); return; }
  const who=m.from?.username?`@${m.from.username}`:`ID: ${id}`;
  if(sheetsEnabled(env)) await queueRecord(env,'leads',{id:`lead:${id}:${m.message_id}`,created_at:new Date().toISOString(),chat_id:id,username:m.from?.username||'',name:safeLogText(s.name,env),phone:safeLogText(s.phone,env),method:safeLogText(text,env),status:'Новая заявка'});
  await send(owner.value,`Новая заявка №${m.message_id} (чат ${id})\nИмя: ${s.name}\nТелефон: ${s.phone}\nСпособ связи: ${text}\nTelegram: ${who}`);
  await db.prepare('DELETE FROM sessions WHERE chat=?').bind(id).run();
  await send(id,'Спасибо! Ваши контакты переданы мастеру. Мы скоро свяжемся с вами. Дата и время записи согласовываются отдельно.');
}
