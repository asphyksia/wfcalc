/**
 * Damage attenuation for boss-type enemies.
 *
 * The wiki (Damage Reduction → Special Enemies) documents the parameters, not the full
 * implementation:
 *  - Archons: Max Damage Per Trigger 460,000, Max Damage Per Second 935,000, 20% flat damage
 *    reduction and 50% reduction to status damage.
 *  - Eidolons: Max Damage Per Hit = 200% of max health, Max Damage Per Second = 100% of max
 *    health.
 *  - The game also has an exponential decay constant (2/3) that smooths the cap over time.
 *
 * This module applies the documented caps per instance and per second. The smoothing is not
 * modelled, so the time to kill is conservative (slower than or equal to the game) and the
 * result says so. A custom profile exists for Liches/Sisters/anything whose numbers are known.
 */
import type { EnemyData } from '../types.ts';

export interface AttenuationProfile {
  id: string;
  /** Max damage per instance, absolute. */
  mdpi?: number;
  /** Max damage per second, absolute. */
  mdps?: number;
  /** Max damage per instance as a fraction of the target's max health. */
  mdpiHealth?: number;
  /** Max damage per second as a fraction of the target's max health. */
  mdpsHealth?: number;
  /** Flat reduction to all damage (0.2 = 20%). */
  flatDr?: number;
  /** Additional reduction to status/DoT damage (0.5 = 50%). */
  statusDr?: number;
}

export interface ResolvedAttenuation {
  id: string;
  mdpi: number;
  mdps: number;
  flatDr: number;
  statusDr: number;
}

const PROFILES: Record<string, AttenuationProfile> = {
  archon: { id: 'archon', mdpi: 460_000, mdps: 935_000, flatDr: 0.2, statusDr: 0.5 },
  eidolon: { id: 'eidolon', mdpiHealth: 2, mdpsHealth: 1 },
};

export function attenuationProfile(id: string): AttenuationProfile | null {
  const key = id.trim().toLowerCase();
  if (key === 'none' || key === 'off') return null;
  return PROFILES[key] ?? null;
}

/** The profile with the health-relative caps resolved to numbers. */
export function resolveAttenuation(
  profile: AttenuationProfile | string | null | undefined,
  health: number,
): ResolvedAttenuation | null {
  if (!profile) return null;
  const base = typeof profile === 'string' ? attenuationProfile(profile) : profile;
  if (!base) return null;
  return {
    id: base.id,
    mdpi: base.mdpi ?? (base.mdpiHealth ? base.mdpiHealth * health : 0),
    mdps: base.mdps ?? (base.mdpsHealth ? base.mdpsHealth * health : 0),
    flatDr: Math.min(1, Math.max(0, base.flatDr ?? 0)),
    statusDr: Math.min(1, Math.max(0, base.statusDr ?? 0)),
  };
}

/** Eidolons use a health-relative profile; the enemy table names them explicitly. */
export const EIDOLON_ATTENUATION = /^Eidolon (Teralyst|Gantulyst|Hydrolyst)$/i;

/** Automatic profile for enemies whose data itself carries attenuation. */
export function automaticAttenuation(enemy: EnemyData): AttenuationProfile | null {
  return EIDOLON_ATTENUATION.test(enemy.name) ? PROFILES.eidolon : null;
}
