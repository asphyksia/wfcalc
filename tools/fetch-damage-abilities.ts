/**
 * Downloads the wiki pages of abilities that deal damage on their own, and writes their base
 * numbers to data/raw/damage-abilities.json.
 *
 * The ability *numbers* come from the wiki infobox (`| strength = 150 / 300 / 500 / 800`).
 * Ability Strength multiplies them linearly, which is the only rule applied here; what each
 * ability does beyond raw damage (stagger, armour strip, area shape) is quoted, not modelled.
 *
 * The list is curated: the wiki has no machine-readable index that says "this ability deals
 * damage of type X", so each entry names the frame, the page and nothing more.
 *
 * Run: node tools/fetch-damage-abilities.ts [--force]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'data/raw/abilities-damage');
const OUT_JSON = join(ROOT, 'data/raw/damage-abilities.json');

/** Frames whose damage abilities are worth modelling, and the pages that document them. */
/**
 * Armour strip, curated from each ability's own wiki page: the percentage of armour removed at
 * 100% Ability Strength, or the flat number of points drained. Ability Strength scales both.
 * Avalanche: "permanently reducing their total armor by 60%", full strip at 167%.
 * Terrify: 60% at max rank. Seeking Shuriken: 70%, full at 143%. Polarize: 400 points.
 */
const ARMOR_STRIP: Record<string, { mode: 'percent' | 'flat'; value: number }> = {
  'Avalanche': { mode: 'percent', value: 60 },
  'Terrify': { mode: 'percent', value: 60 },
  'Seeking Shuriken': { mode: 'percent', value: 70 },
  'Polarize': { mode: 'flat', value: 400 },
  // Nyx: 80% at max rank and 100% strength, capped at the whole armour at 125% strength.
  // "Defense strip is capped at 100% at 125% Ability Strength" (wiki).
  'Psychic Bolts': { mode: 'percent', value: 80 },
};

/**
 * Status effects the ability itself guarantees, curated from the ability's wiki page.
 * Inferno: "100% Heat status chance" on the meteorite, whose damage is half Impact and half
 * Heat, so the proc's seed is half the listed damage. Miasma: 100% Viral status on cast.
 * Shuriken: one guaranteed Bleed per shuriken.
 */
const STATUS_PROCS: Record<string, Array<{ type: string; stacks: number; seedFraction?: number; seed?: number }>> = {
  Inferno: [{ type: 'heat', stacks: 1, seedFraction: 0.5 }],
  Fireball: [{ type: 'heat', stacks: 1, seed: 300 }],
  Miasma: [{ type: 'viral', stacks: 1 }],
  Shuriken: [{ type: 'slash', stacks: 1 }],
};

/**
 * Direct damage split across types, from the ability's own strength line.
 * Inferno: 2,500 "distributed evenly between Impact and Heat". Fireball: 800 direct + 300 AoE,
 * both Heat, for a target at the impact point.
 */
const DAMAGE_COMPONENTS: Record<string, Array<{ type: string; amount: number }>> = {
  Inferno: [{ type: 'impact', amount: 1250 }, { type: 'heat', amount: 1250 }],
  Fireball: [{ type: 'heat', amount: 800 }, { type: 'heat', amount: 300 }],
};

/**
 * Alternative modes whose numbers differ from the first tab of the wiki infobox.
 * Thermal Sunder's Hold casts 1,500 Heat at max rank/battery with a guaranteed Heat proc;
 * the Cold mode is the base entry.
 */
const ABILITY_MODES: Record<string, Record<string, {
  damageType: string; baseDamage: number; damageComponents: Array<{ type: string; amount: number }>;
  statusProcs: Array<{ type: string; stacks: number; seed?: number }>; perSecond: boolean;
}>> = {
  'Thermal Sunder': {
    heat: {
      damageType: 'heat', baseDamage: 1500,
      damageComponents: [{ type: 'heat', amount: 1500 }],
      statusProcs: [{ type: 'heat', stacks: 1, seed: 1500 }], perSecond: false,
    },
  },
};

