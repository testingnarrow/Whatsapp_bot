import {
  getRemoteStore, readSettings, patchSettings, readHistory, writeHistory, rememberStory,
  LATEST_KEY, previewImageKey
} from "./lib/remote-state.mjs";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function validToken(request) {
  const expected = String(process.env.REMOTE_CONTROL_TOKEN || "");
  const provided = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !provided || expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return mismatch === 0;
}

async function sessionSignature(expiry,secret){
 const key=await globalThis.crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=new Uint8Array(await globalThis.crypto.subtle.sign("HMAC",key,new TextEncoder().encode("remote-site-session:v1:"+expiry)));
 return Array.from(sig,b=>b.toString(16).padStart(2,"0")).join("");
}
function constantTimeEqual(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0}
async function validSiteSession(request){
 const secret=String(process.env.REMOTE_CONTROL_TOKEN||"");if(!secret)return false;
 const cookie=String(request.headers.get("cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("remote_site_session="));if(!cookie)return false;
 const token=cookie.slice("remote_site_session=".length),dot=token.indexOf(".");if(dot<1)return false;
 const expiry=token.slice(0,dot),signature=token.slice(dot+1),exp=Number(expiry);
 if(!Number.isSafeInteger(exp)||exp<=Math.floor(Date.now()/1000)||!/^[a-f0-9]{64}$/i.test(signature))return false;
 try{return constantTimeEqual(await sessionSignature(expiry,secret),signature)}catch{return false}
}
function siteBase() {
  const value = process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || "";
  return value ? value.replace(/\/+$/, "") : "";
}

async function launchBackgroundRunner() {
  const base = siteBase();
  const token = String(process.env.REMOTE_CONTROL_TOKEN || "");
  if (!base) throw new Error("Netlify URL environment variable is missing.");
  if (!token) throw new Error("Set REMOTE_CONTROL_TOKEN in Netlify environment variables.");
  const response = await fetch(base + "/.netlify/functions/automation-run-background", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ source: "control-panel" }),
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok && response.status !== 202 && response.status !== 204) {
    throw new Error("Background worker request failed with HTTP " + response.status + ".");
  }
  return response.status;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  let store;
  try {
    store = getRemoteStore();
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "status";

    if (request.method === "GET") {
      const settings = await readSettings(store);
      if (action === "latest") {
        const latest = await store.get("latest", { type: "json", consistency: "strong" });
        return json(200, { latest: latest || null, status: publicStatus(settings) });
      }
      if (action === "history") {
        const history = await readHistory(store);
        return json(200, { count: history.length, recent: history.slice(-30).reverse() });
      }
      return json(200, { status: publicStatus(settings) });
    }

    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!validToken(request) && !(await validSiteSession(request))) return json(401,{error:"Sign in to the site or provide the remote control token."});

    let body = {};
    try { body = await request.json(); } catch {}
    const actionName = String(body.action || "");
    if (actionName === "mark-used") {
      const history = await readHistory(store);
      const updated = rememberStory(history, body.story || {});
      await writeHistory(updated, store);
      return json(200, { ok: true, historyCount: updated.length, alreadyUsed: updated === history });
    }

    if (actionName === "save-preview") {
      const p=body.preview&&typeof body.preview==="object"?body.preview:{}, raw=String(p.png||""), prefix="data:image/png;base64,";
      if(!raw.startsWith(prefix))return json(400,{error:"PNG preview data is required."});
      const b64=raw.slice(prefix.length).replaceAll(" ","");if(!b64||b64.length>8400000)return json(413,{error:"Preview image is too large."});
      const bytes=Buffer.from(b64,"base64");if(bytes.length<100||bytes.length>6*1024*1024)return json(413,{error:"Preview image size is unsupported."});
      const s=p.story&&typeof p.story==="object"?p.story:{}, story={id:String(s.id||"").slice(0,160),title:String(s.title||"").trim().slice(0,240),url:String(s.url||"").slice(0,2048),source:String(s.source||"").slice(0,160),publishedAt:String(s.publishedAt||"").slice(0,80),description:String(s.description||"").slice(0,2000)};
      if(!story.title||!/^https?:\/\//i.test(story.url))return json(400,{error:"A story title and valid URL are required."});
      const draft=p.draft&&typeof p.draft==="object"?p.draft:{};if(JSON.stringify(draft).length>30000)return json(413,{error:"Preview metadata is too large."});
      const photo=v=>!v||typeof v!=="object"?null:{title:String(v.title||"").slice(0,240),url:String(v.url||"").slice(0,2048),thumbnail:String(v.thumbnail||"").slice(0,2048),creator:String(v.creator||v.author||"").slice(0,240),license:String(v.license||"").slice(0,240),source:String(v.source||v.provider||"").slice(0,160)};
      const generatedAt=new Date().toISOString(),post={generatedAt,at:generatedAt,imageKey:previewImageKey(generatedAt),draft,story,chosen:{selected:story,supporting:[],reason:String(p.chosen&&p.chosen.reason||"").slice(0,500),confidence:String(p.chosen&&p.chosen.confidence||draft.confidence||"medium").slice(0,20)},articles:Array.isArray(p.articles)?p.articles.slice(0,4).map(x=>({title:String(x&&(x.articleTitle||x.title)||"").slice(0,240),url:String(x&&(x.finalUrl||x.url)||"").slice(0,2048),source:String(x&&x.source||"").slice(0,160),articleText:String(x&&x.articleText||"").slice(0,2000)})):[],photo:photo(p.photo),photos:Array.isArray(p.photos)?p.photos.slice(0,18).map(photo).filter(Boolean):[],imageWasFound:Boolean(p.photo)};
      await store.set(post.imageKey,new Blob([bytes],{type:"image/png"}));const history=await readHistory(store);await writeHistory(rememberStory(history,story),store);await store.setJSON(LATEST_KEY,post);
      return json(200,{ok:true,generatedAt,imageKey:post.imageKey});
    }

    const settings = await readSettings(store);
    if (actionName === "start") {
      if (!process.env.GEMINI_API_KEY) {
        return json(503, { error: "Set GEMINI_API_KEY in Netlify environment variables before enabling unattended Auto." });
      }
      const intervalHours = Math.min(12, Math.max(1, Number(body.intervalHours) || 3));
      await patchSettings({
        enabled: true,
        intervalHours,
        lastRunAt: new Date().toISOString(),
        lastStatus: "queued",
        lastMessage: "Remote Auto is enabled. The first server-side run has been queued."
      }, store);
      let dispatch = "queued";
      try {
        await launchBackgroundRunner();
      } catch (error) {
        dispatch = "scheduled-retry";
        await patchSettings({
          lastRunAt: new Date(Date.now() - Math.max(0, intervalHours - 1) * 3600000).toISOString(),
          lastStatus: "waiting",
          lastMessage: "Auto is enabled; immediate dispatch was unavailable. The hourly server scheduler will retry. " + String(error.message || error).slice(0, 180)
        }, store);
      }
      return json(200, { ok: true, dispatch, status: publicStatus(await readSettings(store)) });
    }

    if (actionName === "stop") {
      const updated = await patchSettings({
        enabled: false,
        lastStatus: "stopped",
        lastMessage: "Remote Auto is stopped. A run already in progress may finish; no further run will start."
      }, store);
      return json(200, { ok: true, status: publicStatus(updated) });
    }

    if (actionName === "interval") {
      const intervalHours = Math.min(12, Math.max(1, Number(body.intervalHours) || settings.intervalHours || 3));
      const updated = await patchSettings({
        intervalHours,
        lastMessage: settings.enabled
          ? "Remote Auto is active on the server; the new interval is saved."
          : "Interval saved. Press Run now to enable server-side Auto."
      }, store);
      return json(200, { ok: true, status: publicStatus(updated) });
    }

    if (actionName === "run-now") {
      if (!process.env.GEMINI_API_KEY) return json(503, { error: "Set GEMINI_API_KEY in Netlify environment variables first." });
      await patchSettings({
        lastRunAt: new Date().toISOString(),
        lastStatus: "queued",
        lastMessage: "A one-time server-side run has been queued."
      }, store);
      await launchBackgroundRunner();
      return json(200, { ok: true, status: publicStatus(await readSettings(store)) });
    }

    return json(400, { error: "Unknown automation action." });
  } catch (error) {
    return json(503, { error: "Remote automation storage is not ready: " + String(error.message || error).slice(0, 220) });
  }
}

function publicStatus(settings) {
  const last = Date.parse(settings.lastRunAt || "");
  const interval = Math.min(12, Math.max(1, Number(settings.intervalHours) || 3));
  return {
    enabled: Boolean(settings.enabled),
    intervalHours: interval,
    lastRunAt: settings.lastRunAt || null,
    lastCompletedAt: settings.lastCompletedAt || null,
    lastStatus: settings.lastStatus || "idle",
    lastMessage: String(settings.lastMessage || ""),
    latestAt: settings.latestAt || null,
    nextRunAt: settings.enabled && Number.isFinite(last) ? new Date(last + interval * 3600000).toISOString() : null,
    serverConfigured: Boolean(process.env.REMOTE_CONTROL_TOKEN && process.env.GEMINI_API_KEY)
  };
}
