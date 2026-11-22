import assert from "node:assert/strict";
import {randomBytes,createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";
import {githubAuth} from "./github-auth.mjs";
import {reviewApi} from "./reviews.mjs";

const base="https://cf7-art-review-receipts.crazyfs.chatgpt.site";
const hash=s=>createHash("sha256").update(s).digest("base64url");
function database(sql){
  return {prepare(raw){return {first:async()=>sql.prepare(raw).get(),bind(...args){return{first:async()=>sql.prepare(raw).get(...args),
    all:async()=>({results:sql.prepare(raw).all(...args)}),run:async()=>sql.prepare(raw).run(...args)};}};},
  async batch(list){sql.exec("BEGIN");try{const rows=[];for(const s of list)rows.push(await s.run());sql.exec("COMMIT");return rows;}catch(e){sql.exec("ROLLBACK");throw e;}}};
}
test("organization bootstrap, PKCE login, signed feedback, safe callback retry, logout",async()=>{
  const sql=new DatabaseSync(":memory:");
  for(const file of ["001-feedback.sql","002-github-identity.sql"])sql.exec(await readFile(new URL(file,import.meta.url),"utf8"));
  const env={DB:database(sql),REVIEW_AUTH_KEY:randomBytes(32).toString("base64url")};
  const owner={id:183065313,login:"FlashNightModReborn"};
  const fake={client_id:"test-client",client_secret:"fixture-app-secret",slug:"cf7-art-review-sign-in",owner,
    html_url:"https://github.com/apps/cf7-art-review-sign-in",permissions:{metadata:"read"}};
  let pkce,allow=true;
  const send=async(input,opts)=>{
    if(input.includes("app-manifests"))return Response.json({...fake,owner:allow?owner:{id:42,login:"different"}});
    if(input.endsWith("access_token")){
      const b=JSON.parse(opts.body);assert.equal(b.client_secret,fake.client_secret);assert.equal(hash(b.code_verifier),pkce);
      return Response.json({access_token:"synthetic-provider-token"});
    }
    assert.equal(input,"https://api.github.com/user");assert.equal(opts.headers.Authorization,"Bearer synthetic-provider-token");
    return Response.json({id:23017,login:"ExampleArtist"});
  };
  const req=(path_,opts={})=>githubAuth(new Request(base+"/github-auth/"+path_,opts),env,send);
  const cook=r=>r.headers.get("set-cookie").split(";")[0];
  const startSetup=await req("setup");assert.equal(startSetup.status,200);
  const page=await startSetup.text(),regState=/settings\/apps\/new\?state=([\w-]+)/.exec(page)[1];
  assert.ok(page.includes("&quot;default_permissions&quot;:{}"));
  const callback="registered?state="+regState+"&code=sample-manifest-code";
  assert.equal((await req(callback)).status,400);
  allow=false;assert.equal((await req(callback,{headers:{Cookie:cook(startSetup)}})).status,403);
  allow=true;assert.equal((await req(callback,{headers:{Cookie:cook(startSetup)}})).status,200);
  const provider=sql.prepare("select * from github_provider").get();
  assert.notEqual(provider.secret_box,fake.client_secret);
  assert.equal((await (await req("status")).json()).configured,true);
  const verifier=randomBytes(32).toString("base64url");
  const start=await req("start?issue=335&rev=r1&move=U01&challenge="+hash(verifier));
  const target=new URL(start.headers.get("location"));pkce=target.searchParams.get("code_challenge");
  assert.equal(target.origin,"https://github.com");assert.equal(target.pathname,"/login/oauth/authorize");assert.equal(target.searchParams.get("code_challenge_method"),"S256");
  assert.ok(!target.searchParams.has("scope"));const state=target.searchParams.get("state");
  assert.equal((await req("callback?state=incorrect&code=test-login-code",{headers:{Cookie:cook(start)}})).status,400);
  const cancel=await req("callback?state="+state+"&error=access_denied",{headers:{Cookie:cook(start)}});
  assert.ok(cancel.headers.get("location").includes("gh_cancel=1"));
  const success=await req("callback?state="+state+"&code=test-login-code",{headers:{Cookie:cook(start)}});
  const back=new URL(success.headers.get("location"));assert.equal(back.pathname,"/cf7-evidence/review/335/r1/");
  assert.ok(!back.href.includes("synthetic-provider-token"));
  const proof=new URLSearchParams(back.hash.slice(1)).get("gh_return");
  const exchange=(v,issue=335)=>req("exchange",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://flashnightmodreborn.github.io"},
    body:JSON.stringify({proof,verifier:v,issue})});
  assert.equal((await exchange(randomBytes(32).toString("base64url"))).status,401);
  assert.equal((await exchange(verifier,100)).status,401);
  const saved=await (await exchange(verifier)).json();assert.equal(saved.login,"ExampleArtist");
  assert.match(saved.token,/^cfr1\./);assert.equal((await (await exchange(verifier)).json()).token,saved.token);
  assert.equal(sql.prepare("select count(*) n from github_sessions").get().n,1);
  assert.equal(sql.prepare("select count(*) n from github_handoffs").get().n,0);
  let loginSetting=true;
  const policy=async()=>({issue:335,revision:"r1",githubLogin:loginSetting,grants:[],moves:{U01:{version:"a".repeat(64),durationMs:770,choices:["match","mismatch","unclear"]}}});
  const api=(endpoint,options={})=>reviewApi(new Request(base+"/api/v1/reviews/335/"+endpoint,{...options,headers:{
    Authorization:"Bearer "+saved.token,"Content-Type":"application/json",...options.headers}}),env,policy);
  assert.equal((await (await api("session")).json()).display,"@ExampleArtist");
  loginSetting=undefined;
  const updating=await api("session");assert.equal(updating.status,503);assert.equal((await updating.json()).code,"policy_updating");
  loginSetting=false;
  const closed=await api("session");assert.equal(closed.status,403);assert.equal((await closed.json()).code,"writing_disabled");
  loginSetting=true;
  assert.equal((await (await api("session")).json()).display,"@ExampleArtist");
  const event=await api("events",{method:"POST",body:JSON.stringify({revision:"r1",requestId:randomUUID(),action:"U01",asset:"a".repeat(64),
    choice:"comment",note:"测试留言",positionMs:540,previous:0})});
  assert.equal(event.status,201);const e=(await event.json()).event;assert.equal(e.author,"github:23017");assert.equal(e.authorLabel,"@ExampleArtist");assert.equal(e.positionMs,540);
  assert.equal((await api("session?lane=qa")).status,403);
  assert.equal((await req("logout",{method:"POST",headers:{Authorization:"Bearer "+saved.token}})).status,200);
  const expired=await api("session");
  assert.equal(expired.status,401);assert.equal((await expired.json()).code,"session_expired");
  sql.close();
});
