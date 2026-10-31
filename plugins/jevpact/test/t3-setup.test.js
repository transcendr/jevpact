import test from 'node:test';import assert from 'node:assert/strict';
import os from 'node:os';import path from 'node:path';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {configureT3,readT3Setup,t3TokenPath,t3SetupPath} from '../src/t3-setup.js';
import {stateDir,socketPath} from '../src/paths.js';
import {t3Command} from '../src/t3-cli.js';
import {readConfig,t3ConfigThreadId} from '../src/config.js';

test('setup persists explicit consent separately from the private bearer credential and refuses another environment',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'jp-t3-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));t.mock.method(os,'homedir',()=>root);
 const old=process.env.JEVPACT_T3_PROFILE;process.env.JEVPACT_T3_PROFILE='setup-proof';t.after(()=>{if(old===undefined)delete process.env.JEVPACT_T3_PROFILE;else process.env.JEVPACT_T3_PROFILE=old;});
 let environmentId='env';
 class Socket extends EventTarget{constructor(){super();queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 send(value){const m=JSON.parse(value);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{environment:{environmentId},providers:[]}}})})));}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({ticket:'fake-ticket'})}));const previousSocket=globalThis.WebSocket;globalThis.WebSocket=Socket;t.after(()=>{globalThis.WebSocket=previousSocket;});
 const input=path.join(root,'input');await writeFile(input,'private-test-token',{mode:0o600});
 await configureT3({origin:'http://localhost:1234',tokenFile:input,allowWrites:true});
 assert.equal((await readT3Setup()).allowWrites,true);assert.equal((await stat(t3TokenPath())).mode&0o777,0o600);
 assert.equal((await readFile(t3SetupPath(),'utf8')).includes('private-test-token'),false);
 const runtime=path.join(root,'server-runtime.json');await writeFile(runtime,JSON.stringify({origin:'http://localhost:1234'}));
 await configureT3({runtimeFile:runtime});assert.equal((await readT3Setup()).runtimeFile,runtime);
 await writeFile(runtime,JSON.stringify({origin:'http://localhost:4567'}));
 await configureT3({});assert.equal((await readT3Setup()).origin,'http://localhost:4567');assert.equal((await readT3Setup()).allowWrites,true);
 await configureT3({allowWrites:false});assert.equal((await readT3Setup()).allowWrites,false);
 const invalid=path.join(root,'invalid-runtime');await writeFile(invalid,'sensitive-test-value');
 await assert.rejects(configureT3({runtimeFile:invalid}),error=>/not valid JSON/.test(error.message)&&!error.message.includes('sensitive-test-value'));
 environmentId='other';await assert.rejects(configureT3({allowWrites:true}),/environment does not match/);
 t.mock.method(console,'log',()=>{});
 await t3Command(['config','set','mode','off','--thread','mcp:launch:owned-thread']);
 assert.equal((await readConfig()).threads[t3ConfigThreadId('env','mcp:launch:owned-thread')].settings.mode,'off');
 await assert.rejects(t3Command(['config','show','--thread','current']),/explicit thread ID/);
 assert.equal((await readT3Setup()).environmentId,'env');assert.match(stateDir(),/Jevpact-t3-setup-proof$/);assert.match(socketPath(),/t3-[0-9a-f]{12}/);assert(Buffer.byteLength(socketPath())<104);
});
