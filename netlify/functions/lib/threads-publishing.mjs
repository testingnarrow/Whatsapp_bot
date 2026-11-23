import { LATEST_KEY, patchSettings } from "./remote-state.mjs";

export const THREADS_AUTH_KEY = "threads-auth";

function httpError(message, status = 502, uncertain = false) {
  const error = new Error(message); error.status = status; error.uncertain = uncertain; return error;
}
export function threadsConfiguration(env = process.env) {
  return { appConfigured: Boolean(String(env.THREADS_APP_ID||"").trim() && String(env.THREADS_APP_SECRET||"").trim() && String(env.THREADS_REDIRECT_URI||"").trim()) };
}
function siteBase(env = process.env) {
  const value = env.DEPLOY_PRIME_URL || env.DEPLOY_URL || env.URL || "";
  return value ? String(value).replace(/\/+$/, "") : "";
}
async function apiJson(response, label, token) {
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok || data.error) {
    const message = String(data.error?.message || data.error_description || label+" returned HTTP "+response.status)
      .replaceAll(token || "\u0000", "[redacted]").slice(0,300);
    throw httpError(label+" failed: "+message, response.status===401||response.status===403?403:502);
  }
  return data;
}
export async function refreshThreadsToken(store, {env=process.env,fetchImpl=globalThis.fetch,force=false}={}) {
  const auth = await store.get(THREADS_AUTH_KEY,{type:"json",consistency:"strong"});
  if (!auth?.accessToken || !auth?.expiresAt) throw httpError("Connect your Threads account first.",503);
  const now=Date.now(), expiry=Date.parse(auth.expiresAt), issued=Date.parse(auth.issuedAt||"");
  if (!Number.isFinite(expiry) || expiry<=now) throw httpError("The Threads access token has expired. Reconnect your Threads account.",401);
  const age=Number.isFinite(issued)?now-issued:0, remaining=expiry-now;
  if (!force && remaining>10*86400000) return auth;
  if (age<86400000) return auth;
  let response;
  try {
    const url=new URL("https://graph.threads.net/refresh_access_token");
    url.searchParams.set("grant_type","th_refresh_token"); url.searchParams.set("access_token",auth.accessToken);
    response=await fetchImpl(url,{method:"GET",headers:{Accept:"application/json"},signal:AbortSignal.timeout(20000)});
  } catch { throw httpError("Could not reach Threads token refresh. The saved token remains available; the hourly scheduler will retry.",503); }
  const data=await apiJson(response,"Threads token refresh",auth.accessToken);
  const token=String(data.access_token||"").trim();
  if(!token) throw httpError("Threads did not return a refreshed access token. Reconnect Threads if this persists.",502);
  const expiresIn=Math.max(86400,Number(data.expires_in)||5184000),updated={...auth,accessToken:token,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+expiresIn*1000).toISOString(),lastRefreshedAt:new Date(now).toISOString()};
  await store.setJSON(THREADS_AUTH_KEY,updated);
  await patchSettings({threadsLastMessage:"Threads access token refreshed automatically; next expiry "+updated.expiresAt+".",threadsTokenExpiresAt:updated.expiresAt},store);
  return updated;
}
export function fitThreadsCaption(value) {
  let text=String(value||"").trim();
  if(text.length<=500)return text;
  const tags=[...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map(x=>x[0]);
  const body=text.replace(/\s*#[\p{L}\p{N}_]+/gu,"").trim();
  const suffix=[...new Set(tags)].join(" ");
  const room=500-(suffix? suffix.length+2:0);
  let clipped=body.slice(0,Math.max(0,room));
  const boundary=clipped.lastIndexOf(" ");
  if(boundary>Math.floor(room*.65))clipped=clipped.slice(0,boundary);
  return (clipped.trim()+(suffix?"\n\n"+suffix:"")).slice(0,500).trim();
}
export async function publishThreadsImage({imageUrl,caption,accessToken,userId,fetchImpl=globalThis.fetch}) {
  const message=fitThreadsCaption(caption);
  if(!message)throw httpError("The saved post has no caption to publish.",400);
  if(!imageUrl||!/^https:\/\//i.test(imageUrl))throw httpError("A public HTTPS image URL is required for Threads.",400);
  const params=new URLSearchParams({media_type:"IMAGE",image_url:imageUrl,text:message});
  let response,data;
  try {
    response=await fetchImpl("https://graph.threads.net/v1.0/"+encodeURIComponent(userId)+"/threads",{method:"POST",headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/x-www-form-urlencoded"},body:params,signal:AbortSignal.timeout(55000)});
    data=await apiJson(response,"Threads image container creation",accessToken);
  } catch(error) { if(error.uncertain)throw error; if(error.status)throw error; throw httpError("No response while creating the Threads post. Check Threads before retrying.",504,true); }
  const creationId=String(data.id||"").trim();
  if(!creationId)throw httpError("Threads did not return a media container ID. Check Threads before retrying.",502,true);
  const publishParams=new URLSearchParams({creation_id:creationId});
  try {
    response=await fetchImpl("https://graph.threads.net/v1.0/"+encodeURIComponent(userId)+"/threads_publish",{method:"POST",headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/x-www-form-urlencoded"},body:publishParams,signal:AbortSignal.timeout(55000)});
    data=await apiJson(response,"Threads publish",accessToken);
  } catch(error) { if(error.status)throw error; throw httpError("Threads did not confirm publication. Check your profile before retrying to avoid a duplicate.",504,true); }
  const postId=String(data.id||"").trim();
  if(!postId)throw httpError("Threads accepted the publish request but returned no post ID. Check your profile before retrying.",502,true);
  return {postId,creationId,caption:message};
}
export async function publishLatestThreadsPost(store,expectedGeneratedAt,source="manual",options={}) {
  const expected=String(expectedGeneratedAt||"").trim();
  if(!expected)throw httpError("The current saved preview version is missing. Reload and try again.",400);
  const latest=await store.get(LATEST_KEY,{type:"json",consistency:"strong"});
  if(!latest)throw httpError("There is no saved post to publish yet.",404);
  const generatedAt=String(latest.generatedAt||latest.at||"");
  if(generatedAt!==expected)throw httpError("A newer preview replaced this one. Reload the latest preview before publishing.",409);
  const previous=latest.threadsPublish&&typeof latest.threadsPublish==="object"?latest.threadsPublish:{};
  if(previous.status==="published")return {status:"published",alreadyPublished:true,postId:previous.postId||"",publishedAt:previous.publishedAt||""};
  if(previous.status==="publishing")throw httpError("This preview is already being sent to Threads. Wait for the result.",409);
  if(previous.status==="uncertain")throw httpError("Threads did not confirm the previous attempt. Check your profile before retrying.",409,true);
  const auth=await refreshThreadsToken(store,options);
  const root=siteBase(options.env||process.env);
  if(!root)throw httpError("Netlify public site URL is missing.",503);
  const imageKey=String(latest.imageKey||"");if(!imageKey)throw httpError("The saved post has no image key.",404);
  const image=await store.get(imageKey,{type:"arrayBuffer",consistency:"strong"});if(!image)throw httpError("The saved PNG could not be found.",404);
  const bytes=Buffer.from(image),signature=[137,80,78,71,13,10,26,10];
  if(bytes.length<100||bytes.length>9*1024*1024||!signature.every((v,i)=>bytes[i]===v))throw httpError("The saved image is not a supported PNG.",415);
  const caption=String(latest.draft?.caption||"").trim();if(!caption)throw httpError("The saved post has no caption.",400);
  const startedAt=new Date().toISOString(),publishing={status:"publishing",source:source==="auto"?"auto":"manual",startedAt};
  await store.setJSON(LATEST_KEY,{...latest,threadsPublish:publishing});
  await patchSettings({threadsLastStatus:"publishing",threadsLastMessage:"Uploading the saved image and caption to Threads."},store);
  try {
    const imageUrl=root+"/api/automation-image?version="+encodeURIComponent(generatedAt);
    const posted=await publishThreadsImage({imageUrl,caption,accessToken:auth.accessToken,userId:auth.userId,fetchImpl:options.fetchImpl||globalThis.fetch});
    const publishedAt=new Date().toISOString(),threadsPublish={status:"published",source:source==="auto"?"auto":"manual",postId:posted.postId,creationId:posted.creationId,publishedAt};
    const current=await store.get(LATEST_KEY,{type:"json",consistency:"strong"});
    if(current&&String(current.generatedAt||current.at||"")===generatedAt)await store.setJSON(LATEST_KEY,{...current,threadsPublish});
    await patchSettings({threadsLastStatus:"published",threadsLastMessage:"Threads published successfully.",threadsLastPostId:posted.postId,threadsLastPostAt:publishedAt},store);
    return {status:"published",alreadyPublished:false,postId:posted.postId,publishedAt,threadsPublish};
  } catch(error) {
    const failedAt=new Date().toISOString(),status=error?.uncertain?"uncertain":"failed",message=String(error?.message||error||"Threads publish failed").slice(0,300);
    const threadsPublish={status,source:source==="auto"?"auto":"manual",startedAt,failedAt,message};
    const current=await store.get(LATEST_KEY,{type:"json",consistency:"strong"}).catch(()=>null);
    if(current&&String(current.generatedAt||current.at||"")===generatedAt)await store.setJSON(LATEST_KEY,{...current,threadsPublish});
    await patchSettings({threadsLastStatus:status,threadsLastMessage:message,threadsLastPostId:"",threadsLastPostAt:null},store);
    throw error;
  }
}
