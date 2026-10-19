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
import { search } from './engine/search.ts';
import { abilityCast } from './engine/ability.ts';
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

/** `--element-bonus heat:60` -> Kuva/Tenet elemental bonus. */
function parseElementBonus(args: Args) {
  const raw = flag(args, 'element-bonus');
  if (!raw) return undefined;
  const [type, value] = raw.split(':');
  const element = (type ?? '').trim().toLowerCase();
  const amount = Number(String(value ?? '').replace('%', '').trim());
  if (!element || !Number.isFinite(amount)) return undefined;
  return { type: element as never, value: amount > 1 ? amount / 100 : amount };
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
  // Harrow's Covenant scales with the damage prevented during invulnerability.
  const covenantDamage = flag(args, 'covenant-damage');
  if (covenantDamage) conditions.covenantDamage = Number(covenantDamage);
  return conditions;
}

/**
 * Armour strip on the target, either stated ("--armor-strip 60", percent) or taken from an
 * ability the player will cast ("--strip-from Avalanche --strength 200"). This is the seam
 * between the ability and the weapon: what a strip is worth shows up as weapon damage.
 */
function armorStripDebuff(snapshot: Snapshot, args: Args): {
  armorStrip?: number;
  armorStripFlat?: number;
  armorStripBaseFlat?: number;
} {
  // Percentage strips are additive, not multiplicative: the wiki's own example is Terrify at
  // 60% plus one Corrosive Projection at 18% leaving 22% of the armour, not 33%.
  let percent = 0;
  let flat = 0;
  let baseFlat = 0;

  const cp = flag(args, 'cp');
  if (cp !== undefined) {
    const count = Number(cp);
    if (!Number.isFinite(count) || count < 0 || count > 4) throw new Error('--cp expects 0 to 4 Corrosive Projections');
    // 18% per squad member using it.
    percent += 0.18 * count;
  }

  const direct = flag(args, 'armor-strip');
  if (direct !== undefined) {
    const value = Number(direct);
    if (!Number.isFinite(value)) throw new Error(`--armor-strip expects a percentage, got "${direct}"`);
    percent += Math.max(0, value) / 100;
  }

  const from = flag(args, 'strip-from');
  if (from) {
    const cast = abilityCast(snapshot, from, {
      strength: flag(args, 'strength') ? Number(flag(args, 'strength')) : 100,
    });
    if (!cast.armorStrip) throw new Error(`${cast.ability} does not strip armour`);
    if (cast.armorStrip.fraction !== null) percent += cast.armorStrip.fraction;
    if (cast.armorStrip.points !== null) flat += cast.armorStrip.points;
  }

  const shattering = flag(args, 'shattering-impact');
  if (shattering !== undefined) {
    const hits = Number(shattering);
    if (!Number.isFinite(hits) || hits < 0) throw new Error('--shattering-impact expects a number of hits');
    // The mod removes 1 base armour per rank, so 6 per hit at max rank.
    baseFlat += 6 * hits;
  }

  return {
    ...(percent > 0 ? { armorStrip: Math.min(1, percent) } : {}),
    ...(flat > 0 ? { armorStripFlat: flat } : {}),
    ...(baseFlat > 0 ? { armorStripBaseFlat: baseFlat } : {}),
  };
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
    frame: flag(args, 'frame'),
    warframeArcanes: flagAll(args, 'frame-arcane').flatMap((entry) => entry.split(',')).map((e) => parseModArg(e.trim())).filter((e) => e.name),
    frameMods: flagAll(args, 'frame-mods')
      .flatMap((entry) => entry.split(','))
      .map((entry) => parseModArg(entry.trim()))
      .filter((entry) => entry.name),
    riven: parseRiven(args),
    elementBonus: parseElementBonus(args),
    aoeDistance: flag(args, 'aoe-distance') ? Number(flag(args, 'aoe-distance')) : undefined,
    comboHits: flag(args, 'combo-hits') ? Number(flag(args, 'combo-hits')) : undefined,
    heavyAttack: args.flags.has('heavy'),
    // "auto" is handled by the search command; a list is passed through as it stands.
    ...(flagAll(args, 'incarnon').length
      ? { incarnon: flagAll(args, 'incarnon').flatMap((entry) => entry.split(',')).map((e) => e.trim()).filter(Boolean) }
      : {}),
    debuffs: {
      viralStacks: flag(args, 'viral') ? Number(flag(args, 'viral')) : undefined,
      corrosiveStacks: flag(args, 'corrosive') ? Number(flag(args, 'corrosive')) : undefined,
      ...armorStripDebuff(snapshot, args),
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
  const hit = hitEnemy(snapshot, resolved, scaled, {
    armorModel: (flag(args, 'armor-model') as never) ?? undefined,
  });

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
          // Armour actually applied, after every strip: the enemy's own value would make a
          // stripped target look untouched.
          armor: hit.armor,
          dot: hit.dot,
          totalDps: hit.totalDps,
          activeBuffs: resolved.activeBuffs,
          abilityStrength: resolved.abilityStrength,
          riven: resolved.rivenLines,
          incarnon: resolved.incarnonLines,
          comboMultiplier: resolved.comboMultiplier,
          critVariance: resolved.critVariance,
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
  if (build.elementBonus) {
    console.log(`  element      +${(build.elementBonus.value * 100).toFixed(0)}% ${build.elementBonus.type} (Kuva/Tenet bonus)`);
  }
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
  if (resolved.multishot >= 2 && resolved.critChance > 0) {
    const variance = resolved.critVariance;
    console.log(
      `  pellets      ${num(variance.expectedCrits, 2)} crits expected of ${num(variance.pellets, 1)}` +
        `   ${pct(variance.atLeastOneCrit)} of shots land at least one`,
    );
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

/** Machine-readable output for the listing commands; the human table stays the default. */
function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 0));
}

