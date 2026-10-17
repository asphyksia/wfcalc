/**
 * Damage dealt by a resolved build to a scaled enemy.
 *
 * Model:
 *   health hit:  damage × (1 + healthTypeModifier) × (1 − armorDR(type))
 *   shield hit:  damage × (1 + shieldTypeModifier)      (armor does not apply)
 *   Toxin bypasses shields for every enemy except the documented exceptions.
 *
 * Armor type modifiers act on the armor value itself (a resistance makes armor
 * protect more, a vulnerability makes it protect less) — see docs/formulas.md.
 */
import { DAMAGE_TYPES, type DamageType, type Snapshot } from '../types.ts';
import type { ResolvedBuild } from './build.ts';
import { armorDamageReduction, type ScaledEnemy } from './enemy.ts';

export interface TypeBreakdown {
  type: DamageType;
  /** Damage of this type per projectile, before enemy modifiers. */
  raw: number;
  /** Combined multiplier applied to health damage (health modifier × armor DR). */
  healthMultiplier: number;
  /** Damage of this type per projectile that lands on health. */
  toHealth: number;
  /** Damage of this type per projectile that lands on shields. */
  toShield: number;
  /** Share of this build's status procs that will be of this type. */
  procShare: number;
}

export interface EnemyHit {
  level: number;
  health: number;
  shield: number;
  armor: number;
  breakdown: TypeBreakdown[];
  /** Damage per trigger pull against shields. */
  damagePerShotShield: number;
  /** Damage per trigger pull against health. */
  damagePerShotHealth: number;
  /** Trigger pulls needed to remove shields, then health. */
  shotsToKill: number;
  /** Seconds to kill, accounting for reloads. */
  timeToKill: number | null;
  /** Faction damage multiplier that was applied to this target (1 when none). */
  factionMultiplier: number;
  /** Highest single-type damage multiplier found (useful to sanity check element choice). */
  bestType: { type: DamageType; multiplier: number } | null;
  warnings: string[];
}

const healthModifier = (snapshot: Snapshot, type: DamageType, healthType: string): number =>
  (snapshot.modifiers[type]?.[healthType] ?? 0) / 100;

export function hitEnemy(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy): EnemyHit {
  const warnings: string[] = [];
  const armor = scaled.pools.find((pool) => pool.category === 'armor');
  const shields = scaled.pools.filter((pool) => pool.category === 'shield');
  const health = scaled.pools.filter((pool) => pool.category === 'health' || pool.category === 'object');

  if (!health.length) warnings.push('enemy has no health pool in the dataset; assuming Cloned Flesh');
  const healthType = health[0]?.type ?? 'Cloned Flesh';
  const shieldType = shields[0]?.type ?? null;

  const crit = Math.max(1, build.critMultiplier);
  const critMultiplier = 1 + build.critChance * (crit - 1);
  const totalRaw = build.damage.projectileTotal || 1;

  // Faction damage bonus (Bane mods, Roar): multiplicative with everything else and
  // only against the matching faction. `all` is Roar, which applies to every faction.
  const factionKey = (scaled.enemy.faction ?? '').toLowerCase();
  const factionMultiplier = 1 + (build.factionBonus[factionKey] ?? 0) + (build.factionBonus.all ?? 0);

  const breakdown: TypeBreakdown[] = [];
  let perProjectileShield = 0;
  let perProjectileHealth = 0;

  for (const type of DAMAGE_TYPES) {
    const raw = build.damage.perProjectile[type] ?? 0;
    if (raw <= 0) continue;

    const healthMod = healthModifier(snapshot, type, healthType);
    const armorMod = armor ? healthModifier(snapshot, type, armor.type) : 0;
    const dr = armor ? armorDamageReduction(scaled.armor, armorMod) : 0;
    const toHealth = raw * (1 + healthMod) * (1 - dr);

    const shieldMod = shieldType ? healthModifier(snapshot, type, shieldType) : 0;
    const bypassesShield = type === 'toxin' && scaled.enemy.toxinBypassesShields;
    const toShield = shieldType && !bypassesShield ? raw * (1 + shieldMod) : 0;

    breakdown.push({
      type,
      raw,
      healthMultiplier: (1 + healthMod) * (1 - dr),
      toHealth,
      toShield,
      procShare: raw / totalRaw,
    });
    perProjectileHealth += toHealth;
    perProjectileShield += toShield;
  }

  // Toxin that bypasses shields still eats health while shields are up.
  const bypassProjectile =
    breakdown
      .filter((entry) => entry.type === 'toxin' && scaled.enemy.toxinBypassesShields)
      .reduce((sum, entry) => sum + entry.toHealth, 0) * factionMultiplier;

  const shots = build.multishot;
  const damagePerShotShield = perProjectileShield * critMultiplier * shots * factionMultiplier;
  const damagePerShotHealth = perProjectileHealth * critMultiplier * shots * factionMultiplier;

  // Sequential kill: shields first (while the bypassing part already chews health), then health.
  let remainingShield = scaled.shield;
  let remainingHealth = scaled.health;
  let shotsToKill = 0;

  if (damagePerShotHealth <= 0 && damagePerShotShield <= 0) {
    shotsToKill = Infinity;
  } else {
    if (remainingShield > 0 && damagePerShotShield > 0) {
      const shieldShots = remainingShield / damagePerShotShield;
      shotsToKill += shieldShots;
      remainingHealth = Math.max(0, remainingHealth - shieldShots * bypassProjectile * critMultiplier * shots);
    } else if (remainingShield > 0) {
      // Only shield-bypassing damage: shields never go down, but health still does.
      remainingShield = 0;
    }
    if (remainingHealth > 0) {
      shotsToKill += damagePerShotHealth > 0 ? remainingHealth / damagePerShotHealth : Infinity;
    }
  }

  const cycleTime = build.magazineSize / Math.max(0.01, build.fireRate) + build.reloadTime;
  const triggerPullsPerSecond = build.magazineSize / cycleTime;
  const timeToKill = Number.isFinite(shotsToKill) && triggerPullsPerSecond > 0 ? shotsToKill / triggerPullsPerSecond : null;

  const bestType = breakdown.reduce<{ type: DamageType; multiplier: number } | null>(
    (best, entry) => (!best || entry.healthMultiplier > best.multiplier ? { type: entry.type, multiplier: entry.healthMultiplier } : best),
    null,
  );

  return {
    level: scaled.level,
    health: scaled.health,
    shield: scaled.shield,
    armor: scaled.armor,
    breakdown,
    damagePerShotShield,
    damagePerShotHealth,
    shotsToKill,
    timeToKill,
    factionMultiplier,
    bestType,
    warnings,
  };
}

/** Expected status procs per trigger pull, by damage type. */
export function statusProcs(build: ResolvedBuild): Array<{ type: DamageType; procs: number }> {
  const totalRaw = build.damage.projectileTotal || 1;
  const perShot = build.statusChance * build.multishot;
  return (Object.entries(build.damage.perProjectile) as Array<[DamageType, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([type, amount]) => ({ type, procs: perShot * (amount / totalRaw) }));
}
