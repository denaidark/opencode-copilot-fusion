import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const proxyRepository=path.resolve(process.env.FUSION_PROXY_REPOSITORY||'/workspace/omsite');
const {default:express}=await import(pathToFileURL(path.join(proxyRepository,'node_modules/express/index.js')));
const {createFusionPool}=await import(pathToFileURL(path.join(proxyRepository,'server/lib/fusion-pool.mjs')));
const {createFusionProxy}=await import(pathToFileURL(path.join(proxyRepository,'server/lib/fusion-proxy.mjs')));
const root=path.resolve(process.argv[2] || '/workspace/fusion-oc2-diagnostic');
const repository=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const name=process.argv[3]||new Date().toISOString().replaceAll(/[:.]/g,'-');
if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))throw Error('Use a plain unique result name');
const out=path.join(root,'results',name);if(fs.existsSync(out))throw Error('Result directory already exists; use a fresh name');fs.mkdirSync(out,{recursive:true});
const failCompaction=process.argv[4]==='--fail-compaction';
// Deliberately credential-free: this harness exercises real OpenCode, not live model quality.
const token='synthetic_mock_contributor_only';
const upstream='https://api.githubcopilot.com'; // Metadata only; observedFetch below never performs a network fetch.
const password=crypto.randomBytes(32).toString('hex');let capability='';
const clean=s=>String(s).replaceAll(token,'[CONTRIBUTOR]').replaceAll(password,'[SERVER_PASSWORD]').replace(/fsp_[rs]_[\w-]+/g,'[PROXY_CREDENTIAL]').replace(/gh[opusr]_[A-Za-z0-9_]+/g,'[GITHUB_TOKEN]');
const log=r=>{const line=JSON.stringify({time:new Date().toISOString(),...r});fs.appendFileSync(path.join(out,'trace.jsonl'),clean(line)+'\n');console.log(clean(line))};
const pool=createFusionPool({enabled:()=>true,tokenFor:()=>token,sharingAllowed:()=>true,runActive:()=>true});
pool.observe({id:'local-test-contributor'},token,{enabled:true,cause:'ok',upstream});
capability=pool.issue('local-test-consumer','local-diagnostic-only').credential;if(!capability)throw new Error('Local pool credential unavailable');

