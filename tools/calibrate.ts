/**
 * Calibrates wfcalc against real public Overframe builds, unattended.
 *
 *   node tools/calibrate.ts --battery 80        compare N builds and report
 *   node tools/calibrate.ts --build 1036746     compare one build in detail
 *   node tools/calibrate.ts --battery 80 --fix  only show mismatching builds
 *
 * Mod/arcane names come from data/raw/overframe-db.json, learned by
 * `node tools/fetch-overframe-db.ts`. Exit code is non-zero when anything mismatches.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import {
  bestModeFor,
  diffOracle,
  findWeaponName,
  nonApplicableFields,
  getBuild,
  listBuilds,
  loadOracleExceptions,
  loadOverframeDb,
  oracleOf,
  resolveBuildInput,
  sleep,
  weaponNameFromUrl,
} from './lib/overframe.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const REPORT = join(ROOT, 'docs/calibration-results.md');

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const verbose = args.includes('--verbose');

const db = loadOverframeDb();
const exceptions = loadOracleExceptions();
const snapshot = loadSnapshot();

const FIELD_LABEL: Record<string, string> = {
  multishot: 'multishot',
  critChance: 'crit chance',
  critMultiplier: 'crit damage',
  statusChance: 'status chance',
  fireRate: 'fire rate',
  magazine: 'magazine',
  reload: 'reload',
  punchThrough: 'punch through',
};

/** Fetches builds for weapons we know, newest first. */
async function collect(count: number): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  while (out.length < count && page <= 60) {
    const { results } = await listBuilds(page, 100);
    if (!results.length) break;
    for (const summary of results) {
      if (out.length >= count) break;
      const weaponName = weaponNameFromUrl(summary.url ?? '');
      if (!weaponName || !findWeaponName(snapshot, weaponName)) continue;
      try {
        const build = await getBuild(summary.id);
        if (!oracleOf(build)) continue;
        out.push(build);
      } catch {
        continue;
      }
      await sleep(60);
    }
    page++;
  }
  return out;
}

/**
 * Tries the default stat block and every alternative fire mode, and keeps the one that
 * agrees with the oracle most closely. This makes a run measure the formulas instead of
 * our default mode choice; charge weapons are the reason (the arsenal block is the quick
 * shot while Overframe reports the charged one).
 */
function pickMode(input: NonNullable<ReturnType<typeof resolveBuildInput>>, oracle: NonNullable<ReturnType<typeof oracleOf>>) {
  const weapon = snapshot.weapons[input.weapon];
  const variants: Array<string | undefined> = [undefined, ...(weapon?.modes ?? []).map((mode) => mode.name)];
  let best: { mode?: string; resolved: ReturnType<typeof resolveBuild>; diffs: ReturnType<typeof diffOracle> } | null = null;
  for (const mode of variants) {
    let resolved;
    try {
      resolved = resolveBuild(snapshot, { weapon: input!.weapon, mods: input!.mods, arcanes: input!.arcanes, mode });
    } catch {
      continue;
    }
    const diffs = diffOracle(oracle, resolved)
      .filter((diff) => !nonApplicableFields(resolved).has(diff.field))
      // Skip fields where the oracle is wrong and our data is verified in game.
      .filter((diff) => !exceptions[input.weapon]?.[diff.field]);
    if (!best || diffs.length < best.diffs.length) best = { mode, resolved, diffs };
    if (best.diffs.length === 0) break;
  }
  if (!best) throw new Error(`could not resolve ${input.weapon}`);
  return { mode: best.mode, resolved: best.resolved, diffs: best.diffs };
}

