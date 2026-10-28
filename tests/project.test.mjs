import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
test('Netlify app and backend endpoints exist',()=>{assert.ok(existsSync('index.html'));for(const name of ['news','images','article','image-proxy'])assert.ok(existsSync('netlify/functions/'+name+'.mjs'));});
test('Gemini models are cached, restored automatically, and working models are persisted',()=>{const html=readFileSync('index.html','utf8');assert.match(html,/remote_last_working_model/);assert.match(html,/remote_gemini_models_cache_v1/);assert.match(html,/refreshModels\(\)\.catch/);assert.match(html,/rememberWorkingModel\(model\)/);assert.match(html,/trying the next compatible model/i);});
test('Gemini model discovery is live and Facebook publishing is not enabled',()=>{const html=readFileSync('index.html','utf8');assert.match(html,/generativelanguage\.googleapis\.com\/v1beta\/models/);assert.match(html,/supportedGenerationMethods/);assert.match(html,/Facebook added later|does not publish to Facebook/i);assert.doesNotMatch(html,/graph\.facebook\.com\/.*\/photos/i);});
test('Photo search tries Openverse and Wikimedia without narrow filters',()=>{const news=readFileSync('netlify/functions/news.mjs','utf8'),images=readFileSync('netlify/functions/images.mjs','utf8');assert.ok(news.includes('news.google.com/rss/search'));assert.ok(news.includes('ceid=US:en'));assert.ok(images.includes('api.openverse.org'));assert.ok(images.includes('commons.wikimedia.org/w/api.php'));assert.ok(images.includes('Promise.all(tasks)'));assert.ok(!images.includes('ALLOWED_LICENSES'));assert.ok(!images.includes("searchParams.set('aspect_ratio'"));assert.ok(!images.includes("searchParams.set('size'"));assert.ok(!images.includes("searchParams.set('category'"));assert.ok(!images.includes("searchParams.set('license_type'"));});
test('Square renderer has title and paragraph fields',()=>{const html=readFileSync('index.html','utf8');assert.match(html,/width="1080" height="1080"/);assert.match(html,/image_title/);assert.match(html,/image_paragraph/);assert.match(html,/Baloo 2/);});

test('Gemini model compatibility accepts models/ prefixed 3.8 and 3.5 IDs and rejects non-text endpoints',()=>{
 const html=readFileSync('index.html','utf8');
 const cleanMatch=html.match(/function cleanModelName\(name\)\s*\{[^}]*\}/);
 const textMatch=html.match(/function isText\(m\)\s*\{[^}]*\}/);
 assert.ok(cleanMatch,'cleanModelName helper should exist');
 assert.ok(textMatch,'isText compatibility filter should exist');
 const cleanModelName=new Function('return ('+cleanMatch[0]+');')();
 const isText=new Function('cleanModelName','return ('+textMatch[0]+');')(cleanModelName);
 assert.equal(isText({name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}),true);
 assert.equal(isText({name:'models/gemini-3.5-flash',supportedGenerationMethods:['generateContent']}),true);
 assert.equal(isText({name:'models/gemma-4-31b-it',supportedGenerationMethods:['generateContent']}),true);
 assert.equal(isText({name:'models/gemini-3.8-flash-tts',supportedGenerationMethods:['generateContent']}),false);
 assert.equal(isText({name:'models/gemini-3.1-flash-image',supportedGenerationMethods:['generateContent']}),false);
 assert.equal(isText({name:'models/gemini-3.8-flash',supportedGenerationMethods:['countTokens']}),false);
});

test('Photo search tries several categories and always has a clean artwork fallback',()=>{
 const html=readFileSync('index.html','utf8');
 assert.ok(html.includes('function photoQueries(title,hint)'));
 assert.ok(html.includes('for(let i=0;i<photoCandidates.length;i+=4)'));
 assert.ok(html.includes('core.filterUnseenPhotos(photos,recentPhotoHistory)'));
 assert.ok(html.includes('render(null,draft)'));
 assert.ok(html.includes('STORIES FROM THE UNEXPECTED'));
 assert.doesNotMatch(html,/Photo unavailable/);
 assert.doesNotMatch(html,/No landscape image was found from Openverse/);
});

