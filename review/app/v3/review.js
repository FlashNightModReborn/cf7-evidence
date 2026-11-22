import {Receipts} from "./receipts.js";
import * as github from "./github.js";

const $=id=>document.getElementById(id);
const conf=document.body.dataset;
const root=new URL(conf.root,location.href);
const lane=new URLSearchParams(location.search).get("qa")==="1"?"qa":"art";
const labels={match:"对得上",mismatch:"对不上",unclear:"看不清",use:"用左边这版",other:"指的是别的稿",yes:"是这招",no:"不是这招",clear:"撤回标记",comment:"文字评论"};
const marks={match:["✓","ok"],use:["✓","ok"],yes:["✓","ok"],mismatch:["!","bad"],other:["!","bad"],no:["!","bad"],unclear:["?",""],comment:["评",""],pending:["待",""],conflict:["!","bad"],recheck:["复看",""]};
let fragment=location.hash.slice(1);
let initialMove=/^[A-Z]\d{2}$/.test(fragment)?fragment:null;
const hashValues=new URLSearchParams(fragment);
const invite=hashValues.get("invite");
let returned=hashValues.has("gh_return") || hashValues.has("gh_cancel");
let cancelled=hashValues.has("gh_cancel");
const key="cf7-art-review:"+conf.issue+":"+lane+":grant";
let grant=null;
try{grant=localStorage.getItem(key);}catch{}
if(invite){
  if(/^[A-Za-z0-9_-]{43}$/.test(invite)){grant=invite;try{localStorage.setItem(key,invite);}catch{}}
  initialMove=hashValues.get("move");
  history.replaceState(null,"",location.pathname+location.search+(/^[A-Z]\d{2}$/.test(initialMove || "")?"#"+initialMove:""));
}
let account=lane==="art"?github.cachedAccount():null;
if(account)grant=account.token;
if(returned){
  const pending=github.flow();
  initialMove=hashValues.get("move");
  const proof=hashValues.get("gh_return");
  if(!cancelled && pending?.issue===Number(conf.issue) && pending.move===initialMove && /^[a-zA-Z0-9_-]{43}$/.test(proof||"")){
    pending.proof=proof;
    try{github.saveFlow(pending);}catch{}
  }else if(!cancelled){returned=false;}
  history.replaceState(null,"",location.pathname+location.search+(/^[A-Z]\d{2}$/.test(initialMove||"")?"#"+initialMove:""));
}
const initialTime=new URLSearchParams(location.search).get("t");
const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
const wall=$("wall"), dlg=$("detail"), single=$("single");
let model, latest, store, versionRoot, selected, kind="", wantPlay=!reduced, speed=1, resumeAfter=false;
let explicitStatus="", picking=false, authBusy=false, finishingLogin=false;
const buttons=new Map();

