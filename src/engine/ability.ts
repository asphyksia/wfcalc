/**
 * Ability damage.
 *
 * An ability that deals damage does not go through the weapon pipeline: no crit, no
 * multishot, no status. What it shares with weapons is the target maths, so this module
 * applies exactly the same rules `hitEnemy` does — health-type modifier, armour damage
 * reduction with the armour-type modifier, and the minimum-1-per-type rule on armoured
 * targets — to a flat amount of damage of one type.
 *
 * Ability Strength multiplies the base damage linearly, which the wiki states and the game
 * follows for every ability modelled here.
 */
import { armorDamageReduction, scaleEnemy, type ArmorModel, type ScaledEnemy } from './enemy.ts';
import type { DamageType, Snapshot } from '../types.ts';

export interface AbilityCastOptions {
  /** Ability Strength as a percentage, 100 being unmodded. */
  strength?: number;
  enemy?: string;
  level?: number;
  armorModel?: ArmorModel;
  /** Target is an Eximus: add its level-scaled Overguard. */
  eximus?: boolean;
  /** Explicit Overguard amount instead of the Eximus formula. */
  overguard?: number;
}

export interface AbilityCast {
  frame: string;
  ability: string;
  /** Null when the ability deals no damage and is kept only for its armour strip. */
  damageType: DamageType | null;
  /** Damage at 100% Ability Strength. 0 when the ability deals none. */
  baseDamage: number;
  strength: number;
  /** Base damage scaled by Ability Strength, per hit or per second as the ability does. */
  scaledDamage: number;
  /** True when scaledDamage is per second. */
  perSecond: boolean;
  /** Seconds the effect lasts, when it does. */
  durationSeconds: number | null;
  /** Everything a single cast deals, ticks included, at 100% accuracy against nothing. */
  totalDamage: number;
  /** Ticking part of the cast, if any (Inferno's ring alongside its direct hit). */
  ticks: { perSecond: number; damageType: string | null; seconds: number } | null;
  radius: number | null;
  /**
   * Armour this cast removes, scaled by Ability Strength. Percentage strips scale linearly and
   * cap at the whole armour; Polarize drains a flat number of points. This is what a weapon
   * build benefits from, so it is reported here rather than buried in the ability.
   */
  armorStrip: { mode: 'percent' | 'flat'; fraction: number | null; points: number | null } | null;
  target: {
    enemy: string;
    level: number;
    /** Damage of this ability's type after the health-type modifier. */
    healthMultiplier: number;
    /** Fraction of damage removed by armour. */
    armorReduction: number;
    /** Damage a single cast deals to this target's health. */
    perCast: number;
    /** Overguard the target has, and the direct damage of one cast against it. */
    overguard: number;
    overguardPerCast: number;
    /** Casts needed to break Overguard and then remove health; shields are ignored. */
    castsToKill: number | null;
  } | null;
  notes: string[];
}

const healthModifier = (snapshot: Snapshot, type: DamageType, healthType: string): number =>
  (snapshot.modifiers[type]?.[healthType] ?? 0) / 100;

