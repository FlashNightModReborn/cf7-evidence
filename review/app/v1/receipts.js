const transient = status => !status || status === 408 || status === 429 || status >= 500;

export class Receipts extends EventTarget {
  constructor({issue, revision, api, lane, grant}) {
    super();
    this.issue = issue;
    this.revision = revision;
    this.grant = grant;
    this.lane = lane;
    this.base = new URL("/api/v1/reviews/"+issue+"/",api);
    this.key = "cf7-review:"+issue+":"+lane+":pending:";
    this.auth = grant ? "checking" : "guest";
    this.author = null;
    this.events = new Map();
    this.pending = new Map();
    this.cursor = 0;
    this.online = null;
    this.activeRevision = revision;
    this.reading = false;
    this.sending = false;
    this.durableDrafts = true;
  }

  inform() { this.dispatchEvent(new Event("change")); }
  async call(endpoint, {method="GET", body, token=false, after}={}) {
    const url = new URL(endpoint,this.base);
    if (this.lane==="qa") url.searchParams.set("lane","qa");
    if (after!==undefined) url.searchParams.set("after",after);
    const headers={};
    if (token) headers.Authorization="Bearer "+this.grant;
    if (body) headers["Content-Type"]="application/json";
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    try {
      const res=await fetch(url,{method, headers, body:body?JSON.stringify(body):undefined,
        credentials:"omit", cache:"no-store", referrerPolicy:"no-referrer", signal:controller.signal});
      const data=await res.json();
      if(!res.ok){
        const err=new Error(data.error || "暂时无法连接反馈服务");
        err.status=res.status;err.latest=data.latest;throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async checkGrant(){
    if(!this.grant || this.auth==="allowed" || this.auth==="denied")return;
    try{
      const s=await this.call("session",{token:true});
      this.author=s.author;this.activeRevision=s.revision;this.auth="allowed";
    }catch(e){this.auth=e.status===403?"denied":"checking";}
    this.inform();
  }
  async start(){
    // Store drafts separately so two tabs never overwrite unrelated clicks.
    // A new invitation cannot submit a draft created by a different grant.
    if(this.grant){
      const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(this.grant));
      this.key+=Array.from(new Uint8Array(hash).slice(0,12),v=>v.toString(16).padStart(2,"0")).join("")+":";
      this.loadDrafts();
    }
    await Promise.all([this.checkGrant(),this.refresh()]);
    await this.flush();
  }
  loadDrafts(){
    try{
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key?.startsWith(this.key)){
          const item=JSON.parse(localStorage.getItem(key));
          if(item?.body?.revision===this.revision)this.pending.set(item.body.requestId,item);
        }
      }
    }catch{this.durableDrafts=false;}
  }
  save(item){
    this.pending.set(item.body.requestId,item);
    try{localStorage.setItem(this.key+item.body.requestId,JSON.stringify(item));}
    catch{this.durableDrafts=false;}
    this.inform();
  }
  remove(item){
    this.pending.delete(item.body.requestId);
    try{localStorage.removeItem(this.key+item.body.requestId);}catch{}
  }
  forMove(id){
    return [...this.events.values()].filter(e=>e.action===id).sort((a,b)=>b.seq-a.seq);
  }
  mine(id){return this.forMove(id).find(e=>e.author===this.author);}
  draft(id){return [...this.pending.values()].find(p=>p.body.action===id);}
  mark(move){
    const draft=this.draft(move.id);
    if(draft)return draft.problem?"conflict":"pending";
    const newest=new Map();
    for(const event of this.forMove(move.id))if(!newest.has(event.author))newest.set(event.author,event);
    const live=[...newest.values()].filter(e=>e.choice!=="clear");
    const applicable=live.filter(e=>e.asset===move.version);
    for(const code of ["mismatch","other","unclear","yes","no","use","match"]){
      if(applicable.some(e=>e.choice===code))return code;
    }
    return live.length?"recheck":"";
  }
  async refresh(){
    if(this.reading)return;
    this.reading=true;
    try{
      let more;
      do{
        const data=await this.call("events",{after:this.cursor});
        for(const e of data.events){this.events.set(e.seq,e);this.cursor=Math.max(this.cursor,e.seq);}
        this.activeRevision=data.revision;more=data.more;
      }while(more);
      this.online=true;
    }catch{this.online=false;}
    finally{this.reading=false;this.inform();}
  }
  async synchronise(){
    await Promise.all([this.refresh(),this.checkGrant()]);
    await this.flush();
  }
  async select(move,choice,positionMs,note){
    if(this.auth!=="allowed" || this.revision!==this.activeRevision)return;
    const old=this.draft(move.id);
    if(old && !old.problem)return;
    if(old)this.remove(old);
    this.save({body:{requestId:crypto.randomUUID(),revision:this.revision,action:move.id,
      asset:move.version,choice,note:note.trim(),positionMs,previous:this.mine(move.id)?.seq || 0},problem:""});
    await this.flush();
  }
  async flush(){
    if(this.sending || this.auth!=="allowed")return;
    this.sending=true;
    try{
      for(const item of [...this.pending.values()]){
        if(item.problem)continue;
        try{
          const data=await this.call("events",{method:"POST",body:item.body,token:true});
          this.events.set(data.event.seq,data.event);this.remove(item);this.online=true;
        }catch(e){
          if(transient(e.status)){this.online=false;break;}
          if(e.latest)this.events.set(e.latest.seq,e.latest);
          item.problem=e.message;this.save(item);
          if(e.status===403)this.auth="denied";
        }
      }
    }finally{this.sending=false;this.inform();}
  }
}
