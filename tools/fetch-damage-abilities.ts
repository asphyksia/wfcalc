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

/** The max-rank damage number of the strength line, e.g. "150 / 300 / 500 / 800 (Blast damage)". */
function maxDamage(strengthRaw: string): number | null {
  const first = stripTemplates(strengthRaw.split(/<br\s*\/?>/i)[0] ?? '');
  const numbers = first.match(/\d+(?:[.,]\d+)?/g);
  return numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out: Array<{ frame: string; ability: string; damageType: string | null; baseDamage: number | null; radius: number | null; page: string }> = [];
  let failures = 0;

  for (const entry of ABILITIES) {
    const file = join(OUT_DIR, `${entry.page}.wiki`);
    let wikitext: string;
    try {
      wikitext = await readFile(file, 'utf8');
      if (force) throw new Error('force');
    } catch {
      const url = `https://wiki.warframe.com/w/${encodeURIComponent(entry.page).replace(/%2F/g, '/')}?action=raw`;
      const response = await fetch(url, { headers: { 'user-agent': 'wfcalc/0.1 (offline damage calculator)' } });
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

    const strengthRaw = templateParam(wikitext, 'strength');
    if (!strengthRaw) {
      console.error(`SKIP  ${entry.ability}: no strength line`);
      failures++;
      continue;
    }
    const baseDamage = maxDamage(strengthRaw);
    const damageType = damageTypeOf(wikitext, strengthRaw);
    // A "strength" of 1 or 1.25 is a multiplier or a percentage, not damage; the infobox mixes
    // quantities. Only entries that name a damage type and carry a plausible amount are kept.
    if (!damageType || baseDamage === null || baseDamage < 10) {
      console.error(`SKIP  ${entry.ability}: strength is not a damage amount (${baseDamage})`);
      failures++;
      continue;
    }
    const rangeRaw = templateParam(wikitext, 'range') ?? '';
    const rangeNumbers = stripTemplates(rangeRaw).match(/\d+(?:[.,]\d+)?/g);
    const radius = rangeNumbers?.length ? Number(rangeNumbers[rangeNumbers.length - 1].replace(',', '.')) : null;

    out.push({ frame: entry.frame, ability: entry.ability, damageType, baseDamage, radius, page: entry.page });
    console.log(
      `${entry.frame.padEnd(11)} ${entry.ability.padEnd(20)} ${String(baseDamage).padStart(6)} ${String(damageType ?? '?').padEnd(12)} r=${radius ?? '-'}`,
    );
  }

  await writeFile(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${out.length} damage abilities -> data/raw/damage-abilities.json${failures ? `, ${failures} skipped` : ''}`);
}

await main();
