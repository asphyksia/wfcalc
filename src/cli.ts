#!/usr/bin/env node
/**
 * wfcalc CLI.
 *
 *   wfcalc weapons [query]                 list / search weapons
 *   wfcalc mods <weapon> [query]           mods that fit a weapon
 *   wfcalc enemies [query]                 list / search enemies
 *   wfcalc calc <weapon> [options]         damage report
 *   wfcalc compare <weapon> --vs a,b,c     compare mod setups or elemental choices
 *
 * Options for calc/compare:
 *   --mod Serration,R1          equip a mod (R<rank> to under-level it), repeatable
 *   --enemy Bombard --level 150 enemy and level (defaults: first enemy, level 100)
 *   --faction grineer           shorthand: picks a Grineer benchmark and enables faction mods
 *   --mode "Incarnon Form"      use an alternative fire mode
 *   --stacks onKill=5           activate a conditional effect
 *   --status-types 4            number of status types on the target (Galvanized mods)
 *   --headshot                  treat every hit as a weak-point hit
 *   --json                      machine-readable output
 */
import { loadSnapshot, findEnemy, findMod, findWeapon, modsForWeapon } from './data.ts';
import { resolveBuild, type Build, type BuildMod } from './engine/build.ts';
import { scaleEnemy } from './engine/enemy.ts';
import { hitEnemy } from './engine/damage.ts';
import type { Snapshot } from './types.ts';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey;
    const value = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1);
const flagAll = (args: Args, name: string): string[] => args.flags.get(name) ?? [];

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number, digits = 1): string => value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** `--mod Serration` or `--mod Serration:R4` or `--mod "Serration R4"`. */
function parseModArg(raw: string): BuildMod {
  const match = /^(.*?)[\s:]+R(\d+)$/i.exec(raw.trim());
  if (match) return { name: match[1].trim(), rank: Number(match[2]) };
  return { name: raw.trim() };
}

/** Conditions from `--stacks onKill=5` and friends. */
function parseConditions(args: Args): Record<string, number> {
  const conditions: Record<string, number> = {};
  for (const entry of flagAll(args, 'stacks')) {
    for (const pair of entry.split(',')) {
      const [key, value] = pair.split('=');
      conditions[key.trim()] = value ? Number(value) : 1;
    }
  }
  const statusTypes = flag(args, 'status-types');
  if (statusTypes) conditions.statusTypes = Number(statusTypes);
  return conditions;
}

function buildFromArgs(snapshot: Snapshot, args: Args, mods: string[]): Build {
  const weaponQuery = args.positional[0];
  const { item: weapon, suggestions } = findWeapon(snapshot, weaponQuery);
  if (!weapon) {
    throw new Error(`weapon not found: ${weaponQuery}${suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''}`);
  }
  return {
    weapon: weapon.name,
    mods,
    mode: flag(args, 'mode'),
    conditions: parseConditions(args),
    headshot: args.flags.has('headshot'),
  };
}

function resolveEnemy(snapshot: Snapshot, args: Args) {
  const faction = flag(args, 'faction');
  const level = Number(flag(args, 'level') ?? 100);
  let enemyName = flag(args, 'enemy');
  if (!enemyName && faction) {
    const benchmarks: Record<string, string> = {
      grineer: 'Bombard',
      corpus: 'Corpus Tech',
      infested: 'Ancient Healer',
      orokin: 'Corrupted Bombard',
      murmur: 'The Hollow Vein',
      sentient: 'Battalyst',
    };
    enemyName = benchmarks[faction.toLowerCase()] ?? 'Bombard';
  }
  enemyName ??= 'Bombard';
  const { item, suggestions } = findEnemy(snapshot, enemyName);
  if (!item) throw new Error(`enemy not found: ${enemyName}${suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''}`);
  return { enemy: item, level };
}

