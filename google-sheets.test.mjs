import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('Sheets bridge: reject unauthenticated access, deduplicate, store text safely, read back',()=>{
  const tables=new Map();
  let locked=false;
  const makeSheet=()=>{
    const rows=[];
    return {rows,getLastRow:()=>rows.length,setFrozenRows(){},setColumnWidths(){},setColumnWidth(){},
      getRange(start,col,count,width){
        const range={setValues(values){values.forEach((row,i)=>{rows[start-1+i]=row;});return range;},getValues(){return rows.slice(start-1,start-1+count).map(r=>r.slice(col-1,col-1+width));},getDisplayValues(){return range.getValues();},setFontWeight(){return range;},setBackground(){return range;},setNumberFormat(){return range;},setWrap(){return range;},createTextFinder(id){return {matchEntireCell(){return this;},findNext(){return rows.slice(start-1,start-1+count).some(r=>r[col-1]===id);}};}};
        return range;
      }
    };
  };
  const sheet={getId:()=> '1kFN0zD52uCkEYKQKTQRdmmNEPRCdcGH7yRLeZxZWYv4',getSheetByName:n=>tables.get(n),insertSheet(n){const s=makeSheet();tables.set(n,s);return s;}};
  const context=vm.createContext({
    SpreadsheetApp:{openById:()=>sheet,flush(){}},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'a'.repeat(32)})},
    LockService:{getScriptLock:()=>({tryLock(){locked=true;return true;},hasLock:()=>locked,releaseLock(){locked=false;}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:content=>({content,setMimeType(){return this;}})}
  });
  vm.runInContext(fs.readFileSync(new URL('./google-sheets.gs',import.meta.url),'utf8'),context);
  const call=body=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(body)}}).content);
  assert.equal(call({key:'wrong',action:'list',kind:'messages'}).error,'unauthorized');
  assert.equal(tables.size,0);
  const record={id:'message:123',created_at:'2026-10-27T00:00:00Z',chat_id:'77',username:'client',type:'text',text:'=IMPORTXML("https://invalid.example")'};
  const body={key:'a'.repeat(32),action:'append',kind:'messages',records:[record]};
  assert.equal(call(body).ok,true);
  assert.equal(call(body).ok,true);
  assert.equal(tables.get('Сообщения').rows.length,2);
  const result=call({...body,action:'list',limit:5});
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].text[0],"'");
  assert.equal(locked,false);
  assert.equal(JSON.parse(context.doGet().content).service,'client-faq-sheets');
});
