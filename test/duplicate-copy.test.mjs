import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const root = new URL('../src/', import.meta.url).pathname;
const bootstrap = JSON.parse(readFileSync(new URL('bootstrap.json', import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', import.meta.url)));
const self = {}; new Function('self', readFileSync(root + 'xp.js', 'utf8'))(self);
const ctx0 = self.FPLXP.buildContext(bootstrap, fixtures);
const short = id => bootstrap.teams.find(t => t.id === id).short_name;
const p = bootstrap.elements.find(e => e.web_name === 'Haaland');
const f = (ctx0.byTeamGw[p.team] || {})[ctx0.targetGw][0];
const opp = `${short(f.opponentId)} (${f.isHome?'H':'A'})`;

// Two installed copies of the extension on one page. The first has the badge on,
// the second has it off. The second must notice the page is already annotated by
// someone else and say so, rather than looking broken.
const dom = new JSDOM(
  `<!DOCTYPE html><body><div class="Pitch"><div class="Card">` +
  `<div class="Kit" style="background-image:url(/shirt_1.webp)"></div>` +
  `<div class="Nm">${p.web_name}</div><div class="Op">${opp}</div></div></div></body>`,
  { runScripts:'outside-only', pretendToBeVisual:true, url:'https://fantasy.premierleague.com/my-team' });
const w = dom.window;
const warnings = [];
w.console = { ...console, log: () => {}, debug: () => {}, warn: (...a) => warnings.push(a.join(' ')) };
w.fetch = () => Promise.resolve({ ok:true, json:()=>Promise.resolve({ player:null }) });
w.Element.prototype.getBoundingClientRect = function () {
  const c = this.className || '';
  if (/\bCard\b/.test(c)) return { top:100, bottom:285, height:185, left:0, right:120, width:120 };
  if (/\bPitch\b/.test(c)) return { top:100, bottom:400, height:300, left:0, right:500, width:500 };
  if (/\bNm\b/.test(c)) return { top:250, bottom:270, height:20, left:0, right:120, width:120 };
  if (/fplxp-bar/.test(c)) return { top:288, bottom:301, height:13, left:0, right:120, width:120 };
  return { top:0, bottom:0, height:0, left:0, right:0, width:0 };
};

const src = ['xp.js','content.js'].map(fl => readFileSync(root + fl, 'utf8'));
function install(settings) {
  w.chrome = { runtime:{ lastError:undefined, sendMessage:(m,cb)=>cb({ok:true,data:{bootstrap,fixtures}}) },
    storage:{ local:{ get:(d,cb)=>{const o={};for(const k of Object.keys(d||{}))o[k]=k==='settings'?settings:d[k];cb(o);}, set:()=>{} },
              onChanged:{ addListener:()=>{} } } };
  src.forEach(s => w.eval(s));
}

// Copy one: badge on.
install({ showXp:true, showFixtures:true, showXpList:true, showFixturesList:true, fixtureCount:5 });
await new Promise(r=>setTimeout(r,300));
const afterFirst = w.document.querySelectorAll('.fplxp-badge').length;

// Copy two: badge off. It cannot undo copy one's work, but it must not be silent.
install({ showXp:false, showFixtures:true, showXpList:true, showFixturesList:true, fixtureCount:5 });
await new Promise(r=>setTimeout(r,300));
const afterSecond = w.document.querySelectorAll('.fplxp-badge').length;

console.log('badges after copy 1 (badge on):', afterFirst);
console.log('badges after copy 2 (badge off):', afterSecond, '- copy 2 cannot remove copy 1\'s badge');
const warned = warnings.filter(m => /another copy/.test(m));
console.log('duplicate-copy warning emitted:', warned.length ? 'yes' : 'NO');
if (warned.length) console.log('  ->', warned[0].slice(0, 120) + '…');
const ok = afterFirst === 1 && warned.length === 1;
console.log('\n' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