const ABILITIES: Array<{ frame: string; page: string; ability: string }> = [
  { frame: 'Rhino', page: 'Rhino_Stomp', ability: 'Rhino Stomp' },
  { frame: 'Excalibur', page: 'Slash_Dash', ability: 'Slash Dash' },
  { frame: 'Excalibur', page: 'Exalted_Blade', ability: 'Exalted Blade' },
  { frame: 'Volt', page: 'Shock', ability: 'Shock' },
  { frame: 'Volt', page: 'Discharge', ability: 'Discharge' },
  { frame: 'Frost', page: 'Avalanche', ability: 'Avalanche' },
  { frame: 'Ember', page: 'Fireball', ability: 'Fireball' },
  { frame: 'Ember', page: 'Inferno', ability: 'Inferno' },
  { frame: 'Saryn', page: 'Spores', ability: 'Spores' },
  { frame: 'Saryn', page: 'Miasma', ability: 'Miasma' },
  { frame: 'Nova', page: 'Molecular_Prime', ability: 'Molecular Prime' },
  { frame: 'Nova', page: 'Null_Star', ability: 'Null Star' },
  { frame: 'Mag', page: 'Pull', ability: 'Pull' },
  { frame: 'Mag', page: 'Crush', ability: 'Crush' },
  { frame: 'Mesa', page: 'Peacemaker', ability: 'Peacemaker' },
  { frame: 'Ash', page: 'Shuriken', ability: 'Shuriken' },
  { frame: 'Ash', page: 'Blade_Storm', ability: 'Blade Storm' },
  { frame: 'Nidus', page: 'Virulence', ability: 'Virulence' },
  { frame: 'Khora', page: 'Whipclaw', ability: 'Whipclaw' },
  { frame: 'Wisp', page: 'Sol_Gate', ability: 'Sol Gate' },
  { frame: 'Gauss', page: 'Thermal_Sunder', ability: 'Thermal Sunder' },
  { frame: 'Protea', page: 'Blaze_Artillery', ability: 'Blaze Artillery' },
  { frame: 'Xaku', page: 'Grasp_of_Lohk', ability: 'Grasp of Lohk' },
  { frame: 'Xaku', page: 'The_Vast_Untap', ability: 'The Vast Untap' },
  { frame: 'Revenant', page: 'Reave', ability: 'Reave' },
  { frame: 'Sevagoth', page: 'Reap', ability: 'Reap' },
  { frame: 'Yareli', page: 'Aquablades', ability: 'Aquablades' },
  { frame: 'Lavos', page: 'Ophidian_Bite', ability: 'Ophidian Bite' },
  { frame: 'Dante', page: 'Dark_Verse', ability: 'Dark Verse' },
  { frame: 'Kullervo', page: 'Wrathful_Advance', ability: 'Wrathful Advance' },
  // Abilities kept for their armour strip rather than their damage.
  { frame: 'Nekros', page: 'Terrify', ability: 'Terrify' },
  { frame: 'Ash', page: 'Seeking_Shuriken', ability: 'Seeking Shuriken' },
  { frame: 'Mag', page: 'Polarize', ability: 'Polarize' },
  { frame: 'Nyx', page: 'Psychic_Bolts', ability: 'Psychic Bolts' },
];

const force = process.argv.includes('--force');

const stripTemplates = (text: string): string => text.replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();

/** Damage types the game uses, mapped from the wiki's `{{D|Blast}}` markers. */
const DAMAGE_MARKERS = [
  'impact', 'puncture', 'slash', 'heat', 'cold', 'electricity', 'toxin', 'blast',
  'corrosive', 'gas', 'magnetic', 'radiation', 'viral', 'true', 'void', 'tau',
];

/**
 * A template parameter. The value runs to the end of the line and is then cut where the next
 * parameter starts ("| name = ..."), because stopping at the first pipe would truncate
 * "800 ({{D|Blast}} damage)" in the middle of the damage marker.
 */