const wantsJson = (args: Args): boolean => args.flags.has('json');

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = loadSnapshot();

  switch (args.command) {
    case 'weapons': {
      const query = args.positional[0] ?? '';
      const list = Object.values(snapshot.weapons).filter((w) => w.name.toLowerCase().includes(query.toLowerCase()));
      if (wantsJson(args)) {
        emitJson(list.map((w) => ({
          name: w.name, category: w.category, type: w.type, masteryRank: w.masteryRank,
          disposition: w.disposition, hasRivenSlot: w.hasRivenSlot, modClasses: w.modClasses,
        })));
        break;
      }
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
      const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
      if (wantsJson(args)) {
        emitJson({
          weapon: item.name,
          modClasses: item.modClasses,
          count: sorted.length,
          mods: sorted.map((m) => ({
            name: m.name, maxRank: m.maxRank, polarity: m.polarity, rarity: m.rarity,
            baseDrain: m.baseDrain, classes: m.classes, isExilus: Boolean(m.isExilus),
            // partial marks a lower bound: at least one line of the mod is not modelled.
            partial: m.partial, outOfScopeLines: m.outOfScopeLines ?? [],
            description: m.description, levels: m.levels ?? [],
            effects: m.effects.map((e) => ({ target: e.target, op: e.op, value: e.value, condition: e.condition ?? null })),
          })),
        });
        break;
      }
      for (const mod of sorted) {
        console.log(`${mod.name.padEnd(28)} ${String(mod.maxRank).padStart(2)}  ${mod.polarity ?? '-'.padEnd(8)}  ${mod.description.split('\n')[0]}`);
      }
      console.log(`\n${list.length} mod(s) fit ${item.name}`);
      break;
    }
    case 'enemies': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.enemies).filter((e) => e.name.toLowerCase().includes(query));
      if (wantsJson(args)) {
        emitJson(list.map((e) => ({
          name: e.name, faction: e.faction ?? null, health: e.health, shield: e.shield, armor: e.armor,
          healthTypes: e.pools.map((p) => ({ type: p.type, category: p.category, amount: p.amount })),
        })));
        break;
      }
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
      if (wantsJson(args)) {
        emitJson({
          weapon: item.name,
          tiers: [...new Set(options.map((o) => o.tier))].map((tier) => ({
            tier,
            choices: options
              .filter((o) => o.tier === tier)
              .map((o, index) => ({
                index, name: o.name, text: o.text,
                effects: o.effects.map((e) => ({
                  target: e.target, element: e.element ?? null, value: e.value, flat: Boolean(e.flat), raw: e.raw,
                })),
              })),
          })),
        });
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
      const attributes = RIVEN_ATTRIBUTES.filter((a) => a.id.includes(query));
      if (wantsJson(args)) {
        emitJson({ count: RIVEN_ATTRIBUTES.length, attributes: attributes.map((a) => ({ id: a.id, label: a.label })) });
        break;
      }
      for (const attribute of attributes) {
        console.log(`${attribute.id.padEnd(18)} ${attribute.label}`);
      }
      console.log(`\n${RIVEN_ATTRIBUTES.length} attribute(s). Usage: --riven damage,multishot,-zoom`);
      break;
    }
    case 'buffs': {
      if (wantsJson(args)) {
        emitJson(availableBuffs(snapshot).map((buff) => {
          const definition = BUFFS.find((b) => b.id === buff.id)!;
          const ability = snapshot.abilities[definition.ability];
          return {
            id: buff.id, frame: buff.frame, ability: definition.ability,
            abilityBaseValue: ability?.value ?? null, kind: definition.kind,
            element: definition.element ?? null, unit: definition.unit ?? null,
            subsumable: Boolean(buff.subsumable), augments: buff.augments ?? [],
            note: definition.note ?? null, augmentOnly: Boolean(definition.augment),
          };
        }));
        break;
      }
      for (const buff of availableBuffs(snapshot)) {
        const definition = BUFFS.find((b) => b.id === buff.id)!;
        const ability = snapshot.abilities[definition.ability];
        console.log(
          `${buff.id.padEnd(18)} ${buff.frame.padEnd(10)} ${String(ability.value ?? '-').padStart(5)}  ` +
            `${definition.kind.padEnd(18)}${buff.augments ? '(augment)' : buff.subsumable ? '(subsumable)' : ''}  ${definition.note ?? ''}`,
        );
      }
      console.log(`\n${BUFFS.length} buff(s) modelled. Use --buff <id> --strength <percent>.`);
      break;
    }
    case 'arcanes': {
      const query = (args.positional[1] ?? args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.arcanes).filter((a) => a.slot && a.slot !== 'warframe' && a.name.toLowerCase().includes(query));
      const sortedArcanes = list.sort((a, b) => a.name.localeCompare(b.name));
      if (wantsJson(args)) {
        emitJson(sortedArcanes.map((a) => ({
          name: a.name, slot: a.slot, maxRank: a.maxRank, rarity: a.rarity,
          description: a.description,
          effects: a.effects.map((e) => ({ target: e.target, op: e.op, value: e.value, condition: e.condition ?? null })),
        })));
        break;
      }
      for (const arcane of sortedArcanes) {
        console.log(`${arcane.name.padEnd(26)} ${String(arcane.slot).padEnd(10)} R${arcane.maxRank}  ${arcane.description.slice(0, 60)}`);
      }
      console.log(`\n${list.length} weapon arcane(s)`);
      break;
    }
    case 'search': {
      const { item, suggestions } = findWeapon(snapshot, args.positional[0] ?? '');
      if (!item) {
        throw new Error(`weapon not found: ${args.positional[0]}${suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''}`);
      }
      const base = buildFromArgs(snapshot, args, []);
      const commaList = (name: string): string[] =>
        flagAll(args, name).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
      const result = search(snapshot, {
        weapon: item.name,
        objective: (flag(args, 'objective') as 'ttk' | 'dps' | undefined) ?? 'ttk',
        enemy: flag(args, 'enemy') ?? 'Bombard',
        level: flag(args, 'level') ? Number(flag(args, 'level')) : 150,
        capacity: flag(args, 'capacity') ? Number(flag(args, 'capacity')) : 60,
        maxForma: flag(args, 'forma') ? Number(flag(args, 'forma')) : null,
        exclude: commaList('exclude'),
        mustInclude: commaList('must'),
        limit: flag(args, 'top') ? Number(flag(args, 'top')) : 3,
        budget: flag(args, 'budget') ? Number(flag(args, 'budget')) : undefined,
        chooseIncarnon: commaList('incarnon').includes('auto'),
        base: commaList('incarnon').includes('auto') ? { ...base, incarnon: undefined } : base,
      });
      if (wantsJson(args)) {
        emitJson(result);
        break;
      }
      console.log(`${result.weapon} vs ${result.enemy} level ${result.level} — best ${result.builds.length} of ${result.evaluated} builds tried (${result.elapsedMs}ms)\n`);
      result.builds.forEach((build, index) => {
        const ttk = build.timeToKill === null ? 'cannot kill' : `${build.timeToKill.toFixed(2)}s (${Math.ceil(build.shotsToKill ?? 0)} shots)`;
        console.log(`${index + 1}. ${build.timeToKill === null ? '' : `${ttk}  `}${num(build.totalDps, 0)} dps on target (${num(build.sustainedDps, 0)} direct)  crit ${pct(build.critChance)}x${num(build.critMultiplier, 1)}  status ${pct(build.statusChance)}  multishot ${num(build.multishot, 2)}`);
        if (build.incarnonNames.length) console.log(`   Incarnon: ${build.incarnonNames.join(' | ')}`);
        console.log(`   capacity ${build.capacityUsed}/${build.capacity}${build.formaNeeded ? ` — ${build.formaNeeded} forma` : ''}${build.partialMods.length ? ` — lower bound: ${build.partialMods.join(', ')}` : ''}`);
        console.log(`   ${build.mods.map((mod) => `${mod.name}${mod.rank < 99 ? ` R${mod.rank}` : ''}`).join(', ')}\n`);
      });
      for (const assumption of result.assumptions) console.log(`· ${assumption}`);
      for (const note of result.notes) console.log(`· ${note}`);
      break;
    }
    case 'abilities': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.damageAbilities ?? {}).filter(
        (ability) => !query || ability.ability.toLowerCase().includes(query) || ability.frame.toLowerCase().includes(query),
      );
      if (wantsJson(args)) {
        emitJson(list);
        break;
      }
      for (const ability of list.sort((a, b) => a.frame.localeCompare(b.frame) || a.ability.localeCompare(b.ability))) {
        const strip = ability.armorStrip
          ? `strip ${ability.armorStrip.value}${ability.armorStrip.mode === 'percent' ? '%' : 'pts'}`
          : '';
        console.log(`${ability.frame.padEnd(11)} ${ability.ability.padEnd(22)} ${String(ability.baseDamage ?? '-').padStart(6)} ${String(ability.damageType ?? '-').padEnd(12)} r=${String(ability.radius ?? '-').padEnd(5)} ${strip}`);
      }
      console.log(`\n${list.length} damage ability(ies)`);
      break;
    }
    case 'ability': {
      const name = args.positional[0] ?? '';
      const result = abilityCast(snapshot, name, {
        strength: flag(args, 'strength') ? Number(flag(args, 'strength')) : 100,
        enemy: flag(args, 'enemy'),
        level: flag(args, 'level') ? Number(flag(args, 'level')) : 30,
        armorModel: flag(args, 'armor-model') as never,
      });
      if (wantsJson(args)) {
        emitJson(result);
        break;
      }
      console.log(`${result.frame} — ${result.ability} (${result.damageType ?? 'no damage'})`);
      const per = result.perSecond ? '/s' : '';
      console.log(`  ${num(result.baseDamage, 0)}${per} at 100% strength -> ${num(result.scaledDamage, 0)}${per} at ${result.strength}%`);
      if (result.perSecond && result.durationSeconds) {
        console.log(`  ticks for ${result.durationSeconds}s: ${num(result.scaledDamage * result.durationSeconds, 0)} in total`);
      }
      if (result.ticks) {
        console.log(`  plus ${num(result.ticks.perSecond, 0)}/s ${result.ticks.damageType ?? ''} for ${result.ticks.seconds}s: ${num(result.ticks.perSecond * result.ticks.seconds, 0)}`);
        console.log(`  full cast: ${num(result.totalDamage, 0)}`);
      }
      if (result.target) {
        console.log(`  vs ${result.target.enemy} level ${result.target.level}: ${num(result.target.perCast, 0)} per cast`);
        console.log(`  health modifier x${result.target.healthMultiplier.toFixed(2)}, armour removes ${(result.target.armorReduction * 100).toFixed(1)}%`);
        if (result.target.castsToKill !== null) console.log(`  casts to remove its health: ${result.target.castsToKill}`);
      }
      for (const note of result.notes) console.log(`· ${note}`);
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
  wfcalc search <weapon> [options]      find the best build for a target
  wfcalc abilities [query]              abilities that deal damage
  wfcalc ability <name> [options]       damage per cast of one ability
  wfcalc compare <weapon> --vs a,b      compare setups
  wfcalc serve                          web UI + JSON API (see docs/api.md)

Options: --mod NAME[:R<rank>]  --arcane NAME[:R<rank>]  --buff roar,eclipse
         --frame Rhino  --frame-mods "Intensify,Blind Rage"  --frame-arcane "Molt Augmented"
         --strength 284  --riven damage,multishot
         --incarnon "EVO2:0,EVO4:1"  --riven-roll 1.05
         --incarnon form           use the transformed profile with no evolution perks
         --element-bonus heat:60    (Kuva/Tenet elemental bonus)
         --covenant-damage 4000    (damage prevented for Harrow's Covenant)
         --viral 10  --corrosive 10  (status debuffs on the target)
         --armor-strip 60            (percent of the target's armour removed)
         --strip-from "Avalanche"    (take the strip from an ability, at --strength)
         --cp 2                      (Corrosive Projections in the squad, 18% each)
         --shattering-impact 30      (melee hits that chipped the target's base armour)
         --armor-model armor-scaling|multiply|both   (open question, see docs/formulas.md)
         --combo-hits 220  --heavy   (melee combo multiplier / heavy attack)
         --aoe-distance 4            (AoE falloff distance in metres)
         --enemy NAME  --level N  --faction NAME  --mode "Name"
         --stacks onKill=5  --status-types N  --headshot  --json

Ability options:
         --strength N          Ability Strength (100 = unmodded)
         --enemy NAME --level N  apply the target's modifiers and armour

Search options:
         --objective ttk|dps   (default ttk: kill the target fastest)
         --capacity 30|60      (default 60, i.e. with an Orokin Catalyst)
         --forma N             maximum Forma the search may spend
         --must "A,B"          mods that must be in the build
         --exclude "A,B"       mods the player does not own
         --top N               how many builds to return (default 3)
         --incarnon auto       also choose the Incarnon evolutions for the weapon
         --incarnon "EVO2:0"   use these evolutions instead
         --budget N            evaluation budget (default 12000)`);
  }
}

main();
