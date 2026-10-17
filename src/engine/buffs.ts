/**
 * Warframe buffs that change weapon damage.
 *
 * The **numbers** come from the wiki (data/raw/ability-stats.json → snapshot.abilities):
 * max-rank value, scaled by Ability Strength.
 *
 * The **mechanics** — whether a buff multiplies all damage or adds a damage type,
 * and how it interacts with mods — are curated here, because the wikitext describes
 * them in prose. Each entry cites the wiki page it was taken from and the sentence
 * that justifies the modelling choice.
 *
 * Ability Strength is a percentage: 100 = unmodded, 284 = a typical Intensify build.
 */
import type { AbilityData, DamageType, Effect, Snapshot } from '../types.ts';

export type BuffKind =
  | 'damage' // multiplies total weapon damage (same bucket as Serration)
  | 'faction' // faction damage bonus: multiplicative with damage mods
  | 'element' // adds a damage type worth N% of base damage
  | 'elementMultiplier' // multiplies one existing damage type
  | 'speed' // attack / fire rate
  | 'weakPoint'; // multiplies weak-point damage

export interface BuffDefinition {
  /** Stable id used by the CLI/UI. */
  id: string;
  /** Ability name as it appears in the snapshot. */
  ability: string;
  kind: BuffKind;
  /** Which damage type the buff adds or multiplies, when relevant. */
  element?: DamageType;
  /** Picks the right number when the infobox lists several stats. */
  pick?: (ability: AbilityData) => number | null;
  /**
   * How to read the number: `percent` means the stat is a bonus ("50%" -> +0.5),
   * `multiplier` means it is a factor ("2.5x" -> x2.5).
   */
  unit?: 'percent' | 'multiplier';
  /** Weaker version of the ability (augment-only, ally-only, ramp-up...). */
  note?: string;
  /** True for augments: only available if that augment mod is equipped. */
  augment?: boolean;
}

/** Reads the first segment whose label contains all the given words. */
const byLabel =
  (...words: string[]) =>
  (ability: AbilityData): number | null => {
    const segment = ability.segments.find((entry) => words.every((word) => entry.label.includes(word)));
    return segment?.max ?? ability.value ?? null;
  };

/** Reads a segment by position, for the infoboxes whose labels got stripped. */
const byIndex =
  (index: number) =>
  (ability: AbilityData): number | null =>
    ability.segments[index]?.max ?? ability.value ?? null;

/**
 * Registry of supported buffs.
 *
 * | Ability | Effect on weapons | Source |
 * |---|---|---|
 * | Roar | +50% damage to all factions, "considered Faction Damage Bonus" | Rhino/Roar |
 * | Eclipse | +200% weapon damage (day side) | Mirage/Eclipse |
 * | Vex Armor | up to +275% weapon damage (Fury, fully charged) | Chroma/Vex_Armor |
 * | Xata's Whisper | adds Void damage worth 26% of base | Xaku/Xata's_Whisper |
 * | Toxic Lash | adds Toxin damage worth 30% to guns | Saryn/Toxic_Lash |
 * | Nourish | adds Viral damage worth 250% of base | Grendel/Nourish |
 * | Shock Trooper | adds 100% Electricity | Volt/Shock_Trooper (augment) |
 * | Freeze Force | adds 100% Cold | Frost/Freeze_Force (augment) |
 * | Fireball Frenzy | adds 100% Heat | Ember/Fireball_Frenzy (augment) |
 * | Smite Infusion | adds 100% Radiation | Oberon/Smite_Infusion (augment) |
 * | Venom Dose | adds 100% Corrosive | Saryn/Venom_Dose (augment) |
 * | Warcry | +50% attack speed | Valkyr/Warcry |
 * | Accelerant | ×2.5 Heat damage taken by affected enemies | Ember/Accelerant |
 * | Sonar | weak points take ×5 damage | Banshee/Sonar |
 * | Resupply | +25% weapon damage | Cyte-09/Resupply |
 */
