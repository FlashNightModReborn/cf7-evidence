const ORG="FlashNightModReborn", ORG_ID=183065313;
const GH="https://github.com", GAPI="https://api.github.com";
const SITE="https://cf7-art-review-receipts.crazyfs.chatgpt.site";
const PAGES="https://flashnightmodreborn.github.io", REVIEW=PAGES+"/cf7-evidence/review/";
const CALLBACK=SITE+"/github-auth/callback";
const enc=new TextEncoder(), dec=new TextDecoder();
const random=size=>b64(crypto.getRandomValues(new Uint8Array(size)));
const now=()=>Math.floor(Date.now()/1000);
const hex=data=>Array.from(new Uint8Array(data),n=>n.toString(16).padStart(2,"0")).join("");
const sha=async s=>hex(await crypto.subtle.digest("SHA-256",enc.encode(s)));
const challengeOf=async s=>b64(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(s))));
const b64=a=>btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const bytes=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const validSecret=s=>typeof s==="string"&&/^[A-Za-z0-9_-]{43}$/.test(s);
const safe=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
  "Access-Control-Allow-Origin":PAGES,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Vary":"Origin"};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8"}});
const html=(body,extra={})=>new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF7 · GitHub 登录</title><main style="max-width:36rem;margin:14vh auto;padding:1rem;font:18px/1.6 system-ui;color:#1b302a">'+body+'</main></html>',{headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'",...extra}});
class LoginFault extends Error{constructor(status,message){super(message);this.status=status;}}
function requireThat(test,status,message){if(!test)throw new LoginFault(status,message);}
function clockCookie(name,value,ttl){return "__Host-cf7-"+name+"="+value+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age="+ttl;}
function readCookie(request,name){
  const prefix="__Host-cf7-"+name+"=";
  return (request.headers.get("Cookie")||"").split(";").map(v=>v.trim()).find(v=>v.startsWith(prefix))?.slice(prefix.length);
}
async function wrap(env,value,purpose){
  const key=await crypto.subtle.importKey("raw",bytes(env.REVIEW_AUTH_KEY),{name:"AES-GCM"},false,["encrypt"]);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const payload=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:enc.encode(purpose)},key,enc.encode(JSON.stringify(value)));
  return b64(iv)+"."+b64(new Uint8Array(payload));
}
async function unwrap(env,box,purpose){
  try{
    const [iv,payload]=box.split(".");
    const key=await crypto.subtle.importKey("raw",bytes(env.REVIEW_AUTH_KEY),{name:"AES-GCM"},false,["decrypt"]);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(iv),additionalData:enc.encode(purpose)},key,bytes(payload))));
  }catch{throw new LoginFault(400,"登录凭据已过期，请返回校对页重新登录。");}
}
async function stateFrom(request,env,url,kind){
  const state=await unwrap(env,readCookie(request,kind),kind);
  requireThat(state.expires>now() && validSecret(state.nonce) && state.nonce===url.searchParams.get("state"),400,"登录状态已过期，请从校对页重新打开。");
  return state;
}
function redirect(url,cookie){
  return new Response(null,{status:303,headers:{...headers,Location:url,...(cookie?{"Set-Cookie":cookie}:{})}});
}
function reviewUrl(state){
  return REVIEW+state.issue+"/"+(state.rev==="latest"?"":state.rev+"/");
}
function config(db){return db.prepare("SELECT client_id,secret_box,slug FROM github_provider WHERE slot=1").first();}
async function ghJson(send,url,init){
  // workerd supports manual/follow. Reject all redirects here so credentials
  // can only be sent to the exact GitHub origin selected by the caller.
  const step=url.startsWith(GAPI+"/app-manifests/")?"registration":url===GAPI+"/user"?"identity":"token";
  let res;
  try{res=await send(url,{...init,redirect:"manual",headers:{"User-Agent":"CF7-Art-Review","Accept":"application/json",...(init?.headers||{})}});}
  catch{console.error("GitHub upstream unavailable",step);throw new LoginFault(502,"暂时无法连接 GitHub。可以刷新当前页重试。");}
  if(!res.ok)console.error("GitHub upstream response",step,res.status);
  requireThat(res.ok,502,"GitHub 未接受这一步（HTTP "+res.status+"）。请保留当前页。");
  const v=await res.json();
  requireThat(!v.error,400,"GitHub 授权未完成，请重新登录。");
  return v;
}
export async function githubIdentity(db,token){
  if(!/^cfr1\.[A-Za-z0-9_-]{43}$/.test(token))return null;
  return db.prepare("SELECT account_id AS accountId,login FROM github_sessions WHERE digest=? AND expires>?")
    .bind(await sha(token),now()).first();
}
async function sessionToken(env,proof,verifier){
  const key=await crypto.subtle.importKey("raw",bytes(env.REVIEW_AUTH_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return "cfr1."+b64(new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode("review-session-v1:"+proof+":"+verifier))));
}
export async function githubAuth(request,env,send=fetch){
  const url=new URL(request.url), op=url.pathname.split("/").at(-1), db=env.DB;
  const isApi=["status","exchange","logout"].includes(op);
  try{
    if(request.method==="OPTIONS")return json({ok:true});
    requireThat(db && validSecret(env.REVIEW_AUTH_KEY),503,"账号服务尚未完成配置。");
    if(isApi && request.headers.get("Origin"))requireThat(request.headers.get("Origin")===PAGES,403,"来源不属于校对页。");
    if(op==="status" && request.method==="GET"){
      const provider=await config(db);
      return json({configured:!!provider,provider:"github",app:provider?.slug || null});
    }
    if(op==="setup" && request.method==="GET"){
      const old=await config(db);
      if(old)return html('<h1>GitHub 登录已启用</h1><p><a href="'+REVIEW+'335/">返回教官校对页</a></p>');
      const state={nonce:random(32),expires:now()+3600};
      const manifest={name:"CF7 Art Review Sign In",url:REVIEW+"335/",description:"在 CF7 动作校对页使用 GitHub 公开账号签署评论。",
        public:true,redirect_url:SITE+"/github-auth/registered",callback_urls:[CALLBACK],
        hook_attributes:{url:SITE+"/github-auth/webhook-disabled",active:false},default_permissions:{},default_events:[],request_oauth_on_install:false};
      const dest=GH+"/organizations/"+ORG+"/settings/apps/new?state="+state.nonce;
      return html('<h1>启用 GitHub 账号评论</h1><p>仅需项目管理员办理一次。GitHub 会显示应用名称和权限，本应用只读取登录者的公开账号，不申请仓库内容和 Issue 写权限。</p><form method="post" action="'+safe(dest)+'"><input type="hidden" name="manifest" value="'+safe(JSON.stringify(manifest))+'"><button style="font:inherit;padding:.5rem 1rem">前往 GitHub 确认创建</button></form>',{"Set-Cookie":clockCookie("registration",await wrap(env,state,"registration"),3600)});
    }
    if(op==="registered" && request.method==="GET"){
      const old=await config(db);if(old)return redirect(REVIEW+"335/",clockCookie("registration","",0));
      await stateFrom(request,env,url,"registration");
      const code=url.searchParams.get("code")||"";
      requireThat(/^[a-zA-Z0-9_-]{10,256}$/.test(code),400,"缺少 GitHub 创建回执。");
      const app=await ghJson(send,GAPI+"/app-manifests/"+encodeURIComponent(code)+"/conversions",{method:"POST",headers:{"X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:"{}"});
      requireThat(Number(app.owner?.id)===ORG_ID && app.owner?.login?.toLowerCase()===ORG.toLowerCase() &&
        app.client_id && app.client_secret && app.html_url?.startsWith(GH+"/apps/") &&
        Object.entries(app.permissions||{}).every(([k,v])=>v==="none" || k==="metadata"&&v==="read"),403,"请使用 FlashNightModReborn 的公开身份登录应用。");
      const slug=app.slug || new URL(app.html_url).pathname.split("/").filter(Boolean).pop();
      await db.prepare("INSERT INTO github_provider(slot,client_id,secret_box,slug,owner_id) VALUES(1,?,?,?,?) ON CONFLICT(slot) DO NOTHING")
        .bind(app.client_id,await wrap(env,app.client_secret,"app-secret"),slug,ORG_ID).run();
      return html('<h1>GitHub 登录已启用</h1><p><a href="'+REVIEW+'335/?ui=3#U01">回到 U01，使用 GitHub 发表评论</a></p>',{"Set-Cookie":clockCookie("registration","",0)});
    }
    if(op==="start" && request.method==="GET"){
      const provider=await config(db);
      requireThat(provider,503,"项目管理员需要先在 GitHub 确认一次登录应用。草稿已保存在原校对页。");
      const issue=url.searchParams.get("issue")||"", rev=url.searchParams.get("rev")||"latest", move=url.searchParams.get("move")||"", hand=url.searchParams.get("challenge")||"";
      requireThat(/^[1-9]\d{0,8}$/.test(issue)&&/^(latest|r[1-9]\d*)$/.test(rev)&&/^[A-Z]\d{2}$/.test(move)&&validSecret(hand),400,"请从校对页打开登录。");
      const state={nonce:random(32),verifier:random(32),hand,issue,rev,move,expires:now()+600};
      const target=new URL(GH+"/login/oauth/authorize");
      target.search=new URLSearchParams({client_id:provider.client_id,redirect_uri:CALLBACK,state:state.nonce,
        code_challenge:await challengeOf(state.verifier),code_challenge_method:"S256"}).toString();
      return redirect(target.href,clockCookie("github",await wrap(env,state,"github"),600));
    }
    if(op==="callback" && request.method==="GET"){
      const state=await stateFrom(request,env,url,"github");
      if(url.searchParams.has("error"))return redirect(reviewUrl(state)+"?ui=3#gh_cancel=1&move="+state.move,clockCookie("github","",0));
      const provider=await config(db),code=url.searchParams.get("code")||"";
      requireThat(provider&&/^[a-zA-Z0-9_-]{8,256}$/.test(code),400,"GitHub 登录回执无效。");
      const token=await ghJson(send,GH+"/login/oauth/access_token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        client_id:provider.client_id,client_secret:await unwrap(env,provider.secret_box,"app-secret"),code,
        redirect_uri:CALLBACK,code_verifier:state.verifier})});
      requireThat(typeof token.access_token==="string" && token.access_token.length>0,400,"GitHub 未返回身份授权。");
      const user=await ghJson(send,GAPI+"/user",{headers:{Authorization:"Bearer "+token.access_token,"X-GitHub-Api-Version":"2022-11-28"}});
      requireThat(Number.isSafeInteger(user.id) && user.id>0 && typeof user.login==="string" && user.login.length<=100,400,"GitHub 身份无效。");
      const proof=random(32);
      await db.batch([db.prepare("DELETE FROM github_handoffs WHERE expires<=?").bind(now()),
        db.prepare("DELETE FROM github_sessions WHERE expires<=?").bind(now()),
        db.prepare("INSERT INTO github_handoffs(digest,challenge,issue,account_id,login,expires) VALUES(?,?,?,?,?,?)")
          .bind(await sha(proof),state.hand,Number(state.issue),String(user.id),user.login,now()+180)]);
      return redirect(reviewUrl(state)+"?ui=3#gh_return="+proof+"&move="+state.move,clockCookie("github","",0));
    }
    if(op==="exchange" && request.method==="POST"){
      requireThat(request.headers.get("Content-Type")?.startsWith("application/json"),415,"需要 JSON。");
      const text=await request.text();requireThat(text.length<1024,400,"登录回执过长。");
      let payload;try{payload=JSON.parse(text);}catch{throw new LoginFault(400,"登录回执格式无效。");}
      const {proof,verifier,issue}=payload||{};
      requireThat(validSecret(proof)&&validSecret(verifier)&&Number.isSafeInteger(issue)&&issue>0,400,"登录回执无效。");
      const token=await sessionToken(env,proof,verifier), sh=await sha(token), ph=await sha(proof), pc=await challengeOf(verifier), t=now();
      await db.batch([
        db.prepare("INSERT INTO github_sessions(digest,account_id,login,expires) SELECT ?,account_id,login,? FROM github_handoffs WHERE digest=? AND challenge=? AND issue=? AND expires>? ON CONFLICT(digest) DO NOTHING")
          .bind(sh,t+30*86400,ph,pc,issue,t),
        db.prepare("DELETE FROM github_handoffs WHERE digest=? AND challenge=? AND issue=? AND expires>?").bind(ph,pc,issue,t),
      ]);
      const identity=await githubIdentity(db,token);
      requireThat(identity,401,"登录回执无效或已过期，请重新用 GitHub 登录。");
      return json({token,login:identity.login,accountId:identity.accountId});
    }
    if(op==="logout" && request.method==="POST"){
      const token=(request.headers.get("Authorization")||"").replace(/^Bearer /,"");
      if(/^cfr1\.[A-Za-z0-9_-]{43}$/.test(token))await db.prepare("DELETE FROM github_sessions WHERE digest=?").bind(await sha(token)).run();
      return json({ok:true});
    }
    throw new LoginFault(404,"找不到这个登录入口。");
  }catch(e){
    if(!(e instanceof LoginFault))console.error("GH identity service",e?.name||"unavailable");
    const message=e instanceof LoginFault?e.message:"GitHub 登录服务暂时不可用，请重试。";
    return isApi?json({error:message},e instanceof LoginFault?e.status:503):new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><main style="max-width:36rem;margin:14vh auto;font:18px system-ui"><p>'+safe(message)+'</p><a href="'+REVIEW+'335/?ui=3">回到校对页</a></main>',
      {status:e instanceof LoginFault?e.status:503,headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
  }
}
