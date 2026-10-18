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
 *   node tools/overframe.ts https://overframe.gg/build/1036746/... \
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
  console.error('usage: node tools/overframe.ts <build-url|id> [--mods "A,B"] [--arcane "X"] [--conditions onKill=2]');
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

// Learn the id -> name mapping when the slot count matches the mod list.
const mapping: Record<string, string> = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {};
const weaponSlots = build.slots.filter((slot: any, index: number) => index < 8);
if (weaponSlots.length === mods.length) {
  weaponSlots.forEach((slot: any, index: number) => {
    mapping[String(slot.mod)] = mods[index];
  });
  writeFileSync(MAP_FILE, JSON.stringify(mapping, null, 2) + '\n');
}

const snapshot = loadSnapshot();
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
