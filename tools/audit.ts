/**
 * Large-sample validation sweep with statistics.
 *
 * `calibrate.ts` answers "how many builds match". This answers *why* the rest do not, by
 * looking for causes instead of symptoms:
 *
 *  - mismatch rate by weapon category and by field,
 *  - **mod over-representation**: a mod that appears in failing builds far more often than
 *    in passing ones is probably parsed wrong, even when the visible symptom looks like a
 *    weapon-type issue,
 *  - builds we could not evaluate at all (missing mods, unknown items), which is a data
 *    coverage signal rather than a maths error.
 *
 *   node tools/audit.ts --sample 300
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import {
  diffOracle,
  findWeaponName,
  getBuild,
  listBuilds,
  loadOracleExceptions,
  loadOverframeDb,
  nonApplicableFields,
  oracleOf,
  resolveBuildInput,
  sleep,
  weaponNameFromUrl,
} from './lib/overframe.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const sample = flag('sample', 300);

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
};

interface Evaluated {
  id: number;
  weapon: string;
  category: string;
  type: string;
  mods: string[];
  fields: string[];
  ok: boolean;
}

const statsFor = (resolved: ReturnType<typeof resolveBuild>, field: string): number =>
  field === 'multishot' ? resolved.multishot
  : field === 'critChance' ? resolved.critChance
  : field === 'critMultiplier' ? resolved.critMultiplier
  : field === 'statusChance' ? resolved.statusChance
  : field === 'fireRate' ? resolved.fireRate
  : field === 'magazine' ? resolved.magazineSize
  : resolved.reloadTime;

/** Tries every fire mode and keeps the best agreement, so mode choice is not mistaken for an error. */
function bestMatch(input: NonNullable<ReturnType<typeof resolveBuildInput>>, oracle: NonNullable<ReturnType<typeof oracleOf>>) {
  const weapon = snapshot.weapons[input.weapon];
  const variants: Array<string | undefined> = [undefined, ...(weapon?.modes ?? []).map((mode) => mode.name)];
  let best: { resolved: ReturnType<typeof resolveBuild>; diffs: ReturnType<typeof diffOracle> } | null = null;
  for (const mode of variants) {
    const build: Build = { weapon: input.weapon, mods: input.mods, arcanes: input.arcanes, mode };
    let resolved;
    try {
      resolved = resolveBuild(snapshot, build);
    } catch {
      continue;
    }
    const diffs = diffOracle(oracle, resolved)
      .filter((diff) => !nonApplicableFields(resolved).has(diff.field))
      // Skip fields where the oracle is wrong and our data is verified in game.
      .filter((diff) => !exceptions[input.weapon]?.[diff.field]);
    if (!best || diffs.length < best.diffs.length) best = { resolved, diffs };
    if (best.diffs.length === 0) break;
  }
  return best;
}

