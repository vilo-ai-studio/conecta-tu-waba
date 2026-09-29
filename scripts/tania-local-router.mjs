// Router-owned, LOCAL ONLY transport: real Chatwoot + durable SQLite; never calls Meta.
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
const secret = process.env.LOCAL_ROUTER_SECRET || '';
if (secret.length < 16) throw new Error('local_router_secret_required');
const cwBase = process.env.LOCAL_CHATWOOT_URL || 'http://chatwoot:3000';
const taniaBase = process.env.LOCAL_TANIA_URL || 'http://api:8000';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eq = (a,b) => { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
function config() { return JSON.parse(readFileSync(`${root}/chatwoot.json`, 'utf8')); }
async function cw(path, body) {
 const cfg=config();
 const res=await fetch(`${cwBase}/api/v1/accounts/${cfg.account_id}${path}`, {
  method:body===undefined?'GET':'POST', headers:{'content-type':'application/json',api_access_token:cfg.token},
  body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(10000),
 });
 if(!res.ok) throw Object.assign(new Error('chatwoot_rejected'), {status:res.status>=500||res.status===429?503:422});
 return res.json();
}
async function callback(path, body) {
 const res=await fetch(`${taniaBase}/webhooks/router/${path}`, {
  method:'POST',headers:{'content-type':'application/json','X-Client-ID':body.client_id,'X-N8N-Webhook-Secret':secret},
  body:JSON.stringify(body),signal:AbortSignal.timeout(10000),
 });
 if(!res.ok) throw Object.assign(new Error('callback_pending'),{status:503});
}
async function mirror(ref, item, source) {
 const messages=await cw(`/conversations/${ref}/messages`);
 const rows=messages.payload || [];
 if(rows.some(m=>(m.source_id===source || m.content_attributes?.tania_source_id===source))) return;
 await cw(`/conversations/${ref}/messages`,{content:item.body || '[sin texto]',
  message_type:item.direction==='inbound'?'incoming':'outgoing',private:false,source_id:source,
  content_attributes:{local_router:true,tania_source_id:source}});
}
async function snapshot(row) {
 const conversation=await cw(`/conversations/${row.ref}`);
 const state=conversation.status==='resolved'?'resolved':'human_active';
 const revision=row.state===state?row.revision:row.revision+1;
 db.prepare('UPDATE handoffs SET state=?, revision=? WHERE client=? AND id=?').run(state,revision,row.client,row.id);
 const messages=await cw(`/conversations/${row.ref}/messages`);
 const replies=[];
 for(const m of messages.payload || []) {
  if((m.message_type===1 || m.message_type==='outgoing') && !m.private &&
     !m.content_attributes?.local_router && !m.content_attributes?.tania_source_id && !m.source_id && m.content) {
    replies.push({message_id:String(m.id),body:m.content.slice(0,2000)});
  }
 }

 return {external_ref:String(row.ref),state,revision,human_messages:replies};
}
async function handoff(body) {
 const {client_id:client,handoff_id:id,conversation_id:phone}=body;
 if(!/^[0-9a-f-]{36}$/.test(id||'') || !/^521000\d{7}$/.test(phone||'')) throw Object.assign(new Error('synthetic_only'),{status:400});
 const cfg=config(), team=cfg.teams[body.team];
 if(!team) throw Object.assign(new Error('team_unmapped'),{status:422});
 const digest=hash(body);
 let row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(client,id);
 if(row && row.fingerprint!==digest) throw Object.assign(new Error('idempotency_conflict'),{status:409});
 if(!row) {
  db.prepare('INSERT INTO handoffs(client,id,phone,state,fingerprint) VALUES(?,?,?,?,?)').run(client,id,phone,'requested',digest);
  row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(client,id);
 }
 if(!row.ref) {
  const identifier=`${client}:${phone}`;
  const found=await cw(`/contacts/search?q=${encodeURIComponent(identifier)}&include=contact_inboxes`);
  let contact=(found.payload||[]).find(c=>c.identifier===identifier);
  if(!contact) {
   const created=await cw('/contacts',{inbox_id:cfg.inbox_id,name:'Cliente sintético',identifier});
   contact=created.payload.contact;
  }
  const existing=await cw(`/contacts/${contact.id}/conversations`);
  let conversation=(existing.payload||[]).find(c=>c.custom_attributes?.tania_handoff_id===id);
  if(!conversation) {
   let source=(contact.contact_inboxes||[]).find(i=>i.inbox?.id===cfg.inbox_id)?.source_id;
   if(!source) {
    const inbox=await cw(`/contacts/${contact.id}/contact_inboxes`,{inbox_id:cfg.inbox_id});
    source=inbox.source_id;
   }
   conversation=await cw('/conversations',{source_id:source,inbox_id:cfg.inbox_id,contact_id:contact.id,
    custom_attributes:{tania_handoff_id:id},status:'open',team_id:team});
  }
  row.ref=String(conversation.id);
  db.prepare('UPDATE handoffs SET ref=? WHERE client=? AND id=?').run(row.ref,client,id);
 }
 for(const item of body.history || []) await mirror(row.ref,item,`tania:${item.id}`);
 const notes=await cw(`/conversations/${row.ref}/messages`);
 if(!(notes.payload||[]).some(m=>(m.source_id===`handoff-note:${id}` || m.content_attributes?.tania_source_id===`handoff-note:${id}`))) {
  await cw(`/conversations/${row.ref}/messages`,{content:body.summary||'Escalamiento tanIA',
   message_type:'outgoing',private:true,source_id:`handoff-note:${id}`,
   content_attributes:{local_router:true,tania_source_id:`handoff-note:${id}`} });
 }
 await cw(`/conversations/${row.ref}/assignments`,{team_id:team});
 db.prepare('UPDATE handoffs SET state=? WHERE client=? AND id=?').run('human_active',client,id);
 return {external_ref:row.ref,state:'human_active',revision:row.revision};
}
let chain=Promise.resolve(); // serialize local side effects; durable reservations survive restart
const server=createServer((req,res)=>{
 chain=chain.then(async()=>{
  try {
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/health') {await cw('/teams');res.writeHead(200);res.end('local-router-chatwoot');return;}
   if(!eq(req.headers['x-n8n-webhook-secret']||'',secret)) throw Object.assign(new Error('invalid_secret'),{status:401});
   const chunks=[];let size=0;
   for await(const chunk of req) {size+=chunk.length;if(size>131072) throw Object.assign(new Error('too_large'),{status:413});chunks.push(chunk);}
   const body=req.method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(Buffer.concat(chunks).toString());
   if(!/^lab-[0-9a-f-]{36}$/.test(body.client_id||'')) throw Object.assign(new Error('synthetic_only'),{status:403});
   let result;
   if(url.pathname==='/api/public/tania/handoffs') {
    if(req.method==='POST') {
     if(!req.headers['idempotency-key']) throw Object.assign(new Error('key_required'),{status:400});
     result=await handoff(body);
    } else if(req.method==='GET') {
     const row=db.prepare('SELECT * FROM handoffs WHERE client=? AND id=?').get(body.client_id,body.handoff_id);
     if(!row?.ref) throw Object.assign(new Error('handoff_pending'),{status:409});
     result=await snapshot(row);
    } else throw Object.assign(new Error('method_not_allowed'),{status:405});
   } else if(url.pathname==='/api/public/whatsapp/send-message' && req.method==='POST') {
    if(!/^521000\d{7}$/.test(body.to||'') || body.type!=='text') throw Object.assign(new Error('synthetic_only'),{status:403});
    const key=req.headers['idempotency-key'];
    if(!key) throw Object.assign(new Error('key_required'),{status:400});
    const existing=db.prepare('SELECT * FROM messages WHERE client=? AND key=?').get(body.client_id,key);
    if(existing && existing.fingerprint!==hash(body)) throw Object.assign(new Error('idempotency_conflict'),{status:409});
    const row=db.prepare('SELECT * FROM handoffs WHERE client=? AND phone=? AND ref IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(body.client_id,body.to);
    if(row) await mirror(row.ref,{body:body.message,direction:'outbound'},`local-send:${key}`);
    result={ok:true,message_id:`lab-send:${hash([body.client_id,key]).slice(0,32)}`,deduped:!!existing};
    db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(body.client_id,key,hash(body),JSON.stringify(result));
   } else if(url.pathname==='/api/public/tania/lab-messages' && req.method==='POST') {
    const row=db.prepare('SELECT * FROM handoffs WHERE client=? AND phone=? AND ref IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(body.client_id,body.to);
    if(row) await mirror(row.ref,{body:body.message,direction:'inbound'},`tania:${body.message_id}`);
    result={ok:true};
   } else throw Object.assign(new Error('not_found'),{status:404});
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  } catch(error) {
   const status=error.status||503;res.writeHead(status,{'content-type':'application/json'});
   res.end(JSON.stringify({error:status===503?'local_service_unavailable':error.message}));
  }
 }).catch(()=>{if(!res.writableEnded){res.writeHead(503);res.end();}});
});
server.listen(Number(process.env.PORT||8081),'0.0.0.0');
