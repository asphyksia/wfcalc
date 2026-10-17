/**
 * Resolves a build (weapon + mods + conditions) into modded weapon stats.
 *
 * Order of operations follows the arsenal formula documented at
 * wiki.warframe.com/w/Damage/Calculation:
 *
 *   total = base × [1 + elemental bonuses + Σ physical share × physical bonus]
 *                 × (1 + damage bonuses)
 *                 × multishot
 *
 * which, per damage type, means:
 *   physical type  = base_type × (1 + physicalBonus) × (1 + damageBonus)
 *   element        = (innate + base_total × elementBonus) × (1 + damageBonus)
 *
 * Elemental mods are combined into secondary elements in mod-slot order, exactly
 * like the game: Heat + Cold = Blast, Toxin + Electricity = Corrosive, ...
 */
import {
  BASE_ELEMENTS,
  DAMAGE_TYPES,
  ELEMENT_COMBINATIONS,
  PHYSICAL_TYPES,
  type BaseElement,
  type DamageType,
  type Effect,
  type ModData,
  type Snapshot,
  type WeaponData,
  type WeaponMode,
} from '../types.ts';
import { normalizeName } from '../data.ts';

export interface BuildMod {
  name: string;
  /** Mod rank, 0..maxRank. Defaults to max. */
  rank?: number;
}

/** Buff/condition toggles: `{ onKill: 5 }` means the on-kill effect has 5 stacks. */
export type Conditions = Record<string, number | boolean>;

export interface Build {
  weapon: string;
  mods: Array<string | BuildMod>;
  /** Which fire mode to use; defaults to the arsenal mode. */
  mode?: string;
  /** Active conditions for conditional mods. */
  conditions?: Conditions;
  /** Assume weak-point (headshot) hits. */
  headshot?: boolean;
}

export interface ResolvedDamage {
  /** Damage per projectile/pellet, per type, after elemental combination. */
  perProjectile: Partial<Record<DamageType, number>>;
  /** Total damage per projectile (sum of the above). */
  projectileTotal: number;
}

export interface ResolvedBuild {
  weapon: WeaponData;
  mode: WeaponMode | null;
  damage: ResolvedDamage;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  multishot: number;
  fireRate: number;
  reloadTime: number;
  magazineSize: number;
  /** Damage of a full trigger pull (all projectiles), before crit and faction. */
  shotDamage: number;
  /** Average damage per trigger pull including crit expectation. */
  averageShotDamage: number;
  /** Sustained DPS across reloads. */
  sustainedDps: number;
  /** Burst DPS (no reload). */
  burstDps: number;
  /** Elemental bonuses as they were combined, for display. */
  elements: Array<{ type: DamageType; share: number }>;
  /** Mods whose effects are not fully understood, so the result is a lower bound. */
  unsupportedMods: string[];
  /** Conditional effects that were not active and therefore ignored. */
  inactiveConditions: string[];
  /** Non-fatal problems (mod does not fit, incompatible pair, rank out of range). */
  warnings: string[];
}

/** How many stacks of a conditional effect are active, given the build's toggles. */
function conditionStacks(effect: Effect, conditions: Conditions): number {
  if (!effect.condition) return 1;
  let stacks = Number.POSITIVE_INFINITY;
  for (const part of effect.condition.split('+')) {
    const raw = conditions[part];
    if (!raw) return 0; // undefined, false or 0 -> effect inactive
    stacks = Math.min(stacks, typeof raw === 'number' ? raw : 1);
  }
  if (effect.maxStacks) stacks = Math.min(stacks, effect.maxStacks);
  if (effect.perStatusType) stacks *= Math.max(1, Number(conditions.statusTypes ?? 1));
  return Number.isFinite(stacks) ? stacks : 1;
}

/**
 * Scales an effect value from max rank down to the equipped rank.
 * Mods have `maxRank + 1` steps of equal size, so rank 0 is already 1/(maxRank+1)
 * of the max value: Serration R0 is +15%, R9 is +150%, R10 is +165%.
 */
function rankScale(mod: ModData, rank: number | undefined): number {
  if (rank === undefined || mod.maxRank <= 0) return 1;
  return Math.max(0, Math.min(1, (rank + 1) / (mod.maxRank + 1)));
}

function effectValue(effect: Effect, mod: ModData, rank: number | undefined): number {
  return effect.value * rankScale(mod, rank);
}

interface Collected {
  byTarget: Map<string, number>;
  elementBonuses: Array<{ element: BaseElement; amount: number }>;
  faction: Map<string, number>;
  conversions: Array<{ from: BaseElement; to: DamageType; share: number }>;
  inactive: string[];
  unsupported: string[];
  warnings: string[];
}