export function abilityCast(snapshot: Snapshot, abilityName: string, options: AbilityCastOptions = {}): AbilityCast {
  const wanted = abilityName.trim().toLowerCase();
  const entry = Object.values(snapshot.damageAbilities ?? {}).find(
    (ability) => ability.ability.toLowerCase() === wanted,
  );
  if (!entry) {
    const known = Object.values(snapshot.damageAbilities ?? {}).map((ability) => ability.ability);
    throw new Error(`ability not found: ${abilityName}${known.length ? ` (known: ${known.slice(0, 8).join(', ')}...)` : ''}`);
  }

  const strength = options.strength ?? 100;
  const scaledDamage = (entry.baseDamage ?? 0) * (strength / 100);
  // An ability that ticks deals its number every second for its duration: Miasma is 150 per
  // second for 6 seconds, not 150 once. Inferno is a direct hit plus a ring that ticks.
  const durationSeconds = entry.durationSeconds ?? null;
  const seconds = entry.perSecond && durationSeconds ? durationSeconds : 1;
  const mainTotal = scaledDamage * seconds;
  const ticks = entry.extraDot
    ? {
        perSecond: entry.extraDot.perSecond * (strength / 100),
        damageType: entry.extraDot.damageType,
        seconds: entry.extraDot.seconds,
      }
    : null;
  const totalDamage = mainTotal + (ticks ? ticks.perSecond * ticks.seconds : 0);
  const armorStrip = entry.armorStrip
    ? {
        mode: entry.armorStrip.mode,
        fraction: entry.armorStrip.mode === 'percent'
          ? Math.min(1, (entry.armorStrip.value * (strength / 100)) / 100)
          : null,
        points: entry.armorStrip.mode === 'flat'
          ? entry.armorStrip.value * (strength / 100)
          : null,
      }
    : null;
  const notes: string[] = [];
  if (entry.baseDamage) {
    notes.push('Ability damage is flat: it does not crit, use multishot or roll status, and mods on the weapon do not apply.');
  } else {
    notes.push(`${entry.ability} deals no damage of its own; it is here for its armour strip.`);
  }
  if (armorStrip) {
    notes.push(
      armorStrip.mode === 'percent'
        ? `Removes ${(armorStrip.fraction! * 100).toFixed(1)}% of the target's armour; it is the weapon that benefits.`
        : `Drains ${Math.round(armorStrip.points!)} armour points; it is the weapon that benefits.`,
    );
  }

  let target: AbilityCast['target'] = null;
  if (options.enemy) {
    const enemy = snapshot.enemies[options.enemy];
    if (!enemy) throw new Error(`enemy not found: ${options.enemy}`);
    const level = options.level ?? 30;
    const scaled: ScaledEnemy = scaleEnemy(snapshot, enemy, level, {
      eximus: options.eximus,
      overguard: options.overguard,
    });
    const armorModel = options.armorModel ?? 'armor-scaling';
    // A pool's `amount` is its level-1 value: the scaled totals live on the enemy itself.
    const armor = scaled.pools.find((pool) => pool.category === 'armor');
    const health = scaled.pools.filter((pool) => pool.category === 'health' || pool.category === 'object');
    const healthType = health[0]?.type ?? 'Cloned Flesh';
    const healthPool = scaled.health;
    const armorAmount = scaled.armor;

    if (!entry.damageType || !entry.baseDamage) {
      // Nothing to damage: only the strip matters, and it is already reported above.
      return {
        frame: entry.frame, ability: entry.ability, damageType: entry.damageType,
        baseDamage: 0, strength, scaledDamage, perSecond: Boolean(entry.perSecond),
        durationSeconds, totalDamage, ticks, radius: entry.radius ?? null,
        armorStrip, target: null, notes,
      };
    }
    // Each component keeps its own damage type, so each gets its own modifiers.
    const against = (type: DamageType, amount: number): { dealt: number; healthMod: number; dr: number } => {
      const healthMod = healthModifier(snapshot, type, healthType);
      const armorMod = armor ? healthModifier(snapshot, type, armor.type) : 0;
      const dr = armor ? armorDamageReduction(armorAmount, armorMod, armorModel) : 0;
      const armorOnDamage = armorModel === 'armor-scaling' ? 1 : 1 + armorMod;
      // Same floor rule as weapons: on an armoured target every damage type deals at least 1.
      return { dealt: Math.max(amount * (1 + healthMod) * (1 - dr) * armorOnDamage, armor ? 1 : 0), healthMod, dr };
    };

    const main = against(entry.damageType, mainTotal);
    const extra = ticks?.damageType ? against(ticks.damageType as DamageType, ticks.perSecond * ticks.seconds) : null;
    const perCast = main.dealt + (extra?.dealt ?? 0);
    const healthMod = main.healthMod;
    const dr = main.dr;
    // Overguard is neutral except Void (+50%), ignores armour, and is a separate layer first.
    const againstOverguard = (type: DamageType, amount: number): number =>
      amount * (1 + healthModifier(snapshot, type, 'Overguard'));
    const overguardPerCast = againstOverguard(entry.damageType, mainTotal)
      + (ticks?.damageType ? againstOverguard(ticks.damageType as DamageType, ticks.perSecond * ticks.seconds) : 0);
    const overguardCasts = scaled.overguard > 0 && overguardPerCast > 0
      ? Math.ceil(scaled.overguard / overguardPerCast)
      : 0;
    const healthCasts = perCast > 0 && healthPool > 0 ? Math.ceil(healthPool / perCast) : 0;
    const castsToKill = scaled.overguard > 0 && overguardPerCast <= 0
      ? null
      : overguardCasts + healthCasts > 0
        ? overguardCasts + healthCasts
        : null;

    target = {
      enemy: enemy.name,
      level,
      healthMultiplier: 1 + healthMod,
      armorReduction: dr,
      perCast,
      overguard: scaled.overguard,
      overguardPerCast,
      castsToKill,
    };
    if (armor) {
      notes.push(`Target armour ${Math.round(armorAmount)} reduces this type by ${(dr * 100).toFixed(1)}%.`);
    }
    notes.push('Shields are ignored here: ability damage does not always bypass them, but the pool varies by ability.');
    if (scaled.overguard > 0) {
      notes.push(`Overguard ${Math.round(scaled.overguard)} is a separate layer: status DoT and Magnetic amplification are not modelled.`);
    }
  }

  return {
    frame: entry.frame,
    ability: entry.ability,
    damageType: entry.damageType,
    baseDamage: entry.baseDamage ?? 0,
    strength,
    scaledDamage,
    perSecond: Boolean(entry.perSecond),
    durationSeconds,
    totalDamage,
    ticks,
    radius: entry.radius ?? null,
    armorStrip,
    target,
    notes,
  };
}
