import {Receipts} from "./receipts.js";

const $=id=>document.getElementById(id);
const conf=document.body.dataset;
const root=new URL(conf.root,location.href);
const lane=new URLSearchParams(location.search).get("qa")==="1"?"qa":"art";
const labels={match:"对得上",mismatch:"对不上",unclear:"看不清",use:"用左边这版",other:"指的是别的稿",yes:"是这招",no:"不是这招",clear:"撤回标记"};
const marks={match:["✓","ok"],use:["✓","ok"],yes:["✓","ok"],mismatch:["!","bad"],other:["!","bad"],no:["!","bad"],unclear:["?",""],pending:["待",""],conflict:["!","bad"],recheck:["复看",""]};
let fragment=location.hash.slice(1);
let initialMove=/^[A-Z]\d{2}$/.test(fragment)?fragment:null;
const hashValues=new URLSearchParams(fragment);
const invite=hashValues.get("invite");
const key="cf7-art-review:"+conf.issue+":"+lane+":grant";
let grant=null;
try{grant=localStorage.getItem(key);}catch{}
if(invite){
  if(/^[A-Za-z0-9_-]{43}$/.test(invite)){grant=invite;try{localStorage.setItem(key,invite);}catch{}}
  initialMove=hashValues.get("move");
  history.replaceState(null,"",location.pathname+location.search+(/^[A-Z]\d{2}$/.test(initialMove || "")?"#"+initialMove:""));
}
const initialTime=new URLSearchParams(location.search).get("t");
const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
const wall=$("wall"), dlg=$("detail"), single=$("single");
let model, latest, store, versionRoot, selected, kind="", wantPlay=!reduced, speed=1, resumeAfter=false;
let explicitStatus="", noteMove="";
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
  const role=lane==="qa"?"联通测试":store.auth==="allowed"?"可填写":grant?"校对链接":"查看";
  const network=store.online===false?" · 连接待恢复":"";
  $("summary").textContent=role+" · 已记 "+seen+" 项"+(issues?" · 待处理 "+issues:"")+network;
  if(dlg.open && selected)drawDetail();
}
function drawDetail(){
  const m=selected, mine=store.mine(m.id), draft=store.draft(m.id);
  const writable=store.auth==="allowed" && currentView();
  $("noteBox").hidden=!writable;$("answers").hidden=!writable;
  $("question").textContent=m.id==="C01"?"烟雾、装填和滑铲连起来是这样吗？":
    m.provisional?"左边这版是你希望教官用的动作吗？":m.sides===1?"这是你想指出的那一招吗？":"左边是原稿，右边是游戏。动作对得上吗？";
  $("answers").replaceChildren();
  for(const choice of [...m.choices,...(mine && mine.choice!=="clear"?["clear"]:[])]){
    const b=document.createElement("button");b.type="button";b.dataset.choice=choice;b.textContent=labels[choice];
    b.disabled=Boolean(draft&&!draft.problem);b.setAttribute("aria-pressed",String(mine?.asset===m.version && mine.choice===choice));
    b.onclick=async()=>{
      single.pause();
      const pos=Math.min(m.durationMs,Math.max(0,Math.round((single.currentTime||0)*1000)));
      if(choice==="unclear" && m.still){$("still").src=media(m.still);$("still").hidden=false;}else $("still").hidden=true;
      explicitStatus="";await store.select(m,choice,pos,$("note").value);
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
  else if(mine?.asset===m.version)result.textContent=mine.choice==="clear"?"标记已撤回，历史可回看。":"已记录 · "+labels[mine.choice]+" · "+clock(mine.positionMs);
  else if(!writable)result.textContent=store.auth==="denied"?"此链接的填写权限已失效。":
    grant?(store.online===false?"正在连接回执服务。":"正在核对填写权限。"):"当前可查看记录。使用本轮专属链接可填写。";
  else result.textContent=store.mark(m)==="recheck"?"本招已换稿，请复看。":"点选即保存，可改选。";
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
    li.append(when(e.createdAt)+"　"+e.author+" · "+(labels[e.choice]||e.choice)+"　",a);
    if(e.note)li.append("　"+e.note);
    historyList.append(li);
  }
}
function openMove(m,ms=null){
  if(!dlg.open){resumeAfter=wantPlay&&!wall.paused;wall.pause();dlg.showModal();}
  selected=m;explicitStatus=ms===null?"":"正在回看 "+clock(ms);
  $("detailTitle").textContent=m.id+"　"+m.name;$("still").hidden=true;
  const singleSide=m.sides===1 && m.id!=="C01";
  $("playerBox").classList.toggle("single-sided",singleSide);$("absent").hidden=!singleSide;
  if(noteMove!==m.id){$("note").value=store.draft(m.id)?.body.note ?? store.mine(m.id)?.note ?? "";noteMove=m.id;}
  single.src=media(m.video);single.playbackRate=speed;
  single.addEventListener("loadedmetadata",()=>{
    if(selected?.id!==m.id)return;
    if(ms!==null){single.currentTime=Math.min(ms/1000,single.duration);single.pause();}
    else if(!reduced)single.play().catch(()=>{});
  },{once:true});
  single.load();drawDetail();$("back").focus({preventScroll:true});
}
async function init(){
  latest=await get(new URL("latest.json",root),true);
  const revision=conf.round==="latest"?latest.revision:conf.round;
  if(!/^r[1-9]\d*$/.test(revision))throw Error("轮次无效");
  versionRoot=new URL(revision+"/",root);
  model=await get(new URL("manifest.json",versionRoot));
  if(model.issue!==Number(conf.issue) || model.revision!==revision)throw Error("校对页身份不一致");
  store=new Receipts({issue:model.issue,revision,api:conf.api,lane,grant});store.activeRevision=latest.revision;
  for(const m of model.moves){
    const b=document.createElement("button");b.type="button";b.dataset.id=m.id;
    b.dataset.title=m.id+" "+m.name+(m.provisional?"（左图待认）":m.sides===1&&m.id!=="C01"?"（原稿待配）":"");
    b.onclick=()=>{history.replaceState(null,"",location.pathname+(lane==="qa"?"?qa=1":"")+"#"+m.id);openMove(m);};
    buttons.set(m.id,b);$("targets").append(b);
  }
  $("roundLabel").textContent=revision.toUpperCase();store.addEventListener("change",drawState);
  new ResizeObserver(fit).observe($("surface"));fit();drawState();
  const deep=model.moves.find(m=>m.id===initialMove);
  if(deep){const pos=initialTime!==null && /^\d{1,7}$/.test(initialTime)?Math.min(deep.durationMs,Number(initialTime)):null;openMove(deep,pos);}
  store.start().catch(()=>{store.online=false;drawState();});
  window.addEventListener("online",()=>store.synchronise());
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)store.synchronise();});
  setInterval(()=>{if(!document.hidden)store.synchronise();},12000);
}
wall.addEventListener("playing",()=>{wall.style.opacity="1";setPlay();});
wall.addEventListener("pause",setPlay);
$("play").onclick=()=>{if(wall.paused){if(!wall.getAttribute("src")){wantPlay=true;kind="";fit();}else playWall();}else{wantPlay=false;wall.pause();}};
$("slow").onclick=()=>{speed=speed===1?.5:1;wall.playbackRate=speed;$("slow").setAttribute("aria-pressed",String(speed===.5));};
$("back").onclick=()=>dlg.close();
dlg.addEventListener("close",()=>{single.pause();single.removeAttribute("src");single.load();$("still").hidden=true;
  history.replaceState(null,"",conf.round==="latest"?root.href+(lane==="qa"?"?qa=1":""):versionRoot.href+(lane==="qa"?"?qa=1":""));
  if(selected)buttons.get(selected.id).focus({preventScroll:true});selected=null;explicitStatus="";if(resumeAfter)playWall();});
init().catch(e=>{$("summary").textContent="校对清单暂时未载入，请刷新。";console.error(e.message);});
