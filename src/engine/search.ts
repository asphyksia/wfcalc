/**
 * Build search.
 *
 * The calculator evaluates what it is given; this finds what to give it. Greedy fill followed
 * by local search over the mods that fit the weapon, under the real constraints: mod capacity,
 * polarities, how many Forma are available, the Exilus rule, and mods the player does not own.
 *
 * Every number it reports comes from the same engine the rest of the tool uses, so a build
 * found here can be pasted into the UI or the API and will resolve identically. What it cannot
 * do is stated in `notes` rather than hidden: the stance slot and Exilus slot are not searched,
 * and a mod marked `partial` makes the result a lower bound.
 */
import type { Build, BuildMod } from './build.ts';
import { resolveBuild } from './build.ts';
import { hitEnemy } from './damage.ts';
import { scaleEnemy } from './enemy.ts';
import type { ModData, Snapshot, WeaponData } from '../types.ts';

/** Effect axes that can change damage, and so are worth searching over. */
const DAMAGE_TARGETS = new Set([
  'baseDamage', 'multishot', 'critChance', 'critDamage', 'statusChance', 'statusDuration',
  'statusDamage', 'fireRate', 'reloadSpeed', 'magazine', 'element', 'forcedProc',
  'directDamage', 'faction', 'headshotMultiplier', 'heavyAttackSpeed', 'comboDuration',
  'convert', 'ammoMax',
]);

/** Slots the search fills: the eight standard ones, not the Exilus or stance slot. */
const SEARCH_SLOTS = 8;

export interface SearchRequest {
  weapon: string;
  /** `ttk` minimises time to kill the target; `dps` maximises sustained damage. */
  objective?: 'ttk' | 'dps';
  enemy?: string;
  level?: number;
  /** Mod capacity: 30, or 60 with an Orokin Catalyst. */
  capacity?: number;
  /** How many Forma the player is willing to spend; null means as many as needed. */
  maxForma?: number | null;
  /** Mods the player does not own. */
  exclude?: string[];
  /** Mods that must be in the build, e.g. one the player already has equipped. */
  mustInclude?: string[];
  /** Everything else that affects the result: buffs, frame, arcanes, riven, debuffs. */
  base?: Partial<Build>;
  /** How many builds to return. */
  limit?: number;
  /** Evaluation budget; roughly 20k evaluations per second. */
  budget?: number;
}

export interface SearchBuild {
  mods: Array<{ name: string; rank: number; drain: number; polarity: string | null; halvedByPolarity: boolean }>;
  capacityUsed: number;
  capacity: number;
  formaNeeded: number;
  fits: boolean;
  damagePerShot: number;
  burstDps: number;
  sustainedDps: number;
  timeToKill: number | null;
  shotsToKill: number | null;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  multishot: number;
  warnings: string[];
  /** Mods in the build whose numbers are a lower bound. */
  partialMods: string[];
}

export interface SearchResult {
  weapon: string;
  objective: 'ttk' | 'dps';
  enemy: string;
  level: number;
  capacity: number;
  evaluated: number;
  elapsedMs: number;
  builds: SearchBuild[];
  assumptions: string[];
  notes: string[];
}

/** One slot's polarity in the game's own terms. */
function slotPolarity(weapon: WeaponData, index: number): string | null {
  return weapon.polarities[index] ?? null;
}

/**
 * Minimum Forma needed for a set of mods to fit, and the drain once spent.
 *
 * A mod costs `baseDrain + rank`, halved (rounded up, as the game does) when the slot's
 * polarity matches. Slots the weapon already polarised half one mod each for free; every other
 * match costs one Forma, and they are spent where they save the most drain.
 */
