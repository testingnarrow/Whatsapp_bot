import {getRemoteStore,patchSettings} from "./lib/remote-state.mjs";
import {THREADS_AUTH_KEY} from "./lib/threads-publishing.mjs";
const HEAD={"Cache-Control":"no-store","Content-Type":"text/html; charset=utf-8"};
function html(message){const safe=String(message).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));return new Response("<!doctype html><html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>REMOTE Threads</title><body style='font:16px system-ui;background:#101114;color:#eee;padding:40px'><h2>REMOTE · Threads</h2><p>"+safe+"</p><p>You can close this window and return to REMOTE.</p></body></html>",{status:200,headers:HEAD});}
function fail(message,status=400){return new Response(String(message),{status,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});}
async function hmac(value,secret){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value)));return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
function equal(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
async function validSiteSession(request,secret){const item=String(request.headers.get("cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("remote_site_session="));if(!item)return false;const value=item.slice("remote_site_session=".length),dot=value.indexOf(".");if(dot<1)return false;const expiry=value.slice(0,dot),sig=value.slice(dot+1);if(!/^\d{10}$/.test(expiry)||Number(expiry)<=Math.floor(Date.now()/1000)||!/^[a-f0-9]{64}$/i.test(sig))return false;return equal(await hmac("remote-site-session:v1:"+expiry,secret),sig);}
async function validState(state,secret){const p=String(state||"").split(".");if(p.length!==3)return false;const [expiry,nonce,sig]=p;if(!/^\d{10}$/.test(expiry)||Number(expiry)<=Math.floor(Date.now()/1000)||!/^[a-f0-9]{32}$/i.test(nonce))return false;return equal(await hmac("threads-oauth:v1:"+expiry+"."+nonce,secret),sig);}
export default async function handler(request){
 if(request.method!=="GET")return fail("Method not allowed.",405);
 const url=new URL(request.url),action=url.searchParams.get("action")||"connect",env=process.env,appId=String(env.THREADS_APP_ID||"").trim(),secret=String(env.THREADS_APP_SECRET||"").trim(),redirect=String(env.THREADS_REDIRECT_URI||"").trim();
 if(!appId||!secret||!redirect)return html("Threads setup is incomplete. Set THREADS_APP_ID, THREADS_APP_SECRET and THREADS_REDIRECT_URI in Netlify environment variables.");
 const store=getRemoteStore();
 if(action==="connect"){
  const sessionSecret=String(env.REMOTE_CONTROL_TOKEN||"");
  if(!sessionSecret||!(await validSiteSession(request,sessionSecret)))return fail("Sign in to REMOTE before connecting a Threads account.",401);
  const expiry=String(Math.floor(Date.now()/1000)+600),nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join(""),payload=expiry+"."+nonce,state=payload+"."+await hmac("threads-oauth:v1:"+payload,secret);
  const authUrl=new URL("https://threads.net/oauth/authorize");authUrl.searchParams.set("client_id",appId);authUrl.searchParams.set("redirect_uri",redirect);authUrl.searchParams.set("scope","threads_basic,threads_content_publish");authUrl.searchParams.set("response_type","code");authUrl.searchParams.set("state",state);
  return Response.redirect(authUrl.toString(),302);
 }
 if(action!=="callback")return fail("Unknown Threads OAuth action.",400);
 const providerError=url.searchParams.get("error_description")||url.searchParams.get("error");if(providerError)return html("Threads authorization was not completed: "+providerError);
 const code=String(url.searchParams.get("code")||"").trim(),state=String(url.searchParams.get("state")||"");
 if(!code||!(await validState(state,secret)))return html("The Threads authorization code or security state is invalid or expired. Start Connect Threads again.");
 try{
  const body=new URLSearchParams({client_id:appId,client_secret:secret,grant_type:"authorization_code",redirect_uri:redirect,code});
  const shortResponse=await fetch("https://graph.threads.net/oauth/access_token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body,signal:AbortSignal.timeout(20000)}),short=await shortResponse.json().catch(()=>({}));
  if(!shortResponse.ok||!short.access_token)throw new Error(short.error_message||short.error?.message||"Threads authorization-code exchange failed (HTTP "+shortResponse.status+").");
  const longUrl=new URL("https://graph.threads.net/access_token");longUrl.searchParams.set("grant_type","th_exchange_token");longUrl.searchParams.set("client_secret",secret);longUrl.searchParams.set("access_token",short.access_token);
  const longResponse=await fetch(longUrl,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(20000)}),long=await longResponse.json().catch(()=>({}));
  if(!longResponse.ok||!long.access_token)throw new Error(long.error_message||long.error?.message||"Could not exchange for a long-lived Threads token (HTTP "+longResponse.status+").");
  const now=Date.now(),expiresIn=Math.max(86400,Number(long.expires_in)||5184000),userId=String(short.user_id||long.user_id||"").trim();
  if(!userId)throw new Error("Threads did not return the account user ID.");
  const expiresAt=new Date(now+expiresIn*1000).toISOString();
  await store.setJSON(THREADS_AUTH_KEY,{accessToken:String(long.access_token),userId,issuedAt:new Date(now).toISOString(),expiresAt,connectedAt:new Date(now).toISOString(),lastRefreshedAt:null});
  await patchSettings({threadsConnected:true,threadsLastStatus:"connected",threadsLastMessage:"Threads account connected. Token refresh is managed automatically.",threadsTokenExpiresAt:expiresAt},store);
  return html("Threads account connected successfully. Automatic token refresh is enabled. Return to REMOTE and refresh the status.");
 }catch(error){await patchSettings({threadsConnected:false,threadsLastStatus:"failed",threadsLastMessage:String(error.message||error).slice(0,300)},store).catch(()=>{});return html("Could not connect Threads: "+String(error.message||error));}
}
