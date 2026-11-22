const SITE_TOKEN="cf7-art-review:github-account-v1";
const FLOW="cf7-art-review:github-return-v1";
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const tokenFormat=/^cfr1\.[A-Za-z0-9_-]{43}$/;

export function cachedAccount(){
  try{const v=JSON.parse(localStorage.getItem(SITE_TOKEN)||"null");return tokenFormat.test(v?.token||"")?v:null;}catch{return null;}
}
export function flow(){
  try{const value=JSON.parse(sessionStorage.getItem(FLOW)||"null");return value && Date.now()-value.at<3600000?value:null;}catch{return null;}
}
export function saveFlow(value){sessionStorage.setItem(FLOW,JSON.stringify(value));}
export function forgetFlow(){try{sessionStorage.removeItem(FLOW);}catch{}}
export function forgetAccount(){try{localStorage.removeItem(SITE_TOKEN);}catch{}}
async function request(api,op,options={}){
  const control=new AbortController(),deadline=setTimeout(()=>control.abort(),12000);
  try{
    const response=await fetch(new URL("/github-auth/"+op,api),{credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",signal:control.signal,...options});
    const data=await response.json();
    if(!response.ok){const error=Error(data.error||"GitHub 登录暂时不可用。");error.status=response.status;throw error;}
    return data;
  }finally{clearTimeout(deadline);}
}
export async function begin(api,intent){
  const status=await request(api,"status");
  if(!status.configured)throw Error("项目管理员需先在 GitHub 确认登录应用。你的草稿已保留。");
  const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
  const bytes=await crypto.subtle.digest("SHA-256",enc.encode(verifier));
  const state={...intent,verifier,at:Date.now(),id:crypto.randomUUID()};
  try{saveFlow(state);}catch{throw Error("此浏览器没有允许暂存登录草稿，请用普通浏览器标签页打开。");}
  const url=new URL("/github-auth/start",api);
  url.search=new URLSearchParams({issue:String(intent.issue),rev:intent.entry,move:intent.move,challenge:b64(new Uint8Array(bytes))}).toString();
  location.assign(url.href);
}
export async function exchange(api,state){
  const response=await request(api,"exchange",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({proof:state.proof,verifier:state.verifier,issue:state.issue})});
  if(!tokenFormat.test(response.token))throw Error("账号会话无效，请重新登录。");
  const user={token:response.token,login:response.login,accountId:response.accountId};
  try{localStorage.setItem(SITE_TOKEN,JSON.stringify(user));}catch{}
  return user;
}
export async function logout(api,token){
  await request(api,"logout",{method:"POST",headers:{Authorization:"Bearer "+token}});
  forgetAccount();forgetFlow();
}