/** Reads a weapon mode's stats, falling back to the arsenal block. */
export function statsForMode(weapon: WeaponData, modeName?: string): { stats: WeaponData['stats']; mode: WeaponMode | null } {
  if (modeName) {
    const wanted = normalizeName(modeName);
    const mode = weapon.modes.find((m) => normalizeName(m.name) === wanted) ?? weapon.modes.find((m) => normalizeName(m.name).includes(wanted));
    if (mode) return { stats: mode.stats, mode };
  }
  return { stats: weapon.stats, mode: null };
}

export function resolveBuild(snapshot: Snapshot, build: Build): ResolvedBuild {
  const weapon = snapshot.weapons[build.weapon];
  if (!weapon) throw new Error(`unknown weapon: ${build.weapon}`);

  const { stats, mode } = statsForMode(weapon, build.mode);
  const conditions = build.conditions ?? {};

  // ------------------------------------------------------------ gather effects
  const collected: Collected = {
    byTarget: new Map(),
    elementBonuses: [],
    faction: new Map(),
    conversions: [],
    inactive: [],
    unsupported: [],
    warnings: [],
  };

  const equipped: string[] = [];
  for (const entry of build.mods) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const mod = snapshot.mods[wanted] ?? snapshot.mods[Object.keys(snapshot.mods).find((k) => normalizeName(k) === normalizeName(wanted)) ?? ''];
    if (!mod) {
      collected.warnings.push(`mod not found: ${wanted}`);
      continue;
    }
    const fits = mod.classes.some((c) => weapon.modClasses.some((w) => w.toLowerCase() === c.toLowerCase()))
      || mod.classes.some((c) => ['Mod', 'Antique', 'Primary', 'Secondary'].includes(c));
    if (!fits) collected.warnings.push(`${mod.name} does not fit a ${weapon.type} (${weapon.modClasses.join('/')})`);

    if (mod.incompatible.some((other) => equipped.includes(other))) {
      collected.warnings.push(`${mod.name} cannot be equipped with ${mod.incompatible.filter((o) => equipped.includes(o)).join(', ')}`);
    }
    equipped.push(mod.name);
    if (mod.partial) collected.unsupported.push(mod.name);

    for (const effect of mod.effects) {
      const stacks = conditionStacks(effect, conditions);
      if (stacks === 0) {
        collected.inactive.push(`${mod.name}: ${effect.raw}`);
        continue;
      }
      const value = effectValue(effect, mod, rank) * stacks;
      switch (effect.op) {
        case 'convert':
          if (effect.convertsTo && effect.element) {
            collected.conversions.push({ from: effect.element as BaseElement, to: effect.convertsTo, share: value });
          }
          break;
        case 'mult':
          collected.byTarget.set(effect.target, (collected.byTarget.get(effect.target) ?? 1) * (1 + value));
          break;
        default: {
          if (effect.target === 'element' && effect.element) {
            if ((BASE_ELEMENTS as readonly string[]).includes(effect.element)) {
              collected.elementBonuses.push({ element: effect.element as BaseElement, amount: value });
            } else if ((PHYSICAL_TYPES as readonly string[]).includes(effect.element)) {
              // "+60% Impact" boosts that physical type alone, not the whole base.
              collected.byTarget.set(effect.element, (collected.byTarget.get(effect.element) ?? 0) + value);
            } else {
              // An element the weapon may not have innately (e.g. "+90% Radiation"): adds on top.
              const key = `element:${effect.element}`;
              collected.byTarget.set(key, (collected.byTarget.get(key) ?? 0) + value);
            }
          } else if (effect.target === 'factionDamage' && effect.faction) {
            collected.faction.set(effect.faction, (collected.faction.get(effect.faction) ?? 0) + value);
          } else {
            collected.byTarget.set(effect.target, (collected.byTarget.get(effect.target) ?? 0) + value);
          }
          break;
        }
      }
    }
  }

  const bonus = (target: string): number => collected.byTarget.get(target) ?? 0;

  // ---------------------------------------------------------------- base damage
  const baseTotal = DAMAGE_TYPES.reduce((sum, type) => sum + (stats[type] ?? 0), 0);
  const damageBonus = 1 + bonus('baseDamage');

  // Physical types keep their distribution and get their own bonuses.
  const damage: Partial<Record<DamageType, number>> = {};
  for (const type of PHYSICAL_TYPES) {
    const base = stats[type] ?? 0;
    if (base <= 0) continue;
    damage[type] = base * (1 + bonus(type)) * damageBonus;
  }

  // Non-combinable damage the weapon already has (true, void, tau, or innate combined elements),
  // plus mods that grant such a type outright ("+90% Radiation" on a weapon without it).
  const innateCombined: DamageType[] = ['blast', 'corrosive', 'gas', 'magnetic', 'radiation', 'viral', 'true', 'void', 'tau'];
  for (const type of innateCombined) {
    const base = stats[type] ?? 0;
    const added = baseTotal * bonus(`element:${type}`) * damageBonus;
    if (base > 0 || added > 0) damage[type] = base * damageBonus + added;
  }

  // ------------------------------------------------- elemental combination phase
  // Contributions in application order: innate single elements first, then mods in slot order.
  const contributions: Array<{ element: BaseElement; amount: number }> = [];

  // "X% of Damage converted into <element>" (rare, mostly augments): that share of the
  // total stops being physical damage and becomes the target element instead.
  const conversions = collected.conversions.filter((c) => c.share > 0);
  const convertedShare = Math.min(1, conversions.reduce((sum, c) => sum + c.share, 0));
  if (convertedShare > 0) {
    for (const key of Object.keys(damage) as DamageType[]) damage[key] = (damage[key] ?? 0) * (1 - convertedShare);
  }

  for (const element of BASE_ELEMENTS) {
    const innate = (stats[element] ?? 0) * (1 - convertedShare);
    if (innate > 0) contributions.push({ element, amount: innate * damageBonus });
  }
  for (const conversion of conversions) {
    if ((BASE_ELEMENTS as readonly string[]).includes(conversion.to)) {
      contributions.push({ element: conversion.to as BaseElement, amount: baseTotal * conversion.share * damageBonus });
    } else {
      damage[conversion.to] = (damage[conversion.to] ?? 0) + baseTotal * conversion.share * damageBonus;
    }
  }
  for (const entry of collected.elementBonuses) {
    contributions.push({ element: entry.element, amount: baseTotal * entry.amount * damageBonus });
  }

  const pending = new Map<BaseElement, number>();
  const combined: Partial<Record<DamageType, number>> = {};
  for (const { element, amount } of contributions) {
    if (amount <= 0) continue;
    const partner = [...pending.keys()].find((other) => {
      const combo = Object.entries(ELEMENT_COMBINATIONS).find(
        ([, pair]) => pair.includes(element) && pair.includes(other) && element !== other,
      );
      return Boolean(combo);
    });
    if (partner) {
      const combo = Object.entries(ELEMENT_COMBINATIONS).find(
        ([, pair]) => pair.includes(element) && pair.includes(partner) && element !== partner,
      )!;
      combined[combo[0] as DamageType] = (combined[combo[0] as DamageType] ?? 0) + amount + (pending.get(partner) ?? 0);
      pending.delete(partner);
    } else {
      pending.set(element, (pending.get(element) ?? 0) + amount);
    }
  }
  for (const [element, amount] of pending) {
    if (amount > 0) damage[element] = (damage[element] ?? 0) + amount;
  }
  for (const [type, amount] of Object.entries(combined)) {
    damage[type as DamageType] = (damage[type as DamageType] ?? 0) + (amount as number);
  }

  const projectileTotal = Object.values(damage).reduce((sum, value) => sum + (value ?? 0), 0);

  // ------------------------------------------------------------------- crit etc.
  const critChance = (stats.critChance ?? 0) * (1 + bonus('critChance'));
  const critMultiplier = (stats.critMultiplier ?? 1) * (1 + bonus('critDamage'));
  const statusChance = Math.min(1, (stats.statusChance ?? 0) * (1 + bonus('statusChance')));
  const multishot = (stats.multishot ?? 1) * (1 + bonus('multishot'));
  const fireRate = (stats.fireRate ?? 1) * (1 + bonus('fireRate'));
  const reloadTime = (stats.reloadTime ?? 0) / (1 + bonus('reloadSpeed'));
  const magazineSize = Math.max(1, (stats.magazineSize ?? 1) * (1 + bonus('magazine')));

  const crit = Math.max(1, critMultiplier);
  const averageCritMultiplier = 1 + critChance * (crit - 1);
  const headshotMultiplier = build.headshot ? 2 : 1;

  const shotDamage = projectileTotal * multishot * headshotMultiplier;
  const averageShotDamage = shotDamage * averageCritMultiplier;

  const burstDps = averageShotDamage * fireRate;
  const damagePerMagazine = averageShotDamage * Math.max(1, magazineSize);
  const cycleTime = Math.max(1, magazineSize) / Math.max(0.01, fireRate) + reloadTime;
  const sustainedDps = cycleTime > 0 ? damagePerMagazine / cycleTime : burstDps;

  const elements = (Object.entries(damage) as Array<[DamageType, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([type, amount]) => ({ type, share: projectileTotal > 0 ? amount / projectileTotal : 0 }));

  return {
    weapon,
    mode,
    damage: { perProjectile: damage, projectileTotal },
    critChance,
    critMultiplier: crit,
    statusChance,
    multishot,
    fireRate,
    reloadTime,
    magazineSize,
    shotDamage,
    averageShotDamage,
    burstDps,
    sustainedDps,
    elements,
    unsupportedMods: collected.unsupported,
    inactiveConditions: collected.inactive,
    warnings: collected.warnings,
  };
}
