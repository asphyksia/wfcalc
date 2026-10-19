/**
 * Armour strip on the target.
 *
 * A strip is not a weapon stat: it is something the squad brings (Corrosive Projection), the
 * weapon chips away over time (Shattering Impact) or an ability casts before shooting. The
 * engine only needs the resulting debuff, so the CLI and the HTTP API both come through here
 * to turn their inputs into it.
 *
 * Percentage strips are additive, not multiplicative: the wiki's own example is Terrify at
 * 60% plus one Corrosive Projection at 18% leaving 22% of the armour, not 33%.
 */
import type { Snapshot } from '../types.ts';
import { abilityCast } from './ability.ts';

export interface StripOptions {
  /** Corrosive Projections in the squad, 0-4, 18% each. */
  corrosiveProjections?: number;
  /** Direct percentage strip, 0-100. */
  armorStripPercent?: number;
  /** Take the strip from an ability the player will cast. */
  stripFrom?: string;
  /** Shattering Impact hits: 6 base armour removed per hit at max rank. */
  shatteringImpactHits?: number;
  /** Ability Strength for `stripFrom`, as a percentage. */
  strength?: number;
}

export interface StripDebuff {
  armorStrip?: number;
  armorStripFlat?: number;
  armorStripBaseFlat?: number;
}

export function resolveStrip(snapshot: Snapshot, options: StripOptions): StripDebuff {
  let percent = 0;
  let flat = 0;
  let baseFlat = 0;

  if (options.corrosiveProjections !== undefined) {
    const count = Number(options.corrosiveProjections);
    if (!Number.isFinite(count) || count < 0 || count > 4) throw new Error('corrosiveProjections expects 0 to 4');
    percent += 0.18 * count;
  }

  if (options.armorStripPercent !== undefined) {
    const value = Number(options.armorStripPercent);
    if (!Number.isFinite(value)) throw new Error(`armorStripPercent expects a percentage, got "${options.armorStripPercent}"`);
    percent += Math.max(0, value) / 100;
  }

  if (options.stripFrom) {
    const cast = abilityCast(snapshot, options.stripFrom, { strength: options.strength ?? 100 });
    if (!cast.armorStrip) throw new Error(`${cast.ability} does not strip armour`);
    if (cast.armorStrip.fraction !== null) percent += cast.armorStrip.fraction;
    if (cast.armorStrip.points !== null) flat += cast.armorStrip.points;
  }

  if (options.shatteringImpactHits !== undefined) {
    const hits = Number(options.shatteringImpactHits);
    if (!Number.isFinite(hits) || hits < 0) throw new Error('shatteringImpactHits expects a number of hits');
    baseFlat += 6 * hits;
  }

  return {
    ...(percent > 0 ? { armorStrip: Math.min(1, percent) } : {}),
    ...(flat > 0 ? { armorStripFlat: flat } : {}),
    ...(baseFlat > 0 ? { armorStripBaseFlat: baseFlat } : {}),
  };
}
