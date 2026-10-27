// Store INTEGRATION_KEY in Project Settings -> Script properties, never in code.
const TARGET_SHEET_ID = '1kFN0zD52uCkEYKQKTQRdmmNEPRCdcGH7yRLeZxZWYv4';
const TABLES = {
  messages: {name:'Сообщения', headers:['ID','Дата (UTC)','Telegram ID','Имя в Telegram','Тип','Сообщение'], fields:['id','created_at','chat_id','username','type','text']},
  leads: {name:'Заявки', headers:['ID','Дата (UTC)','Telegram ID','Имя в Telegram','Имя клиента','Телефон','Способ связи','Статус'], fields:['id','created_at','chat_id','username','name','phone','method','status']}
};
function json_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return json_({ok:true,service:'client-faq-sheets',version:1}); }
function target_() {
  const book = SpreadsheetApp.openById(TARGET_SHEET_ID);
  if (!book || book.getId() !== TARGET_SHEET_ID) throw new Error('Wrong spreadsheet');
  return book;
}
function sheet_(kind) {
  const spec=TABLES[kind], book=target_();
  let sheet=book.getSheetByName(spec.name);
  if (!sheet) sheet=book.insertSheet(spec.name);
  if (sheet.getLastRow()===0) {
    sheet.getRange(1,1,1,spec.headers.length).setValues([spec.headers]);
    sheet.getRange(1,1,1,spec.headers.length).setFontWeight('bold').setBackground('#e1edf7');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1,spec.headers.length,160);
    if(kind==='messages') sheet.setColumnWidth(6,420);
  }
  const headers=sheet.getRange(1,1,1,spec.headers.length).getValues()[0];
  if(headers.some((h,i)=>h!==spec.headers[i])) throw new Error('Existing sheet has different columns');
  return sheet;
}
function prepareSheets() { Object.keys(TABLES).forEach(sheet_); }
function plain_(value) {
  const s=String(value==null?'':value).slice(0,8000);
  // Prevent client text from becoming spreadsheet formulas.
  return /^[=+\-@\t\r\n]/.test(s) ? "'"+s : s;
}
function doPost(e) {
  let lock;
  try {
    if(!e || !e.postData || e.postData.contents.length>200000) return json_({ok:false,error:'invalid_request'});
    const body=JSON.parse(e.postData.contents);
    const key=PropertiesService.getScriptProperties().getProperty('INTEGRATION_KEY');
    if(!key || key.length<32 || body.key!==key) return json_({ok:false,error:'unauthorized'});
    if(body.action==='health') return json_({ok:true,service:'client-faq-sheets'});
    if(!TABLES[body.kind]) return json_({ok:false,error:'invalid_kind'});
    lock=LockService.getScriptLock();
    if(!lock.tryLock(20000)) return json_({ok:false,error:'busy'});
    const sheet=sheet_(body.kind), spec=TABLES[body.kind];
    if(body.action==='append') {
      const records=body.records;
      if(!Array.isArray(records) || records.length>20 || records.some(r=>!r || !/^[A-Za-z0-9:_-]{1,100}$/.test(String(r.id)))) return json_({ok:false,error:'invalid_records'});
      const accepted=[];
      for(const record of records) {
        const id=String(record.id);
        const exists=sheet.getLastRow()>1 && sheet.getRange(2,1,sheet.getLastRow()-1,1).createTextFinder(id).matchEntireCell(true).findNext();
        if(!exists) {
          const row=sheet.getRange(sheet.getLastRow()+1,1,1,spec.fields.length);
          row.setNumberFormat('@');
          row.setValues([spec.fields.map(f=>plain_(record[f]))]);
          row.setWrap(true);
        }
        accepted.push(id);
      }
      SpreadsheetApp.flush();
      return json_({ok:true,accepted});
    }
    if(body.action==='list') {
      const limit=Math.max(1,Math.min(10,Number(body.limit)||5));
      const count=Math.min(limit,Math.max(0,sheet.getLastRow()-1));
      const rows=count?sheet.getRange(sheet.getLastRow()-count+1,1,count,spec.fields.length).getDisplayValues():[];
      return json_({ok:true,records:rows.reverse().map(row=>Object.fromEntries(spec.fields.map((f,i)=>[f,row[i]])))});
    }
    return json_({ok:false,error:'invalid_action'});
  } catch { return json_({ok:false,error:'storage_error'}); }
  finally { if(lock && lock.hasLock()) lock.releaseLock(); }
}