async function get(url,noCache=false){
  const r=await fetch(url,{cache:noCache?"no-cache":"default",referrerPolicy:"no-referrer"});
  if(!r.ok)throw Error("素材清单读取失败");
  return r.json();
}
function media(path){return new URL(path,versionRoot).href;}
function setPlay(){ $("play").textContent=wall.paused?"播放全部":"暂停全部"; }
function playWall(){wantPlay=true;wall.play().catch(()=>{if(wall.paused)setPlay();});}
function fit(){
  if(!model)return;
  const surface=$("surface"), w=surface.clientWidth, h=surface.clientHeight;
  if(!w || !h)return;
  const next=h>w?"tall":"wide", v=model.layouts[next], scale=Math.min(w/v.width,h/v.height);
  $("board").style.width=v.width*scale+"px";$("board").style.height=v.height*scale+"px";
  if(kind===next)return;
  const time=Number.isFinite(wall.currentTime)?wall.currentTime:0;
  kind=next;$("board").dataset.layout=next;
  for(const [id,box] of Object.entries(v.slots)){
    const [x,y,cw,ch]=box, s=buttons.get(id)?.style;
    if(!s)continue;
    s.left=x*100/v.width+"%";s.top=y*100/v.height+"%";s.width=cw*100/v.width+"%";s.height=ch*100/v.height+"%";
  }
  const picture=$("poster").parentNode;
  picture.querySelector("source").srcset=media(model.layouts.tall.poster);
  $("poster").src=media(model.layouts.wide.poster);
  wall.style.opacity="0";
  async function loadMotion(){
    if(kind!==next)return;
    if(reduced && !wantPlay && !time){wall.removeAttribute("src");wall.load();return;}
    wall.src=media(v.movie);
    wall.addEventListener("loadedmetadata",()=>{
      if(kind!==next)return;
      wall.playbackRate=speed;
      if(time>0 && Number.isFinite(wall.duration)){
        wall.addEventListener("seeked",()=>{if(kind===next)wall.style.opacity="1";},{once:true});
        wall.currentTime=Math.min(time,Math.max(0,wall.duration-.02));
      }
      if(wantPlay && !dlg.open)playWall();
    },{once:true});
    wall.load();
  }
  // Show the orientation-specific still first. Fetch a single overview stream.
  $("poster").decode().catch(()=>{}).then(loadMotion);
}
function currentView(){return model.revision===store.activeRevision;}
function linkAt(revision,id,ms){
  const url=new URL(revision+"/",root);
  if(lane==="qa")url.searchParams.set("qa","1");
  url.searchParams.set("t",String(ms));url.hash=id;return url.href;
}
function clock(ms){return (ms/1000).toFixed(2)+" 秒";}
function when(value){return new Date(value).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function position(){
  return selected?Math.min(selected.durationMs,Math.max(0,Math.round((single.currentTime||0)*1000))):0;
}
function draftKey(m){return "cf7-review:draft:"+conf.issue+":"+lane+":"+model.revision+":"+m.id;}
function noteDraft(m){
  try{return JSON.parse(sessionStorage.getItem(draftKey(m)) || "null");}catch{return null;}
}
function rememberNote(){
  if(!selected)return;
  try{
    if($("note").value)sessionStorage.setItem(draftKey(selected),JSON.stringify({text:$("note").value,ms:position()}));
    else sessionStorage.removeItem(draftKey(selected));
  }catch{}
}
function chooseMode(value){
  picking=value;$("chooseComment").textContent=value?"点一格选动作":"写评论";
  $("chooseComment").setAttribute("aria-pressed",String(value));$("surface").classList.toggle("picking",value);
  drawState();
}
function drawState(){
  if(!store || !model)return;
  let seen=0,issues=0;
  for(const m of model.moves){
    const button=buttons.get(m.id), code=store.mark(m), info=marks[code];
    if(info){button.dataset.mark=info[0];button.dataset.tone=info[1];}
    else{delete button.dataset.mark;delete button.dataset.tone;}
    const wording=labels[code] || ({pending:"待同步",conflict:"需重新确认",recheck:"新版待复看"}[code]||"待反馈");
    button.title=button.getAttribute("data-title")+" · "+wording;button.setAttribute("aria-label",button.title);
    if(code && !["pending","conflict","recheck"].includes(code))seen++;
    if(["mismatch","other","unclear","no"].includes(code))issues++;
  }
  const signed=store.auth==="allowed" && store.author?.startsWith("github:");
  const role=lane==="qa"?"联通测试":signed?store.display:store.auth==="allowed"?"可填写":"查看";
  $("githubUser").hidden=lane==="qa";
  $("githubUser").textContent=signed?"退出账号":"GitHub 登录";
  const network=store.online===false?" · 连接待恢复":"";
  $("summary").textContent=picking?"点要评论的动作":role+" · 已记 "+seen+" 项"+(issues?" · 待处理 "+issues:"")+network;
  if(dlg.open && selected)drawDetail();
}
function drawDetail(){
  const m=selected, mine=store.mine(m.id), draft=store.draft(m.id);
  const writable=store.auth==="allowed" && currentView();
  $("answers").hidden=!currentView();$("question").hidden=!currentView();
  $("note").readOnly=!currentView();
  $("sendNote").disabled=authBusy || !currentView() || Boolean(draft&&!draft.problem);
  $("sendNote").textContent=authBusy?"正在连接 GitHub…":writable?"发表评论":"用 GitHub 账号发表";
  $("commentHint").textContent=!currentView()?"历史版本":writable?(store.author?.startsWith("github:")?"使用 "+store.display+" 署名。":"可单独发表评论，文字随记录展示。"):"登录后会发表当前文字，并记住这一拍。";
  $("question").textContent=m.id==="C01"?"烟雾、装填和滑铲连起来是这样吗？":
    m.provisional?"左边这版是你希望教官用的动作吗？":m.sides===1?"这是你想指出的那一招吗？":"左边是原稿，右边是游戏。动作对得上吗？";
  $("answers").replaceChildren();
  for(const choice of [...m.choices,...(mine && mine.choice!=="clear"?["clear"]:[])]){
    const b=document.createElement("button");b.type="button";b.dataset.choice=choice;b.textContent=labels[choice];
    b.disabled=authBusy || Boolean(draft&&!draft.problem);b.setAttribute("aria-pressed",String(store.myDecision(m)?.choice===choice));
    b.onclick=async()=>{
      single.pause();
      const pos=Math.min(m.durationMs,Math.max(0,Math.round((single.currentTime||0)*1000)));
      if(choice==="unclear" && m.still){$("still").src=media(m.still);$("still").hidden=false;}else $("still").hidden=true;
      explicitStatus="";if(!writable){await loginFor(choice);return;}await sendSelection(m,choice,pos);
    };
    $("answers").append(b);
  }
  const result=$("result");result.replaceChildren();
  if(draft)result.textContent=draft.problem || (store.durableDrafts?"待同步，联网后会继续保存。":"待同步，请保持此页打开。");
  else if(explicitStatus)result.textContent=explicitStatus;
  else if(!currentView()){
    result.append("这是存档版本。");
    const a=document.createElement("a");a.href=new URL((lane==="qa"?"?qa=1":"")+"#"+m.id,root);a.textContent="打开最新校对页";result.append(a);
  }
  else if(mine?.asset===m.version)result.textContent=mine.choice==="clear"?"标记已撤回，历史可回看。":(mine.choice==="comment"?"评论已保存":"已记录 · "+labels[mine.choice])+" · "+clock(mine.positionMs);
  else if(!writable)result.textContent=store.auth==="denied"?"账号会话已到期，可以重新使用 GitHub 登录。":grant?(store.online===false?"正在连接回执服务。":"正在核对账号。"):"";
  else result.textContent=store.mark(m)==="recheck"?"本招已换稿，请复看。":"";
  const entries=store.forMove(m.id);$("historyBox").hidden=!entries.length;
  const historyList=$("history");historyList.replaceChildren();
  for(const e of entries){
    const li=document.createElement("li"), a=document.createElement("a");
    a.href=linkAt(e.revision,e.action,e.positionMs);
    a.textContent=e.revision.toUpperCase()+" · "+clock(e.positionMs);
    if(e.revision===model.revision)a.onclick=event=>{
      if(event.ctrlKey || event.metaKey || event.shiftKey)return;
      event.preventDefault();single.pause();single.currentTime=e.positionMs/1000;
      explicitStatus="正在回看 "+a.textContent;drawDetail();
      history.replaceState(null,"",a.href);
    };
    li.append(when(e.createdAt)+"　"+(e.authorLabel||e.author)+" · "+(labels[e.choice]||e.choice)+"　",a);
    if(e.note)li.append("　"+e.note);
    historyList.append(li);
  }
}
async function sendSelection(m,choice,ms,intent={}){
  const text=(intent.note??$("note").value).trim();
  const previous=intent.previous??(store.mine(m.id)?.seq || 0);
  await store.select(m,choice,ms,choice==="clear"?"":text,intent);
  const saved=store.mine(m.id);
  if(selected?.id===m.id && saved && saved.seq>previous && saved.choice===choice && !store.draft(m.id) && $("note").value.trim()===text){
    $("note").value="";rememberNote();
  }
}
async function submitNote(){
  if(!selected || !currentView())return;
  single.pause();
  if(!$("note").value.trim()){
    explicitStatus="先在上面的「写评论」里输入文字。";drawDetail();$("note").focus();return;
  }
  if(store.auth!=="allowed"){await loginFor("comment");return;}
  explicitStatus="";await sendSelection(selected,"comment",position());
}
function makeStore(value){
  const next=new Receipts({issue:model.issue,revision:model.revision,api:conf.api,lane,grant:value});
  next.activeRevision=latest.revision;return next;
}
async function loginFor(choice=null){
  if(authBusy || !selected || lane!=="art")return;
  single.pause();rememberNote();authBusy=true;explicitStatus="";drawDetail();
  try{
    await github.begin(conf.api,{issue:model.issue,revision:model.revision,entry:conf.round,move:selected.id,
      version:selected.version,ms:position(),note:$("note").value.trim(),choice});
  }catch(e){explicitStatus=e.message || "暂时无法打开 GitHub，草稿已保留。";authBusy=false;drawDetail();}
}
async function useAccount(token){
  store.removeEventListener("change",drawState);
  grant=token;store=makeStore(token);store.addEventListener("change",drawState);await store.start();drawState();
}
async function finishLogin(){
  if(finishingLogin || lane!=="art")return;
  if(cancelled){cancelled=false;github.forgetFlow();explicitStatus="已取消 GitHub 登录，草稿已保留。";drawState();return;}
  const tx=github.flow();
  if(!tx?.proof || tx.issue!==model.issue)return;
  const move=model.moves.find(m=>m.id===tx.move);
  if(!move)return;
  finishingLogin=true;authBusy=true;
  try{
    account=await github.exchange(conf.api,tx);
    await useAccount(account.token);
    if(store.auth!=="allowed")throw Error("正在连接回执服务，草稿已保留。");
    if(!dlg.open || selected?.id!==move.id)openMove(move,tx.ms);
    $("note").value=tx.note;explicitStatus="已使用 @"+account.login+" 登录。";
    if(tx.choice && currentView() && model.revision===tx.revision && move.version===tx.version){
      if(tx.previous===undefined){tx.previous=store.mine(move.id)?.seq || 0;github.saveFlow(tx);}
      explicitStatus="";await sendSelection(move,tx.choice,tx.ms,tx);
    }else if(tx.choice){explicitStatus="已登录，动作已换版。请看过新版后再次发表。";}
    github.forgetFlow();returned=false;
  }catch(e){
    if(e.status===401 || e.status===400)github.forgetFlow();
    explicitStatus=e.message || "暂时连不上 GitHub，草稿已保留。";
  }finally{authBusy=false;finishingLogin=false;drawState();}
}
function openMove(m,ms=null,focusComment=false){
  if(!dlg.open){resumeAfter=wantPlay&&!wall.paused;wall.pause();dlg.showModal();}
  const composed=noteDraft(m);
  selected=m;explicitStatus=ms===null?"":"正在回看 "+clock(ms);
  $("detailTitle").textContent=m.id+"　"+m.name;$("still").hidden=true;
  const singleSide=m.sides===1 && m.id!=="C01";
  $("playerBox").classList.toggle("single-sided",singleSide);$("absent").hidden=!singleSide;
  $("note").value=store.draft(m.id)?.body.note ?? composed?.text ?? "";
  single.src=media(m.video);single.playbackRate=speed;
  single.addEventListener("loadedmetadata",()=>{
    if(selected?.id!==m.id)return;
    if(ms!==null || composed || focusComment){single.currentTime=Math.min((ms??composed?.ms??0)/1000,single.duration);single.pause();}
    else if(!reduced)single.play().catch(()=>{});
  },{once:true});
  single.load();drawDetail();(focusComment?$("note"):$("back")).focus({preventScroll:true});
}
async function init(){
  latest=await get(new URL("latest.json",root),true);
  const revision=conf.round==="latest"?latest.revision:conf.round;
  if(!/^r[1-9]\d*$/.test(revision))throw Error("轮次无效");
  versionRoot=new URL(revision+"/",root);
  model=await get(new URL("manifest.json",versionRoot));
  if(model.issue!==Number(conf.issue) || model.revision!==revision)throw Error("校对页身份不一致");
  store=makeStore(grant);
  for(const m of model.moves){
    const b=document.createElement("button");b.type="button";b.dataset.id=m.id;
    b.dataset.title=m.id+" "+m.name+(m.provisional?"（左图待认）":m.sides===1&&m.id!=="C01"?"（原稿待配）":"");
    b.onclick=()=>{const focus=picking;chooseMode(false);history.replaceState(null,"",location.pathname+(lane==="qa"?"?qa=1":"")+"#"+m.id);openMove(m,null,focus);};
    buttons.set(m.id,b);$("targets").append(b);
  }
  $("roundLabel").textContent=revision.toUpperCase();store.addEventListener("change",drawState);
  new ResizeObserver(fit).observe($("surface"));fit();drawState();
  const deep=model.moves.find(m=>m.id===initialMove);
  if(deep){const hand=github.flow();const pos=initialTime!==null && /^\d{1,7}$/.test(initialTime)?Math.min(deep.durationMs,Number(initialTime)):(returned&&hand?.move===deep.id?hand.ms:null);openMove(deep,pos,Boolean(invite||returned));}
  if(returned || github.flow()?.proof)await finishLogin();
  if(!store.author)store.start().catch(()=>{store.online=false;drawState();});
  window.addEventListener("online",async()=>{await finishLogin();await store.synchronise();});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)store.synchronise();});
  setInterval(()=>{if(!document.hidden)store.synchronise();},12000);
}
wall.addEventListener("playing",()=>{wall.style.opacity="1";setPlay();});
wall.addEventListener("pause",setPlay);
$("play").onclick=()=>{if(wall.paused){if(!wall.getAttribute("src")){wantPlay=true;kind="";fit();}else playWall();}else{wantPlay=false;wall.pause();}};
$("slow").onclick=()=>{speed=speed===1?.5:1;wall.playbackRate=speed;$("slow").setAttribute("aria-pressed",String(speed===.5));};
$("chooseComment").onclick=()=>chooseMode(!picking);
$("sendNote").onclick=submitNote;
$("githubUser").onclick=async()=>{
  if(!model || lane!=="art")return;
  if(account && store.auth==="allowed" && store.author?.startsWith("github:")){
    try{await github.logout(conf.api,account.token);account=null;try{localStorage.removeItem(key);}catch{} await useAccount(null);}
    catch{$("summary").textContent="暂时未能退出，请重试。";}
    return;
  }
  if(!selected)openMove(model.moves[0],null,true);
  await loginFor();
};
$("note").addEventListener("focus",()=>{single.pause();$("noteTime").textContent="画面 "+clock(position());});
$("note").addEventListener("input",rememberNote);
$("note").addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();submitNote();}});
for(const event of ["pause","seeked","loadedmetadata"])single.addEventListener(event,()=>{$("noteTime").textContent="画面 "+clock(position());});
$("back").onclick=()=>dlg.close();
dlg.addEventListener("close",()=>{single.pause();single.removeAttribute("src");single.load();$("still").hidden=true;
  history.replaceState(null,"",conf.round==="latest"?root.href+(lane==="qa"?"?qa=1":""):versionRoot.href+(lane==="qa"?"?qa=1":""));
  if(selected)buttons.get(selected.id).focus({preventScroll:true});selected=null;explicitStatus="";if(resumeAfter)playWall();});
init().catch(e=>{$("summary").textContent="校对清单暂时未载入，请刷新。";console.error(e.message);});