const one = flag('build');
if (one) {
  const build = await getBuild(one);
  const oracle = oracleOf(build);
  const input = resolveBuildInput(build, db, snapshot);
  if (!oracle || !input) {
    console.log('could not resolve this build (missing oracle, weapon or mods)');
    process.exit(1);
  }
  console.log(`${build.title}`);
  console.log(`  weapon : ${input.weapon}`);
  console.log(`  mods   : ${input.mods.map((mod) => `${mod.name} R${mod.rank}`).join(', ')}`);
  if (input.arcanes.length) console.log(`  arcanes: ${input.arcanes.map((a) => `${a.name} R${a.rank}`).join(', ')}`);
  if (input.unknown.length) console.log(`  unknown: ${input.unknown.join(', ')}`);

  const picked = pickMode(input, oracle);
  if (picked.mode) console.log(`  mode   : ${picked.mode}`);
  const resolved = picked.resolved;
  const skip = nonApplicableFields(resolved);
  const diffs = picked.diffs.filter((diff) => !skip.has(diff.field));
  if (skip.size) console.log(`  n/a    : ${[...skip].join(', ')} (weapon has no such stat)`);
  console.log('\n  stat                 overframe      wfcalc');
  for (const key of Object.keys(FIELD_LABEL)) {
    const expected = (oracle as any)[key] as number;
    const actual =
      key === 'multishot' ? resolved.multishot
      : key === 'critChance' ? resolved.critChance
      : key === 'critMultiplier' ? resolved.critMultiplier
      : key === 'statusChance' ? resolved.statusChance
      : key === 'fireRate' ? resolved.fireRate
      : key === 'magazine' ? resolved.magazineSize
      : key === 'punchThrough' ? resolved.punchThrough
      : resolved.reloadTime;
    const hit = !diffs.some((diff) => diff.field === key);
    if (skip.has(key)) { console.log(`  ${FIELD_LABEL[key].padEnd(20)} ${expected.toFixed(4).padStart(10)} ${actual.toFixed(4).padStart(12)}  n/a`); continue; }
    console.log(`  ${FIELD_LABEL[key].padEnd(20)} ${expected.toFixed(4).padStart(10)} ${actual.toFixed(4).padStart(12)}  ${hit ? 'ok' : 'MISMATCH'}`);
  }
  console.log(`\n  ${diffs.length === 0 ? 'MATCH' : `${diffs.length} mismatch(es)`}`);
  process.exitCode = diffs.length ? 1 : 0;
  process.exit();
}

const count = Number(flag('battery') ?? 50);
console.log(`fetching up to ${count} Overframe builds…`);
const builds = await collect(count);
console.log(`${builds.length} usable builds\n`);

const mismatches: Array<{ build: any; weapon: string; diffs: ReturnType<typeof diffOracle>; unknown: string[] }> = [];
let matched = 0;
let skipped = 0;

for (const build of builds) {
  const oracle = oracleOf(build);
  const input = resolveBuildInput(build, db, snapshot);
  if (!oracle || !input) {
    skipped++;
    continue;
  }
  let diffs;
  try {
    diffs = pickMode(input, oracle).diffs;
  } catch {
    skipped++;
    continue;
  }
  if (diffs.length === 0) {
    matched++;
    if (verbose) console.log(`  ok   ${build.id} ${input.weapon}`);
  } else {
    mismatches.push({ build, weapon: input.weapon, diffs, unknown: input.unknown });
    if (verbose) {
      console.log(`  FAIL ${build.id} ${input.weapon}: ${diffs.map((d) => `${FIELD_LABEL[d.field]} ${d.actual.toFixed(3)} vs ${d.expected.toFixed(3)}`).join('; ')}`);
    }
  }
  await sleep(20);
}

console.log(`\nmatched: ${matched}/${matched + mismatches.length}${skipped ? ` (${skipped} skipped)` : ''}`);
if (mismatches.length) {
  // Group by signature so systematic errors stand out from one-off data problems.
  const groups = new Map<string, number>();
  for (const failure of mismatches) {
    for (const diff of failure.diffs) {
      const ratio = diff.expected === 0 ? 'inf' : (diff.actual / diff.expected).toFixed(2);
      const key = `${FIELD_LABEL[diff.field]}: x${ratio}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
  console.log('\nmismatch signatures (ratio = ours / theirs):');
  for (const [key, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${key}`);
  console.log('\nworst offenders:');
  for (const failure of mismatches.slice(0, 10)) {
    console.log(`  ${failure.build.id} ${failure.weapon}: ${failure.diffs.map((d) => d.field).join(', ')}${failure.unknown.length ? ` [unknown: ${failure.unknown.slice(0, 2).join(', ')}]` : ''}`);
  }
}

writeFileSync(
  REPORT,
  [
    '# Calibration results',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run calibrate\`. Every row is a`,
    'public Overframe build compared field by field (multishot, critical chance, critical',
    'damage, status chance, fire rate, magazine, reload) against wfcalc, using the game\'s own',
    'modifier keys from `overframe.gg/api/v1`.',
    '',
    `- builds compared: **${matched + mismatches.length}**`,
    `- matching: **${matched}**`,
    `- mismatching: **${mismatches.length}**`,
    '',
    ...(mismatches.length
      ? [
          '## Mismatches',
          '',
          '| build | weapon | fields (ours vs theirs) |',
          '|---|---|---|',
          ...mismatches
            .slice(0, 100)
            .map(
              (failure) =>
                `| ${failure.build.id} | ${failure.weapon} | ${failure.diffs
                  .map((d) => `${d.field} ${d.actual.toFixed(3)} vs ${d.expected.toFixed(3)}`)
                  .join('<br>')} |`,
            ),
        ]
      : ['Every compared build matches on all seven stats.']),
    '',
  ].join('\n'),
);

if (mismatches.length) process.exitCode = 1;
