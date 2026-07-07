// Automated precise GPU profiling on Quest 3 - NO headset required.
//
// The flat Quest Browser panel is only 1280x670, but the WebGL *canvas* can be
// sized to eye-buffer resolution (2064x2208, MSAA4) via ?benchw/&benchh - the
// Adreno then does full-res fill that ovrgpuprofiler render-stage traces capture
// (Surface ... 2064x2208 MSAA4 ... Render : X.XXms). This driver launches that
// flat high-res page in driver-paced mode (?bench&benchremote), steps every
// (pose,rung) itself, and reads the scene Render stage per config. Rungs are
// cycled tightly per pose so slow thermal drift is common-mode and cancels in
// the paired delta; GPU frequency is sampled as a thermal guard.
//
// Run: node serve.mjs 8123   (one terminal)
//      node scripts/bench-quest.mjs [--set both|cells|worst] [--cycles 3]
// Put the headset on the desk (proximity is simulated so it won't sleep).
// Output: baked/bench-quest-gpu.json  ->  node scripts/bench-analyze.mjs it
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';

const ADB = process.env.ADB || 'C:/Users/aticp/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const PKG = 'com.oculus.browser';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SET = arg('set', 'both'), CYCLES = +arg('cycles', '3');
const W = arg('w', '2064'), H = arg('h', '2208');
const SETTLE_MS = +arg('settle', '900');   // after a rung swap: recompile + steady state
// ao-tap/ao-regen decompose the old single "ao" (uOccOn) delta into the tap,
// the layer-regen pass, and reflection occlusion - see the RUNGS note in main.js
const RUNGS = ['off', 'pccm', 'portal', 'ao-tap', 'ao-regen', 'ao', 'full'];
const CMD = 'baked/bench-cmd.json', STATE = 'baked/bench-state.json', MANIFEST = 'baked/bench-manifest.json';

