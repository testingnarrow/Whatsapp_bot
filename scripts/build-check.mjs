import { readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const required=['index.html','netlify.toml','package.json','netlify/functions/news.mjs','netlify/functions/images.mjs','netlify/functions/article.mjs','netlify/functions/image-proxy.mjs','netlify/functions/lib/remote-state.mjs','netlify/functions/automation-settings.mjs','netlify/functions/automation-tick.mjs','netlify/functions/automation-run-background.mjs','netlify/functions/automation-latest-image.mjs','netlify/functions/lib/news-generation-core.mjs','netlify/functions/lib/facebook-publishing.mjs'];
for(const file of required)if(!existsSync(file))throw new Error('Required project file is missing: '+file);
const html=readFileSync('index.html','utf8');
for(const marker of ['Generate preview','generativelanguage.googleapis.com','/api/news','/api/images','/api/article','/api/image-proxy','/api/automation','/api/automation-image','width="1080" height="1080"','image_paragraph','captionBox','remoteToken','publishFacebook','facebook-settings','publish-latest'])if(!html.toLowerCase().includes(marker.toLowerCase()))throw new Error('Missing expected feature marker: '+marker);
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
if(!scripts.length)throw new Error('No inline application script found.');
for(const script of scripts){const r=spawnSync(process.execPath,['--check','--input-type=commonjs'],{input:script,encoding:'utf8'});if(r.status!==0)throw new Error('Inline script syntax error:\n'+r.stderr);}
for(const file of readdirSync('netlify/functions').filter(f=>f.endsWith('.mjs'))){const r=spawnSync(process.execPath,['--check',join('netlify/functions',file)],{encoding:'utf8'});if(r.status!==0)throw new Error('Syntax error in '+file+':\n'+r.stderr);}
mkdirSync('dist',{recursive:true});copyFileSync('index.html','dist/index.html');copyFileSync('netlify/functions/lib/news-generation-core.mjs','dist/news-generation-core.mjs');
const coreCheck=spawnSync(process.execPath,['--check','netlify/functions/lib/news-generation-core.mjs'],{encoding:'utf8'});if(coreCheck.status!==0)throw new Error('Syntax error in shared core:\n'+coreCheck.stderr);
console.log('REMOTE build checks passed: required files, shared core and JavaScript syntax are valid; dist assets are ready for Netlify.');
