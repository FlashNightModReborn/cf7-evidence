import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {test} from "node:test";
import {reviewApi} from "./reviews.mjs";
import {Receipts} from "../app/v4/receipts.js";

test("persisted choices, versioned replay, edit conflicts and withdrawals",async()=>{
  const sql=new DatabaseSync(":memory:");
  sql.exec(await readFile(new URL("./001-feedback.sql",import.meta.url),"utf8"));
  sql.exec(await readFile(new URL("./002-github-identity.sql",import.meta.url),"utf8"));
  const DB={prepare(statement){return{bind(...args){const q=sql.prepare(statement);return{
    first:async()=>q.get(...args),all:async()=>({results:q.all(...args)}),run:async()=>q.run(...args),
  };}};}};
  const key=randomBytes(32).toString("base64url"), digest=s=>createHash("sha256").update(s).digest("hex");
  const policy={issue:335,revision:"r1",moves:{},grants:[{lane:"art",author:"测试画师",digest:digest(key)}]};
  const asset=digest("pose A"), changed=digest("pose B");
  policy.moves.U19={version:asset,choices:["match","mismatch","unclear"],durationMs:600};
  const state={DB};
  async function request(path,method="GET",token="",data=null){
    const headers={"Origin":"https://flashnightmodreborn.github.io"};
    if(token)headers.Authorization="Bearer "+token;
    if(data)headers["Content-Type"]="application/json";
    const r=await reviewApi(new Request("https://example.test/api/v1/reviews/335/"+path,{method,headers,body:data?JSON.stringify(data):undefined}),state,async()=>policy);
    return {status:r.status,body:await r.json()};
  }
  const original={requestId:randomUUID(),revision:"r1",action:"U19",asset,choice:"mismatch",positionMs:230,note:"第一拍",previous:0};
  assert.equal((await request("events","POST","",original)).status,403);
  assert.equal((await request("session?lane=qa","GET",key)).status,403);
  const a=await request("events","POST",key,original);assert.equal(a.status,201);
  assert.equal(a.body.event.positionMs,230);
  const replay=await request("events","POST",key,original);assert.equal(replay.status,200);assert.equal(replay.body.event.seq,a.body.event.seq);
  assert.equal((await request("events","POST",key,{...original,choice:"match"})).status,409);
  assert.equal((await request("events","POST",key,{...original,requestId:randomUUID(),choice:"match"})).status,409);
  assert.equal((await request("events","POST",key,{...original,requestId:randomUUID(),positionMs:700})).status,400);
  const msg=await request("events","POST",key,{...original,requestId:randomUUID(),previous:a.body.event.seq,choice:"comment",note:"文字可以单独发"});
  assert.equal(msg.status,201);
  assert.equal((await request("events","POST",key,{...original,requestId:randomUUID(),previous:msg.body.event.seq,choice:"comment",note:"   "})).status,400);
  policy.revision="r2";policy.moves.U19.version=changed;
  assert.equal((await request("events","POST",key,original)).status,200);
  assert.equal((await request("events","POST",key,{...original,requestId:randomUUID()})).status,409);
  const store=new Receipts({issue:335,revision:"r2",api:"https://example.test",lane:"art"});
  store.events.set(a.body.event.seq,a.body.event);
  store.events.set(msg.body.event.seq,msg.body.event);
  assert.equal(store.mark({id:"U19",version:asset}),"mismatch");
  assert.equal(store.mark({id:"U19",version:changed}),"recheck");
  const b=await request("events","POST",key,{...original,requestId:randomUUID(),revision:"r2",asset:changed,previous:msg.body.event.seq,choice:"match"});
  assert.equal(b.status,201);store.events.set(b.body.event.seq,b.body.event);assert.equal(store.mark({id:"U19",version:changed}),"match");
  const cleared=await request("events","POST",key,{...original,requestId:randomUUID(),revision:"r2",asset:changed,previous:b.body.event.seq,choice:"clear"});
  assert.equal(cleared.status,201);store.events.set(cleared.body.event.seq,cleared.body.event);
  assert.equal(store.mark({id:"U19",version:changed}),"");
  const rows=(await request("events")).body.events;
  assert.deepEqual(rows.map(r=>r.revision),["r1","r1","r2","r2"]);
  policy.moves.U01=policy.moves.U19;
  const firstComment=await request("events","POST",key,{...original,revision:"r2",asset:changed,action:"U01",requestId:randomUUID(),choice:"comment",note:"只留一条意见"});
  assert.equal(firstComment.status,201);store.events.set(firstComment.body.event.seq,firstComment.body.event);
  assert.equal(store.mark({id:"U01",version:changed}),"comment");
  assert.deepEqual((await request("events?lane=qa")).body.events,[]);
  sql.close();
});