function fitMods(
  mods: Array<{ mod: ModData; rank: number }>,
  weapon: WeaponData,
  capacity: number,
): { drain: number; formaNeeded: number; entries: SearchBuild['mods'] } {
  const free = [...weapon.polarities];
  const entries: SearchBuild['mods'] = [];
  const pending: Array<{ mod: ModData; rank: number; full: number; saving: number; halved: boolean }> = [];

  for (const { mod, rank } of mods) {
    const full = (mod.baseDrain ?? 0) + rank;
    const matching = free.indexOf(mod.polarity ?? '');
    // A free slot is one the weapon already has the right polarity on.
    if (mod.polarity && matching !== -1) {
      free.splice(matching, 1);
      pending.push({ mod, rank, full, saving: full - Math.ceil(full / 2), halved: true });
    } else {
      pending.push({ mod, rank, full, saving: full - Math.ceil(full / 2), halved: false });
    }
  }

  let drain = pending.reduce((sum, entry) => sum + (entry.halved ? Math.ceil(entry.full / 2) : entry.full), 0);
  let formaNeeded = 0;
  // Spend Forma on the remaining mods, biggest saving first, until the capacity fits.
  for (const entry of pending.filter((e) => !e.halved).sort((a, b) => b.saving - a.saving)) {
    if (drain <= capacity) break;
    drain -= entry.saving;
    entry.halved = true;
    formaNeeded++;
  }

  for (const entry of pending) {
    const paid = entry.halved ? Math.ceil(entry.full / 2) : entry.full;
    entries.push({
      name: entry.mod.name,
      rank: entry.rank,
      drain: paid,
      polarity: entry.mod.polarity,
      halvedByPolarity: entry.halved,
    });
  }
  return { drain, formaNeeded, entries };
}

/**
 * Trying every order of the elemental mods matters: the game combines them in slot order, so
 * heat+cold+toxin can end up viral+heat or viral+cold depending on where each sits.
 */
function bestElementOrder(
  names: string[],
  evaluate: (order: string[]) => number,
): string[] {
  const elementPositions = names
    .map((name, index) => ({ name, index }))
    .filter((entry) => /Rounds$|Clip$|Fire$|Stormbringer|Charged Shell|Contagious Spread|Fever Strike|North Wind|Molten Impact|Infected Clip|Hellfire|Cryo Rounds/.test(entry.name));
  if (elementPositions.length < 2 || elementPositions.length > 5) return names;

  const slots = elementPositions.map((entry) => entry.index);
  const mods = elementPositions.map((entry) => entry.name);
  let best = names;
  let bestScore = evaluate(names);

  const permute = (rest: string[], chosen: string[]): void => {
    if (!rest.length) {
      const candidate = [...names];
      slots.forEach((slot, i) => { candidate[slot] = chosen[i]; });
      const score = evaluate(candidate);
      if (score > bestScore) { bestScore = score; best = candidate; }
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, rest[i]]);
    }
  };
  permute(mods, []);
  return best;
}