const sh = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
const shq = s => execFileSync(ADB, ['shell', s], { encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

let seq = 0;
async function command(poseIdx, rung) {                  // set (pose,rung), wait for the page to apply it
  seq++;
  writeFileSync(CMD, JSON.stringify({ seq, poseIdx, rung }));
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await sleep(100);
    try { const s = JSON.parse(readFileSync(STATE, 'utf8')); if (s.seq === seq) return s; } catch {}
  }
  return null;
}

// render-stage trace -> median scene Render ms across the eye-res MSAA4 surfaces
// (isolates our fill from compositor Preempt). Returns { render, total, res, n }.
function traceScene() {
  let out; try { out = shq('ovrgpuprofiler -t1'); } catch (e) { return null; }
  const lines = out.split('\n');
  let inBrowser = false; const render = [], total = []; let res = '';
  for (const ln of lines) {
    if (ln.startsWith('Process ')) { inBrowser = ln.includes(PKG); continue; }
    if (!inBrowser) continue;
    const dim = ln.match(/Surface\s+\d+\s*\|\s*(\d+)\s*x\s*(\d+)\s*\|/);
    if (!dim) continue;
    const w = +dim[1], h = +dim[2];
    if (w * h < 1_000_000 || !/MSAA 4/.test(ln)) continue;  // the scene eye surface only
    const tot = ln.match(/\|\s*([\d.]+)\s*ms\s*\|/);
    const rnd = ln.match(/Render\s*:\s*([\d.]+)\s*ms/);
    if (rnd) { render.push(+rnd[1]); res = `${w}x${h}`; if (tot) total.push(+tot[1]); }
  }
  if (!render.length) return null;
  return { render: median(render), total: median(total), res, n: render.length };
}

function gpuFreqMHz() {
  // -r streams every second forever; a PC-side timeout captures the first
  // sample from the adb pipe, then pkill clears the orphaned device process
  let out = '';
  try { out = execFileSync(ADB, ['shell', 'ovrgpuprofiler -r'], { encoding: 'utf8', timeout: 2500 }); }
  catch (e) { out = ((e.stdout || '') + ''); }
  try { execFileSync(ADB, ['shell', 'pkill -f ovrgpuprofiler'], { timeout: 3000 }); } catch {}
  const m = out.match(/GPU Frequency\s*:\s*([\d.]+)/);
  return m ? Math.round(+m[1] / 1e6) : 0;
}

async function main() {
  console.log(`setup: reverse, force-stop, detailed mode, launch flat high-res paced (${W}x${H}) ...`);
  for (const f of [CMD, STATE, MANIFEST]) if (existsSync(f)) unlinkSync(f);
  sh('reverse', 'tcp:8123', 'tcp:8123');
  shq(`am force-stop ${PKG}`);
  shq(`ovrgpuprofiler -e ${PKG}`);
  shq('am broadcast -a com.oculus.vrpowermanager.prox_close');
  const url = `http://localhost:8123/?bench=1&benchremote=1&benchset=${SET}&benchw=${W}&benchh=${H}`;
  shq(`am start -a android.intent.action.VIEW -d '${url}' ${PKG}`);

  console.log('waiting for page (baked load + compile + manifest) ...');
  let manifest = null;
  for (let i = 0; i < 60; i++) { await sleep(1000); try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')); break; } catch {} }
  if (!manifest) { console.error('no manifest - page did not reach paced mode. Is serve.mjs on :8123?'); return cleanup(); }
  const poses = manifest.poses;
  console.log(`ready: ${poses.length} poses @ ${manifest.renderW}x${manifest.renderH}, ${CYCLES} cycles x ${RUNGS.length} rungs`);
  console.log(`est ~${Math.round(poses.length * CYCLES * RUNGS.length * (SETTLE_MS + 1300) / 60000)} min\n`);

  const results = [];
  const t0 = Date.now();
  for (let pi = 0; pi < poses.length; pi++) {
    const p = poses[pi];
    const f0 = gpuFreqMHz();
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const row = [];
      for (const rung of RUNGS) {
        const st = await command(pi, rung);
        if (!st) { row.push(`${rung}:noack`); continue; }
        await sleep(SETTLE_MS);
        const t = traceScene();
        if (t) { results.push({ round: cycle, key: p.key, group: p.group, cell: p.cell, name: p.name, rung, ms: t.render, totalMs: t.total, res: t.res, n: t.n }); row.push(`${rung}:${t.render.toFixed(2)}`); }
        else row.push(`${rung}:--`);
      }
      console.log(`  ${p.key} c${cycle}  ${row.join('  ')}`);
    }
    const f1 = gpuFreqMHz();
    // paired-delta readout for this pose
    const byR = {}; for (const r of results.filter(r => r.key === p.key)) (byR[r.rung] = byR[r.rung] || []).push(r.ms);
    const m = r => median(byR[r] || [0]);
    console.log(`  = ${p.name}: reflections ${(m('pccm') - m('off')).toFixed(2)}  traversal ${(m('portal') - m('pccm')).toFixed(2)}  ` +
      `tap ${(m('ao-tap') - m('portal')).toFixed(2)}  regen ${(m('ao-regen') - m('ao-tap')).toFixed(2)}  ` +
      `reflOcc ${(m('ao') - m('ao-regen')).toFixed(2)}  shadows ${(m('full') - m('ao')).toFixed(2)}  full ${m('full').toFixed(2)}ms  [gpu ${f0}->${f1}MHz]`);
    if (Math.abs(f1 - f0) > 40) console.warn(`  ! GPU freq drifted ${f0}->${f1} MHz (thermal) - pausing 20s to cool`), await sleep(20000);
    save(results, t0);
  }
  writeFileSync(CMD, JSON.stringify({ seq: ++seq, done: true }));
  console.log(`\ndone in ${Math.round((Date.now() - t0) / 60000)} min`);
  cleanup();
}

function save(results, t0) {
  writeFileSync('baked/bench-quest-gpu.json', JSON.stringify({
    meta: { platform: 'quest-flat-eyeres-ovrgpuprofiler', renderRes: `${W}x${H}`, cycles: CYCLES,
      metric: 'scene Render stage (ms), median over ~1s of frames', device: '2G0YC1ZF8K089S', wallMs: Date.now() - t0,
      rungs: RUNGS.map(name => ({ name })) },
    results,
  }, null, 2));
}

function cleanup() {
  console.log('cleanup: disable detailed mode, restore proximity');
  try { shq('ovrgpuprofiler -d'); } catch {}
  try { shq('am broadcast -a com.oculus.vrpowermanager.prox_open'); } catch {}
  console.log('analyze:  node scripts/bench-analyze.mjs baked/bench-quest-gpu.json');
}

main().catch(e => { console.error(e); cleanup(); });
