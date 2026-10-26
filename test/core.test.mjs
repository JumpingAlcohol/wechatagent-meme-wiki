import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createMemeService} from '../lib/core.mjs';
import {syncCycle} from '../lib/sync.mjs';
const entries=[{title:'测试梗',slug:'test',summary:'只读测试定义',usage:'测试用法'}];
function contexts(){const store=new Map();return (account='account-a',chat='private-a',kind='private')=>{const scope=account+'|'+chat;return {account:{id:account},chat:{key:chat,kind},actor:{id:'tester'},sessionId:'session',now:Date.parse('2026-10-26T12:00Z'),message:'',config:()=>({online:false,autoPrefetch:true,maxTerms:50,editorHashes:[]}),storage:{get:async name=>structuredClone(store.get(scope+'|'+name)??null),set:async(name,value)=>store.set(scope+'|'+name,structuredClone(value))},fetch:async()=>{throw Error('Unexpected network call');}};};}
test('dictionary snapshot preserves its declared count and digest',()=>{const meta=JSON.parse(fs.readFileSync(new URL('../assets/dictionary-info.json',import.meta.url))),bytes=Buffer.concat(meta.parts.map(name=>fs.readFileSync(new URL('../assets/'+name,import.meta.url))));assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256);assert.equal(JSON.parse(gunzipSync(bytes)).length,6660);});
test('local lookup does not touch the network; unknown terms remain unknown when offline',async()=>{const service=createMemeService(entries),ctx=contexts()();assert.equal((await service.search(ctx,{query:'测试梗'})).source,'local');assert.equal((await service.search(ctx,{query:'没有这个词'})).status,'not_found');});
test('teaching needs a current explicit instruction and remains account/chat scoped',async()=>{const service=createMemeService(entries),make=contexts(),ctx=make();await assert.rejects(service.terms(ctx,{action:'learn'}));ctx.message='/黑话 自家梗 只在这里懂';await service.before(ctx);await service.terms(ctx,{action:'learn'});assert.equal((await service.search(ctx,{query:'自家梗'})).source,'custom');assert.equal((await service.search(make('account-a','other-chat'),{query:'自家梗'})).status,'not_found');assert.equal((await service.search(make('account-b','private-a'),{query:'自家梗'})).status,'not_found');});
test('unlisted group members cannot teach shared terms',async()=>{const service=createMemeService(entries),ctx=contexts()('a','group','group');ctx.message='/黑话 自家梗 这个含义';await service.before(ctx);await assert.rejects(service.terms(ctx,{action:'learn'}),/无权/);});
test('a general hello causes no automatic dictionary injection',async()=>{assert.deepEqual(await createMemeService(entries).before({...contexts()(),message:'哈哈'}),{});});
test('sync cycle uses selected timezone and weekly boundary',()=>{assert.equal(syncCycle(Date.parse('2026-10-25T07:59Z'),{timeZone:'America/Toronto',syncTime:'04:00',syncWeekday:'Sunday'}),'2026-10-18');assert.equal(syncCycle(Date.parse('2026-10-25T08:00Z'),{timeZone:'America/Toronto',syncTime:'04:00',syncWeekday:'Sunday'}),'2026-10-25');});