export function search(snapshot: Snapshot, request: SearchRequest): SearchResult {
  const started = performance.now();
  const weapon = snapshot.weapons[request.weapon];
  if (!weapon) throw new Error(`weapon not found: ${request.weapon}`);

  const objective = request.objective ?? 'ttk';
  const level = request.level ?? 150;
  const capacity = request.capacity ?? 60;
  const maxForma = request.maxForma ?? null;
  const limit = request.limit ?? 3;
  const budget = request.budget ?? 12000;

  const excluded = new Set((request.exclude ?? []).map((n) => n.toLowerCase()));
  const mustInclude = (request.mustInclude ?? []).filter(Boolean);
  const base = request.base ?? {};

  const allMods = Object.values(snapshot.mods);
  const fitsWeapon = allMods.filter((mod) => {
    if (mod.conclave) return false;
    if (/^Flawed /.test(mod.name)) return false;
    if (excluded.has(mod.name.toLowerCase())) return false;
    // Exilus mods cannot go in the eight standard slots, so the search leaves them out.
    if (mod.isExilus) return false;
    if (!mod.classes.some((c) => weapon.modClasses.some((w) => w.toLowerCase() === c.toLowerCase()))) return false;
    // Cannonade mods lock the trigger to semi-auto, so they only fit weapons that have one.
    if (mod.effects.some((effect) => effect.target === 'requiresSemiTrigger') && weapon.trigger !== 'Semi') return false;
    return mod.effects.some((effect) => DAMAGE_TARGETS.has(String(effect.target)));
  });

  const pool = new Map(fitsWeapon.map((mod) => [mod.name, mod]));
  for (const name of mustInclude) {
    const mod = snapshot.mods[name];
    if (mod) pool.set(name, mod);
  }

  // The target does not change during the search, so it is scaled once.
  const enemyName = request.enemy ?? 'Bombard';
  const enemy = snapshot.enemies[enemyName];
  if (!enemy) throw new Error(`enemy not found: ${enemyName}`);
  const scaled = scaleEnemy(snapshot, enemy, level);

  let evaluated = 0;
  const scoreCache = new Map<string, { score: number; resolved: ReturnType<typeof resolveBuild>; hit: ReturnType<typeof hitEnemy> }>();

  const evaluateOrder = (names: string[], quick = false): number => {
    if (!names.length) return quick ? -1 : 0;
    const key = names.join('|');
    const cached = scoreCache.get(key);
    if (cached) return cached.score;
    const build: Build = { ...base, weapon: weapon.name, mods: names.map((name) => ({ name })) };
    evaluated++;
    let score: number;
    let resolved: ReturnType<typeof resolveBuild>;
    let hit: ReturnType<typeof hitEnemy>;
    try {
      resolved = resolveBuild(snapshot, build);
      hit = hitEnemy(snapshot, resolved, scaled, {});
      score = objective === 'ttk'
        ? (hit.timeToKill === null ? -1 : 1 / Math.max(hit.timeToKill, 1e-6))
        : resolved.sustainedDps;
    } catch {
      return -1;
    }
    scoreCache.set(key, { score, resolved, hit });
    return score;
  };

  const candidates = [...pool.values()]
    .filter((mod) => !mustInclude.includes(mod.name))
    .map((mod) => ({ mod, rank: mod.maxRank ?? 0 }));

  // Feasibility: the build must fit, spending no more Forma than allowed.
  const fits = (names: string[]): { ok: boolean; drain: number; formaNeeded: number; entries: SearchBuild['mods'] } => {
    const mods = names
      .map((name) => ({ mod: pool.get(name) ?? snapshot.mods[name], rank: (pool.get(name) ?? snapshot.mods[name])?.maxRank ?? 0 }))
      .filter((entry): entry is { mod: ModData; rank: number } => Boolean(entry.mod));
    const result = fitMods(mods, weapon, capacity);
    const ok = result.drain <= capacity && (maxForma === null || result.formaNeeded <= maxForma);
    return { ok, ...result };
  };

  let current = [...mustInclude];
  let currentScore = evaluateOrder(current);
  const used = new Set(current);

  // Greedy: add whichever mod helps most, while it still helps and the build still fits.
  while (current.length < SEARCH_SLOTS && evaluated < budget) {
    let bestName: string | null = null;
    let bestScore = currentScore;
    for (const { mod } of candidates) {
      if (used.has(mod.name)) continue;
      if (evaluated >= budget) break;
      const trial = [...current, mod.name];
      if (!fits(trial).ok) continue;
      const score = evaluateOrder(trial, true);
      if (score > bestScore + 1e-9) { bestScore = score; bestName = mod.name; }
    }
    if (!bestName) break;
    current = [...current, bestName];
    used.add(bestName);
    currentScore = bestScore;
  }

  // Local search: try every single change until none of them improves the build.
  let improved = true;
  while (improved && evaluated < budget) {
    improved = false;
    let bestScore = currentScore;
    let bestNames = current;
    for (let slot = 0; slot < SEARCH_SLOTS; slot++) {
      // A mod the player already has equipped is not the search's to remove.
      if (mustInclude.includes(current[slot] ?? '')) continue;
      for (const { mod } of candidates) {
        if (evaluated >= budget) break;
        if (current[slot] === mod.name) continue;
        if (used.has(mod.name) && !current.includes(mod.name)) continue;
        const trial = [...current];
        if (slot < trial.length) trial[slot] = mod.name;
        else trial.push(mod.name);
        const unique = new Set(trial);
        if (unique.size !== trial.length) continue;
        if (!fits(trial).ok) continue;
        const score = evaluateOrder(trial, true);
        if (score > bestScore + 1e-9) { bestScore = score; bestNames = trial; }
      }
      // Removing a mod is allowed too: sometimes seven mods beat eight.
      if (slot < current.length && evaluated < budget) {
        const trial = current.filter((_, index) => index !== slot);
        const score = evaluateOrder(trial, true);
        if (score > bestScore + 1e-9) { bestScore = score; bestNames = trial; }
      }
    }
    if (bestNames !== current) {
      current = bestNames;
      currentScore = bestScore;
      used.clear();
      for (const name of current) used.add(name);
      improved = true;
    }
  }

  // Element order is free to change without touching capacity.
  current = bestElementOrder(current, (order) => evaluateOrder(order, true));

  const buildFrom = (names: string[]): SearchBuild => {
    const entry = scoreCache.get(names.join('|'));
    if (!entry) evaluateOrder(names);
    const scored = scoreCache.get(names.join('|'))!;
    const fit = fits(names);
    return {
      mods: fit.entries,
      capacityUsed: fit.drain,
      capacity,
      formaNeeded: fit.formaNeeded,
      fits: fit.ok,
      damagePerShot: scored.resolved.averageShotDamage,
      burstDps: scored.resolved.burstDps,
      sustainedDps: scored.resolved.sustainedDps,
      timeToKill: scored.hit.timeToKill,
      shotsToKill: scored.hit.shotsToKill,
      critChance: scored.resolved.critChance,
      critMultiplier: scored.resolved.critMultiplier,
      statusChance: scored.resolved.statusChance,
      multishot: scored.resolved.multishot,
      warnings: scored.resolved.warnings,
      partialMods: names.filter((name) => snapshot.mods[name]?.partial),
    };
  };

  // Alternative builds: force each of the strongest few mods out and re-optimise, and keep the
  // results that are genuinely different, so the player sees a real choice rather than clones.
  const builds: SearchBuild[] = [buildFrom(current)];
  const leaders = [...candidates]
    .map(({ mod }) => ({ name: mod.name, score: evaluateOrder([...current.slice(0, SEARCH_SLOTS - 1), mod.name], true) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  for (const banned of leaders) {
    if (builds.length >= limit) break;
    if (evaluated >= budget) break;
    const without = current.filter((name) => name !== banned.name);
    used.clear();
    for (const name of without) used.add(name);
    let variant = without;
    let variantScore = evaluateOrder(variant, true);
    for (let round = 0; round < 2; round++) {
      let bestName: string | null = null;
      let bestScore = variantScore;
      for (const { mod } of candidates) {
        if (variant.length >= SEARCH_SLOTS) break;
        if (used.has(mod.name) || mod.name === banned.name) continue;
        const trial = [...variant, mod.name];
        if (!fits(trial).ok) continue;
        const score = evaluateOrder(trial, true);
        if (score > bestScore + 1e-9) { bestScore = score; bestName = mod.name; }
      }
      if (!bestName) break;
      variant = [...variant, bestName];
      used.add(bestName);
      variantScore = bestScore;
    }
    variant = bestElementOrder(variant, (order) => evaluateOrder(order, true));
    const signature = [...variant].sort().join('|');
    if (builds.some((existing) => existing.mods.map((m) => m.name).sort().join('|') === signature)) continue;
    builds.push(buildFrom(variant));
  }

  builds.sort((a, b) => (objective === 'ttk'
    ? (a.timeToKill ?? Infinity) - (b.timeToKill ?? Infinity)
    : b.sustainedDps - a.sustainedDps));

  const assumptions: string[] = [
    `All mods at max rank, ${capacity} capacity${capacity === 60 ? ' (Orokin Catalyst)' : ''}`,
    objective === 'ttk'
      ? `Objective: kill ${enemy.name} at level ${level} in the fewest shots`
      : 'Objective: highest sustained DPS',
  ];
  if (base.conditions && Object.keys(base.conditions).length) {
    assumptions.push(`Conditions: ${Object.entries(base.conditions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (base.buffs?.length) assumptions.push(`Buffs: ${base.buffs.join(', ')}`);
  if (base.frame) assumptions.push(`Warframe: ${base.frame}`);
  // Ability Strength decides how much a Roar or Eclipse is worth, so it is stated, not implied.
  const strength = scoreCache.get(current.join('|'))?.resolved.abilityStrength;
  if (base.buffs?.length && typeof strength === 'number') {
    assumptions.push(`Ability Strength: ${strength.toFixed(0)}%${base.frameMods?.length ? ' (from the frame mods)' : ''}`);
  }

  const notes: string[] = [
    'The Exilus and stance slots are not searched; an Exilus mod is never worth a standard slot.',
  ];
  if (weapon.category === 'melee') {
    notes.push('Melee stance is not searched, so its extra capacity is not counted.');
  }
  if (builds.some((build) => build.partialMods.length)) {
    const names = [...new Set(builds.flatMap((build) => build.partialMods))];
    notes.push(`Lower bound: ${names.join(', ')} have lines this calculator does not model.`);
  }
  if (maxForma !== null) notes.push(`At most ${maxForma} Forma assumed.`);

  return {
    weapon: weapon.name,
    objective,
    enemy: enemy.name,
    level,
    capacity,
    evaluated,
    elapsedMs: Math.round(performance.now() - started),
    builds: builds.slice(0, limit),
    assumptions,
    notes,
  };
}
