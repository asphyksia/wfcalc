/**
 * Compares wfcalc against Overframe (overframe.gg) builds.
 *
 * Overframe's HTML is behind Cloudflare, but its JSON API is not:
 *   GET https://overframe.gg/api/v1/builds/<id>
 * returns the mod slots with ranks plus `stats`, which is the game's own modifier
 * block (WEAPON_CRIT_CHANCE, WEAPON_FIRE_ITERATIONS, ...). That makes it an
 * independent oracle.
 *
 * The mod ids in `slots` are Overframe-internal, so the mod list has to be given
 * explicitly (or learned into data/raw/overframe-mods.json over time):
 *
 *   node tools/oracle.ts https://overframe.gg/build/1036746/... \
 *        --mods "Galvanized Chamber,Galvanized Aptitude,Hellfire,Thermite Rounds,Critical Delay,Primed Shred,Vital Sense,Serration" \
 *        --arcane "Primary Crux" --conditions onKill=2
 *
 * Without --mods it just prints the oracle, which is still useful.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MAP_FILE = join(ROOT, 'data/raw/overframe-mods.json');

const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith('--')) ?? '';
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const list = (name: string): string[] =>
  (flag(name) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

const buildId = /\/build\/(\d+)/.exec(url)?.[1] ?? (/^\d+$/.test(url) ? url : null);
if (!buildId) {
  console.error('usage: node tools/oracle.ts <build-url|id> [--mods "A,B"] [--arcane "X"] [--conditions onKill=2]');
  process.exit(1);
}

const build = await fetch(`https://overframe.gg/api/v1/builds/${buildId}`, {
  headers: { 'user-agent': 'Mozilla/5.0' },
}).then((response) => {
  if (!response.ok) throw new Error(`Overframe API ${response.status} for build ${buildId}`);
  return response.json() as Promise<any>;
});

/** Overframe's internal modifier keys, mapped to what we report. */
const ORACLE_KEYS = {
  'multishot': 'WEAPON_FIRE_ITERATIONS',
  'crit chance': 'WEAPON_CRIT_CHANCE',
  'crit damage': 'WEAPON_CRIT_DAMAGE',
  'status chance': 'WEAPON_PROC_CHANCE',
  'fire rate': 'WEAPON_FIRE_RATE',
  'damage multiplier': 'WEAPON_DAMAGE_AMOUNT',
  'punch through': 'WEAPON_PUNCTURE_DEPTH',
  'magazine': 'WEAPON_CLIP_MAX',
  'reload': 'WEAPON_RELOAD_TIME',
} as const;

const oracle: Record<string, number> = {};
for (const [label, key] of Object.entries(ORACLE_KEYS)) {
  const value = build.stats?.[key];
  if (typeof value === 'number') oracle[label] = value;
}
const heatBonus = build.stats?.['WEAPON_PERCENT_BASE_DAMAGE_ADDED,DT_FIRE'];

console.log(`Overframe build ${buildId}: ${build.title}`);
console.log(`  author ${build.author?.username ?? '-'}  updated ${build.updated?.slice(0, 10)}  item ${build.item_data?.locTag ?? '-'}`);
console.log(`  slots: ${build.slots.map((slot: any) => `${slot.mod}@R${slot.rank}`).join(' ')}`);
console.log('  oracle:');
for (const [label, value] of Object.entries(oracle)) console.log(`    ${label.padEnd(18)} ${value}`);
if (typeof heatBonus === 'number') console.log(`    ${'heat bonus'.padEnd(18)} ${(heatBonus * 100).toFixed(0)}%`);
if (typeof build.total_damage === 'number') console.log(`    ${'total damage'.padEnd(18)} ${build.total_damage}`);

const mods = list('mods');
if (!mods.length) {
  console.log('\nPass --mods "A,B,C" to compute the same build with wfcalc and diff it.');
  process.exit(0);
}

