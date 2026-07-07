// One-command PC GPU-profile run: launch a real-GPU Chrome window on the
// ?bench URL, wait for the self-uploaded result, then analyze.
// Usage: node scripts/bench-pc.mjs [--set both|cells|worst] [--rounds N]
//        [--frames N] [--warm N] [--port 8123] [--out pc]
// Requires the dev server already running: node serve.mjs 8123
import { spawn } from 'child_process';
import { existsSync, unlinkSync, statSync } from 'fs';
import { execFileSync } from 'child_process';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = process.env.CHROME ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe',
   'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!CHROME) { console.error('chrome.exe not found - set CHROME=path'); process.exit(1); }

const port = arg('port', '8123');
const out = arg('out', 'pc');
const qsObj = {
  bench: '1', benchset: arg('set', 'both'), benchrounds: arg('cycles', '6'),
  benchframes: arg('k', '8'), benchwarm: arg('warm', '10'),
  benchw: arg('w', '2560'), benchh: arg('h', '1440'), benchout: out,
};
const dyndirty = arg('dyndirty', null); // A/B lever: pass 0 to force full regen
if (dyndirty !== null) qsObj.dyndirty = dyndirty;
const qs = new URLSearchParams(qsObj).toString();
const url = `http://127.0.0.1:${port}/?${qs}`;
const resultFile = `baked/bench-${out}.json`;
const profile = process.env.TEMP + '/pgi-bench-chrome';

if (existsSync(resultFile)) unlinkSync(resultFile);
console.log('launching Chrome (real GPU, foreground - do not minimize) ...\n ', url);
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  // background tabs throttle rAF to 1/s and stop timer queries; keep it live
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--window-size=1300,800', url,
], { detached: true, stdio: 'ignore' });

const t0 = Date.now();
const timeoutMin = +arg('timeout', '30');
const poll = setInterval(() => {
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (existsSync(resultFile) && statSync(resultFile).size > 100) {
    clearInterval(poll);
    console.log(`\nresult after ${mins} min -> ${resultFile}`);
    try { chrome.kill(); } catch {}
    try { process.kill(-chrome.pid); } catch {}
    console.log('\n' + '='.repeat(72));
    try { console.log(execFileSync('node', ['scripts/bench-analyze.mjs', resultFile], { encoding: 'utf8' })); }
    catch (e) { console.error(e.message); }
    process.exit(0);
  }
  if ((Date.now() - t0) > timeoutMin * 60000) {
    clearInterval(poll);
    console.error(`timeout after ${timeoutMin} min - no ${resultFile}. Check the Chrome window's on-page error log.`);
    try { chrome.kill(); } catch {}
    process.exit(1);
  }
  process.stdout.write(`\r  waiting ${mins} min ...`);
}, 3000);
