/**
 * Enemy stats at a given level.
 *
 * Level scaling follows wiki.warframe.com/w/Enemy_Level_Scaling: two endpoint curves
 * f1 (low levels) and f2 (high levels) blended with a smoothstep between level
 * gaps L=70 and U=80, evaluated in binary32 like the game does.
 *
 * Armor damage reduction follows wiki.warframe.com/w/Armor:
 *   DR = 90% × sqrt(armor / 2700)     while armor ≤ 2700
 *   DR = armor / (armor + 300)        above that (only reachable with buffs/debuffs)
 */
import type { EnemyData, HealthPool, Snapshot } from '../types.ts';

/** f32 rounding, because the game stores these values as binary32. */
const f32 = Math.fround;

interface Curve {
  c1: number;
  e1: number;
  c2: number;
  e2: number;
}

/** Health scaling coefficients per faction family. */
const HEALTH_CURVES: Record<string, Curve> = {
  grineer: { c1: 0.015, e1: 2.12, c2: 10.7332, e2: 0.72 },
  scaldra: { c1: 0.015, e1: 2.12, c2: 10.7332, e2: 0.72 },
  corpus: { c1: 0.015, e1: 2.12, c2: 13.4165, e2: 0.55 },
  infested: { c1: 0.0225, e1: 2.12, c2: 16.0998, e2: 0.72 },
  corrupted: { c1: 0.015, e1: 2.1, c2: 10.7332, e2: 0.685 },
  orokin: { c1: 0.015, e1: 2.1, c2: 10.7332, e2: 0.685 },
  murmur: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  sentient: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  neutral: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  tenno: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
};

const SHIELD_CURVES: Record<string, Curve> = {
  corpus: { c1: 0.02, e1: 1.76, c2: 2, e2: 0.76 },
  techrot: { c1: 0.02, e1: 1.76, c2: 2, e2: 0.76 },
  corrupted: { c1: 0.02, e1: 1.75, c2: 2, e2: 0.75 },
  orokin: { c1: 0.02, e1: 1.75, c2: 2, e2: 0.75 },
  default: { c1: 0.02, e1: 1.75, c2: 1.6, e2: 0.75 },
};

/** Armor has a single curve shared by every faction. */
const ARMOR_CURVE: Curve = { c1: 0.005, e1: 1.75, c2: 0.4, e2: 0.75 };

const TRANSITION_LOW = 70;
const TRANSITION_HIGH = 80;

/** Blends the two endpoint curves with the smoothstep the game uses. */
function curveMultiplier(curve: Curve, levelGap: number): number {
  const q = f32(Math.max(0, levelGap));
  const f1 = f32(1 + f32(curve.c1 * f32(Math.pow(q, curve.e1))));
  const f2 = f32(1 + f32(curve.c2 * f32(Math.pow(q, curve.e2))));
  const t = f32(Math.min(1, Math.max(0, f32(f32(q - TRANSITION_LOW) / f32(TRANSITION_HIGH - TRANSITION_LOW)))));
  const s = f32(f32(t * t) * f32(3 - f32(2 * t)));
  return f32(f1 + f32(f32(f2 - f1) * s));
}

export interface ScaledPool extends HealthPool {
  /** Current amount at the requested level. */
  current: number;
}

export interface ScaledEnemy {
  enemy: EnemyData;
  level: number;
  health: number;
  shield: number;
  armor: number;
  /** Armor after damage-type and status effects, per incoming damage type. */
  pools: ScaledPool[];
}

/** Scales an enemy's pools to the requested level. */
export function scaleEnemy(snapshot: Snapshot, enemy: EnemyData, level: number): ScaledEnemy {
  const faction = (enemy.faction ?? 'neutral').toLowerCase();
  const q = Math.max(0, level - enemy.baseLevel);

  const healthCurve = HEALTH_CURVES[faction] ?? HEALTH_CURVES.neutral;
  const shieldCurve = SHIELD_CURVES[faction] ?? SHIELD_CURVES.default;

  const health = enemy.health * curveMultiplier(healthCurve, q);
  const shield = enemy.shield * curveMultiplier(shieldCurve, q);
  // Level scaling clamps enemy armor to the 200..2700 band (wiki: Armor).
  const armorFromLevel = enemy.armor * curveMultiplier(ARMOR_CURVE, q);
  const armor = armorFromLevel > 0 ? Math.min(2700, Math.max(200, armorFromLevel)) : 0;

  const pools: ScaledPool[] = enemy.pools.map((pool) => ({
    ...pool,
    current: pool.amount * (pool.category === 'shield' ? shield / Math.max(1, enemy.shield) : health / Math.max(1, enemy.health)),
  }));

  return { enemy, level, health, shield, armor, pools };
  void snapshot;
}

/**
 * How an armour-type damage modifier interacts with armour. This is the one modelling
 * decision in the project that has never been verified in game, and it matters a lot: at
 * 2700 armour with a +75% vulnerability the three readings differ by more than 5x.
 *
 *  - 'armor-scaling' (default): the modifier scales the armour value, so a vulnerability
 *    both raises damage and lowers DR.
 *  - 'multiply': DR comes from the plain armour value and the modifier multiplies damage
 *    on top ("independent of sources of damage reduction", per the wiki).
 *  - 'both': the modifier scales the armour *and* multiplies damage, which is what the
 *    reference open-source calculators do.
 */
export type ArmorModel = 'armor-scaling' | 'multiply' | 'both';

/**
 * Damage reduction from armor, using the current enemy formula.
 * `modifier` is the armor-type damage modifier for the incoming damage type (fraction).
 * Vulnerability (+75% for Radiation vs Alloy Armor) reduces effective armor.
 */
export function armorDamageReduction(armor: number, modifier = 0, model: ArmorModel = 'armor-scaling'): number {
  if (armor <= 0) return 0;
  const scaledByModifier = model !== 'multiply';
  const effective = scaledByModifier ? Math.max(0, armor * (1 - modifier)) : armor;
  if (effective <= 0) return 0;
  if (effective <= 2700) return Math.min(0.9, 0.9 * Math.sqrt(effective / 2700));
  return effective / (effective + 300);
}
