import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const groupConversations = rows => [...new Set(rows.map(r=>r.key))].map(key=>({key,anchor:rows.find(r=>r.key===key)}));
const inbox=readFileSync(new URL('../src/inbox.js',import.meta.url),'utf8');
for (const name of ['selectAdjacent', 'selectAfterTargets']) {
 for (const retained of ['pending', 'dismissed', 'answered']) {
  test(`${name} retains a visible conversation with a ${retained} message`, () => {
   const start = inbox.indexOf('    function '+name+'(');
   const stop = inbox.indexOf('\n    function ', start+20);
   const old = {messageId:'a',key:'thread'};
   const other = {messageId:'b',key:'other'};
   const remaining = {messageId:'c',key:'thread',status:retained};
   const chosen = [];
   const ctx = vm.createContext({groupConversations,state:{selectedId:'a',selectedConversationKey:'thread'},visibleMessages:[other,remaining],latestList:{messages:[other,remaining]},optimistic:new Map(),predictedRow:r=>r,conversationKeyOf:r=>r.key,selectMessage:r=>chosen.push(r.key),run:x=>x,detailPane:{update:r=>chosen.push(r.key)}});
   vm.runInContext(inbox.slice(start,stop)+'\nglobalThis.invokeSelection='+name,ctx);
   if(name==='selectAdjacent') ctx.invokeSelection([other,remaining],[old,other,remaining]);
   else ctx.invokeSelection(new Set(['a']),[old,other,remaining]);
   assert.equal(chosen[0], 'thread');
  });
 }
 test(`${name} advances when the conversation leaves the visible list`, () => {
  const start=inbox.indexOf('    function '+name+'('), stop=inbox.indexOf('\n    function ',start+20);
  const old={messageId:'a',key:'thread'}, other={messageId:'b',key:'other'}, hidden={messageId:'c',key:'thread',status:'pending'};
  const chosen=[];
  const ctx=vm.createContext({groupConversations,state:{selectedId:'a',selectedConversationKey:'thread'},visibleMessages:[other],latestList:{messages:[other,hidden]},optimistic:new Map(),predictedRow:r=>r,conversationKeyOf:r=>r.key,selectMessage:r=>chosen.push(r.key),run:x=>x,detailPane:{update:r=>chosen.push(r.key)}});
  vm.runInContext(inbox.slice(start,stop)+'\nglobalThis.invokeSelection='+name,ctx);
  if(name==='selectAdjacent')ctx.invokeSelection([other],[old,other]);else ctx.invokeSelection(new Set(['a']),[old,other]);
  assert.equal(chosen[0],'other');
 });
}
const thread=readFileSync(new URL('../src/pane-thread.js',import.meta.url),'utf8');
test('settled collapsed line uses the incoming status',()=>{
 const start=thread.indexOf('    function reconcile(incoming)');const stop=thread.indexOf('\n    /**',start);
 const old={messageId:'a',status:'pending'},fresh={...old,status:'dismissed'};let collapsedStatus;
 const ctx=vm.createContext({painted:{rows:[old],nodes:{querySelectorAll:()=>[]}},generation:1,cards:new Map([['a',{row:old}]]),expanded:new Set(),isOpenMessage:r=>r.status==='pending',collapseCard:()=>{collapsedStatus=ctx.painted.rows[0].status},latestOf:r=>r[0],paintOrphanMark:()=>{}});
 vm.runInContext(thread.slice(start,stop)+'\nglobalThis.run=reconcile',ctx);ctx.run([fresh]);assert.equal(collapsedStatus,'dismissed');
});

const notification = readFileSync(new URL('../src/render-notification.js', import.meta.url), 'utf8');
for (const action of ['dismiss', 'restore']) {
 test(`notification ${action} switches to its reverse action after successful publication`, async () => {
  const start = notification.indexOf('    async function '+action+'(');
  const stop = notification.indexOf('\n    }', start) + 6;
  const applied = [];
  const row = {messageId:'a',status:action==='dismiss'?'pending':'dismissed',responseId:action==='dismiss'?null:'dismiss-a'};
  const ctx = vm.createContext({currentRow:row, settled:action==='restore', restoreInFlight:false,
   actions:{onDismiss:async()=> 'dismiss-a',onRestore:async()=> 'restore-a'},
   bar:{querySelector:()=>({disabled:false})}, error:{}, drawFooter:()=>{},
   isOpen:r=>r.status==='pending',applyRow:r=>applied.push(r)});
  vm.runInContext(notification.slice(start,stop)+'\nglobalThis.invoke='+action,ctx);
  await ctx.invoke();
  assert.equal(applied[0].status,action==='dismiss'?'dismissed':'pending');
  assert.equal(applied[0].responseId,action==='dismiss'?'dismiss-a':null);
 });
}

test('read completion fills the dismissal ID after an optimistic status update', async () => {
 const start=notification.indexOf('    async function dismiss('),stop=notification.indexOf('\n    }',start)+6;
 const applied=[];
 const ctx=vm.createContext({settled:false,currentRow:{messageId:'a',status:'pending'},
  bar:{querySelector:()=>({disabled:false})},error:{},isOpen:r=>r.status==='pending',applyRow:r=>applied.push(r),
  actions:{onDismiss:async()=>{ctx.currentRow={messageId:'a',status:'dismissed'};return 'dismiss-a';}}});
 vm.runInContext(notification.slice(start,stop)+'\nglobalThis.invoke=dismiss',ctx);
 await ctx.invoke();assert.equal(applied[0].responseId,'dismiss-a');
});
test('an acted-on message that remains visible keeps its conversation selected', () => {
 const start=inbox.indexOf('    function selectAfterTargets('),stop=inbox.indexOf('\n    function ',start+20);
 const row={messageId:'a',key:'thread',status:'dismissed'},chosen=[];
 const ctx=vm.createContext({groupConversations,state:{selectedId:'a',selectedConversationKey:'thread'},visibleMessages:[row],
  conversationKeyOf:r=>r.key,run:x=>x,detailPane:{update:r=>chosen.push(r.messageId)}});
 vm.runInContext(inbox.slice(start,stop)+'\nglobalThis.invoke=selectAfterTargets',ctx);
 ctx.invoke(new Set(['a']),[row]);assert.deepEqual(chosen,['a']);
});
for (const name of ['selectAdjacent','selectAfterTargets']) {
 test(`${name} advances by conversation rather than message index`, () => {
  const start=inbox.indexOf('    function '+name+'('),stop=inbox.indexOf('\n    function ',start+20);
  const before=[{messageId:'x',key:'first'},{messageId:'y',key:'first'},{messageId:'a',key:'thread'},{messageId:'b',key:'next'},{messageId:'c',key:'last'}];
  const after=before.filter(r=>r.key!=='thread'),chosen=[];
  const ctx=vm.createContext({groupConversations,state:{selectedId:'a',selectedConversationKey:'thread'},visibleMessages:after,
   conversationKeyOf:r=>r.key,selectMessage:r=>chosen.push(r.key)});
  vm.runInContext(inbox.slice(start,stop)+'\nglobalThis.invoke='+name,ctx);
  if(name==='selectAdjacent')ctx.invoke(after,before);else ctx.invoke(new Set(['a']),before);
  assert.deepEqual(chosen,['next']);
 });
}
