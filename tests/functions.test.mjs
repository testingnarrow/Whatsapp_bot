import test from 'node:test';
import assert from 'node:assert/strict';
import news from '../netlify/functions/news.mjs';
import images from '../netlify/functions/images.mjs';
import article from '../netlify/functions/article.mjs';
import imageProxy from '../netlify/functions/image-proxy.mjs';
const originalFetch = globalThis.fetch;

test('news endpoint parses RSS and normalizes candidate titles', async () => {
  const xml = '<?xml version="1.0"?><rss><channel><item><title>Penguin surprises visitors - Example News</title><link>https://example.com/story</link><description>A detailed story about a surprising penguin event with enough context.</description><pubDate>' + new Date().toUTCString() + '</pubDate><source>Example News</source></item></channel></rss>';
  globalThis.fetch = async () => new Response(xml, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  try { const response = await news(new Request('https://local.test/api/news?limit=60')); const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.count, 1); assert.equal(data.candidates[0].title, 'Penguin surprises visitors'); assert.equal(data.candidates[0].source, 'Example News'); assert.equal(data.queries.filter(query => query.ok).length, 8); }
  finally { globalThis.fetch = originalFetch; }
});

test('Photo search accepts portrait images and any reported licence without restrictive API filters', async () => {
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'commons.wikimedia.org') return new Response(JSON.stringify({query:{pages:[]}}),{status:200,headers:{'Content-Type':'application/json'}});
    assert.equal(parsed.hostname, 'api.openverse.org');
    for (const name of ['size','aspect_ratio','category','license','license_type']) assert.equal(parsed.searchParams.has(name), false);
    return new Response(JSON.stringify({ results: [
      { id:'by', title:'Wide CC BY', url:'https://images.example/by.jpg', thumbnail:'https://images.example/by-thumb.jpg', foreign_landing_url:'https://example.com/by', license:'by', license_url:'https://creativecommons.org/licenses/by/4.0/', width:2400, height:1000 },
      { id:'sa', title:'Wide CC BY-SA', url:'https://images.example/sa.jpg', foreign_landing_url:'https://example.com/sa', license:'by-sa', license_url:'https://creativecommons.org/licenses/by-sa/4.0/', width:1900, height:1200 },
      { id:'portrait', title:'Portrait accepted', url:'https://images.example/port.jpg', foreign_landing_url:'https://example.com/port', license:'by', width:800, height:1400 },
      { id:'nc', title:'NC accepted', url:'https://images.example/nc.jpg', foreign_landing_url:'https://example.com/nc', license:'by-nc', license_url:'https://creativecommons.org/licenses/by-nc/4.0/', width:1400, height:900 },
      { id:'unknown', title:'Unknown licence/dimensions accepted', url:'https://images.example/unknown.jpg', width:0, height:0 }
    ] }), { status:200, headers:{'Content-Type':'application/json'} });
  };
  try {
    const response=await images(new Request('https://local.test/api/images?q=workplace&limit=8'));
    const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.count,5);
    assert.ok(data.results.some(item=>item.license==='by-sa'));
    assert.ok(data.results.some(item=>item.title==='Portrait accepted'));
    assert.ok(data.results.some(item=>item.license==='by-nc'));
    assert.ok(data.results.some(item=>item.title==='Unknown licence/dimensions accepted'));
  } finally { globalThis.fetch=originalFetch; }
});

test('Openverse HTTP 502 falls back to unrestricted Wikimedia Commons photo results', async () => {
  globalThis.fetch=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==='api.openverse.org')return new Response(JSON.stringify({detail:'upstream unavailable'}),{status:502,headers:{'Content-Type':'application/json'}});
    assert.equal(parsed.hostname,'commons.wikimedia.org'); assert.equal(parsed.searchParams.get('action'),'query'); assert.equal(parsed.searchParams.get('generator'),'search');
    return new Response(JSON.stringify({query:{pages:[
      {pageid:1,title:'File:Funny dog.jpg',imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/d/d0/Funny_dog.jpg',thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d0/Funny_dog.jpg/1600px-Funny_dog.jpg',width:2200,height:1300,thumbwidth:1600,thumbheight:945,mime:'image/jpeg',extmetadata:{LicenseShortName:{value:'CC BY-SA 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'},Artist:{value:'Jane Artist'}}}]},
      {pageid:2,title:'File:Portrait.jpg',imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/portrait.jpg',thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/portrait.jpg/1600px-portrait.jpg',width:800,height:1200,thumbwidth:800,thumbheight:1200,mime:'image/jpeg',extmetadata:{LicenseShortName:{value:'CC BY 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'}}}]},
      {pageid:3,title:'File:NC.jpg',imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/nc.jpg',thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/nc.jpg/1600px-nc.jpg',width:2000,height:1000,thumbwidth:1600,thumbheight:800,mime:'image/jpeg',extmetadata:{LicenseShortName:{value:'CC BY-NC 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-nc/4.0/'}}}]}
    ]}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const response=await images(new Request('https://local.test/api/images?q=funny%20dog&limit=8'));
    const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.count,3);
    assert.equal(data.fallbackUsed,true);
    assert.ok(data.results.every(item=>item.provider==='Wikimedia Commons'));
    assert.ok(data.results.some(item=>item.title==='Portrait.jpg'));
    assert.ok(data.results.some(item=>item.license==='CC BY-NC 4.0'));
    assert.ok(data.results[0].foreign_landing_url.includes('commons.wikimedia.org/wiki/File:'));
  } finally { globalThis.fetch=originalFetch; }
});

test('Both image providers can fail without crashing and diagnostics are retained', async () => {
  globalThis.fetch=async url=>new Response(JSON.stringify({error:'simulated failure'}),{status:new URL(String(url)).hostname==='api.openverse.org'?502:503,headers:{'Content-Type':'application/json'}});
  try { const response=await images(new Request('https://local.test/api/images?q=rare-topic&limit=8')); const data=await response.json(); assert.equal(response.status,200); assert.equal(data.count,0); assert.ok(data.attempts.some(a=>a.provider==='Openverse'&&a.status==='error')); assert.ok(data.attempts.some(a=>a.provider==='Wikimedia Commons'&&a.status==='error')); assert.ok(data.warnings[0].includes('Neither image provider returned an image')); }
  finally { globalThis.fetch=originalFetch; }
});

test('article reader and image proxy reject unsafe local URLs', async () => {
  const a=await article(new Request('https://local.test/api/article?url=http%3A%2F%2Flocalhost%2Fsecret'));
  const b=await imageProxy(new Request('https://local.test/api/image-proxy?url=https%3A%2F%2Flocalhost%2Fsecret.jpg'));
  assert.equal(a.status,400); assert.equal(b.status,400);
});
