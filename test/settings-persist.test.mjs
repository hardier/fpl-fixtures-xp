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

// One storage shared by the popup and the page, as chrome.storage.local is.
const store = {};
function fakeStorage() {
  return {
    local: {
      get: (d, cb) => { const o = {};
        for (const k of Object.keys(d || {})) o[k] = store[k] !== undefined ? store[k] : d[k];
        cb(o); },
      set: (o, cb) => { Object.assign(store, JSON.parse(JSON.stringify(o))); if (cb) cb(); }
    },
    onChanged: { addListener: () => {} }
  };
}

// --- step 1: open the popup and untick the pitch xP badge
const popup = new JSDOM(readFileSync(root + 'popup.html', 'utf8'),
  { runScripts:'outside-only', pretendToBeVisual:true });
const pw = popup.window;
pw.console = { ...console, log: () => {}, debug: () => {}, warn: () => {} };
pw.chrome = { runtime: { lastError: undefined,
  sendMessage: (m, cb) => { if (m.type === 'core') return cb({ ok:true, data:{ bootstrap, fixtures } });
                            cb({ ok:true, data:{ entry:{}, picks:null } }); } },
  storage: fakeStorage() };
for (const fl of ['xp.js','popup.js']) pw.eval(readFileSync(root + fl, 'utf8'));
pw.document.dispatchEvent(new pw.Event('DOMContentLoaded'));
await new Promise(r => setTimeout(r, 200));

const box = pw.document.getElementById('opt-xp');
console.log('pitch xP checkbox starts:', box.checked);
box.checked = false;
box.dispatchEvent(new pw.Event('change'));
await new Promise(r => setTimeout(r, 100));
console.log('stored settings after untick:', JSON.stringify(store.settings));

// --- step 2: a fresh page load reads that same storage
async function loadPage() {
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div class="Pitch"><div class="Card">` +
    `<div class="Kit" style="background-image:url(/shirt_1.webp)"></div>` +
    `<div class="Nm">${p.web_name}</div><div class="Op">${opp}</div></div></div></body>`,
    { runScripts:'outside-only', pretendToBeVisual:true, url:'https://fantasy.premierleague.com/my-team' });
  const w = dom.window;
  w.console = { ...console, log: () => {}, debug: () => {}, warn: (...a) => console.log('WARN', ...a) };
  w.fetch = () => Promise.resolve({ ok:true, json:()=>Promise.resolve({ player:{ entry: 4791912 } }) });
  w.chrome = { runtime:{ lastError:undefined, sendMessage:(m,cb)=>cb({ok:true,data:{bootstrap,fixtures}}) },
               storage: fakeStorage() };
  w.Element.prototype.getBoundingClientRect = function () {
    const c = this.className || '';
    if (/\bCard\b/.test(c)) return { top:100, bottom:285, height:185, left:0, right:120, width:120 };
    if (/\bPitch\b/.test(c)) return { top:100, bottom:400, height:300, left:0, right:500, width:500 };
    if (/\bNm\b/.test(c)) return { top:250, bottom:270, height:20, left:0, right:120, width:120 };
    if (/fplxp-bar/.test(c)) return { top:288, bottom:301, height:13, left:0, right:120, width:120 };
    return { top:0, bottom:0, height:0, left:0, right:0, width:0 };
  };
  for (const fl of ['xp.js','content.js']) w.eval(readFileSync(root + fl, 'utf8'));
  await new Promise(r => setTimeout(r, 400));
  return w.document;
}

const d1 = await loadPage();
console.log('\nafter refresh: badges %d (want 0), chips %s (want present)',
  d1.querySelectorAll('.fplxp-badge').length,
  d1.querySelectorAll('.fplxp-chip').length ? 'yes' : 'no');
console.log('storage now:', JSON.stringify(store.settings));

// --- step 3: load again, in case the first load rewrote the setting
const d2 = await loadPage();
console.log('\nsecond refresh: badges %d (want 0)', d2.querySelectorAll('.fplxp-badge').length);
console.log('storage now:', JSON.stringify(store.settings));

const ok = d1.querySelectorAll('.fplxp-badge').length === 0 &&
           d2.querySelectorAll('.fplxp-badge').length === 0 &&
           store.settings.showXp === false;
console.log('\n' + (ok ? 'PASS' : 'FAIL — the unticked setting did not survive'));
process.exit(ok ? 0 : 1);
