/**
 * Drift check: our weapon stats against Overframe's mirror of the same game export.
 *
 * Both sides come from the game's Public Export, so they *should* agree. When they do not,
 * one of them is stale — and since Overframe renders the live game, the usual answer is
 * that our copy is behind (that is exactly how Acceltra's status chance and Fulmin's
 * magazine were found, but by accident).
 *
 * Fields are compared as **ratios**, because the raw export stores them in different units
 * (fire rate in ticks per minute). A field with a stable ratio across most weapons is a unit
 * difference; a weapon that deviates from that median is worth a look.
 *
 * This is a **signal, not a verdict**: some raw fields are left at their default (Acceltra's
 * `criticalHitDamageMultiplier` is 2 in the export while the game and Overframe's own engine
 * both use 2.8), so crit/status divergences need arbitration. The reliable classes are
 * magazine size and reload, where the export has no such defaults — that is how the Fulmin
 * family's factor-of-10 error surfaced.
 *
 * Run: node tools/drift.ts [--tolerance 0.02] [--quiet]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot } from '../src/data.ts';
import { loadOverframeChunks } from './lib/overframe-chunks.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW = join(ROOT, 'data/raw');

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const tolerance = flag('tolerance', 0.02);
const quiet = args.includes('--quiet');

interface Sample {
  weapon: string;
  field: string;
  ours: number;
  theirs: number;
}

/**
 * Fields of the raw export that carry a weapon's base stats. A weapon can have several
 * behaviours (fire modes), each with its own crit/rate values and our snapshot keeps one of
 * them, so every behaviour is returned as a candidate rather than just the first.
 */
const FIELD_PATHS: Array<[field: string, pick: (data: any) => number[]]> = [
  ['critChance', (data) => candidates(data, (impact) => impact?.criticalHitChance)],
  ['critMultiplier', (data) => candidates(data, (impact) => impact?.criticalHitDamageMultiplier)],
  ['statusChance', (data) => candidates(data, (impact) => impact?.AttackData?.ProcChance)],
  ['fireRate', (data) => candidates(data, (_impact, state) => state?.fireRate)],
  ['reloadTime', (data) => candidates(data, (_impact, state) => state?.reloadTime)],
  ['magazineSize', (data) => (typeof data?.AmmoClipSize === 'number' && data.AmmoClipSize > 0 ? [data.AmmoClipSize] : [])],
];

/**
 * Walks every behaviour until `pick` yields a value. The `impact:` sub-object holds crit and
 * proc values while `state:` holds fire rate and reload; a behaviour may carry `fire:`
 * instead of `impact:` and a weapon may have several behaviours, so all are tried.
 */
function candidates(data: any, pick: (impact: any, state: any) => unknown): number[] {
  const out: number[] = [];
  for (const behaviour of data?.Behaviors ?? []) {
    const entries = Object.entries<any>(behaviour ?? {});
    const impact =
      entries.find(([key]) => key.startsWith('impact:'))?.[1] ??
      entries.find(([key]) => key.startsWith('fire:'))?.[1];
    const state = entries.find(([key]) => key.startsWith('state:'))?.[1];
    const value = pick(impact, state);
    if (typeof value === 'number' && value > 0) out.push(value);
  }
  return out;
}

const median = (values: number[]): number => {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function main(): Promise<void> {
  const snapshot = loadSnapshot();
  if (!quiet) console.log('loading Overframe’s item mirror…');
  const chunks = await loadOverframeChunks();
  if (!quiet) console.log(`  ${Object.keys(chunks.itemsByPath).length} items`);

  // Join the raw export (which carries the Lotus path) to Overframe's mirror.
  const rawFiles = ['Primary', 'Secondary', 'Melee', 'Arch-Gun', 'Arch-Melee', 'SentinelWeapons'];
  const samples: Sample[] = [];
  let joined = 0;
  let missing = 0;

  for (const file of rawFiles) {
    let weapons: any[];
    try {
      weapons = JSON.parse(readFileSync(join(RAW, `wfcd-${file}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const weapon of weapons) {
      const ours = snapshot.weapons[weapon.name];
      const theirs = chunks.itemsByPath[weapon.uniqueName];
      if (!ours || !theirs) {
        missing++;
        continue;
      }
      joined++;
      for (const [field, pick] of FIELD_PATHS) {
        const ourValue = (ours.stats as any)[field];
        if (typeof ourValue !== 'number' || ourValue <= 0) continue;
        const options = pick(theirs);
        if (!options.length) continue;
        // Compare against the closest candidate: a weapon with several fire modes exposes
        // several values and our snapshot legitimately keeps one of them.
        const closest = options.reduce((best, option) =>
          Math.abs(Math.log(option / ourValue)) < Math.abs(Math.log(best / ourValue)) ? option : best,
        );
        samples.push({ weapon: weapon.name, field, ours: ourValue, theirs: closest });
      }
    }
  }

  if (!quiet) console.log(`joined ${joined} weapons (${missing} not in the mirror)\n`);

  // A stable median ratio per field means a unit difference; outliers are drift.
  const byField = new Map<string, Sample[]>();
  for (const sample of samples) byField.set(sample.field, [...(byField.get(sample.field) ?? []), sample]);

  const drift: Array<Sample & { ratio: number }> = [];
  for (const [field, list] of byField) {
    const base = median(list.map((sample) => sample.ours / sample.theirs));
    for (const sample of list) {
      const ratio = sample.ours / sample.theirs;
      if (Math.abs(ratio - base) / base > tolerance) drift.push({ ...sample, ratio });
    }
    if (!quiet) {
      console.log(`${field.padEnd(16)} ${list.length} samples, unit ratio ${base.toFixed(4)}, ${drift.filter((d) => d.field === field).length} deviating`);
    }
  }

  console.log(`\n${drift.length} divergence(s) over ${samples.length} comparisons`);
  if (drift.length) {
    const shown = new Map<string, typeof drift>();
    for (const entry of drift) shown.set(entry.weapon, [...(shown.get(entry.weapon) ?? []), entry]);
    console.log('\nweapons where our copy disagrees with the mirror:');
    for (const [weapon, entries] of shown) {
      console.log(
        `  ${weapon.padEnd(24)} ${entries
          .map((entry) => `${entry.field} ours ${entry.ours} vs export ${entry.theirs}`)
          .join('; ')}`,
      );
    }
    console.log('\nFix by adding a data/weapon-overrides.json entry, or by refreshing the export.');
    process.exitCode = 1;
  }
}

await main();
