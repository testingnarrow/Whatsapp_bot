import test from "node:test";
import assert from "node:assert/strict";
import {fitThreadsCaption,refreshThreadsToken,publishThreadsImage,threadsConfiguration} from "../netlify/functions/lib/threads-publishing.mjs";

test("Threads captions stay within the 500-character API limit",()=>{
 const caption=fitThreadsCaption("A".repeat(650)+"\n\n#News #World");
 assert.ok(caption.length<=500);
 assert.ok(caption.includes("#News"));
 assert.ok(caption.includes("#World"));
});

test("Threads app configuration requires the app ID, secret and exact redirect URI",()=>{
 assert.equal(threadsConfiguration({THREADS_APP_ID:"1",THREADS_APP_SECRET:"secret",THREADS_REDIRECT_URI:"https://example.test/api/threads-auth?action=callback"}).appConfigured,true);
 assert.equal(threadsConfiguration({THREADS_APP_ID:"1",THREADS_APP_SECRET:""}).appConfigured,false);
});

test("Threads token refresh persists the replacement token and expiry",async()=>{
 const storeData={"threads-auth":{accessToken:"old-token",userId:"123",issuedAt:new Date(Date.now()-30*86400000).toISOString(),expiresAt:new Date(Date.now()+5*86400000).toISOString()}};
 const store={async get(k){return storeData[k]||null},async setJSON(k,v){storeData[k]=v}};
 const auth=await refreshThreadsToken(store,{env:{},fetchImpl:async url=>{
  assert.match(String(url),/refresh_access_token/);
  return new Response(JSON.stringify({access_token:"new-token",expires_in:5184000}),{status:200});
 }});
 assert.equal(auth.accessToken,"new-token");
 assert.ok(Date.parse(auth.expiresAt)>Date.now()+50*86400000);
 assert.equal(storeData["threads-auth"].accessToken,"new-token");
});

test("Threads image publishing creates a container then publishes it",async()=>{
 const calls=[];
 const result=await publishThreadsImage({imageUrl:"https://remote.example/api/automation-image?version=2026-01-01",caption:"Test post #News",accessToken:"secret-token",userId:"123",fetchImpl:async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).endsWith("/threads"))return new Response(JSON.stringify({id:"container-1"}),{status:200});
  return new Response(JSON.stringify({id:"post-1"}),{status:200});
 }});
 assert.equal(calls.length,2);
 assert.match(calls[0].url,/\/123\/threads$/);
 assert.equal(new URLSearchParams(calls[0].options.body).get("media_type"),"IMAGE");
 assert.equal(new URLSearchParams(calls[0].options.body).get("image_url"),"https://remote.example/api/automation-image?version=2026-01-01");
 assert.match(calls[1].url,/\/123\/threads_publish$/);
 assert.equal(result.postId,"post-1");
});
