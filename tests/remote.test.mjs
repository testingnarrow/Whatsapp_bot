import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalStoryUrl, normalizeStoryTitle, isStoryUsed, rememberStory, writeHistory
} from '../netlify/functions/lib/remote-state.mjs';
import {buildRankingPrompt,resolveRanking,needsGraphicRepair,prepareDraftCopy,finalizeDraft,buildFallbackDraft,photoQueries} from '../netlify/functions/lib/news-generation-core.mjs';

test('canonical story URLs ignore tracking parameters and trailing fragments',()=>{
  assert.equal(
    canonicalStoryUrl('https://www.Example.com/story/?utm_source=feed&fbclid=abc#section'),
    'https://example.com/story'
  );
});

test('permanent history catches the same URL and slightly reworded syndicated headlines',()=>{
  const first={
    title:'Rare Nanotyrannus Skeleton Sells for $47.3M at New York Auction',
    url:'https://www.example.com/story?id=1&utm_source=rss'
  };
  const history=rememberStory([],first,'2026-10-28T00:00:00.000Z');
  assert.equal(isStoryUsed({
    title:'Rare Nanotyrannus skeleton sells for $47.3 million at New York auction',
    url:'https://www.example.com/story?id=1&utm_campaign=other'
  },history),true);
  assert.equal(isStoryUsed({
    title:'Nanotyrannus Skeleton Fetches Millions at Auction',
    url:'https://another.example.com/related'
  },history),true);
  assert.equal(isStoryUsed({
    title:'A rare dog finds a new home after a long journey',
    url:'https://another.example.com/dog-story'
  },history),false);
});

test('rememberStory does not add duplicate stories twice',()=>{
  const story={title:'Unexpected discovery at a museum draws attention',url:'https://news.example/museum-story'};
  const first=rememberStory([],story);
  const second=rememberStory(first,{...story,title:'Unexpected museum discovery draws attention',url:'https://news.example/museum-story?utm_source=share'});
  assert.equal(second.length,1);
  assert.equal(first.length,1);
});

test('Server Auto explicitly loads a font and refuses to save graphics without visible text',()=>{
 const worker=readFileSync('netlify/functions/automation-run-background.mjs','utf8');
 assert.ok(worker.includes('async function ensureGraphicFont()'));
 assert.ok(worker.includes('font:{fontFiles,loadSystemFonts:false,defaultFontFamily:"Atkinson Hyperlegible",sansSerifFamily:"Atkinson Hyperlegible"}'));
 assert.ok(worker.includes('function assertGraphicTextVisible(rendered)'));
 assert.ok(worker.includes('Auto graphic text did not render visibly'));
 assert.ok(worker.includes('Skipped a story already recorded in server history'));
});
test('Manual and Auto use the same shared ranking, copy and photo-query core',()=>{
 const html=readFileSync('index.html','utf8'),worker=readFileSync('netlify/functions/automation-run-background.mjs','utf8'),build=readFileSync('scripts/build-check.mjs','utf8');
 assert.ok(html.includes("import('/news-generation-core.mjs')"));assert.ok(html.includes('core.buildDraftPrompt(chosen,articles)'));assert.ok(html.includes('core.resolveRanking(result,candidates,alreadyUsedLocally)'));
 assert.ok(worker.includes('buildDraftPrompt(chosen,articles)'));assert.ok(worker.includes('buildRankingPrompt(candidates)'));assert.ok(worker.includes('photoQueries(story.title,draft.image_query)'));assert.ok(build.includes('dist/news-generation-core.mjs'));
});
test('Shared core creates a non-empty fallback graphic and clean caption with eight hashtags',()=>{
 const chosen={selected:{id:'one',title:'Rare fossil found in an unexpected river discovery',url:'https://news.example/story',description:'Scientists are examining a fossil discovered by a local river guide, with more study expected.'}};
 const articles=[{url:chosen.selected.url,articleText:'Scientists are examining a fossil discovered by a local river guide. Museum researchers are studying the find for additional context.'}];
 const d=finalizeDraft(buildFallbackDraft(chosen,articles),chosen,articles);
 assert.ok(d.image_title.length>0);assert.ok(d.image_paragraph.length>0);assert.ok(d.caption.includes('#News'));assert.equal(d.hashtags.length,8);assert.ok(!d.caption.includes('https://'));
 assert.ok(photoQueries(chosen.selected.title,'museum fossil exhibit').length>1);
 assert.equal(needsGraphicRepair(prepareDraftCopy({image_title:'',image_paragraph:''},chosen,[])),true);
});
test('Shared ranking resolves corroborating stories but excludes history duplicates',()=>{
 const list=[{id:'one',title:'Fresh museum story',url:'https://news.example/one'},{id:'two',title:'Corroborating museum report',url:'https://news.example/two'},{id:'old',title:'Already-used story',url:'https://news.example/old'}];
 assert.ok(buildRankingPrompt(list).includes('supporting_ids'));const picked=resolveRanking({selected_id:'one',supporting_ids:['two','old'],confidence:'high'},list,x=>x.id==='old');
 assert.equal(picked.selected.id,'one');assert.deepEqual(picked.supporting.map(x=>x.id),['two']);
});
test('Auto repairs a legacy blank preview asset and refuses invisible graphics',()=>{
 const worker=readFileSync('netlify/functions/automation-run-background.mjs','utf8'),endpoint=readFileSync('netlify/functions/automation-latest-image.mjs','utf8');
 assert.ok(worker.includes('async function repairLegacyPreview'));assert.ok(worker.includes('graphicTextVersion:2'));assert.ok(worker.includes('assertGraphicTextVisible(rendered)'));assert.ok(endpoint.includes('latest.imageUpdatedAt'));
});
