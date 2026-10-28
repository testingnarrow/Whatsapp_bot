import { getRemoteStore, LATEST_KEY, LATEST_IMAGE_KEY, previewImageKey } from "./lib/remote-state.mjs";

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405 });
  try {
    const store=getRemoteStore(),latest=await store.get(LATEST_KEY,{type:"json",consistency:"strong"}),version=new URL(request.url).searchParams.get("version");
    let imageKey=latest&&latest.imageKey?latest.imageKey:LATEST_IMAGE_KEY;
    if(version){const current=latest&&String(latest.generatedAt||latest.at||"")===version;imageKey=current&&latest.imageKey?latest.imageKey:current?LATEST_IMAGE_KEY:previewImageKey(version)}
    const data=await store.get(imageKey,{type:"arrayBuffer",consistency:"strong"});
    if(!data)return new Response("No remote preview image was found for this version.",{status:404});
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return new Response("Remote image storage is not ready: " + String(error.message || error), { status: 503 });
  }
}