let mockSequence=0;
async function mockUpstream(url,options) {
 await new Promise(resolve=>setTimeout(resolve,150));
 if(url.endsWith('/auto')) return Response.json({session_token:'synthetic_mock_session',selected_model:{id:'fusion-mock',supported_endpoints:['/responses'],vision:true},expires_at:Math.floor(Date.now()/1000)+600});
 const body=JSON.parse(options.body),isCompaction=JSON.stringify((body.input||[]).filter(item=>item.role==='user').at(-1)||'').includes('## Objective')||JSON.stringify((body.input||[]).filter(item=>item.role==='user').at(-1)||'').includes('required summary template'),write=isCompaction?undefined:(body.tools||[]).find(t=>t.name==='write');
 if(isCompaction&&failCompaction)return Response.json({error:{code:'upstream_error',message:'Synthetic temporary compaction failure.'}},{status:503,headers:{'Retry-After':'0'}});
 const input=body.input||[],large=JSON.stringify(input).includes('Create large.html now'),filename=large?'large.html':'index.html';
 const called=input.some(item=>item.type==='function_call'&&item.name==='write'&&String(item.arguments).includes(filename));
 const id='resp_mock_'+(++mockSequence),events=[],output=[];
 const emit=(type,fields)=>events.push({type,sequence_number:events.length,...fields});
 emit('response.created',{response:{id,status:'in_progress',object:'response',model:'fusion-mock',output:[]}});
 if(write&&!called) {
   const content='<!doctype html><meta charset="utf-8"><title>Target game</title><button id="target">Click target</button><p id="score">0</p><button onclick="n=0;score.textContent=n">Restart</button><script>let n=0;target.onclick=()=>{score.textContent=++n;target.style.marginLeft=Math.random()*80+"vw"}</script>'+ (large?'<!--'+('large mock transport payload '.repeat(6000))+'-->':'');
   const properties=write.parameters?.properties||{},args={};
   for(const key of Object.keys(properties)) if(/^(filePath|file_path|path|filename)$/.test(key)) args[key]=path.join(project,filename); else if(key==='content') args[key]=content;
   if(!Object.keys(args).length) throw new Error('Unrecognized write tool schema');
   const item={type:'function_call',id:'fc_'+mockSequence,call_id:'call_'+mockSequence,name:'write',arguments:JSON.stringify(args),status:'completed'};
   emit('response.output_item.added',{output_index:0,item:{...item,arguments:'',status:'in_progress'}});
   emit('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:item.arguments});
   emit('response.function_call_arguments.done',{output_index:0,item_id:item.id,arguments:item.arguments});
   emit('response.output_item.done',{output_index:0,item});output.push(item);
 }else{
   const text=write?'Wrote the requested local file.':isCompaction?'## Objective\n- Create local games.\n## Requirements\n- No deployment.\n## Decisions\n- Standalone HTML.\n## Work State\n### Completed\n- Wrote index.html.\n### Active\n- None.\n### Blocked\n- None.\n## Next Move\n1. Continue user requests.\n## Relevant Files\n- index.html: playable target game.\n## Important Context\n- Local test only.':'Local game';
   const item={type:'message',id:'msg_'+mockSequence,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
   emit('response.output_item.added',{output_index:0,item:{...item,content:[],status:'in_progress'}});
   emit('response.content_part.added',{output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit('response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:text});
   emit('response.output_text.done',{output_index:0,item_id:item.id,content_index:0,text});
   emit('response.output_item.done',{output_index:0,item});output.push(item);
 }
 emit('response.completed',{response:{id,status:'completed',object:'response',model:'fusion-mock',output,usage:{input_tokens:100,output_tokens:50,total_tokens:150}}});
 return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}

let serial=0;
async function observedFetch(url,options){
 const n=++serial,start=Date.now(),b=JSON.parse(options.body),headers=options.headers;if(url.endsWith('/auto')){autoCalls++;if(b.tier!=='balance')throw Error('Wrong default tier');}else if(Object.hasOwn(b,'temperature'))throw Error('Routed temperature leaked');
 log({event:'upstream_request',n,path:new URL(url).pathname,body_keys:Object.keys(b),model:b.model,max_output_tokens:b.max_output_tokens,max_tokens:b.max_tokens,stream:b.stream,input_items:Array.isArray(b.input)?b.input.length:undefined,input_chars:JSON.stringify(b.input||'').length,reasoning:b.reasoning,headers:Object.fromEntries(Object.entries(headers).filter(([k])=>['copilot-integration-id','x-initiator','x-github-api-version','user-agent','accept','openai-intent'].includes(k)))});
 try{
 const r=await mockUpstream(url,options);log({event:'upstream_headers',n,status:r.status,ms:Date.now()-start,content_type:r.headers.get('content-type'),retry_after:r.headers.get('retry-after')});
 if(!r.body)return r;
 let bytes=0,chunks=0,first=0,last=0,buf='';const decoder=new TextDecoder();
 const stream=r.body.pipeThrough(new TransformStream({transform(v,c){bytes+=v.byteLength;chunks++;if(!first){first=Date.now();log({event:'first_chunk',n,ms:first-start,bytes:v.byteLength})}last=Date.now();
 if(r.headers.get('content-type')?.includes('text/event-stream')){buf+=decoder.decode(v,{stream:true});let at;while((at=buf.indexOf('\n\n'))>=0){const frame=buf.slice(0,at);buf=buf.slice(at+2);for(const line of frame.split('\n'))if(line.startsWith('data:'))try{const e=JSON.parse(line.slice(5));if(['response.completed','response.incomplete','response.failed','error'].includes(e.type))log({event:'upstream_terminal',n,type:e.type,status:e.response?.status,reason:e.response?.incomplete_details?.reason,usage:e.response?.usage,error_type:e.error?.type,error_code:e.error?.code})}catch{}} if(buf.length>1024*1024)buf=''} c.enqueue(v)},flush(){log({event:'upstream_eof',n,ms:Date.now()-start,bytes,chunks,stream_ms:last-first})}}));
 return new Response(stream,{status:r.status,headers:r.headers});
 }catch(e){log({event:'upstream_transport_error',n,ms:Date.now()-start,type:e.name,aborted:options.signal?.aborted});throw e}
}
let ingress=0,maxIngress=0,local429=0;
const app=express();app.use((req,res,next)=>{ingress++;maxIngress=Math.max(maxIngress,ingress);const start=Date.now();let emitted=false;log({event:'proxy_ingress',path:req.path,busy:pool.authenticate(String(req.get('authorization')||'').replace(/^Bearer /i,''))?.row.busy});const done=()=>{if(emitted)return;emitted=true;ingress--;if(res.statusCode===429)local429++;log({event:'proxy_egress',path:req.path,status:res.statusCode,ms:Date.now()-start,finished:res.writableFinished})};res.once('finish',done);res.once('close',done);next()});app.use(createFusionProxy({pool,request:observedFetch}));
const proxy=app.listen(0,'127.0.0.1');await new Promise(r=>proxy.once('listening',r));
const proxyURL=`http://127.0.0.1:${proxy.address().port}/api/fusion-pool`;
let auxiliaryCalls=0, compactionCalls=0, autoCalls=0;
const auxiliary=express();auxiliary.use(express.json({limit:'16mb'}));
auxiliary.post('/v1/responses',async(req,res)=>{
 auxiliaryCalls++;
 if(req.get('authorization')!=='Bearer public'||req.get('copilot-session-token'))throw Error('Pool credential crossed auxiliary trust boundary');
 if(!req.get('user-agent')?.includes('opencode'))throw Error('Native OpenCode client identity was lost');
 const input=JSON.stringify(req.body.input||[]),compaction=/## Objective|required summary template/.test(input);
 if(compaction)compactionCalls++;
 log({event:'auxiliary_request',compaction,model:req.body.model,stream:req.body.stream});
 const response=await mockUpstream('https://synthetic.test/responses',{body:JSON.stringify(req.body)});
 res.status(response.status);response.headers.forEach((value,key)=>res.set(key,value));res.send(await response.text());
});
const auxiliaryServer=auxiliary.listen(0,'127.0.0.1');await new Promise(r=>auxiliaryServer.once('listening',r));
const auxiliaryURL=`http://127.0.0.1:${auxiliaryServer.address().port}/v1`;
const home=path.join(out,'home'),project=path.join(out,'game');for(const d of [home,project,path.join(home,'.config/opencode')])fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(home,'.config/opencode/opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',experimental:{background_compaction:false},plugins:[repository,path.join(proxyRepository,'runner/fusion-policy')],media:{image:{max_width:1024,max_height:1024,max_base64_bytes:150000}},permission:{'*':'allow',task:'allow'}}));
const env={PATH:process.env.PATH,HOME:home,PWD:project,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CACHE_HOME:path.join(home,'.cache'),OPENCODE_PASSWORD:password,FUSION_ACCESS_TOKEN:capability,FUSION_UPSTREAM:proxyURL,FUSION_AUXILIARY_UPSTREAM:auxiliaryURL,OPENCODE_DISABLE_AUTOUPDATE:'true'};delete env.FUSION_TEST_CONTRIBUTOR_TOKEN;delete env.FUSION_TEST_UPSTREAM;
const binary=path.join(root,'bin/opencode'),children=new Set();
function child(args,file,timeoutMs){return new Promise(resolve=>{const proc=spawn(binary,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});children.add(proc);let data='',pending='';const record=chunk=>{data+=clean(chunk.toString());pending+=chunk;let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const e=JSON.parse(line);if(e.sessionID&&['error','step_finish','step_start'].includes(e.type))log({event:'opencode',type:e.type,sessionID:e.sessionID,error:e.error,part:e.type==='step_finish'?e.part:undefined})}catch{}}};proc.stdout.on('data',record);proc.stderr.on('data',record);let timed=false;const timer=setTimeout(()=>{timed=true;proc.kill('SIGTERM');setTimeout(()=>proc.kill('SIGKILL'),3000).unref()},timeoutMs);proc.on('close',(code,signal)=>{clearTimeout(timer);children.delete(proc);fs.writeFileSync(path.join(out,file),clean(data));log({event:'cli_exit',file,code,signal,timed});resolve({code,data,timed})});proc.on('error',e=>{log({event:'spawn_error',message:e.message});resolve({code:1,data})})})}
const server=spawn(binary,['serve','--hostname','127.0.0.1','--port','0'],{cwd:project,env,stdio:['ignore','pipe','pipe']});children.add(server);let serverLog='',base;
const got=chunk=>{serverLog+=clean(chunk);const m=serverLog.match(/https?:\/\/127\.0\.0\.1:\d+/);if(m)base=m[0]};server.stdout.on('data',got);server.stderr.on('data',got);
const auth={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{...auth,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Local API ${method} ${url}: ${r.status}`);return r.status===204?null:r.json()}
try {
 const until=Date.now()+90000;let ready=false;while(Date.now()<until){if(base)try{const r=await api('/api/info');log({event:'server_ready',version:r.version,proxy:'current omsite; credential-free synthetic upstream'});ready=true;break}catch{}if(server.exitCode!==null)break;await delay(500)}if(!ready)throw new Error('Isolated OpenCode server did not become ready');
 const simple=await child(['run','--server',base,'--auto','--model','copilot-fusion-direct/fusion','--format','json','Create index.html: a complete simple playable click-the-target HTML game with score, restart button, inline CSS and JS, no dependencies or network requests. Keep it under 150 lines. Use the write tool. Do not inspect environment variables or credentials. Stop after writing; no deployment.'],'simple.log',240000);
 const rows=simple.data.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}});const sid=rows.find(r=>r.sessionID)?.sessionID;log({event:'simple_result',code:simple.code,sessionID:sid,file_exists:fs.existsSync(path.join(project,'index.html')),file_bytes:fs.existsSync(path.join(project,'index.html'))?fs.statSync(path.join(project,'index.html')).size:0});
 if(!sid||simple.code!==0||!fs.existsSync(path.join(project,'index.html')))throw new Error('Simple game write did not succeed');
 if(autoCalls!==1)throw Error('Title/main/tool followups did not share one route');
 log({event:'manual_compaction_begin'});await api(`/api/session/${sid}/compact`,'POST',{});let compacted=false;const end=Date.now()+180000;
 while(Date.now()<end){const r=await api(`/api/session/${sid}/message`);const c=(r.data||[]).find(m=>m.type==='compaction');if(c&&['completed','failed'].includes(c.status)){log({event:'compaction_result',status:c.status,error:c.error});if(c.status!==(failCompaction?'failed':'completed'))throw new Error('Unexpected compaction result');compacted=true;break}await delay(500)}
 if(!compacted)throw new Error('Compaction did not settle before harness deadline');
 if(failCompaction){const attempts=(serverLog.match(/\[fusion-policy\] Compaction attempt/g)||[]).length;if(attempts!==3)throw new Error('Compaction policy did not stop after exactly three attempts');log({event:'compaction_bound_result',attempts,visible_failure:true});}
 else {
 const large=await child(['run','--session',sid,'--server',base,'--auto','--model','copilot-fusion-direct/fusion','--format','json','Create large.html now using one write tool call. Build an ambitious polished standalone HTML canvas tower-defense game with 12 distinct towers, upgrade trees, 20 enemy types, 40 individually hand-authored wave configurations with varied squads, an illustrated SVG title screen, particles, music synthesis, touch controls, pathfinding, collision, pause, shop and save/load. Include complete detailed CSS, all inline JS and every level and item description, a tutorial, tooltip explanations, game over and victory screens. No external dependencies, no placeholders, no TODOs. Do not use a shell generator: write complete working source code in one write call. Start with implementation and keep writing the complete file. Do not inspect credentials or environment. No deployment.'],'large.log',360000);
 if(large.code!==0||!fs.existsSync(path.join(project,'large.html')))throw new Error('Large mock file write did not complete');
 if(local429!==0||autoCalls!==2||compactionCalls!==1||auxiliaryCalls<2)throw new Error('Sticky/auxiliary/reanchor assertions failed');
 log({event:'transport_summary',max_concurrent_ingress:maxIngress,local_429:local429,large_file_bytes:fs.statSync(path.join(project,'large.html')).size,auto_calls:autoCalls,auxiliary_calls:auxiliaryCalls,compaction_calls:compactionCalls,upstream:'synthetic; not live acceptance evidence'});
 log({event:'large_result',code:large.code,timed:large.timed,file_exists:fs.existsSync(path.join(project,'large.html')),length_error:large.data.split('\n').some(line=>{try{const event=JSON.parse(line);return event.type==='error'&&/output token limit|stop reason: length|truncated/.test(JSON.stringify(event.error))}catch{return false}}),compaction:/compaction/i.test(large.data)});
}}catch(e){log({event:'test_error',name:e.name,message:e.message});process.exitCode=1}
finally{pool.end('local-diagnostic-only');for(const c of children)c.kill('SIGTERM');await delay(1000);for(const c of children)c.kill('SIGKILL');proxy.closeAllConnections();await new Promise(r=>proxy.close(r));auxiliaryServer.closeAllConnections();await new Promise(r=>auxiliaryServer.close(r));fs.writeFileSync(path.join(out,'server.log'),clean(serverLog));delete env.FUSION_ACCESS_TOKEN;delete env.OPENCODE_PASSWORD;delete process.env.FUSION_TEST_CONTRIBUTOR_TOKEN;let secretFiles=0;const walk=d=>{for(const entry of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile()&&fs.statSync(p).size<50000000){const b=fs.readFileSync(p);if(b.includes(Buffer.from(token))||b.includes(Buffer.from(capability))||b.includes(Buffer.from(password)))secretFiles++}}};walk(out);log({event:'cleanup',credentials:'process memory released',credential_files_found:secretFiles});if(secretFiles)process.exitCode=1;}
