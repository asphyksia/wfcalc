/**
 * Learns Overframe's internal mod ids and calibrates wfcalc against real builds.
 *
 * Overframe exposes `/api/v1/builds/` (paginated list) and `/api/v1/builds/<id>`
 * (full build with `slots` and the game's own modifier block in `stats`). There is no
 * mod catalogue endpoint, but the ids can be *solved*: in a build where every mod but
 * one is known, try every mod that fits the weapon and keep the one whose computed
 * stats reproduce Overframe's.
 *
 *   node tools/calibrate.ts --discover 120     # learn ids from N builds
 *   node tools/calibrate.ts --battery 60       # verify N builds end to end
 *
 * The learned map lives in data/raw/overframe-mods.json and grows every run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findWeapon, loadSnapshot, modsForWeapon } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';
import type { ModData, Snapshot, WeaponData } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MAP_FILE = join(ROOT, 'data/raw/overframe-mods.json');
const REPORT_FILE = join(ROOT, 'docs/calibration-results.md');
const API = 'https://overframe.gg/api/v1';

const args = process.argv.slice(2);
const flag = (name: string): number | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : undefined;
};
const discoverCount = flag('discover') ?? 0;
const batteryCount = flag('battery') ?? 0;
const verbose = args.includes('--verbose');

const snapshot = loadSnapshot();
mkdirSync(join(ROOT, 'data/raw'), { recursive: true });
const mapping: Record<string, string> = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${API}${path}`, { headers: { 'user-agent': 'wfcalc/0.1', accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return response.json();
}

/** `/build/374539/revenant-prime/...` -> the weapon name Overframe uses. */
function weaponFromUrl(url: string): string | null {
  const match = /\/build\/\d+\/([^/]+)\//.exec(url);
  return match ? match[1].replace(/-/g, ' ') : null;
}

interface Oracle {
  multishot: number;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  fireRate: number;
  magazine: number;
  reload: number;
}

function oracleOf(build: any): Oracle | null {
  const stats = build.stats ?? {};
  const pick = (key: string): number | null => (typeof stats[key] === 'number' ? stats[key] : null);
  const values = {
    multishot: pick('WEAPON_FIRE_ITERATIONS'),
    critChance: pick('WEAPON_CRIT_CHANCE'),
    critMultiplier: pick('WEAPON_CRIT_DAMAGE'),
    statusChance: pick('WEAPON_PROC_CHANCE'),
    fireRate: pick('WEAPON_FIRE_RATE'),
    magazine: pick('WEAPON_CLIP_MAX'),
    reload: pick('WEAPON_RELOAD_TIME'),
  };
  if (Object.values(values).some((value) => value === null)) return null;
  return values as Oracle;
}

const near = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= Math.max(1e-3, Math.abs(expected) * 3e-3);

/** Compares a resolved build against the oracle; returns the list of failing fields. */
function diff(oracle: Oracle, resolved: ReturnType<typeof resolveBuild>): string[] {
  const failures: string[] = [];
  if (!near(resolved.multishot, oracle.multishot)) failures.push(`multishot ${resolved.multishot.toFixed(3)} vs ${oracle.multishot.toFixed(3)}`);
  if (!near(resolved.critChance, oracle.critChance)) failures.push(`crit ${resolved.critChance.toFixed(4)} vs ${oracle.critChance.toFixed(4)}`);
  if (!near(resolved.critMultiplier, oracle.critMultiplier)) failures.push(`cd ${resolved.critMultiplier.toFixed(3)} vs ${oracle.critMultiplier.toFixed(3)}`);
  if (!near(resolved.statusChance, oracle.statusChance)) failures.push(`status ${resolved.statusChance.toFixed(4)} vs ${oracle.statusChance.toFixed(4)}`);
  if (!near(resolved.fireRate, oracle.fireRate)) failures.push(`fire ${resolved.fireRate.toFixed(3)} vs ${oracle.fireRate.toFixed(3)}`);
  if (!near(resolved.magazineSize, oracle.magazine)) failures.push(`magazine ${resolved.magazineSize.toFixed(1)} vs ${oracle.magazine.toFixed(1)}`);
  if (!near(resolved.reloadTime, oracle.reload)) failures.push(`reload ${resolved.reloadTime.toFixed(3)} vs ${oracle.reload.toFixed(3)}`);
  return failures;
}

interface Candidate {
  buildId: number;
  weapon: WeaponData;
  oracle: Oracle;
  slots: Array<{ mod: number; rank: number }>;
}

