// Post-process ?bench results into per-feature GPU-cost statistics.
// Usage: node scripts/bench-analyze.mjs baked/bench-pc.json [baked/bench-quest-gpu.json ...]
//
// Input schema (baked/bench-<name>.json): { meta, results:[{round,key,group,
// cell,name,rung,ms,n}] }. PC results carry ms directly (timer query); Quest
// results get ms filled by scripts/bench-quest.mjs from the ovrgpuprofiler
// render-stage capture, so this analyzer treats both platforms identically.
//
// The rung ladder adds one feature at a time, so each feature's cost is the
// PAIRED per-pose delta between adjacent rungs (paired => the fixed scene cost
// cancels). We report mean +- 95% CI across all (round x pose) instances, plus
// per-cell breakdown and absolute per-rung frame time vs the VR budgets.
import { readFileSync, writeFileSync } from 'fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/bench-analyze.mjs <bench-*.json> [more.json ...]');
  process.exit(1);
}

const RUNGS = ['off', 'pccm', 'portal', 'ao-tap', 'ao-regen', 'ao', 'full'];
// [label, fromRung, toRung] : cost = median(to) - median(from), paired per pose.
// Headline comparisons first (the write-up's questions), then the per-feature
// breakdown - each breakdown rung adds exactly one feature over the previous.
// Older result files missing the ao-tap/ao-regen rungs simply skip those rows.
const FEATURES = [
  // -- headline comparisons --
  ['PORTAL reflections vs none        (portal - off)', 'off', 'portal'],
  ['PORTAL reflections vs zero-hop IBL (portal - pccm)', 'pccm', 'portal'],
  ['ALL VFX vs none                   (full - off)', 'off', 'full'],
  // -- per-feature breakdown (one feature per rung) --
  ['  reflections: zero-hop PCCM IBL  (pccm - off)', 'off', 'pccm'],
  ['  + portal traversal              (portal - pccm)', 'pccm', 'portal'],
  ['  + contact-AO tap                (ao-tap - portal)', 'portal', 'ao-tap'],
  ['  + dyn-occ layer regen (moving)  (ao-regen - ao-tap)', 'ao-tap', 'ao-regen'],
  ['  + reflection-ray occlusion      (ao - ao-regen)', 'ao-regen', 'ao'],
  ['  + dynamic soft shadows          (full - ao)', 'ao', 'full'],
];
const BUDGET = { '90Hz': 11.11, '72Hz': 13.89 };

const stats = a => {
  const n = a.length;
  if (!n) return { n: 0 };
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const v = n > 1 ? a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(v);
  const s = [...a].sort((x, y) => x - y);
  return { n, mean, sd, ci95: 1.96 * sd / Math.sqrt(n), med: s[n >> 1], min: s[0], max: s[n - 1] };
};
const f3 = x => (x >= 0 ? ' ' : '') + x.toFixed(3);

const summary = [];
for (const file of files) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const withMs = d.results.filter(r => r.ms != null);
  console.log(`\n${'='.repeat(72)}\n${file}   [${d.meta.platform}]  seed=${d.meta.seed}  rounds=${d.meta.rounds}  samples=${withMs.length}/${d.results.length}`);
  if (!withMs.length) { console.log('  (no ms yet - Quest results need bench-quest.mjs to fill from ovrgpuprofiler)'); continue; }

  const groups = {};
  for (const r of withMs) (groups[r.group] = groups[r.group] || []).push(r);

  for (const gk of Object.keys(groups)) {
    // poses[round|key] = { rung: ms, ..., __meta }
    const poses = {};
    for (const r of groups[gk]) {
      const pk = r.round + '|' + r.key;
      poses[pk] = poses[pk] || { __meta: r };
      poses[pk][r.rung] = r.ms;
    }
    const P = Object.values(poses);
    console.log(`\n  --- group "${gk}"  (${P.length} pose-instances across rounds) ---`);
    console.log('  absolute frame GPU ms per rung:');
    for (const rung of RUNGS) {
      const st = stats(P.map(p => p[rung]).filter(x => x != null));
      if (st.n) console.log(`    ${rung.padEnd(7)} median ${f3(st.med)}  mean ${f3(st.mean)} +-${st.ci95.toFixed(3)}  [${f3(st.min)},${f3(st.max)}]`);
    }
    console.log('  per-feature marginal cost (paired per-pose delta):');
    for (const [label, aR, bR] of FEATURES) {
      const deltas = P.filter(p => p[aR] != null && p[bR] != null).map(p => p[bR] - p[aR]);
      const st = stats(deltas);
      if (st.n) {
        console.log(`    ${label.padEnd(52)} ${f3(st.mean)} ms  95%CI +-${st.ci95.toFixed(3)}  range [${f3(st.min)},${f3(st.max)}]  n=${st.n}`);
        summary.push({ file, platform: d.meta.platform, group: gk, feature: label, meanMs: st.mean, ci95: st.ci95, medMs: st.med, min: st.min, max: st.max, n: st.n });
      }
    }
    // full-config frame time vs VR budgets (worst group is the ceiling that matters)
    const fullAbs = stats(P.map(p => p.full).filter(x => x != null));
    if (fullAbs.n) {
      const b = Object.entries(BUDGET).map(([k, v]) => `${k}:${(100 * fullAbs.med / v).toFixed(0)}%`).join(' ');
      console.log(`  full-config median ${fullAbs.med.toFixed(3)}ms  = frame budget ${b}`);
    }
    if (gk === 'cell') {
      console.log('  per-cell portal-traversal cost (portal-pccm, mean over rounds):');
      const byCell = {};
      for (const p of P) if (p.pccm != null && p.portal != null) (byCell[p.__meta.name] = byCell[p.__meta.name] || []).push(p.portal - p.pccm);
      for (const [name, a] of Object.entries(byCell).sort((x, y) => stats(y[1]).mean - stats(x[1]).mean)) {
        console.log(`    ${name.padEnd(12)} ${f3(stats(a).mean)} ms`);
      }
    }
  }
}

// machine-readable summary for the write-up / plotting
if (summary.length) {
  writeFileSync('baked/bench-summary.json', JSON.stringify(summary, null, 2));
  const csv = 'file,platform,group,feature,meanMs,ci95,medMs,min,max,n\n' +
    summary.map(s => [s.file, s.platform, s.group, '"' + s.feature + '"', s.meanMs, s.ci95, s.medMs, s.min, s.max, s.n].join(',')).join('\n');
  writeFileSync('baked/bench-summary.csv', csv);
  console.log('\nwrote baked/bench-summary.json + .csv');
}