function templateParam(wikitext: string, key: string): string | null {
  const re = new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n]+)`, 'gi');
  const values = [...wikitext.matchAll(re)].map((match) =>
    match[1].replace(/\s*\|\s*[a-z_]+\s*=.*$/i, '').trim(),
  );
  return values.length ? values.join('<br>') : null;
}

/**
 * Damage type of the ability, read from the `{{D|...}}` markers next to the strength value.
 * Falls back to the page's own category, which the wiki fills in for damage abilities.
 */
function damageTypeOf(wikitext: string, strengthRaw: string): string | null {
  const marked = [...strengthRaw.matchAll(/\{\{\s*D\s*\|\s*([A-Za-z]+)/g)].map((match) => match[1].toLowerCase());
  if (marked.length) return marked.find((type) => DAMAGE_MARKERS.includes(type)) ?? null;
  const category = /\[\[Category:([A-Za-z]+)_Damage\]\]/i.exec(wikitext);
  if (category) {
    const type = category[1].toLowerCase();
    return DAMAGE_MARKERS.includes(type) ? type : null;
  }
  return null;
}

/** Splits "<a / b / c> (label)<br/><d - e / ...> (other label)" into labelled segments. */
function segments(strengthRaw: string): Array<{ numbers: number[]; label: string; raw: string }> {
  return strengthRaw
    .split(/<br\s*\/?>/i)
    .map((part) => {
      const clean = stripTemplates(part);
      const numbers = (clean.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));
      const label = clean.replace(/[\d.,%]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      return { numbers, label, raw: part };
    })
    .filter((segment) => segment.numbers.length > 0);
}

/**
 * Whether the ability's own prose says the damage is per second. The infobox alone is not
 * enough: Miasma's strength line reads "110 / 125 / 135 / 150 (Viral damage)" and only the
 * ability description says "per second".
 */
function isPerSecond(wikitext: string, maxDamageValue: number): boolean {
  // Only the descriptive `info` paragraph counts. The infobox itself joins its segments with
  // <br/>, so reading it makes Inferno's direct hit inherit the ring's "per second".
  // Some pages (Miasma) have no `info` parameter, so the description has to be found in the rest
  // of the page. The strength line is removed first, because its <br/>-joined segments would
  // otherwise run together.
  const info = templateParam(wikitext, 'info');
  // `??` would keep an empty string: these pages put several parameters on one line, so the
  // value sometimes comes back empty even though the description is there.
  const source = info && info.trim().length > 40 ? info : wikitext.replace(/\|\s*strength\s*=[^\n]*/gi, ' ');
  const prose = stripTemplates(source.replace(/\[\[[^\]]*\]\]/g, ' ')).replace(/<br\s*\/?>/gi, '. ');
  // The sentence that carries the damage number is the one that decides: Inferno's ring and its
  // direct hit sit in the same paragraph, and only the ring is per second.
  return prose
    .split(/\.\s/)
    .some((sentence) => /per\s+second/i.test(sentence) && sentence.includes(String(maxDamageValue)));
}

/** Max-rank duration in seconds, from `| duration = 7 / 10 / 12 / 15 s`. */
function durationOf(wikitext: string): number | null {
  const raw = templateParam(wikitext, 'duration');
  if (!raw) return null;
  const numbers = stripTemplates(raw).match(/\d+(?:[.,]\d+)?/g);
  return numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null;
}

/** The max-rank damage number of the strength line, e.g. "150 / 300 / 500 / 800 (Blast damage)". */
function maxDamage(strengthRaw: string): number | null {
  const first = stripTemplates(strengthRaw.split(/<br\s*\/?>/i)[0] ?? '');
  const numbers = first.match(/\d+(?:[.,]\d+)?/g);
  return numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out: Array<{
    frame: string; ability: string; damageType: string | null; baseDamage: number | null;
    radius: number | null; page: string;
    armorStrip: { mode: 'percent' | 'flat'; value: number } | null;
    perSecond: boolean; durationSeconds: number | null;
    extraDot: { perSecond: number; damageType: string | null; seconds: number } | null;
    statusProcs: Array<{ type: string; stacks: number; seedFraction?: number; seed?: number }>;
    damageComponents: Array<{ type: string; amount: number }>;
    modes: Record<string, any>;
  }> = [];
  let failures = 0;

  for (const entry of ABILITIES) {
    const file = join(OUT_DIR, `${entry.page}.wiki`);
    let wikitext: string;
    try {
      wikitext = await readFile(file, 'utf8');
      if (force) throw new Error('force');
    } catch {
      const url = `https://wiki.warframe.com/w/${encodeURIComponent(entry.page).replace(/%2F/g, '/')}?action=raw`;
      const response = await fetch(url, {
        headers: { 'user-agent': 'wfcalc/0.1 (offline damage calculator)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        console.error(`FAIL  ${entry.ability}: ${response.status}`);
        failures++;
        continue;
      }
      wikitext = await response.text();
      if (/<!DOCTYPE html>/i.test(wikitext)) {
        console.error(`FAIL  ${entry.ability}: page missing`);
        failures++;
        continue;
      }
      await writeFile(file, wikitext);
    }

    const armorStrip = ARMOR_STRIP[entry.ability] ?? null;
    const statusProcs = STATUS_PROCS[entry.ability] ?? [];
    const damageComponents = DAMAGE_COMPONENTS[entry.ability] ?? [];
    const modes = ABILITY_MODES[entry.ability] ?? {};
    const strengthRaw = templateParam(wikitext, 'strength');
    if (!strengthRaw && !armorStrip) {
      console.error(`SKIP  ${entry.ability}: no strength line`);
      failures++;
      continue;
    }
    const damageType = strengthRaw ? damageTypeOf(wikitext, strengthRaw) : null;
    // No damage type means no damage: the strength line of a strip-only ability (Terrify,
    // Psychic Bolts) carries the strip percentage, not an amount of damage.
    const baseDamage = strengthRaw && damageType ? maxDamage(strengthRaw) : null;
    const durationSeconds = strengthRaw ? durationOf(wikitext) : null;
    // Damage that ticks: either the main value is "per second" (Miasma) or the infobox carries
    // a second, ticking segment next to the direct hit (Inferno's ring of fire).
    const perSecond = Boolean(strengthRaw && baseDamage !== null && isPerSecond(wikitext, baseDamage));
    const extra = strengthRaw ? segments(strengthRaw).slice(1).find((segment) => /per second|\/s\b/.test(segment.label)) : undefined;
    const extraDot = extra && durationSeconds
      ? {
          perSecond: extra.numbers[extra.numbers.length - 1],
          // The damage type lives in the {{D|...}} marker, which stripping templates removes.
          damageType: damageTypeOf(wikitext, extra.raw),
          seconds: durationSeconds,
        }
      : null;
    // A "strength" of 1 or 1.25 is a multiplier or a percentage, not damage; the infobox mixes
    // quantities. Only entries that name a damage type and carry a plausible amount are kept.
    if (!armorStrip && (!damageType || baseDamage === null || baseDamage < 10)) {
      console.error(`SKIP  ${entry.ability}: strength is not a damage amount (${baseDamage})`);
      failures++;
      continue;
    }
    const rangeRaw = templateParam(wikitext, 'range') ?? '';
    const rangeNumbers = stripTemplates(rangeRaw).match(/\d+(?:[.,]\d+)?/g);
    const radius = rangeNumbers?.length ? Number(rangeNumbers[rangeNumbers.length - 1].replace(',', '.')) : null;

    out.push({
      frame: entry.frame, ability: entry.ability, damageType, baseDamage, radius, page: entry.page,
      armorStrip, perSecond, durationSeconds, extraDot, statusProcs, damageComponents, modes,
    });
    console.log(
      `${entry.frame.padEnd(11)} ${entry.ability.padEnd(20)} ${String(baseDamage).padStart(6)}${perSecond ? '/s' : '  '} ${String(damageType ?? '?').padEnd(11)} r=${String(radius ?? '-').padEnd(5)} `
        + `${armorStrip ? `strip ${armorStrip.value}${armorStrip.mode === 'percent' ? '%' : 'pts'} ` : ''}`
        + `${extraDot ? `+ ${extraDot.perSecond}/s ${extraDot.damageType} x${extraDot.seconds}s` : ''}`
        + `${statusProcs.length ? ` status ${statusProcs.map((p) => `${p.stacks}x${p.type}`).join('+')}` : ''}`,
    );
  }

  await writeFile(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${out.length} damage abilities -> data/raw/damage-abilities.json${failures ? `, ${failures} skipped` : ''}`);
}

await main();
