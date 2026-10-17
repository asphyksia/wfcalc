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
import { BUFFS, availableBuffs } from './engine/buffs.ts';
import { RIVEN_ATTRIBUTES, type RivenSpec } from './engine/riven.ts';
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

/** `--riven damage,multishot,-zoom` -> a riven spec (- prefix means malus). */
function parseRiven(args: Args): RivenSpec | undefined {
  const raw = flag(args, 'riven');
  if (!raw) return undefined;
  const stats: string[] = [];
  let malus: string | undefined;
  for (const token of raw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    if (token.startsWith('-')) malus = token.slice(1);
    else stats.push(token);
  }
  return {
    stats,
    malus,
    roll: flag(args, 'riven-roll') ? Number(flag(args, 'riven-roll')) : undefined,
    rank: flag(args, 'riven-rank') ? Number(flag(args, 'riven-rank')) : undefined,
  };
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
  const buffs = flagAll(args, 'buff')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    weapon: weapon.name,
    mods,
    arcanes: flagAll(args, 'arcane').map(parseModArg),
    buffs,
    abilityStrength: flag(args, 'strength') ? Number(flag(args, 'strength')) : undefined,
    frameMods: flagAll(args, 'frame-mods')
      .flatMap((entry) => entry.split(','))
      .map((entry) => parseModArg(entry.trim()))
      .filter((entry) => entry.name),
    riven: parseRiven(args),
    aoeDistance: flag(args, 'aoe-distance') ? Number(flag(args, 'aoe-distance')) : undefined,
    comboHits: flag(args, 'combo-hits') ? Number(flag(args, 'combo-hits')) : undefined,
    heavyAttack: args.flags.has('heavy'),
    incarnon: flagAll(args, 'incarnon').flatMap((entry) => entry.split(',')).map((e) => e.trim()).filter(Boolean),
    debuffs: {
      viralStacks: flag(args, 'viral') ? Number(flag(args, 'viral')) : undefined,
      corrosiveStacks: flag(args, 'corrosive') ? Number(flag(args, 'corrosive')) : undefined,
    },
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
          factionMultiplier: hit.factionMultiplier,
          dot: hit.dot,
          totalDps: hit.totalDps,
          activeBuffs: resolved.activeBuffs,
          abilityStrength: resolved.abilityStrength,
          riven: resolved.rivenLines,
          incarnon: resolved.incarnonLines,
          comboMultiplier: resolved.comboMultiplier,
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
  if (hit.factionMultiplier !== 1) console.log(`  faction      x${hit.factionMultiplier.toFixed(2)} vs ${enemy.faction ?? 'unknown'}`);
  if (resolved.activeBuffs.length) console.log(`  buffs        ${resolved.activeBuffs.join(', ')} @ ${num(resolved.abilityStrength)}% strength`);
  if (resolved.rivenLines.length) console.log(`  riven        ${resolved.rivenLines.join(', ')}`);
  if (resolved.incarnonLines.length) console.log(`  incarnon     ${resolved.incarnonLines.join(' / ')}`);
  if (resolved.comboMultiplier > 1) {
    console.log(`  combo        ${num(resolved.comboMultiplier, 1)}x at ${build.comboHits} hits${build.heavyAttack ? ' (heavy attack)' : ''}`);
  }
  if (hit.dot.length) {
    console.log('  ── status damage ──');
    for (const entry of hit.dot.sort((a, b) => b.dps - a.dps)) {
      console.log(
        `   ${entry.type.padEnd(12)} ${num(entry.procsPerSecond, 2).padStart(5)} proc/s  ` +
          `tick ${num(entry.tickDamage, 1).padStart(7)} × ${entry.ticks}  → ${num(entry.dps).padStart(8)} dps`,
      );
    }
    console.log(`   ${'total'.padEnd(12)} ${num(hit.totalDps).padStart(34)} dps including status`);
  }
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
      // Search names and descriptions: players look for "multishot", not "Split Chamber".
      const list = modsForWeapon(snapshot, item).filter(
        (m) => !m.conclave && (m.name.toLowerCase().includes(query) || m.description.toLowerCase().includes(query) || m.effects.some((e) => e.target.toLowerCase().includes(query))),
      );
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
    case 'incarnon': {
      const { item, suggestions } = findWeapon(snapshot, args.positional[0] ?? '');
      if (!item) throw new Error(`weapon not found: ${args.positional[0]} ${suggestions.join(', ')}`);
      const options = snapshot.incarnons[item.name] ?? [];
      if (!options.length) {
        console.log(`no Incarnon evolution data for ${item.name}`);
        break;
      }
      const byTier = new Map<string, typeof options>();
      for (const option of options) byTier.set(option.tier, [...(byTier.get(option.tier) ?? []), option]);
      for (const [tier, list] of byTier) {
        console.log(`${tier}`);
        list.forEach((option, index) => {
          const effects = option.effects
            .map((e) => `${e.target}${e.element ? `:${e.element}` : ''} ${e.flat ? `+${e.value}` : `+${(e.value * 100).toFixed(0)}%`}`)
            .join(', ');
          console.log(`  ${index}. ${option.name.padEnd(26)} ${effects || '(mechanic, no stats parsed)'}`);
        });
      }
      console.log(`\nPick with: --incarnon "${[...byTier.keys()].slice(0, 2).map((t) => `${t}:0`).join(',')}"`);
      break;
    }
    case 'rivens': {
      const query = (args.positional[0] ?? '').toLowerCase();
      for (const attribute of RIVEN_ATTRIBUTES.filter((a) => a.id.includes(query))) {
        console.log(`${attribute.id.padEnd(18)} ${attribute.label}`);
      }
      console.log(`\n${RIVEN_ATTRIBUTES.length} attribute(s). Usage: --riven damage,multishot,-zoom`);
      break;
    }
    case 'buffs': {
      for (const buff of availableBuffs(snapshot)) {
        const definition = BUFFS.find((b) => b.id === buff.id)!;
        const ability = snapshot.abilities[definition.ability];
        console.log(
          `${buff.id.padEnd(18)} ${buff.frame.padEnd(10)} ${String(ability.value ?? '-').padStart(5)}  ` +
            `${definition.kind.padEnd(18)}${buff.augments ? '(augment)' : ''}  ${definition.note ?? ''}`,
        );
      }
      console.log(`\n${BUFFS.length} buff(s) modelled. Use --buff <id> --strength <percent>.`);
      break;
    }
    case 'arcanes': {
      const query = (args.positional[1] ?? args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.arcanes).filter((a) => a.slot && a.slot !== 'warframe' && a.name.toLowerCase().includes(query));
      for (const arcane of list.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`${arcane.name.padEnd(26)} ${String(arcane.slot).padEnd(10)} R${arcane.maxRank}  ${arcane.description.slice(0, 60)}`);
      }
      console.log(`\n${list.length} weapon arcane(s)`);
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
  wfcalc arcanes [query]                weapon arcanes
  wfcalc buffs                          warframe buffs modelled
  wfcalc incarnon <weapon>              list Incarnon evolution options
  wfcalc rivens [query]                 riven attribute ids
  wfcalc enemies [query]                search enemies
  wfcalc calc <weapon> [options]        damage report
  wfcalc compare <weapon> --vs a,b      compare setups
  wfcalc serve                          web UI + JSON API (see docs/api.md)

Options: --mod NAME[:R<rank>]  --arcane NAME[:R<rank>]  --buff roar,eclipse
         --strength 284  --frame-mods "Intensify,Blind Rage"  --riven damage,multishot
         --incarnon "EVO2:0,EVO4:1"  --riven-roll 1.05
         --viral 10  --corrosive 10  (status debuffs on the target)
         --combo-hits 220  --heavy   (melee combo multiplier / heavy attack)
         --aoe-distance 4            (AoE falloff distance in metres)
         --enemy NAME  --level N  --faction NAME  --mode "Name"
         --stacks onKill=5  --status-types N  --headshot  --json`);
  }
}

main();