export const BUFFS: BuffDefinition[] = [
  { id: 'roar', ability: 'Roar', kind: 'faction' },
  { id: 'eclipse', ability: 'Eclipse', kind: 'damage', pick: byLabel('damage', 'bonus'), note: 'day side' },
  { id: 'vex-armor', ability: 'Vex Armor', kind: 'damage', pick: byLabel('fury', 'max'), note: 'Fury at maximum' },
  { id: 'xatas-whisper', ability: "Xata's Whisper", kind: 'element', element: 'void' },
  { id: 'toxic-lash', ability: 'Toxic Lash', kind: 'element', element: 'toxin', pick: byLabel('gun') },
  { id: 'nourish', ability: 'Nourish', kind: 'element', element: 'viral', pick: byIndex(3) },
  { id: 'shock-trooper', ability: 'Shock Trooper', kind: 'element', element: 'electricity', augment: true, pick: byLabel('damage') },
  { id: 'freeze-force', ability: 'Freeze Force', kind: 'element', element: 'cold', augment: true, pick: byLabel('damage') },
  { id: 'fireball-frenzy', ability: 'Fireball Frenzy', kind: 'element', element: 'heat', augment: true, pick: byLabel('damage') },
  { id: 'smite-infusion', ability: 'Smite Infusion', kind: 'element', element: 'radiation', augment: true, pick: byLabel('damage') },
  { id: 'venom-dose', ability: 'Venom Dose', kind: 'element', element: 'corrosive', augment: true, pick: byLabel('damage') },
  { id: 'warcry', ability: 'Warcry', kind: 'speed', pick: byLabel('attack', 'speed') },
  { id: 'accelerant', ability: 'Accelerant', kind: 'elementMultiplier', element: 'heat', unit: 'multiplier', pick: byLabel('multiplier') },
  { id: 'sonar', ability: 'Sonar', kind: 'weakPoint', unit: 'multiplier' },
  { id: 'resupply', ability: 'Resupply', kind: 'damage', pick: byLabel('weapon', 'damage') },
];

export const buffById = (id: string): BuffDefinition | undefined =>
  BUFFS.find((buff) => buff.id === id) ?? BUFFS.find((buff) => buff.ability.toLowerCase() === id.toLowerCase());

/**
 * Turns an active buff into effects, given the caster's Ability Strength.
 * `strength` is a percentage: 100 means unmodded.
 */
export function buffEffects(snapshot: Snapshot, definition: BuffDefinition, strength = 100): Effect[] {
  const ability = snapshot.abilities[definition.ability];
  if (!ability) return [];
  const base = definition.pick ? definition.pick(ability) : ability.value;
  if (base === null || base === undefined) return [];

  const scale = strength / 100;
  const isMultiplier = definition.unit === 'multiplier';
  const raw = `${definition.ability} ${base}${isMultiplier ? 'x' : '%'} × ${strength}% strength`;
  // Bonuses are fractions (+50% -> 0.5); multipliers are factors (x2.5 -> 2.5).
  const magnitude = isMultiplier ? base * scale : (base / 100) * scale;
  const value = magnitude;

  switch (definition.kind) {
    case 'damage':
      return [{ target: 'baseDamage', op: 'add', value, raw }];
    case 'faction':
      // Roar is explicitly a faction damage bonus: multiplicative with damage mods.
      return [{ target: 'factionDamage', faction: 'all', op: 'add', value, raw }];
    case 'element':
      return [{ target: 'element', element: definition.element, op: 'add', value, raw }];
    case 'elementMultiplier':
      // "x2.5 Heat damage": the engine applies (1 + value), so pass the bonus part.
      return [{ target: 'elementMultiplier', element: definition.element, op: 'mult', value: Math.max(-1, value - 1), raw }];
    case 'speed':
      return [{ target: 'fireRate', op: 'add', value, raw }];
    case 'weakPoint':
      // Sonar replaces the weak-point multiplier (default x2) with its scaled value.
      return [{ target: 'weakPointOverride', op: 'add', value, raw }];
    default:
      return [];
  }
}

/** Every buff that is currently available, for CLI/UI listings. */
export function availableBuffs(snapshot: Snapshot): Array<{ id: string; ability: string; frame: string; augments: boolean }> {
  return BUFFS.filter((buff) => snapshot.abilities[buff.ability]).map((buff) => ({
    id: buff.id,
    ability: buff.ability,
    frame: snapshot.abilities[buff.ability].frame,
    augments: Boolean(buff.augment),
  }));
}
