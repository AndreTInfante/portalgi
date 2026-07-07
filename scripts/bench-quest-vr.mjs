// Precise data from a REAL in-VR session on Quest 3 (true stereo eye buffers,
// foveation, reprojection - the actual shipped frame cost). Complements the
// automated flat run (scripts/bench-quest.mjs): flat gives clean per-feature
// deltas across all 14 cells at eye resolution; this gives the real in-headset
// numbers at the cells you physically visit.
//
// The camera pose is head-driven (WebXR owns it), so you walk to a cell and
// hold still while the driver cycles the measurement RUNG (via ?benchremote)
// and runs an ovrgpuprofiler render-stage trace of the eye buffer per rung.
// Rungs are cycled tightly so slow thermal drift cancels in the paired delta.
//
// Run: node serve.mjs 8123    (one terminal)
//      node scripts/bench-quest-vr.mjs [--cycles 4]
//   1) Put the headset ON. In the Browser panel, click "Enter VR".
//   2) Walk to a cell, hold still, press Enter here, type the cell name.
//   3) Repeat per cell. Type "done" to finish.
// Output: baked/bench-quest-vr.json  ->  node scripts/bench-analyze.mjs it
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';

const ADB = process.env.ADB || 'C:/Users/aticp/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const PKG = 'com.oculus.browser';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CYCLES = +arg('cycles', '4');
const SETTLE_MS = +arg('settle', '900');
// ao-tap/ao-regen decompose the old single "ao" (uOccOn) delta into the tap,
// the layer-regen pass, and reflection occlusion - see the RUNGS note in main.js
const RUNGS = ['off', 'pccm', 'portal', 'ao-tap', 'ao-regen', 'ao', 'full'];
const CMD = 'baked/bench-cmd.json', STATE = 'baked/bench-state.json';

