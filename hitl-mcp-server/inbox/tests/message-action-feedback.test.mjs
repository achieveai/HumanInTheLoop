import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const inbox=readFileSync(new URL('../src/inbox.js',import.meta.url),'utf8');
for(const [name,end] of [['selectAdjacent','selectAfterTargets'],['selectAfterTargets','']]) {
 test(name+' retains another waiting message in the selected conversation',()=>{
 const start=inbox.indexOf('    function '+name+'('); const stop=end?inbox.indexOf('    function '+end+'(',start):inbox.indexOf('\n    function ',start+20);
 const old={messageId:'a',key:'thread'},other={messageId:'b',key:'other'},remaining={messageId:'c',key:'thread',status:'pending'};
 const chosen=[];const ctx=vm.createContext({state:{selectedId:'a',selectedConversationKey:'thread'},visibleMessages:[other],latestList:{messages:[other,remaining]},optimistic:new Map(),predictedRow:r=>r,conversationKeyOf:r=>r.key,selectMessage:r=>chosen.push(r.messageId),run:x=>x,detailPane:{update:r=>chosen.push(r.messageId)}});
 vm.runInContext(inbox.slice(start,stop)+'\nglobalThis.invokeSelection='+name,ctx);
 if(name==='selectAdjacent')ctx.invokeSelection([other],[old,other,remaining]);else ctx.invokeSelection(new Set(['a']),[old,other,remaining]);
 assert.equal(chosen[0],'c');
 });
}
const thread=readFileSync(new URL('../src/pane-thread.js',import.meta.url),'utf8');
test('settled collapsed line uses the incoming status',()=>{
 const start=thread.indexOf('    function reconcile(incoming)');const stop=thread.indexOf('\n    /**',start);
 const old={messageId:'a',status:'pending'},fresh={...old,status:'dismissed'};let collapsedStatus;
 const ctx=vm.createContext({painted:{rows:[old],nodes:{querySelectorAll:()=>[]}},generation:1,cards:new Map([['a',{row:old}]]),expanded:new Set(),isOpenMessage:r=>r.status==='pending',collapseCard:()=>{collapsedStatus=ctx.painted.rows[0].status},latestOf:r=>r[0],paintOrphanMark:()=>{}});
 vm.runInContext(thread.slice(start,stop)+'\nglobalThis.run=reconcile',ctx);ctx.run([fresh]);assert.equal(collapsedStatus,'dismissed');
});
