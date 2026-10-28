import { Resvg } from "@resvg/resvg-js";
import { getRemoteStore, readSettings, patchSettings, readHistory, writeHistory, rememberStory, isStoryUsed, LATEST_KEY, previewImageKey } from "./lib/remote-state.mjs";

export const config = { background: true };

const base = () => String(process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || "").replace(/\/+$/, "");
function auth(req) {
  const a = String(process.env.REMOTE_CONTROL_TOKEN || ""), b = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!a || a.length !== b.length || !b) return false;
  let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
async function getJson(url, ms = 15000) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + String((d.error && d.error.message) || d.error || "").slice(0, 140));
  return d;
}
function urlKey(raw) { try { const u = new URL(raw); if (u.protocol !== "https:") return ""; u.hash = ""; return u.href; } catch { return ""; } }
function score(s) {
  const t = (String(s.title || "") + " " + String(s.description || "")).toLowerCase();
  let n = ["odd","weird","bizarre","unusual","unexpected","strange","surprising","rare","discovery","fossil","animal","museum","auction","record","mystery","funny"].filter(w => t.includes(w)).length * 3;
  if (String(s.description || "").length > 90) n += 2;
  if (/apnews|upi|reuters|bbc|abcnews|theguardian|cbsnews|nbcnews/i.test(String(s.source || ""))) n += 2;
  n += Math.max(0, 5 - Math.max(0, Date.now() - (Date.parse(s.publishedAt || "") || Date.now())) / 86400000);
  return n;
}
async function getFresh(baseUrl, history) {
  const paths = ["/api/news?limit=200&broad=1", "/api/news?limit=200&broad=1&older=1", "/api/news?limit=200&broad=1&older=1&wide=1"];
  const found = new Map(), tries = [];
  for (const path of paths) {
    try {
      const d = await getJson(baseUrl + path, 25000); tries.push({path,count:d.count || 0});
      for (const s of d.candidates || []) { const u=urlKey(s.url); if(u && s.title && !isStoryUsed(s,history)) found.set(u,{...s,url:u}); }
    } catch(e) { tries.push({path,error:String(e.message || e).slice(0,120)}); }
    if (found.size >= 15) break;
  }
  return { stories:[...found.values()].sort((a,b)=>score(b)-score(a)), tries };
}
function modelScore(m) { const s=String(m.name||"").toLowerCase(); return (/(preview|experimental|latest)/.test(s)?0:1000)+(/flash-lite/.test(s)?250:/flash/.test(s)?180:0); }
async function models(apiKey) {
  const d=await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key="+encodeURIComponent(apiKey),12000);
  return (d.models||[]).filter(m=>/^(gemini|gemma)-/i.test(String(m.name||"").replace(/^models\//,"")) && (m.supportedGenerationMethods||[]).includes("generateContent") && !/(image|tts|audio|live|embedding|robot|deep-research|computer-use|veo|nano-banana|transcribe|translate)/i.test(m.name||"")).sort((a,b)=>modelScore(b)-modelScore(a));
}
function parse(text) {
  const fence = String.fromCharCode(96).repeat(3);
  const s=String(text||"").trim().replace(new RegExp("^"+fence+"(?:json)?\\s*","i"),"").replace(new RegExp("\\s*"+fence+"$"),"");
  try { return JSON.parse(s); } catch {}
  const a=s.indexOf("{"),b=s.lastIndexOf("}");
  if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
  throw new Error("Invalid JSON from Gemini.");
}
async function ai(prompt, apiKey, list, settings, store, tokens=2200) {
  const saved=String(settings.lastWorkingModel||"").replace(/^models\//,"");
  const order=[...list].sort((a,b)=>String(a.name).replace(/^models\//,"")===saved?-1:String(b.name).replace(/^models\//,"")===saved?1:0);
  let last;
  for(const m of order.slice(0,5)) {
    const id=String(m.name).replace(/^models\//,"");
    try {
      const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(id)+":generateContent?key="+encodeURIComponent(apiKey),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:.25,maxOutputTokens:tokens,responseMimeType:"application/json"}}),signal:AbortSignal.timeout(20000)});
      let d={};try{d=await r.json();}catch{}
      if(!r.ok)throw new Error((d.error&&d.error.message)||("Gemini HTTP "+r.status));
      const out=(d.candidates||[]).flatMap(c=>(c.content&&c.content.parts)||[]).map(p=>p.text||"").join("\n");
      const value=parse(out);await patchSettings({lastWorkingModel:id},store);return value;
    } catch(e) { last=e; console.warn("Gemini model fallback:",String(e.message||e).slice(0,100)); }
  }
  throw last || new Error("No text model available.");
}
function photoQuery(title) {
  const t=String(title||"").toLowerCase(), rules=[
    [/museum|exhibit|gallery|artifact|fossil|dinosaur|prehistoric|paleontolog|skeleton|nanotyrannus/,"museum dinosaur fossil skeleton exhibition"],
    [/auction|auctioneer|bidding|bid\b|sold for/,"auction house bidding room"],
    [/court|judge|lawsuit|trial|verdict/,"courthouse courtroom"],
    [/police|crime|arrest|investigation/,"police vehicle city street"],
    [/wildfire|firefighter|fire truck|blaze/,"firefighters emergency scene"],
    [/flood|tornado|hurricane|storm|weather/,"storm clouds flooded city street"],
    [/airplane|aircraft|airline|airport|flight/,"airport passenger airplane"],
    [/train|railway|subway/,"train railway station"],
    [/car|truck|vehicle|traffic|motorcycle/,"road traffic vehicles city street"],
    [/rocket|space|satellite|astronaut/,"rocket launch space center"],
    [/animal|dog|cat|wildlife|zoo|whale|bird|penguin/,"wildlife animals natural habitat"],
    [/hospital|doctor|medical|health|patient/,"hospital medical professionals"],
    [/school|student|teacher|classroom|university/,"school classroom education"],
    [/restaurant|food|chef|meal|cooking/,"restaurant kitchen food preparation"],
    [/football|basketball|baseball|soccer|tennis|sport/,"sports stadium competition"],
    [/election|president|government|politic|congress/,"government building press conference"],
    [/robot|artificial intelligence|\bai\b|computer|technology|software/,"technology computer laboratory"]
  ];
  return (rules.find(([p])=>p.test(t))||[null,"museum exhibition hall"])[1];
}
function photoAlternates(q) {
  if(/museum|dinosaur|fossil|skeleton/.test(q))return ["natural history museum exhibit","dinosaur skeleton museum display","museum gallery exhibition hall","dinosaur fossil display","museum interior exhibition","science museum dinosaur exhibit"];
  if(/auction/.test(q))return ["auction house interior","auction gallery crowd","auction display tables","auctioneer bidding room","public auction interior"];
  if(/court|judge|lawsuit/.test(q))return ["courthouse interior","judge courtroom","court building exterior","law court hearing room"];
  if(/animal|wildlife|zoo|dog|cat/.test(q))return ["wildlife animals natural habitat","zoo animal exhibit","wildlife rescue centre","animal close up outdoors"];
  return ["public building exterior","people at a public event","museum exhibition hall","city street everyday life","community event crowd","public interior hall"];
}
async function testImage(base, photo) {
  const url=String(photo && (photo.url||photo.thumbnail)||"");
  if(!/^https:\/\//i.test(url))return null;
  try {
    const r=await fetch(base+"/api/image-proxy?url="+encodeURIComponent(url),{headers:{Accept:"image/jpeg,image/png,image/webp"},signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;
    const type=String(r.headers.get("content-type")||"").split(";")[0].toLowerCase();
    if(!["image/jpeg","image/png","image/webp"].includes(type))return null;
    const bytes=Buffer.from(await r.arrayBuffer());if(!bytes.length||bytes.length>6*1024*1024)return null;
    return {photo,dataUri:"data:"+type+";base64,"+bytes.toString("base64")};
  } catch { return null; }
}
async function searchPhoto(base,title) {
  const first=photoQuery(title),queries=[...new Set([first,...photoAlternates(first)])],all=[],seen=new Set(),attempts=[];
  for(const q of queries) {
    try {
      const d=await getJson(base+"/api/images?q="+encodeURIComponent(q)+"&limit=20",12000);
      attempts.push({query:q,count:Number(d.count)||0});
      const fresh=[];
      for(const p of d.results||[]){const k=String(p.url||p.thumbnail||"");if(k&&!seen.has(k)){seen.add(k);all.push(p);fresh.push(p);}}
      for(let i=0;i<fresh.length;i+=4){const batch=await Promise.all(fresh.slice(i,i+4).map(p=>testImage(base,p)));const found=batch.find(Boolean);if(found)return{image:found,photos:all.slice(0,18),attempts};}
    } catch(e){attempts.push({query:q,error:String(e.message||e).slice(0,120)});}
  }
  return {image:null,photos:all.slice(0,18),attempts};
}
function esc(v){return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
function wrap(v,max){const out=[];let line="";for(const word of String(v||"").trim().split(/\s+/)){const n=line?line+" "+word:word;if(n.length>max&&line){out.push(line);line=word;}else line=n;}if(line)out.push(line);return out;}
function renderSvg(draft,dataUri) {
  const title=String(draft.image_title||"An Unexpected Turn of Events"),body=String(draft.image_paragraph||draft.caption||title),page=String(draft.page_name||"REMOTE NEWS").trim().slice(0,28)||"REMOTE NEWS",p={x:166,y:200,w:748,h:642},w=672;
  let bs=42,ts=59,tl=[],bl=[],th=0,bh=0,gap=18;
  for(;bs>=28;bs--){ts=Math.round(bs*1.4);tl=wrap(title,Math.max(18,Math.floor(w/(ts*.56))));bl=wrap(body,Math.max(25,Math.floor(w/(bs*.52))));th=ts*1.05;bh=bs*1.22;if(tl.length<=2&&tl.length*th+gap+bl.length*bh<=p.h-63)break;}
  let y=p.y+32+Math.max(0,p.h-63-tl.length*th-gap-bl.length*bh)*.08;
  const a=tl.map((s,i)=>'<text x="204" y="'+(y+ts+i*th)+'" font-family="Arial,sans-serif" font-size="'+ts+'" font-weight="800" fill="#a51d20">'+esc(s)+'</text>').join("");y+=tl.length*th+gap;
  const b=bl.map((s,i)=>'<text x="204" y="'+(y+bs+i*bh)+'" font-family="Arial,sans-serif" font-size="'+bs+'" font-weight="700" fill="#050505">'+esc(s)+'</text>').join("");
  let grid="";for(let i=0;i<=10;i++)grid+='<path d="M540 758L'+(i*108)+' 1080"/>';
  const photo=dataUri?'<image href="'+dataUri+'" x="0" y="0" width="1080" height="760" preserveAspectRatio="xMidYMid slice"/>':'<rect width="1080" height="760" fill="url(#fallback)"/><g opacity=".38" stroke="#c8d5ff" stroke-width="3" fill="none"><path d="M0 140L1080 680M0 300L930 760M160 0L700 760M620 0L1080 430M0 550L440 760"/><circle cx="150" cy="150" r="45" fill="#f5d323"/><circle cx="895" cy="190" r="70" fill="#7ed2ff"/><circle cx="760" cy="530" r="95" fill="#d7d6ff"/></g><text x="540" y="270" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#f5d323">REMOTE / FIELD REPORT</text><text x="540" y="345" text-anchor="middle" font-family="Arial,sans-serif" font-size="29" font-weight="700" fill="#ffffff">STORIES FROM THE UNEXPECTED</text>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><defs><linearGradient id="fallback"><stop stop-color="#14113e"/><stop offset=".5" stop-color="#3d326d"/><stop offset="1" stop-color="#102e60"/></linearGradient><linearGradient id="fade" x2="0" y2="1"><stop stop-color="#100d46" stop-opacity="0"/><stop offset=".48" stop-color="#100d46" stop-opacity=".22"/><stop offset="1" stop-color="#100d46" stop-opacity=".97"/></linearGradient></defs><rect width="1080" height="1080" fill="#100d46"/>'+photo+'<rect y="210" width="1080" height="660" fill="url(#fade)"/><g fill="none" stroke="#aeb4ff" stroke-opacity=".62" stroke-width="2">'+grid+'<path d="M0 790H1080M0 845H1080M0 910H1080M0 990H1080"/></g><rect x="122" y="165" width="836" height="780" rx="40" fill="none" stroke="#fff" stroke-width="18"/><rect x="166" y="200" width="748" height="642" rx="27" fill="#f7d80e" stroke="#fff" stroke-width="10"/>'+a+b+'<rect x="403" y="866" width="274" height="55" rx="28" fill="#fff"/><text x="540" y="894" text-anchor="middle" dominant-baseline="middle" font-family="Arial,sans-serif" font-size="27" font-weight="800" fill="#080808">'+esc(page)+'</text></svg>';
}
function cleanCaption(v){let s=String(v||"").replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi,"");s=s.replace(/(?:^|\n)\s*(sources?|references?|source links?|read more|links?)\s*:[\s\S]*$/i,"").replace(/https?:\/\/\S+/gi,"").replace(/(^|\s)#[a-z0-9_]+/gi," ");return s.replace(/\n{3,}/g,"\n\n").trim();}
function tags(suggested,title){const out=[];const add=v=>{const t=String(v||"").replace(/^#+/,"").replace(/[^a-z0-9_]/gi,"").slice(0,30);if(t&&out.length<8&&!out.some(x=>x.toLowerCase()==="#"+t.toLowerCase()))out.push("#"+t);};add("News");for(const t of Array.isArray(suggested)?suggested:[])add(t);const s=String(title||"").toLowerCase();for(const [p,ts] of [[/dinosaur|fossil|skeleton|paleontolog|nanotyrannus/,["Dinosaur","Fossil","Museum","Science"]],[/auction|bidding/,["Auction","Collectibles"]],[/wildlife|animal|dog|cat|zoo/,["Animals","Wildlife"]],[/court|judge|lawsuit|trial/,["Court","Law"]],[/police|crime|arrest/,["Police","PublicSafety"]],[/weather|storm|flood/,["Weather","Climate"]],[/airport|airplane|flight/,["Aviation","Travel"]],[/sport|football|basketball|soccer/,["Sports","Competition"]],[/technology|computer|robot|software/,["Technology","Innovation"]]])if(p.test(s))ts.forEach(add);["WorldNews","TrendingNow","CurrentEvents","USNews","InterestingFacts","TopStories","TodayInNews"].forEach(add);return out.slice(0,8);}
function fallbackDraft(s,detail){let title=String(s.title||"Unexpected News").replace(/\s+-\s+[^-]{2,70}$/,"").trim();if(title.length>56)title=title.slice(0,53).replace(/\s+\S*$/,"")+"...";const text=String(detail||s.description||s.title||"").replace(/\s+/g," ").trim();return{image_title:title,image_paragraph:(text||title).slice(0,315),caption:title+"\n\n"+text+"\n\nThe available details are limited, so this summary stays close to the published report.",image_query:photoQuery(title),hashtags:[],confidence:detail?"medium":"low",verification_note:"Based on the available headline and article text."};}
async function makeDraft(s,detail,key,list,settings,store){const f=fallbackDraft(s,detail);try{const d=await ai("Write accurate engaging English Facebook news for US readers, with a human-sounding hook and 2-4 short paragraphs. No invented facts, URLs or source list. Return JSON only with image_title max 56 chars, image_paragraph 200-310 chars (max 340), caption 110-160 words before hashtags, hashtags array of 8 relevant tags including #News, confidence and verification_note. For rare fossil auction stories use a general museum dinosaur fossil skeleton exhibition photo theme, not the exact event. Evidence: "+JSON.stringify({story:s,articleText:String(detail||"").slice(0,6000)}),key,list,settings,store,2500);d.image_title=String(d.image_title||f.image_title).trim();if(d.image_title.length>56)d.image_title=f.image_title;d.image_paragraph=String(d.image_paragraph||f.image_paragraph).replace(/\s+/g," ").trim();if(d.image_paragraph.length>340)d.image_paragraph=d.image_paragraph.slice(0,337).replace(/\s+\S*$/,"")+"...";if(d.image_paragraph.length<100)d.image_paragraph=f.image_paragraph;d.image_query=photoQuery(s.title);d.hashtags=tags(d.hashtags,s.title);d.caption=cleanCaption(d.caption)+"\n\n"+d.hashtags.join(" ");d.confidence=["high","medium","low"].includes(String(d.confidence))?d.confidence:"medium";return d;}catch(e){console.warn("Draft fallback:",String(e.message||e).slice(0,120));f.hashtags=tags([],s.title);f.caption=cleanCaption(f.caption)+"\n\n"+f.hashtags.join(" ");return f;}}
async function fail(store,settings,error){const h=Math.max(1,Math.min(12,Number(settings.intervalHours)||3)),n=Date.now();await patchSettings({lastCompletedAt:new Date(n).toISOString(),lastRunAt:new Date(n-Math.max(0,h-1)*3600000).toISOString(),lastStatus:"retrying",lastMessage:"Remote run failed; Auto remains enabled and will retry. "+String(error.message||error).slice(0,180)},store);}
export default async function handler(req){
  if(!auth(req)){console.error("Rejected remote worker: invalid control token.");return;}
  const store=getRemoteStore();let settings=await readSettings(store);if(!settings.enabled){await patchSettings({lastStatus:"stopped",lastMessage:"Remote Auto is disabled."},store);return;}
  const root=base(),key=String(process.env.GEMINI_API_KEY||"");if(!root){await fail(store,settings,new Error("Netlify URL is missing."));return;}
  try{
    await patchSettings({lastRunAt:new Date().toISOString(),lastStatus:"running",lastMessage:"Searching broader news sources and excluding previously used stories."},store);
    const history=await readHistory(store),scan=await getFresh(root,history);
    if(!scan.stories.length){settings=await readSettings(store);const h=Math.max(1,Math.min(12,Number(settings.intervalHours)||3)),n=Date.now();await patchSettings({lastCompletedAt:new Date(n).toISOString(),lastRunAt:new Date(n-Math.max(0,h-1)*3600000).toISOString(),lastStatus:"waiting-for-fresh-news",lastMessage:"Tried current, broad, older and wide searches. No unused story was found; the hourly server scheduler will retry."},store);return;}
    let list=[];try{if(key)list=await models(key);}catch(e){console.warn("Gemini models unavailable:",String(e.message||e).slice(0,100));}
    await patchSettings({lastMessage:"Ranking fresh story candidates and selecting the strongest unused report."},store);
    let story=scan.stories[0];if(key&&list.length){try{const r=await ai("Choose the strongest fresh human-interest or unusual US news story from this list. Return JSON only {\"selected_id\":\"exact id\"}. Candidates: "+JSON.stringify(scan.stories.slice(0,45).map(s=>({id:s.id,title:s.title,source:s.source,date:s.publishedAt,description:String(s.description||"").slice(0,250),url:s.url}))),key,list,settings,store,700);const selected=scan.stories.find(s=>s.id===String(r.selected_id||""));if(selected)story=selected;}catch(e){console.warn("Ranking fallback, use next fresh story:",String(e.message||e).slice(0,100));}}
    await patchSettings({lastMessage:"Reading the selected article and collecting report details."},store);
    let detail=String(story.description||"");try{const d=await getJson(root+"/api/article?url="+encodeURIComponent(story.url),11000);if(d.text)detail=String(d.text).slice(0,6500);}catch{}
    settings=await readSettings(store);
    await patchSettings({lastMessage:"Drafting the graphic headline, on-image summary and full caption."},store);
    let draft=key&&list.length?await makeDraft(story,detail,key,list,settings,store):fallbackDraft(story,detail);
    const titleText=String(draft.image_title||story.title||"Latest News").replace(/\s+/g," ").trim();
    draft.image_title=(titleText.slice(0,56)||"Latest News");
    let paragraphText=String(draft.image_paragraph||detail||story.description||story.title||draft.image_title).replace(/\s+/g," ").trim();
    if(paragraphText.length<80)paragraphText=(paragraphText+" — Read the full report for the latest verified details.").trim();
    draft.image_paragraph=paragraphText.slice(0,315);
    const captionFallback=String(story.title||"Latest News")+"\n\n"+String(detail||story.description||story.title||"The report has limited details at this time.")+"\n\nDetails may develop as more information becomes available.";
    draft.caption=cleanCaption(draft.caption);
    if(draft.caption.length<80)draft.caption=cleanCaption(captionFallback);
    draft.hashtags=tags(draft.hashtags,story.title);
    draft.caption+=(draft.caption?"\n\n":"")+draft.hashtags.join(" ");
    draft.page_name=String(settings.pageName||"REMOTE NEWS").trim().slice(0,28)||"REMOTE NEWS";
    await patchSettings({lastMessage:"Searching several generic photo categories and checking that the files really load."},store);
    const q=photoQuery(story.title),queries=[...new Set([q,...photoAlternates(q)])],photos=[],seen=new Set(),attempts=[];let chosen=null;
    for(const query of queries){try{const d=await getJson(root+"/api/images?q="+encodeURIComponent(query)+"&limit=20",12000);attempts.push({query,count:Number(d.count)||0});for(const p of d.results||[]){const k=String(p.url||p.thumbnail||"");if(k&&!seen.has(k)){seen.add(k);photos.push(p);}}for(let i=0;i<photos.length;i+=4){const results=await Promise.all(photos.slice(i,i+4).map(p=>testImage(root,p)));chosen=results.find(Boolean)||chosen;if(chosen)break;}if(chosen)break;}catch(e){attempts.push({query,error:String(e.message||e).slice(0,120)});}}
    await patchSettings({lastMessage:"Rendering the finished graphic with its headline, summary and page label."},store);
    const png=new Resvg(renderSvg(draft,chosen&&chosen.dataUri),{fitTo:{mode:"width",value:1080}}).render().asPng();
    await patchSettings({lastMessage:"Saving the completed post and recording its no-repeat history."},store);
    const post={generatedAt:new Date().toISOString(),pageName:draft.page_name,draft,story,chosen:{selected:story,supporting:[],reason:"Selected from a wider news search.",confidence:draft.confidence||"medium"},articles:[{title:story.title,url:story.url,source:story.source,articleText:detail.slice(0,1200)}],photo:chosen?chosen.photo:null,photos:photos.slice(0,18),photoAttempts:attempts,imageWasFound:Boolean(chosen)};
    post.imageKey=previewImageKey(post.generatedAt);
    await store.set(post.imageKey,new Blob([png],{type:"image/png"}));
    await writeHistory(rememberStory(history,story),store);
    await store.setJSON(LATEST_KEY,post);
    await patchSettings({lastCompletedAt:new Date().toISOString(),lastStatus:"success",latestAt:post.generatedAt,lastMessage:"New post saved: "+String(story.title||"").slice(0,140)+(chosen?" with matching photo.":" All photo searches tried; branded artwork fallback used.")},store);
    console.log("REMOTE created post",story.title,"photo",Boolean(chosen),"photo queries",attempts.length);
  }catch(e){console.error("REMOTE worker:",String(e.stack||e));settings=await readSettings(store).catch(()=>settings);await fail(store,settings,e);}
}