test('Generic photo search queries represent the subject rather than the exact news event',()=>{
 const html=readFileSync('index.html','utf8'),core=readFileSync('netlify/functions/lib/news-generation-core.mjs','utf8');
 const match=html.match(/function genericPhotoQuery\(title,hintedQuery\)\s*\{[\s\S]*?\n\}/);
 assert.ok(match,'genericPhotoQuery helper should exist');
 const genericPhotoQuery=new Function('return ('+match[0]+');')();
 assert.equal(genericPhotoQuery('Rare Nanotyrannus Skeleton Sells For $47.3M','nanotyrannus auction'),'museum dinosaur fossil skeleton exhibition');
 assert.equal(genericPhotoQuery('Judge dismisses a lawsuit','legal dispute'),'courthouse courtroom');
 assert.ok(core.includes('not an exact photo of this particular incident'));
});
test('Graphic typography uses a larger proportional title and keeps the badge away from the yellow panel',()=>{
 const html=readFileSync('index.html','utf8');
 assert.ok(html.includes('titleSize=Math.round(bodySize*1.45)'));
 assert.ok(html.includes('const panel={x:166,y:200,w:748,h:642}'));
 assert.ok(html.includes('rounded(ctx,403,866,274,55,28'));
 assert.ok(html.includes('ctx.fillText(line,textX,y,textW)'));
});
test('Caption removes source links and appends exactly eight relevant hashtags',()=>{
 const html=readFileSync('index.html','utf8');
 const cleanMatch=html.match(/function cleanCaptionBody\(raw\)\s*\{[\s\S]*?\n\}/);
 const tagsMatch=html.match(/function hashtagsForPost\(suggested,title,imageQuery\)\s*\{[\s\S]*?\n\}/);
 assert.ok(cleanMatch,'cleanCaptionBody helper should exist');
 assert.ok(tagsMatch,'hashtagsForPost helper should exist');
 const cleanCaptionBody=new Function('return ('+cleanMatch[0]+');')();
 const hashtagsForPost=new Function('return ('+tagsMatch[0]+');')();
 const clean=cleanCaptionBody('A remarkable fossil sold for millions.\n\nSources: https://example.com/report');
 assert.ok(!/https?:\/\//i.test(clean));
 assert.ok(!/sources?:/i.test(clean));
 const tags=hashtagsForPost(['#Auction','#News','#Dinosaur'],'Nanotyrannus fossil auction','museum dinosaur fossil skeleton exhibition');
 assert.equal(tags.length,8);
 assert.equal(tags[0],'#News');
 assert.equal(new Set(tags.map(tag=>tag.toLowerCase())).size,8);
 assert.ok(tags.includes('#Auction'));
 assert.ok(tags.includes('#Fossil'));
});

test('Remote Auto runs as a server background function with a schedule and persisted story history',()=>{
 const files=['netlify/functions/automation-settings.mjs','netlify/functions/automation-tick.mjs','netlify/functions/automation-run-background.mjs','netlify/functions/automation-latest-image.mjs','netlify/functions/lib/remote-state.mjs'];
 for(const file of files)assert.ok(existsSync(file),file+' must exist');
 const toml=readFileSync('netlify.toml','utf8'),worker=readFileSync('netlify/functions/automation-run-background.mjs','utf8'),state=readFileSync('netlify/functions/lib/remote-state.mjs','utf8'),html=readFileSync('index.html','utf8');
 assert.ok(toml.includes('schedule = "0 * * * *"'));
 assert.ok(toml.includes('background = true'));
 assert.ok(worker.includes('export const config = { background: true }'));
 assert.ok(worker.includes('await writeHistory(rememberStory(latestHistory,story),store)'));
 assert.ok(state.includes('export function isStoryUsed'));
 assert.ok(state.includes('export async function readHistory'));
 assert.ok(html.includes('REMOTE_CONTROL_TOKEN'));
 assert.ok(html.includes('/api/automation?action=status'));
 assert.ok(html.includes('/api/automation-image?version='));
 assert.ok(html.includes("import('/news-generation-core.mjs')"));
 assert.ok(worker.includes('buildDraftPrompt(chosen,articles)'));
 assert.ok(!html.includes('setTimeout(()=>{if(state.auto)generate'));
});
test('Server history canonicalizes tracking URLs and rejects repeat stories',()=>{
 const source=readFileSync('netlify/functions/lib/remote-state.mjs','utf8');
 assert.ok(source.includes('export function canonicalStoryUrl'));
 assert.ok(source.includes('export function normalizeStoryTitle'));
 assert.ok(source.includes('export function isStoryUsed'));
 assert.ok(source.includes('export function rememberStory'));
});
test('News selection can broaden into older and wider searches instead of relying on one feed pass',()=>{
 const news=readFileSync('netlify/functions/news.mjs','utf8');
 assert.ok(news.includes('BROAD_QUERIES'));
 assert.ok(news.includes('OLDER_QUERIES'));
 assert.ok(news.includes('WIDE_QUERIES'));
 assert.ok(news.includes('isStoryUsed(item, history)'));
 assert.ok(news.includes('limit = Math.min(200'));
});
