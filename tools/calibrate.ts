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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  type Oracle,
  type ResolvedBuildInput,
} from './lib/overframe.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const REPORT = join(ROOT, 'docs/calibration-results.md');
const FIXTURE = join(ROOT, 'data/calibration-builds.json');

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const verbose = args.includes('--verbose');
const refresh = args.includes('--refresh');

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
  const seen = new Set<number | string>();
  let page = 1;
  while (out.length < count && page <= 60) {
    const { results } = await listBuilds(page, 100);
    if (!results.length) break;
    for (const summary of results) {
      if (out.length >= count) break;
      if (seen.has(summary.id)) continue;
      const weaponName = weaponNameFromUrl(summary.url ?? '');
      if (!weaponName || !findWeaponName(snapshot, weaponName)) continue;
      try {
        const build = await getBuild(summary.id);
        if (!oracleOf(build)) continue;
        seen.add(summary.id);
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


interface PinnedBuild {
  id: number;
  title: string;
  weapon: string;
  mods: Array<{ name: string; rank: number }>;
  arcanes: Array<{ name: string; rank: number }>;
  oracle: Oracle;
}

interface CalibrationFixture {
  source: string;
  generatedAt: string;
  builds: PinnedBuild[];
}

function readFixture(): CalibrationFixture | null {
  if (!existsSync(FIXTURE)) return null;
  try {
    return JSON.parse(readFileSync(FIXTURE, 'utf8')) as CalibrationFixture;
  } catch {
    return null;
  }
}

const pinnedInput = (entry: PinnedBuild): ResolvedBuildInput => ({
  weapon: entry.weapon,
  mods: entry.mods,
  arcanes: entry.arcanes,
  unknown: [],
});

/**
 * Fetches a fresh battery from Overframe once and pins it. Everything the comparison needs is
 * stored (names, ranks and the oracle block), so the default run is offline and deterministic.
 * Only builds whose mods and weapon resolve in the snapshot are kept.
 */
async function refreshFixture(count: number): Promise<CalibrationFixture> {
  const db = loadOverframeDb();
  // Overframe builds can carry mods or a weapon the snapshot does not know; collect extra so
  // the pinned battery still reaches `count` after filtering.
  const wanted = Math.max(count * 4, count + 50);
  console.log(`fetching up to ${wanted} Overframe builds for a battery of ${count}…`);
  const raw = await collect(wanted);
  const seen = new Set<number>();
  const builds: PinnedBuild[] = [];
  let noOracle = 0;
  let noWeapon = 0;
  let unknownMods = 0;
  for (const build of raw) {
    const id = Number(build.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const oracle = oracleOf(build);
    const input = resolveBuildInput(build, db, snapshot);
    if (!oracle) { noOracle++; continue; }
    if (!input) { noWeapon++; continue; }
    if (input.unknown.length) { unknownMods++; continue; }
    seen.add(id);
    builds.push({
      id,
      title: String(build.title ?? ''),
      weapon: input.weapon,
      mods: input.mods,
      arcanes: input.arcanes,
      oracle,
    });
  }
  const fixture: CalibrationFixture = {
    source: 'overframe.gg/api/v1/builds',
    generatedAt: new Date().toISOString().slice(0, 10),
    builds: builds.slice(0, count),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`  rejected: ${noOracle} without an oracle, ${noWeapon} without a known weapon, ${unknownMods} with unknown mods`);
  console.log(`pinned ${fixture.builds.length} builds (from ${raw.length} fetched) -> ${FIXTURE.slice(ROOT.length)}`);
  return fixture;
}

const existingFixture = readFixture();
const one = flag('build');
if (one) {
  const pinned = existingFixture?.builds.find((entry) => entry.id === Number(one));
  const build = pinned ?? await getBuild(one);
  const oracle = pinned?.oracle ?? oracleOf(build);
  const input = pinned ? pinnedInput(pinned) : resolveBuildInput(build, loadOverframeDb(), snapshot);
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
const fixture = refresh ? await refreshFixture(count) : existingFixture;
if (!fixture) {
  console.error(`no calibration fixture at ${FIXTURE.slice(ROOT.length)}`);
  console.error('run: npm run calibrate -- --refresh');
  process.exit(1);
}
const builds = fixture.builds.slice(0, count);
console.log(`${fixture.builds.length} pinned builds (${fixture.generatedAt}), comparing ${builds.length}\n`);

const mismatches: Array<{ build: PinnedBuild; weapon: string; diffs: ReturnType<typeof diffOracle>; unknown: string[] }> = [];
const byCategory = new Map<string, { total: number; matched: number }>();
let matched = 0;
let skipped = 0;

for (const entry of builds) {
  const category = snapshot.weapons[entry.weapon]?.category ?? 'other';
  const bucket = byCategory.get(category) ?? { total: 0, matched: 0 };
  bucket.total++;
  byCategory.set(category, bucket);
  const input = pinnedInput(entry);
  let diffs;
  try {
    diffs = pickMode(input, entry.oracle).diffs;
  } catch {
    skipped++;
    continue;
  }
  if (diffs.length === 0) {
    matched++;
    bucket.matched++;
    if (verbose) console.log(`  ok   ${entry.id} ${input.weapon}`);
  } else {
    mismatches.push({ build: entry, weapon: input.weapon, diffs, unknown: [] });
    if (verbose) {
      console.log(`  FAIL ${entry.id} ${input.weapon}: ${diffs.map((d) => `${FIELD_LABEL[d.field]} ${d.actual.toFixed(3)} vs ${d.expected.toFixed(3)}`).join('; ')}`);
    }
  }
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
    console.log(`  ${failure.build.id} ${failure.weapon}: ${failure.diffs.map((d) => d.field).join(', ')}`);
  }
}

writeFileSync(
  REPORT,
  [
    '# Calibration results',
    '',
    `Pinned battery fetched from Overframe on ${fixture.generatedAt} (${fixture.builds.length} builds).`,
    'Every row is a public build compared field by field (multishot, critical chance, critical',
    'damage, status chance, fire rate, magazine, reload) against wfcalc, using the game\'s own',
    'modifier keys from `overframe.gg/api/v1`. The battery is `data/calibration-builds.json`;',
    'refresh it deliberately with `npm run calibrate -- --refresh`.',
    '',
    `- builds compared: **${matched + mismatches.length}**`,
    `- matching: **${matched}**`,
    `- mismatching: **${mismatches.length}**`,
    `- by category: **${[...byCategory]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([category, value]) => `${category} ${value.matched}/${value.total}`)
      .join(' · ')}**`,
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