/** Fetches builds for weapons we know, with their oracle, until `count` are collected. */
async function collect(count: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let next: string | null = `/builds?limit=100`;
  let pages = 0;
  while (out.length < count && next && pages < 40) {
    const page = await getJson(next);
    pages++;
    for (const summary of page.results ?? []) {
      if (out.length >= count) break;
      const weaponName = weaponFromUrl(summary.url);
      if (!weaponName) continue;
      const { item: weapon } = findWeapon(snapshot, weaponName);
      if (!weapon) continue;
      if (weapon.category === 'archgun' || weapon.category === 'archmelee') continue;
      let build: any;
      try {
        build = await getJson(`/builds/${summary.id}`);
      } catch {
        continue;
      }
      const oracle = oracleOf(build);
      if (!oracle) continue;
      const slots = (build.slots ?? [])
        .filter((slot: any) => slot.rank !== undefined && slot.mod)
        .slice(0, 8)
        .map((slot: any) => ({ mod: slot.mod, rank: slot.rank }));
      if (slots.length < 6 || slots.length > 8) continue; // incomplete or weird builds
      out.push({ buildId: summary.id, weapon, oracle, slots });
      await sleep(80);
    }
    next = page.next ? page.next.replace('https://overframe.gg/api/v1', '') : null;
  }
  return out;
}

/** Which mods can a weapon take, for the solver. */
function candidatesFor(weapon: WeaponData, rank: number): ModData[] {
  return modsForWeapon(snapshot, weapon).filter(
    (mod) => !mod.conclave && mod.effects.length > 0 && mod.maxRank >= rank,
  );
}

async function main(): Promise<void> {
  const total = discoverCount || batteryCount;
  if (!total) {
    console.log('usage: node tools/calibrate.ts --discover N | --battery N [--verbose]');
    process.exit(1);
  }

  console.log(`fetching ${total} Overframe builds…`);
  const builds = await collect(total);
  console.log(`${builds.length} usable builds (weapon known, oracle complete)\n`);

  let learned = 0;
  let verified = 0;
  let skipped = 0;
  const failures: Array<{ buildId: number; weapon: string; fields: string[] }> = [];

  for (const build of builds) {
    const known = build.slots.filter((slot) => mapping[String(slot.mod)]);
    const unknown = build.slots.filter((slot) => !mapping[String(slot.mod)]);

    // Solver: exactly one unknown mod -> try every mod that fits.
    if (discoverCount && unknown.length === 1) {
      const slot = unknown[0];
      const others = known.map((entry) => ({ name: mapping[String(entry.mod)], rank: entry.rank }));
      const matches: string[] = [];
      for (const candidate of candidatesFor(build.weapon, slot.rank)) {
        let resolved;
        try {
          resolved = resolveBuild(snapshot, {
            weapon: build.weapon.name,
            mods: [...others, { name: candidate.name, rank: slot.rank }],
          });
        } catch {
          continue;
        }
        if (diff(build.oracle, resolved).length === 0) matches.push(candidate.name);
      }
      const unique = [...new Set(matches)];
      if (unique.length === 1) {
        mapping[String(slot.mod)] = unique[0];
        learned++;
        if (verbose) console.log(`  learned ${slot.mod} = ${unique[0]} (build ${build.buildId})`);
      } else if (verbose && unique.length > 1) {
        console.log(`  ambiguous ${slot.mod}: ${unique.slice(0, 4).join(' / ')}`);
      }
      writeFileSync(MAP_FILE, JSON.stringify(mapping, null, 2) + '\n');
      continue;
    }

    if (unknown.length !== 0) {
      skipped++;
      continue;
    }

    // Verification battery.
    const resolved = resolveBuild(snapshot, {
      weapon: build.weapon.name,
      mods: build.slots.map((slot) => ({ name: mapping[String(slot.mod)], rank: slot.rank })),
    });
    const fields = diff(build.oracle, resolved);
    if (fields.length === 0) {
      verified++;
    } else {
      failures.push({ buildId: build.buildId, weapon: build.weapon.name, fields });
      if (verbose) console.log(`  FAIL build ${build.buildId} (${build.weapon.name}): ${fields.join('; ')}`);
    }
  }

  writeFileSync(MAP_FILE, JSON.stringify(mapping, null, 2) + '\n');
  console.log(`\nknown mod ids: ${Object.keys(mapping).length}${learned ? ` (+${learned} this run)` : ''}`);
  console.log(`verified builds: ${verified}/${verified + failures.length}${skipped ? `, ${skipped} skipped (unknown mods)` : ''}`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const failure of failures.slice(0, 15)) {
      console.log(`  ${failure.buildId} ${failure.weapon}: ${failure.fields.join('; ')}`);
    }
  }

  // Keep a machine-readable record of the run.
  writeFileSync(
    REPORT_FILE,
    [
      '# Calibration results',
      '',
      `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run calibrate\`.`
        + ' Each row is a public Overframe build compared field by field against wfcalc.',
      '',
      `- builds compared: **${verified + failures.length}**`,
      `- matching: **${verified}**`,
      `- mismatching: **${failures.length}**`,
      `- Overframe mod ids learned: **${Object.keys(mapping).length}**`,
      '',
      ...(failures.length
        ? ['## Mismatches', '', '| build | weapon | fields |', '|---|---|---|',
           ...failures.map((f) => `| ${f.buildId} | ${f.weapon} | ${f.fields.join('<br>')} |`)]
        : ['All compared builds match on multishot, critical chance, critical damage, status chance, fire rate, magazine and reload.']),
      '',
    ].join('\n'),
  );
  if (failures.length) process.exitCode = 1;
}

await main();
