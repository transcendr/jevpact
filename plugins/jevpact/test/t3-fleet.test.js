import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { T3Fleet } from '../src/t3-fleet.js';
const shell = (id, active = false) => ({ id, title: id, projectId: 'project', providerInstanceId: 'codex',
  activeRunId: active ? 'run' : null, archivedAt: null, deletedAt: null, lineage: {} });
function fixture(t, { guarded = 1, allowWrites = true } = {}) {
  const streams = []; const calls = []; const entries = new Map(); const timers = [];
  const rpc = { async request(tag, payload) { calls.push({tag,payload}); return {guardedMaintenance: guarded,
    guardedMaintenanceActivePause: true, environment: { environmentId: 'env' }, providers: [{ instanceId:'codex',driver:'codex' }]}; },
    async subscribe(tag,payload,handlers) { const stream={tag,payload,handlers,closed:false};streams.push(stream);
      if(tag==='orchestration.subscribeShell')handlers.onFrame({kind:'snapshot',snapshot:{snapshotSequence:1,projects:[{id:'project',workspaceRoot:'/workspace'}],threads:[]}});
      else handlers.onFrame({kind:'snapshot',snapshotSequence:1,projection:{thread:{id:payload.threadId,defaultProvider:'codex'},runs:[],messages:[],turnItems:[],providerThreads:[],providerTurns:[],subagents:[]}});
      handlers.onFrame({kind:'synchronized'});return ()=>{stream.closed=true;}; },close(){} };
  const fleet=new T3Fleet({origin:'http://localhost',environmentId:'env',token:'private',allowWrites,rpcFactory:()=>rpc,schedule:fn=>{timers.push(fn);return fn;},cancel(){}});
  const daemon={getThread:id=>entries.get(id),async attach(id,_path,options){const reader=fleet.source.create({threadId:id});await reader.open();
    const entry={reader,controller:{busy:false,pending:null},...options};entries.set(id,entry);fleet.transport.bindReader(id,reader,options);return entry;},
    async detach(id){const entry=entries.get(id);if(entry){fleet.transport.unbindReader(id,entry.reader);await entry.reader.close();entries.delete(id);}}};
  t.after(async()=>{await fleet.close();for(const id of [...entries.keys()])await daemon.detach(id);});
  return {fleet,daemon,entries,streams,calls,timers};
}
test('all idle threads attach without detailed subscriptions; activity opens observation and archive detaches', async t=>{
  const f=fixture(t);await f.fleet.start(f.daemon);
  for(const id of ['one','two','three'])await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell(id)});
  await f.fleet.frame({kind:'snapshot',resolvedRepositoryIdentityRoots:['/workspace'],snapshot:{snapshotSequence:99,projects:[{id:'project',workspaceRoot:'/workspace'}],threads:[],archivedThreads:[]}});
  assert.equal(f.fleet.sequence,1);
  assert.equal(f.entries.size,3);assert.equal(f.streams.filter(s=>s.tag==='orchestration.subscribeThread').length,0);
  assert.equal(f.fleet.cwd('one'),'/workspace');assert.equal(f.entries.get('one').allowWrites,true);
  await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('one',true)});
  assert.equal(f.streams.filter(s=>s.tag==='orchestration.subscribeThread'&&!s.closed).length,1);
  await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('one')});f.fleet.quiescent('one');
  assert.equal(f.streams.filter(s=>s.tag==='orchestration.subscribeThread'&&!s.closed).length,0);
  await f.fleet.frame({kind:'thread.updated',location:'archive',thread:{...shell('one'),archivedAt:'now'}});
  assert.equal(f.entries.has('one'),false);assert.equal(f.fleet.shells.size,2);
  await f.fleet.frame({kind:'thread.removed',threadId:'two'});assert.equal(f.entries.has('two'),false);
  await f.fleet.frame({kind:'project.removed',projectId:'project'});assert.equal(f.entries.size,0);
});
test('old server and absent setup consent remain read-only with an actionable explanation', async t=>{
  for(const options of [{guarded:undefined},{allowWrites:false}]){
    const f=fixture(t,options);if('guarded'in options)f.fleet.rpcFactory=()=>({
      async request(){return{environment:{environmentId:'env'},providers:[]};},
      async subscribe(_tag,_payload,handlers){handlers.onFrame({kind:'synchronized'});return()=>{};},close(){}});
    await f.fleet.start(f.daemon);await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('thread')});
    assert.equal(f.entries.get('thread').allowWrites,false);
    assert.match(f.fleet.reason(),options.allowWrites===false?/not enabled/:/does not support guarded maintenance/);
    assert(!f.calls.some(c=>c.tag==='orchestration.dispatchCommand'));
  }
});
test('disconnect revokes grants, reconnect rechecks capability, and missing request IDs are visible', async t=>{
  const f=fixture(t);await f.fleet.start(f.daemon);await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('one',true)});
  assert.match(f.fleet.describe('one',{supported:true,requestCountSupported:false,providerTurnId:'turn'},{mode:'automatic'}).statusReason,/has not supplied a native ID/);
  await f.fleet.disconnected({code:'t3-disconnected'});assert.equal(f.entries.size,0);assert.equal(f.fleet.transport.readers.size,0);
  assert.match(f.fleet.reason(),/Disconnected/);assert.equal(f.timers.length,1);
  f.timers.shift()();await f.fleet.work;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c.tag==='server.getConfig').length,2);
});


test('reconnection refreshes the runtime origin and rechecks a downgraded server capability',async t=>{
 const f=fixture(t);const dir=await mkdtemp(path.join(os.tmpdir(),'jp-t3-origin-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'runtime.json');f.fleet.runtimeFile=file;let guarded=true;const origins=[];const stub=f.fleet.rpcFactory();
 f.fleet.rpcFactory=options=>{origins.push(options.origin);return{...stub,origin:options.origin,async request(...args){return{...await stub.request(...args),guardedMaintenance:guarded?1:undefined};}};};
 await writeFile(file,JSON.stringify({origin:'http://localhost:1234'}));await f.fleet.start(f.daemon);
 await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('one')});assert(f.entries.get('one').allowWrites);
 await f.fleet.disconnected({code:'t3-disconnected'});guarded=false;await writeFile(file,JSON.stringify({origin:'http://localhost:4321'}));await f.fleet.connect();
 await f.fleet.frame({kind:'thread.updated',location:'active',thread:shell('one')});
 assert.deepEqual(origins,['http://localhost:1234','http://localhost:4321']);assert.equal(f.entries.get('one').allowWrites,false);assert(f.fleet.allowWrites);assert.match(f.fleet.reason(),/does not support guarded maintenance/);
});


test('a rejected runtime origin never enters public status',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'jp-t3-origin-secret-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const runtimeFile=path.join(dir,'runtime.json');await writeFile(runtimeFile,JSON.stringify({origin:'http://hidden-test-value@localhost'}));
 const fleet=new T3Fleet({origin:'http://localhost:1234',environmentId:'env',token:'test',runtimeFile,schedule:()=>null,cancel(){}});t.after(()=>fleet.close());
 await fleet.start({detach:async()=>{}});assert.equal(fleet.status().origin,'http://localhost:1234');assert.equal(JSON.stringify(fleet.status()).includes('hidden-test-value'),false);
});