async function main(): Promise<void> {
  console.log(`collecting up to ${sample} builds…`);
  const builds: any[] = [];
  let page = 1;
  let skippedWeapon = 0;
  while (builds.length < sample && page <= 200) {
    const { results } = await listBuilds(page, 100);
    if (!results.length) break;
    for (const summary of results) {
      if (builds.length >= sample) break;
      const name = weaponNameFromUrl(summary.url ?? '');
      if (!name || !findWeaponName(snapshot, name)) {
        skippedWeapon++;
        continue;
      }
      try {
        const build = await getBuild(summary.id);
        if (oracleOf(build)) builds.push(build);
      } catch {
        /* ignore and keep going */
      }
      await sleep(40);
    }
    page++;
  }
  console.log(`${builds.length} builds with a usable oracle (${skippedWeapon} skipped: weapon not in our data)\n`);

  const evaluated: Evaluated[] = [];
  let unresolvable = 0;
  for (const build of builds) {
    const oracle = oracleOf(build);
    const input = resolveBuildInput(build, db, snapshot);
    if (!oracle || !input) {
      unresolvable++;
      continue;
    }
    const best = bestMatch(input, oracle);
    if (!best) {
      unresolvable++;
      continue;
    }
    const weapon = snapshot.weapons[input.weapon];
    evaluated.push({
      id: build.id,
      weapon: input.weapon,
      category: weapon.category,
      type: weapon.type,
      mods: input.mods.map((mod) => mod.name),
      fields: best.diffs.map((diff) => diff.field),
      ok: best.diffs.length === 0,
    });
  }

  const skippedFields = evaluated.reduce(
    (sum, entry) => sum + Object.keys(exceptions[entry.weapon] ?? {}).length,
    0,
  );
  if (skippedFields) console.log(`note: ${skippedFields} field comparison(s) skipped — verified oracle errors, see data/oracle-exceptions.json\n`);
  const ok = evaluated.filter((entry) => entry.ok);
  const bad = evaluated.filter((entry) => !entry.ok);
  console.log(`${evaluated.length} builds evaluated: ${ok.length} match, ${bad.length} mismatch (${unresolvable} unresolvable)\n`);

  // ---------------------------------------------------------------- by category
  console.log('mismatch rate by weapon category:');
  const categories = new Map<string, { ok: number; bad: number }>();
  for (const entry of evaluated) {
    const bucket = categories.get(entry.category) ?? { ok: 0, bad: 0 };
    if (entry.ok) bucket.ok++;
    else bucket.bad++;
    categories.set(entry.category, bucket);
  }
  for (const [category, bucket] of [...categories].sort((a, b) => b[1].bad - a[1].bad)) {
    const total = bucket.ok + bucket.bad;
    console.log(`  ${category.padEnd(12)} ${String(bucket.bad).padStart(3)}/${String(total).padEnd(3)} failing  (${((bucket.bad / total) * 100).toFixed(0)}%)`);
  }

  // ------------------------------------------------------------- by field
  console.log('\nfailing field frequency:');
  const fields = new Map<string, number>();
  for (const entry of bad) for (const field of entry.fields) fields.set(field, (fields.get(field) ?? 0) + 1);
  for (const [field, count] of [...fields].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(FIELD_LABEL[field] ?? field).padEnd(16)} ${String(count).padStart(3)}  (${((count / bad.length) * 100).toFixed(0)}% of failing builds)`);
  }

  // ------------------------------------------------- mod over-representation
  // Compare how often a mod appears in failing builds relative to passing ones. Mods used in
  // only a handful of builds are ignored so a single odd build cannot dominate.
  const modStats = new Map<string, { bad: number; ok: number }>();
  for (const entry of evaluated) {
    for (const mod of new Set(entry.mods)) {
      const bucket = modStats.get(mod) ?? { bad: 0, ok: 0 };
      if (entry.ok) bucket.ok++;
      else bucket.bad++;
      modStats.set(mod, bucket);
    }
  }
  const baseRate = bad.length / Math.max(1, evaluated.length);
  const suspects = [...modStats]
    .map(([mod, bucket]) => {
      const total = bucket.bad + bucket.ok;
      const rate = bucket.bad / total;
      return { mod, total, rate, lift: rate / baseRate };
    })
    .filter((entry) => entry.total >= 4)
    .sort((a, b) => b.lift - a.lift);

  console.log(`\nmods over-represented in failures (base failure rate ${(baseRate * 100).toFixed(0)}%):`);
  for (const suspect of suspects.slice(0, 12)) {
    console.log(
      `  ${suspect.mod.padEnd(28)} ${String(suspect.total).padStart(3)} builds  ${(suspect.rate * 100).toFixed(0)}% failing  lift x${suspect.lift.toFixed(2)}`,
    );
  }

  writeFileSync(
    join(ROOT, 'docs/audit-results.md'),
    [
      '# Validation audit',
      '',
      `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run audit\` on ${evaluated.length} public Overframe builds.`,
      '',
      `- matching: **${ok.length}**`,
      `- mismatching: **${bad.length}**`,
      `- could not evaluate (missing data): **${unresolvable}**`,
      '',
      '## Failure rate by weapon category',
      '',
      '| category | failing | rate |',
      '|---|---|---|',
      ...[...categories].sort((a, b) => b[1].bad - a[1].bad).map(([category, bucket]) => {
        const total = bucket.ok + bucket.bad;
        return `| ${category} | ${bucket.bad}/${total} | ${((bucket.bad / total) * 100).toFixed(0)}% |`;
      }),
      '',
      '## Failing fields',
      '',
      '| field | count |',
      '|---|---|',
      ...[...fields].sort((a, b) => b[1] - a[1]).map(([field, count]) => `| ${FIELD_LABEL[field] ?? field} | ${count} |`),
      '',
      '## Suspect mods (over-represented in failures)',
      '',
      '| mod | builds | failing | lift |',
      '|---|---|---|---|',
      ...suspects.slice(0, 20).map((s) => `| ${s.mod} | ${s.total} | ${(s.rate * 100).toFixed(0)}% | x${s.lift.toFixed(2)} |`),
      '',
    ].join('\n'),
  );
  console.log('\nwritten to docs/audit-results.md');
}

await main();