const snapshot = loadSnapshot();
const mapping: Record<string, string> = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {};
const weaponSlots = build.slots.filter((slot: any, _index: number) => true).slice(0, 8);
const conditions: Record<string, number> = {};
for (const pair of (flag('conditions') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split('=');
  conditions[key] = Number(value ?? 1);
}

// Overframe's `stats` block is the unstacked modifier set; its `total_damage` headline
// number does include the conditional toggles. Compare each against its own state.
const bare = resolveBuild(snapshot, {
  weapon: flag('weapon') ?? 'Haalvu',
  mods,
  arcanes: list('arcane').map((name) => ({ name })),
});
const resolved = resolveBuild(snapshot, {
  weapon: flag('weapon') ?? 'Haalvu',
  mods,
  arcanes: list('arcane').map((name) => ({ name })),
  conditions,
});

/**
 * Solves which mod id is which name: backtracks over the slot list keeping only
 * assignments where the mod's drain matches the slot's, then keeps the assignment that
 * reproduces the oracle's stats. Slot order is *not* reliable — this was verified the
 * hard way.
 */
function solveMapping(): Record<string, string> | null {
  if (weaponSlots.length !== mods.length) return null;
  const fits = (modName: string, slot: any): boolean => {
    const mod = snapshot.mods[modName];
    if (!mod || slot.rank > mod.maxRank) return false;
    const base = mod.baseDrain + slot.rank;
    return slot.polarity_match === 2 ? Math.floor(base / 2) === slot.drain : base === slot.drain;
  };
  const solutions: Record<string, string>[] = [];
  const used = new Set<string>();
  const current: Record<string, string> = {};
  const walk = (index: number): void => {
    if (solutions.length > 1) return; // ambiguous, stop early
    if (index === weaponSlots.length) {
      const candidateMods = weaponSlots.map((slot: any) => ({ name: current[String(slot.mod)], rank: slot.rank }));
      const resolvedCandidate = resolveBuild(snapshot, { weapon: flag('weapon') ?? 'Haalvu', mods: candidateMods });
      if (diff(oracle, resolvedCandidate).length === 0) solutions.push({ ...current });
      return;
    }
    const slot = weaponSlots[index];
    for (const name of mods) {
      if (used.has(name) || !fits(name, slot)) continue;
      used.add(name);
      current[String(slot.mod)] = name;
      walk(index + 1);
      used.delete(name);
    }
  };
  walk(0);
  return solutions.length === 1 ? solutions[0] : null;
}

if (weaponSlots.length === mods.length) {
  const solved = solveMapping();
  if (solved) {
    Object.assign(mapping, solved);
    writeFileSync(MAP_FILE, JSON.stringify(mapping, null, 2) + '\n');
    console.log('  mod ids solved and verified against the oracle:');
    for (const [id, name] of Object.entries(solved)) console.log(`    ${id.padStart(5)} = ${name}`);
  } else {
    console.log('  could not uniquely solve the id mapping (ambiguous or a mod is not in the dataset)');
  }
}

/** Fields where the two implementations must agree. */
const near = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= Math.max(1e-3, Math.abs(expected) * 3e-3);
const diff = (expected: Record<string, number>, resolved: ReturnType<typeof resolveBuild>): string[] => {
  const failures: string[] = [];
  if (expected['multishot'] !== undefined && !near(resolved.multishot, expected['multishot'])) failures.push('multishot');
  if (expected['crit chance'] !== undefined && !near(resolved.critChance, expected['crit chance'])) failures.push('crit');
  if (expected['crit damage'] !== undefined && !near(resolved.critMultiplier, expected['crit damage'])) failures.push('cd');
  if (expected['status chance'] !== undefined && !near(resolved.statusChance, expected['status chance'])) failures.push('status');
  if (expected['fire rate'] !== undefined && !near(resolved.fireRate, expected['fire rate'])) failures.push('fire');
  if (expected['magazine'] !== undefined && !near(resolved.magazineSize, expected['magazine'])) failures.push('magazine');
  if (expected['reload'] !== undefined && !near(resolved.reloadTime, expected['reload'])) failures.push('reload');
  return failures;
};

const computed: Record<string, number> = {
  'multishot': bare.multishot,
  'crit chance': bare.critChance,
  'crit damage': bare.critMultiplier,
  'status chance': bare.statusChance,
  'fire rate': bare.fireRate,
  'magazine': bare.magazineSize,
  'reload': bare.reloadTime,
};

console.log('\n  stat                 overframe      wfcalc     diff');
let mismatches = 0;
for (const [label, expected] of Object.entries(oracle)) {
  const actual = computed[label];
  if (actual === undefined) continue;
  const diff = actual - expected;
  const ok = Math.abs(diff) <= Math.max(1e-3, Math.abs(expected) * 2e-3);
  if (!ok) mismatches++;
  console.log(
    `  ${label.padEnd(20)} ${expected.toFixed(4).padStart(10)} ${actual.toFixed(4).padStart(12)} ${(ok ? 'ok' : `${diff > 0 ? '+' : ''}${diff.toFixed(4)}`).padStart(8)}`,
  );
}
// Headline total damage, which does include the conditional toggles.
if (typeof build.total_damage === 'number') {
  const mine = resolved.damage.projectileTotal;
  const diff = mine - build.total_damage;
  const ok = Math.abs(diff) <= Math.max(0.5, build.total_damage * 3e-3);
  if (!ok) mismatches++;
  console.log(`  ${'total damage'.padEnd(20)} ${build.total_damage.toFixed(2).padStart(10)} ${mine.toFixed(2).padStart(12)} ${(ok ? 'ok' : `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`).padStart(8)}`);
}

console.log(`\n  ${mismatches === 0 ? 'MATCH' : `${mismatches} mismatch(es)`}`);
process.exitCode = mismatches === 0 ? 0 : 1;
