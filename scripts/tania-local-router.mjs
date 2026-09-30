// Router-owned LOCAL ONLY transport. Synthetic clients; real local Chatwoot; no Meta.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root = process.env.LOCAL_ROUTER_STATE_DIR || '/data';
mkdirSync(root, { recursive: true });
const db = new DatabaseSync(`${root}/router.sqlite`);
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS handoffs (client TEXT, id TEXT, phone TEXT, ref TEXT,
 state TEXT, revision INTEGER DEFAULT 1, fingerprint TEXT, PRIMARY KEY(client,id));
 CREATE TABLE IF NOT EXISTS messages (client TEXT, key TEXT, fingerprint TEXT, result TEXT,
 PRIMARY KEY(client,key));`);
const columns = new Set(db.prepare('PRAGMA table_info(handoffs)').all().map(c => c.name));
for (const [name, type] of Object.entries({account_id:'INTEGER', inbox_id:'INTEGER',
 team_id:'INTEGER', area:'TEXT', ref_format:'INTEGER DEFAULT 1'})) {
 if (!columns.has(name)) db.exec(`ALTER TABLE handoffs ADD COLUMN ${name} ${type}`);
}
const secret = process.env.LOCAL_ROUTER_SECRET || '';
if (secret.length < 16) throw new Error('local_router_secret_required');
const cwBase = process.env.LOCAL_CHATWOOT_URL || 'http://chatwoot:3000';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eq = (a,b) => {
 const x=Buffer.from(a), y=Buffer.from(b);
 return x.length===y.length && timingSafeEqual(x,y);
};
const fail = (code,status) => {throw Object.assign(new Error(code),{status});};
function config() {return JSON.parse(readFileSync(`${root}/chatwoot.json`, 'utf8'));}
function routeForRow(row) {
 const cfg=config();
 if (!row.account_id) {
  const legacy=cfg.legacy || cfg;
  if (!legacy.account_id) fail('legacy_route_missing',503);
  db.prepare('UPDATE handoffs SET account_id=?, inbox_id=?, team_id=?, area=? WHERE client=? AND id=?')
   .run(legacy.account_id,legacy.inbox_id,legacy.teams?.postventa || null,'legacy',row.client,row.id);
  row.account_id=legacy.account_id; row.inbox_id=legacy.inbox_id;
 }
 const legacy=cfg.legacy;
 const token=legacy?.account_id===row.account_id ? legacy.token : cfg.token;
 return {account_id:row.account_id,inbox_id:row.inbox_id,team_id:row.team_id,token};
}
function reference(row) {
 return row.ref_format===2 ? `cw:${row.account_id}:${row.ref}` : String(row.ref);
}
async function cw(route,path,body) {
 const res=await fetch(`${cwBase}/api/v1/accounts/${route.account_id}${path}`, {
  method:body===undefined?'GET':'POST',
  headers:{'content-type':'application/json',api_access_token:route.token},
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),
 });
 if (!res.ok) fail('chatwoot_rejected',res.status>=500||res.status===429?503:422);
 return res.json();
}
async function mirror(row,item,source) {
 const route=routeForRow(row);
 const messages=await cw(route,`/conversations/${row.ref}/messages`);
 if ((messages.payload||[]).some(m=>m.source_id===source || m.content_attributes?.tania_source_id===source)) return;
 await cw(route,`/conversations/${row.ref}/messages`,{
  content:item.body || '[sin texto]', message_type:item.direction==='inbound'?'incoming':'outgoing',
  private:false, source_id:source, content_attributes:{local_router:true,tania_source_id:source},
 });
}
async function snapshot(row) {
 const route=routeForRow(row);
 const conversation=await cw(route,`/conversations/${row.ref}`);
 const state=conversation.status==='resolved'?'resolved':'human_active';
 const revision=row.state===state?row.revision:row.revision+1;
 db.prepare('UPDATE handoffs SET state=?, revision=? WHERE client=? AND id=?')
  .run(state,revision,row.client,row.id);
 const messages=await cw(route,`/conversations/${row.ref}/messages`);
 const replies=(messages.payload||[]).filter(m=>
  (m.message_type===1 || m.message_type==='outgoing') && !m.private &&
  !m.content_attributes?.local_router && !m.content_attributes?.tania_source_id && !m.source_id && m.content
 ).map(m=>({message_id:row.ref_format===2?`${row.account_id}:${m.id}`:String(m.id),body:m.content.slice(0,2000)}));
 return {external_ref:reference(row),state,revision,human_messages:replies};
}
async function handoff(body) {
 const {client_id:client,handoff_id:id,conversation_id:phone}=body;
 if (!/^[0-9a-f-]{36}$/.test(id||'') || !/^521000\d{7}$/.test(phone||'')) fail('synthetic_only',400);
 const digest=hash(body);
 let row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(client,id);
 if (row && row.fingerprint!==digest) fail('idempotency_conflict',409);
 if (!row) {
  const area=({identidad:'postventa',documentos:'postventa',tickets:'postventa',garantia:'garantias',
   Postventa:'postventa'})[body.team] || body.team;
  const target=config().routes?.[area];
  if (!target?.account_id || !target.inbox_id || !target.team_id) fail('area_route_unmapped',422);
  db.prepare(`INSERT INTO handoffs(client,id,phone,state,fingerprint,account_id,inbox_id,team_id,area,ref_format)
   VALUES(?,?,?,?,?,?,?,?,?,2)`)
   .run(client,id,phone,'requested',digest,target.account_id,target.inbox_id,target.team_id,area);
  row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(client,id);
 }
 const route=routeForRow(row);
 if (!row.ref) {
  const identifier=`${client}:${phone}`;
  const found=await cw(route,`/contacts/search?q=${encodeURIComponent(identifier)}&include=contact_inboxes`);
  let contact=(found.payload||[]).find(c=>c.identifier===identifier);
  if (!contact) contact=(await cw(route,'/contacts',{
   inbox_id:route.inbox_id,name:'Cliente sintético',identifier,
  })).payload.contact;
  const existing=await cw(route,`/contacts/${contact.id}/conversations`);
  let conversation=(existing.payload||[]).find(c=>c.custom_attributes?.tania_handoff_id===id);
  if (!conversation) {
   let source=(contact.contact_inboxes||[]).find(i=>i.inbox?.id===route.inbox_id)?.source_id;
   if (!source) source=(await cw(route,`/contacts/${contact.id}/contact_inboxes`,{inbox_id:route.inbox_id})).source_id;
   conversation=await cw(route,'/conversations',{
    source_id:source,inbox_id:route.inbox_id,contact_id:contact.id,status:'open',team_id:route.team_id,
    custom_attributes:{tania_handoff_id:id,tania_area:row.area},
   });
  }
  row.ref=String(conversation.id);
  db.prepare('UPDATE handoffs SET ref=? WHERE client=? AND id=?').run(row.ref,client,id);
 }
 for (const item of body.history||[]) await mirror(row,item,`tania:${item.id}`);
 const notes=await cw(route,`/conversations/${row.ref}/messages`);
 if (!(notes.payload||[]).some(m=>m.content_attributes?.tania_source_id===`handoff-note:${id}`)) {
  await cw(route,`/conversations/${row.ref}/messages`,{
   content:body.summary||'Escalamiento tanIA',message_type:'outgoing',private:true,
   content_attributes:{local_router:true,tania_source_id:`handoff-note:${id}`},
  });
 }
 await cw(route,`/conversations/${row.ref}/assignments`,{team_id:route.team_id});
 db.prepare('UPDATE handoffs SET state=? WHERE client=? AND id=?').run('human_active',client,id);
 return {external_ref:reference(row),state:'human_active',revision:row.revision};
}
let chain=Promise.resolve();
createServer((req,res)=>{
 chain=chain.then(async()=>{
  try {
   const url=new URL(req.url,'http://localhost');
   if (url.pathname==='/health') {
    const cfg=config();
    for (const route of Object.values(cfg.routes||{})) await cw({...route,token:cfg.token},'/teams');
    if (Object.keys(cfg.routes||{}).length!==7) fail('areas_not_ready',503);
    res.writeHead(200);res.end('local-router-isolated-chatwoot');return;
   }
   if (!eq(req.headers['x-n8n-webhook-secret']||'',secret)) fail('invalid_secret',401);
   const chunks=[];let size=0;
   for await(const chunk of req) {size+=chunk.length;if(size>131072) fail('too_large',413);chunks.push(chunk);}
   const body=req.method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(Buffer.concat(chunks).toString());
   if (!/^lab-[0-9a-f-]{36}$/.test(body.client_id||'')) fail('synthetic_only',403);
   let result;
   if (url.pathname==='/api/public/tania/handoffs') {
    if (req.method==='POST') {
     if (!req.headers['idempotency-key']) fail('key_required',400);
     result=await handoff(body);
    } else if(req.method==='GET') {
     const row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(body.client_id,body.handoff_id);
     if (!row?.ref) fail('handoff_pending',409);
     result=await snapshot(row);
    } else fail('method_not_allowed',405);
   } else if(url.pathname==='/api/public/whatsapp/send-message' && req.method==='POST') {
    if (!/^521000\d{7}$/.test(body.to||'') || body.type!=='text') fail('synthetic_only',403);
    const key=req.headers['idempotency-key'];
    if (!key) fail('key_required',400);
    const existing=db.prepare('SELECT * FROM messages WHERE client=? AND key=?').get(body.client_id,key);
    if (existing && existing.fingerprint!==hash(body)) fail('idempotency_conflict',409);
    const row=db.prepare(`SELECT * FROM handoffs WHERE client=? AND phone=? AND ref IS NOT NULL
     ORDER BY rowid DESC LIMIT 1`).get(body.client_id,body.to);
    if (row) await mirror(row,{body:body.message,direction:'outbound'},`local-send:${key}`);
    result={ok:true,message_id:`lab-send:${hash([body.client_id,key]).slice(0,32)}`,deduped:!!existing};
    db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(body.client_id,key,hash(body),JSON.stringify(result));
   } else if(url.pathname==='/api/public/tania/lab-messages' && req.method==='POST') {
    const row=db.prepare(`SELECT * FROM handoffs WHERE client=? AND phone=? AND ref IS NOT NULL
     ORDER BY rowid DESC LIMIT 1`).get(body.client_id,body.to);
    if (row) await mirror(row,{body:body.message,direction:'inbound'},`tania:${body.message_id}`);
    result={ok:true};
   } else fail('not_found',404);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  } catch(error) {
   const status=error.status||503;res.writeHead(status,{'content-type':'application/json'});
   res.end(JSON.stringify({error:status===503?'local_service_unavailable':error.message}));
  }
 }).catch(()=>{if(!res.writableEnded){res.writeHead(503);res.end();}});
}).listen(Number(process.env.PORT||8081),'0.0.0.0');