const sh = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
const shq = s => execFileSync(ADB, ['shell', s], { encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

let seq = 0;
async function setRung(rung) {
  seq++;
  writeFileSync(CMD, JSON.stringify({ seq, rung }));
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await sleep(100);
    try { const s = JSON.parse(readFileSync(STATE, 'utf8')); if (s.seq === seq) return s; } catch {}
  }
  return null;
}

// eye-buffer scene Render ms: largest MSAA4 browser surface(s), median over ~1s
function traceScene() {
  let out; try { out = shq('ovrgpuprofiler -t1'); } catch (e) { return null; }
  let inBrowser = false; const render = [], total = []; let res = '';
  for (const ln of out.split('\n')) {
    if (ln.startsWith('Process ')) { inBrowser = ln.includes(PKG); continue; }
    if (!inBrowser) continue;
    const dim = ln.match(/Surface\s+\d+\s*\|\s*(\d+)\s*x\s*(\d+)\s*\|/);
    if (!dim) continue;
    const w = +dim[1], h = +dim[2];
    if (w * h < 1_000_000 || !/MSAA 4/.test(ln)) continue;
    const rnd = ln.match(/Render\s*:\s*([\d.]+)\s*ms/), tot = ln.match(/\|\s*([\d.]+)\s*ms\s*\|/);
    if (rnd) { render.push(+rnd[1]); res = `${w}x${h}`; if (tot) total.push(+tot[1]); }
  }
  return render.length ? { render: median(render), total: median(total), res, n: render.length } : null;
}
function gpuFreqMHz() {
  let out = '';
  try { out = execFileSync(ADB, ['shell', 'ovrgpuprofiler -r'], { encoding: 'utf8', timeout: 2500 }); }
  catch (e) { out = ((e.stdout || '') + ''); }
  try { execFileSync(ADB, ['shell', 'pkill -f ovrgpuprofiler'], { timeout: 3000 }); } catch {}
  const m = out.match(/GPU Frequency\s*:\s*([\d.]+)/); return m ? Math.round(+m[1] / 1e6) : 0;
}

const results = [];
function save() {
  writeFileSync('baked/bench-quest-vr.json', JSON.stringify({
    meta: { platform: 'quest-invr-ovrgpuprofiler', cycles: CYCLES,
      metric: 'eye-buffer Render stage (ms), median over ~1s', device: '2G0YC1ZF8K089S',
      rungs: RUNGS.map(name => ({ name })) }, results }, null, 2));
}

async function measureView(label) {
  console.log(`\n== ${label}: ${CYCLES} cycles x ${RUNGS.length} rungs - HOLD STILL ==`);
  const f0 = gpuFreqMHz();
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const row = [];
    for (const rung of RUNGS) {
      const st = await setRung(rung);
      if (!st) { row.push(`${rung}:noack`); continue; }
      if (cycle === 0 && rung === 'off' && !st.xr) console.warn('  ! page reports NOT in VR - click "Enter VR" in the panel');
      await sleep(SETTLE_MS);
      const t = traceScene();
      if (t) { results.push({ round: cycle, key: label, group: 'invr', cell: st.cell, name: label, rung, ms: t.render, totalMs: t.total, res: t.res, n: t.n }); row.push(`${rung}:${t.render.toFixed(2)}`); }
      else row.push(`${rung}:--`);
    }
    console.log(`  c${cycle}  ${row.join('  ')}`);
  }
  const f1 = gpuFreqMHz();
  const byR = {}; for (const r of results.filter(r => r.key === label)) (byR[r.rung] = byR[r.rung] || []).push(r.ms);
  const m = r => median(byR[r] || [0]);
  const eyeRes = results.filter(r => r.key === label).pop();
  console.log(`  => eye ${eyeRes ? eyeRes.res : '?'}: reflections ${(m('pccm') - m('off')).toFixed(2)}  traversal ${(m('portal') - m('pccm')).toFixed(2)}  ` +
    `tap ${(m('ao-tap') - m('portal')).toFixed(2)}  regen ${(m('ao-regen') - m('ao-tap')).toFixed(2)}  ` +
    `reflOcc ${(m('ao') - m('ao-regen')).toFixed(2)}  shadows ${(m('full') - m('ao')).toFixed(2)}  |  full ${m('full').toFixed(2)}ms  [gpu ${f0}->${f1}MHz]`);
  if (Math.abs(f1 - f0) > 40) console.warn(`  ! GPU freq ${f0}->${f1} MHz (thermal) - rest a bit before the next view`);
}

async function main() {
  console.log('setup: reverse, force-stop, detailed mode, launch ?benchremote (interactive) ...');
  for (const f of [CMD, STATE]) if (existsSync(f)) unlinkSync(f);
  sh('reverse', 'tcp:8123', 'tcp:8123');
  shq(`am force-stop ${PKG}`);
  shq(`ovrgpuprofiler -e ${PKG}`);
  shq('am broadcast -a com.oculus.vrpowermanager.prox_close');
  shq(`am start -a android.intent.action.VIEW -d 'http://localhost:8123/?benchremote=1' ${PKG}`);
  console.log('launched. Put on the headset and click "Enter VR" in the Browser panel.');
  try {
    while (true) {
      const label = (await ask('\nWalk to a cell + hold still, then type its name (or "done"): ')).trim();
      if (!label || label.toLowerCase() === 'done') break;
      const st = await setRung('portal');
      if (!st) { console.warn('  page not responding - is ?benchremote loaded + Enter VR active? retry.'); continue; }
      await measureView(label);
      save();
    }
  } finally {
    console.log('\ncleanup: disable detailed mode, restore proximity');
    try { shq('ovrgpuprofiler -d'); } catch {}
    try { shq('am broadcast -a com.oculus.vrpowermanager.prox_open'); } catch {}
    save();
    console.log('wrote baked/bench-quest-vr.json  ->  node scripts/bench-analyze.mjs baked/bench-quest-vr.json');
    rl.close();
  }
}
main().catch(e => { console.error(e); rl.close(); });