function report(snapshot: Snapshot, args: Args, mods: BuildMod[], label: string): void {
  const build = buildFromArgs(snapshot, args, mods.map((m) => (m.rank ? `${m.name}=R${m.rank}` : m.name)));
  // Re-apply ranks lost by the string round-trip above.
  build.mods = mods;
  const resolved = resolveBuild(snapshot, build);
  const { enemy, level } = resolveEnemy(snapshot, args);
  const scaled = scaleEnemy(snapshot, enemy, level);
  const hit = hitEnemy(snapshot, resolved, scaled);

  if (args.flags.has('json')) {
    console.log(
      JSON.stringify(
        {
          label,
          weapon: resolved.weapon.name,
          mode: resolved.mode?.name ?? 'arsenal',
          level,
          enemy: enemy.name,
          damage: resolved.damage.perProjectile,
          projectileTotal: resolved.damage.projectileTotal,
          shotDamage: resolved.shotDamage,
          averageShotDamage: resolved.averageShotDamage,
          burstDps: resolved.burstDps,
          sustainedDps: resolved.sustainedDps,
          critChance: resolved.critChance,
          critMultiplier: resolved.critMultiplier,
          statusChance: resolved.statusChance,
          multishot: resolved.multishot,
          fireRate: resolved.fireRate,
          shotsToKill: hit.shotsToKill,
          timeToKill: hit.timeToKill,
          warnings: resolved.warnings,
          unsupportedMods: resolved.unsupportedMods,
          inactiveConditions: resolved.inactiveConditions,
        },
        null,
        2,
      ),
    );
    return;
  }

  const w = resolved.weapon;
  console.log(`\n${label}  —  ${w.name} (${w.type}${resolved.mode ? `, ${resolved.mode.name}` : ''}) vs ${enemy.name} lv${level}`);
  console.log('─'.repeat(78));
  console.log(
    `  damage/shot  ${num(resolved.damage.projectileTotal, 2).padStart(9)}  ` +
      `×${resolved.multishot.toFixed(2)} multishot  ×${(1 + resolved.critChance * (resolved.critMultiplier - 1)).toFixed(2)} crit avg`,
  );
  console.log(
    `  crit         ${pct(resolved.critChance).padStart(7)} ×${resolved.critMultiplier.toFixed(2)}` +
      `   status ${pct(resolved.statusChance)}   fire rate ${resolved.fireRate.toFixed(2)}/s`,
  );
  console.log(`  elements     ${resolved.elements.map((e) => `${e.type} ${pct(e.share)}`).join(', ')}`);
  console.log(
    `  dps          burst ${num(resolved.burstDps)}   sustained ${num(resolved.sustainedDps)}` +
      `   avg hit ${num(resolved.averageShotDamage)}`,
  );
  console.log(
    `  target       hp ${num(scaled.health)}  shields ${num(scaled.shield)}  armor ${num(scaled.armor)}` +
      `   -> ${num(hit.shotsToKill)} shots${hit.timeToKill !== null ? `, ${num(hit.timeToKill, 2)}s` : ''}`,
  );
  if (hit.bestType) {
    console.log(`  best type    ${hit.bestType.type} ×${hit.bestType.multiplier.toFixed(2)}`);
  }
  console.log('  ── per type ──');
  for (const entry of hit.breakdown.sort((a, b) => b.toHealth - a.toHealth)) {
    console.log(
      `   ${entry.type.padEnd(12)} ${num(entry.raw, 2).padStart(8)}  hp×${entry.healthMultiplier.toFixed(2).padStart(5)}` +
        `  → ${num(entry.toHealth, 2).padStart(8)}   proc ${pct(entry.procShare)}`,
    );
  }
  for (const warning of resolved.warnings) console.log(`  ! ${warning}`);
  if (resolved.unsupportedMods.length) console.log(`  ! mods with unknown effects (result is a lower bound): ${resolved.unsupportedMods.join(', ')}`);
  if (resolved.inactiveConditions.length) console.log(`  · inactive conditions: ${resolved.inactiveConditions.length} (use --stacks to enable)`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = loadSnapshot();

  switch (args.command) {
    case 'weapons': {
      const query = args.positional[0] ?? '';
      const list = Object.values(snapshot.weapons).filter((w) => w.name.toLowerCase().includes(query.toLowerCase()));
      for (const weapon of list.slice(0, 60)) {
        console.log(`${weapon.name.padEnd(30)} ${weapon.category.padEnd(10)} ${weapon.type.padEnd(14)} MR${weapon.masteryRank}`);
      }
      console.log(`\n${list.length} weapon(s)`);
      break;
    }
    case 'mods': {
      const { item, suggestions } = findWeapon(snapshot, args.positional[0] ?? '');
      if (!item) throw new Error(`weapon not found: ${args.positional[0]} ${suggestions.join(', ')}`);
      const query = (args.positional[1] ?? '').toLowerCase();
      const list = modsForWeapon(snapshot, item).filter((m) => m.name.toLowerCase().includes(query) && !m.conclave);
      for (const mod of list.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`${mod.name.padEnd(28)} ${String(mod.maxRank).padStart(2)}  ${mod.polarity ?? '-'.padEnd(8)}  ${mod.description.split('\n')[0]}`);
      }
      console.log(`\n${list.length} mod(s) fit ${item.name}`);
      break;
    }
    case 'enemies': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.enemies).filter((e) => e.name.toLowerCase().includes(query));
      for (const enemy of list.slice(0, 60)) {
        console.log(`${enemy.name.padEnd(32)} ${(enemy.faction ?? '-').padEnd(10)} hp${enemy.health} sh${enemy.shield} ar${enemy.armor}  ${enemy.pools.map((p) => p.type).join('+')}`);
      }
      console.log(`\n${list.length} enemy(ies)`);
      break;
    }
    case 'calc': {
      report(snapshot, args, flagAll(args, 'mod').map(parseModArg), 'build');
      break;
    }
    case 'compare': {
      const setups = flagAll(args, 'vs');
      const base = flagAll(args, 'mod').map(parseModArg);
      if (setups.length === 0) {
        // Default comparison: no mods, then each single element mod.
        report(snapshot, args, base, 'current build');
        for (const mod of ['Hellfire', 'Cryo Rounds', 'Infected Clip', 'Stormbringer']) {
          if (findMod(snapshot, mod).item) report(snapshot, args, [...base, parseModArg(mod)], `+${mod}`);
        }
      } else {
        for (const setup of setups) {
          const extra = setup.split(',').map((s) => s.trim()).filter(Boolean).map(parseModArg);
          report(snapshot, args, [...base, ...extra], [...base, ...extra].map((m) => m.name).join(' + '));
        }
      }
      break;
    }
    default:
      console.log(`wfcalc — offline Warframe damage calculator

  wfcalc weapons [query]                search weapons
  wfcalc mods <weapon> [query]          mods that fit a weapon
  wfcalc enemies [query]                search enemies
  wfcalc calc <weapon> [options]        damage report
  wfcalc compare <weapon> --vs a,b      compare setups

Options: --mod NAME[:R<rank>] (repeatable), --enemy NAME, --level N, --faction NAME,
         --mode "Name", --stacks onKill=5, --status-types N, --headshot, --json`);
  }
}

main();
