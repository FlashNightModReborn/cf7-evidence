const origin = "https://flashnightmodreborn.github.io";
const policyRoot = "https://raw.githubusercontent.com/FlashNightModReborn/cf7-evidence/main/review/";
const policies = new Map();
const fields = "seq,issue,lane,author,revision,action,asset,choice,note,position_ms AS positionMs,previous,created_at AS createdAt";
const latestSQL = "SELECT "+fields+" FROM feedback_events WHERE issue=? AND lane=? AND author=? AND action=? ORDER BY seq DESC LIMIT 1";
const acceptedChoices = new Set(["match","mismatch","unclear","use","other","yes","no"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ApiFault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function verify(condition,status,message) {
  if (!condition) throw new ApiFault(status,message);
}
function json(body,status=200) {
  return new Response(JSON.stringify(body),{status,headers:{
    "Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",
    "Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"600",
    "Vary":"Origin","X-Content-Type-Options":"nosniff",
  }});
}

async function policyFor(issue) {
  const entry=policies.get(issue);
  if (entry && entry.expires>Date.now()) return entry.value;
  const r=await fetch(policyRoot+issue+"/policy.json",{headers:{Accept:"application/json"},cf:{cacheTtl:15}});
  verify(r.status!==404,404,"找不到这张校对单");
  verify(r.ok,503,"暂时读不到校对版本");
  const value=await r.json();
  verify(value.issue===issue && /^r[1-9]\d*$/.test(value.revision) && value.moves && Array.isArray(value.grants),
    503,"校对版本正在更新");
  if(policies.size>=64)policies.delete(policies.keys().next().value);
  policies.set(issue,{value,expires:Date.now()+15000});
  return value;
}

async function grantFor(request,policy,lane) {
  const h=request.headers.get("Authorization") || "";
  verify(/^Bearer [a-zA-Z0-9_-]{40,96}$/.test(h),403,"请使用本单的专属校对链接");
  const encoded=new TextEncoder().encode(h.slice(7));
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",encoded));
  const digest=Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
  const grant=policy.grants.find(g=>g.digest===digest && g.lane===lane);
  verify(grant && typeof grant.author==="string",403,"此链接没有本单的填写权限");
  return grant;
}

async function limitedBody(request) {
  verify((request.headers.get("Content-Type") || "").split(";")[0]==="application/json",415,"需要 JSON");
  verify(Number(request.headers.get("Content-Length") || 0)<=4096,413,"反馈过长");
  const reader=request.body?.getReader();
  verify(reader,400,"缺少反馈");
  const data=new Uint8Array(4096);
  let n=0;
  while(true){
    const next=await reader.read();
    if(next.done)break;
    if(n+next.value.length>data.length){await reader.cancel();throw new ApiFault(413,"反馈过长");}
    data.set(next.value,n);n+=next.value.length;
  }
  try{return JSON.parse(new TextDecoder().decode(data.subarray(0,n)));}
  catch{throw new ApiFault(400,"反馈格式无效");}
}

async function writeEvent(db,issue,lane,author,policy,b) {
  verify(b && typeof b==="object" && uuid.test(b.requestId || "") && typeof b.action==="string" && /^[A-Z]\d{2}$/.test(b.action),400,"动作或回执编号无效");
  verify(typeof b.note==="string" && [...b.note].length<=180 && Number.isSafeInteger(b.previous) && b.previous>=0 &&
    typeof b.asset==="string" && /^[a-f0-9]{64}$/.test(b.asset) && Number.isSafeInteger(b.positionMs) && b.positionMs>=0,400,"反馈字段无效");
  const lookup=()=>db.prepare("SELECT "+fields+" FROM feedback_events WHERE issue=? AND lane=? AND author=? AND request_id=?")
    .bind(issue,lane,author,b.requestId).first();
  const same=(old)=>["revision","action","asset","choice","note","positionMs","previous"].every(k=>old[k]===b[k]);
  // A response lost across a new release still resolves to the original receipt.
  const existing=await lookup();
  if(existing){verify(same(existing),409,"回执编号已经用于另一条反馈");return json({event:existing,replayed:true});}
  verify(policy.revision===b.revision,409,"已发布新一轮，请刷新后再确认");
  const move=Object.hasOwn(policy.moves,b.action)?policy.moves[b.action]:null;
  verify(move && move.version===b.asset,409,"动作版本已更新，请重新查看");
  verify(b.choice==="clear" || (acceptedChoices.has(b.choice) && move.choices.includes(b.choice)),400,"这个选项不适用于该动作");
  verify(b.positionMs<=move.durationMs,400,"播放位置超出本段画面");
  const insert=`INSERT INTO feedback_events(issue,lane,author,request_id,revision,action,asset,choice,note,position_ms,previous,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE COALESCE((SELECT seq FROM feedback_events WHERE issue=? AND lane=? AND author=? AND action=? ORDER BY seq DESC LIMIT 1),0)=?
    AND (SELECT COUNT(*) FROM feedback_events WHERE issue=? AND lane=? AND author=? AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))<60
    ON CONFLICT(issue,lane,author,request_id) DO NOTHING`;
  await db.prepare(insert).bind(issue,lane,author,b.requestId,b.revision,b.action,b.asset,b.choice,b.note,b.positionMs,b.previous,
    issue,lane,author,b.action,b.previous,issue,lane,author).run();
  const receipt=await lookup();
  if(receipt){verify(same(receipt),409,"回执编号已经用于另一条反馈");return json({event:receipt},201);}
  const newest=await db.prepare(latestSQL).bind(issue,lane,author,b.action).first();
  if((newest?.seq || 0)!==b.previous)return json({error:"这招出现了较新的反馈，请看过后再选",latest:newest},409);
  return json({error:"操作较快，稍后会继续同步"},429);
}

export async function reviewApi(request,env,loadPolicy=policyFor) {
  const url=new URL(request.url);
  try{
    const match=/^\/api\/v1\/reviews\/([1-9]\d{0,8})\/(events|session)$/.exec(url.pathname);
    verify(match,404,"找不到此接口");
    if(request.method==="OPTIONS")return json({ok:true});
    const issue=Number(match[1]), endpoint=match[2], lane=url.searchParams.get("lane") || "art";
    verify(lane==="art" || lane==="qa",400,"回执分组无效");
    const incoming=request.headers.get("Origin");
    verify(!incoming || incoming===origin,403,"此来源不属于校对页面");
    const policy=await loadPolicy(issue);
    if(endpoint==="session"){
      verify(request.method==="GET",405,"请求方式无效");
      const grant=await grantFor(request,policy,lane);
      return json({issue,revision:policy.revision,lane,author:grant.author});
    }
    verify(env.DB,503,"反馈存储尚未就绪");
    if(request.method==="GET"){
      const raw=url.searchParams.get("after") || "0";
      verify(/^\d{1,14}$/.test(raw),400,"回执位置无效");
      const result=await env.DB.prepare("SELECT "+fields+" FROM feedback_events WHERE issue=? AND lane=? AND seq>? ORDER BY seq LIMIT 201")
        .bind(issue,lane,Number(raw)).all();
      return json({issue,revision:policy.revision,events:result.results.slice(0,200),more:result.results.length>200});
    }
    verify(request.method==="POST",405,"请求方式无效");
    const grant=await grantFor(request,policy,lane);
    return await writeEvent(env.DB,issue,lane,grant.author,policy,await limitedBody(request));
  }catch(error){
    if(error instanceof ApiFault)return json({error:error.message},error.status);
    console.error("Review API error",error instanceof Error?error.name:"unknown");
    return json({error:"回执服务暂时不可用，请稍后重试"},503);
  }
}
