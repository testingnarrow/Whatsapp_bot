import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalStoryUrl, normalizeStoryTitle, isStoryUsed, rememberStory, writeHistory
} from '../netlify/functions/lib/remote-state.mjs';

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
 assert.ok(worker.includes('Skipped a story that another run already added to server history'));
});
test('Server Auto repairs empty graphic copy and uses generic photo hints',()=>{
 const worker=readFileSync('netlify/functions/automation-run-background.mjs','utf8');
 assert.ok(worker.includes('d.image_paragraph=String(d.image_paragraph||fallback.image_paragraph'));
 assert.ok(worker.includes('if(d.image_title.length>56 || d.image_paragraph.length<160 || d.image_paragraph.length>340)'));
 assert.ok(worker.includes('photoQuery(story.title,draft.image_query)'));
 assert.ok(worker.includes('draft.page_name=String(settings.pageName||"REMOTE NEWS")'));
});
