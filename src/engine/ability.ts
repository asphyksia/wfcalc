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
}

export interface AbilityCast {
  frame: string;
  ability: string;
  /** Null when the ability deals no damage and is kept only for its armour strip. */
  damageType: DamageType | null;
  /** Damage at 100% Ability Strength. 0 when the ability deals none. */
  baseDamage: number;
  strength: number;
  /** Base damage scaled by Ability Strength. */
  scaledDamage: number;
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
    /** Damage a single cast deals to this target. */
    perCast: number;
    /** Casts needed to remove its health, ignoring shields. */
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
    const scaled: ScaledEnemy = scaleEnemy(snapshot, enemy, level);
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
        baseDamage: 0, strength, scaledDamage, radius: entry.radius ?? null, armorStrip, target: null, notes,
      };
    }
    const healthMod = healthModifier(snapshot, entry.damageType, healthType);
    const armorMod = armor ? healthModifier(snapshot, entry.damageType, armor.type) : 0;
    const dr = armor ? armorDamageReduction(armorAmount, armorMod, armorModel) : 0;
    const armorOnDamage = armorModel === 'armor-scaling' ? 1 : 1 + armorMod;
    // Same floor rule as weapons: on an armoured target every damage type deals at least 1.
    const perCast = Math.max(scaledDamage * (1 + healthMod) * (1 - dr) * armorOnDamage, armor ? 1 : 0);

    target = {
      enemy: enemy.name,
      level,
      healthMultiplier: 1 + healthMod,
      armorReduction: dr,
      perCast,
      castsToKill: perCast > 0 && healthPool > 0 ? Math.ceil(healthPool / perCast) : null,
    };
    if (armor) {
      notes.push(`Target armour ${Math.round(armorAmount)} reduces this type by ${(dr * 100).toFixed(1)}%.`);
    }
    notes.push('Shields are ignored here: ability damage does not always bypass them, but the pool varies by ability.');
  }

  return {
    frame: entry.frame,
    ability: entry.ability,
    damageType: entry.damageType,
    baseDamage: entry.baseDamage ?? 0,
    strength,
    scaledDamage,
    radius: entry.radius ?? null,
    armorStrip,
    target,
    notes,
  };
}
