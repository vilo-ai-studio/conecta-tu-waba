import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const areas=['postventa','legal','contable','pld','garantias','entregas','cancelaciones'];
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('area references, immutable reservations, duplicates, missing routes and restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tania-router-test-'));
 const conversations=new Map(), messages=new Map();
 const legacyClient=`lab-${randomUUID()}`,legacyId=randomUUID();
 const legacyDb=new DatabaseSync(join(root,'router.sqlite'));
 legacyDb.exec('CREATE TABLE handoffs (client TEXT, id TEXT, phone TEXT, ref TEXT, state TEXT, revision INTEGER DEFAULT 1, fingerprint TEXT, PRIMARY KEY(client,id))');
 legacyDb.prepare('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?)').run(legacyClient,legacyId,'5210000000000','1','human_active',1,'synthetic');
 legacyDb.close();
 conversations.set(50,{id:1,status:'open'});
 messages.set(50,[{id:99,message_type:1,private:false,content:'Legacy synthetic reply'}]);
 let creates=0;
 const mock=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const account=Number(url.pathname.split('/')[4]);
  const path=url.pathname.split('/').slice(5).join('/');
  let raw='';for await(const chunk of req) raw+=chunk;
  const body=raw?JSON.parse(raw):null;
  let result={};
  if(path==='teams') result=[];
  else if(path==='contacts/search') result={payload:[]};
  else if(path==='contacts'&&body) result={payload:{contact:{id:1,contact_inboxes:[{inbox:{id:account},source_id:'source'}]}}};
  else if(path==='contacts/1/conversations') result={payload:conversations.has(account)?[conversations.get(account)]:[]};
  else if(path==='conversations'&&body) {creates++;result={id:1,...body};conversations.set(account,result);}
  else if(path==='conversations/1') result={...conversations.get(account),status:'open'};
  else if(path==='conversations/1/messages') {
   const rows=messages.get(account)||[];
   if(body){result={id:rows.length+1,...body};rows.push(result);messages.set(account,rows);}
   else result={payload:rows};
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 });
 const mockPort=await listen(mock);
 const reservation=createServer();const port=await listen(reservation);
 await new Promise(resolve=>reservation.close(resolve));
 const cfg={version:2,token:'synthetic-token',routes:Object.fromEntries(areas.map((area,i)=>[area,
  {account_id:i+1,inbox_id:i+1,team_id:i+1}]))};
 cfg.legacy={account_id:50,inbox_id:50,teams:{postventa:50},token:'synthetic-legacy-token'};
 const save=()=>writeFileSync(join(root,'chatwoot.json'),JSON.stringify(cfg));save();
 let child;
 const start=async()=>{
  child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'tania-local-router.mjs')],{
   env:{...process.env,PORT:String(port),LOCAL_ROUTER_STATE_DIR:root,
    LOCAL_ROUTER_SECRET:'synthetic-test-secret',LOCAL_CHATWOOT_URL:`http://127.0.0.1:${mockPort}`},
   stdio:'ignore',
  });
  for(let i=0;i<80;i++) {try {if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await pause(50);}
  throw new Error('test_router_not_ready');
 };
 const stop=async()=>{if(child&&!child.killed){child.kill();await new Promise(resolve=>child.once('exit',resolve));}};
 const call=async(body)=>fetch(`http://127.0.0.1:${port}/api/public/tania/handoffs`,{
  method:'POST',headers:{'Content-Type':'application/json','X-N8N-Webhook-Secret':'synthetic-test-secret','Idempotency-Key':body.handoff_id},
  body:JSON.stringify(body),
 });
 try {
  await start();
  const legacyResponse=await fetch(`http://127.0.0.1:${port}/api/public/tania/handoffs?client_id=${legacyClient}&handoff_id=${legacyId}`,{headers:{'X-N8N-Webhook-Secret':'synthetic-test-secret'}});
  const legacySnapshot=await legacyResponse.json();
  assert.equal(legacySnapshot.external_ref,'1');assert.equal(legacySnapshot.human_messages[0].message_id,'99');
  const base={client_id:`lab-${randomUUID()}`,conversation_id:'5210000000000',summary:'Sintético',history:[]};
  const first={...base,handoff_id:randomUUID(),team:'postventa'};
  const second={...base,handoff_id:randomUUID(),team:'legal'};
  const firstResult=await (await call(first)).json(),secondResult=await (await call(second)).json();
  assert.equal(firstResult.external_ref,'cw:1:1');assert.equal(secondResult.external_ref,'cw:2:1');
  assert.equal((await call({...first,summary:'changed'})).status,409);
  const duplicates=await Promise.all([call(first),call(first),call(first)]);
  assert.ok(duplicates.every(r=>r.ok));assert.equal(creates,2);
  cfg.routes.legal={account_id:999,inbox_id:999,team_id:999};delete cfg.routes.pld;save();
  assert.equal((await (await call(second)).json()).external_ref,'cw:2:1');
  assert.equal((await call({...base,handoff_id:randomUUID(),team:'pld'})).status,422);
  cfg.routes.pld={account_id:4,inbox_id:4,team_id:4};save();
  await stop();await start();
  assert.equal((await (await call(second)).json()).external_ref,'cw:2:1');assert.equal(creates,2);
  const wrong=await fetch(`http://127.0.0.1:${port}/api/public/tania/handoffs`,{method:'POST',body:'{}'});
  assert.equal(wrong.status,401);
 } finally {await stop();await new Promise(resolve=>mock.close(resolve));rmSync(root,{recursive:true,force:true});}
});
