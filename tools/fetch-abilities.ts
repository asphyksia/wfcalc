/**
 * Downloads the wiki pages of the abilities that buff weapon damage, parses their
 * stat tables and writes data/raw/ability-stats.json.
 *
 * Only the *numbers* come from here. How each buff applies to a weapon — multiplicative
 * or additive, which damage type, what it scales with — is curated in
 * src/engine/buffs.ts, because no parser can infer that from the wikitext.
 *
 * Two page layouts exist:
 *  - Ability pages use `{{AbilityU10.x | strength = 10 / 15 / 25 / 50 % | ... }}`
 *  - Augment mods use an `emodtable` wikitable with one row per rank
 *
 * Run: node tools/fetch-abilities.ts [--force]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'data/raw/abilities');
const OUT_JSON = join(ROOT, 'data/raw/ability-stats.json');

/** Abilities and augments that add or multiply weapon damage. */
const ABILITIES: Array<{ page: string; frame: string; ability: string; kind: 'ability' | 'augment' }> = [
  { page: 'Roar', frame: 'Rhino', ability: 'Roar', kind: 'ability' },
  { page: 'Eclipse', frame: 'Mirage', ability: 'Eclipse', kind: 'ability' },
  { page: 'Vex_Armor', frame: 'Chroma', ability: 'Vex Armor', kind: 'ability' },
  { page: "Xata's_Whisper", frame: 'Xaku', ability: "Xata's Whisper", kind: 'ability' },
  { page: 'Toxic_Lash', frame: 'Saryn', ability: 'Toxic Lash', kind: 'ability' },
  { page: 'Nourish', frame: 'Grendel', ability: 'Nourish', kind: 'ability' },
  { page: 'Shock_Trooper', frame: 'Volt', ability: 'Shock Trooper', kind: 'augment' },
  { page: 'Freeze_Force', frame: 'Frost', ability: 'Freeze Force', kind: 'augment' },
  { page: 'Fireball_Frenzy', frame: 'Ember', ability: 'Fireball Frenzy', kind: 'augment' },
  { page: 'Smite_Infusion', frame: 'Oberon', ability: 'Smite Infusion', kind: 'augment' },
  { page: 'Venom_Dose', frame: 'Saryn', ability: 'Venom Dose', kind: 'augment' },
  { page: 'Amp_(Ability)', frame: 'Octavia', ability: 'Amp', kind: 'ability' },
  { page: 'Reservoirs', frame: 'Wisp', ability: 'Reservoirs', kind: 'ability' },
  { page: 'Covenant', frame: 'Harrow', ability: 'Covenant', kind: 'ability' },
  { page: 'Sonar', frame: 'Banshee', ability: 'Sonar', kind: 'ability' },
  { page: 'Warcry', frame: 'Valkyr', ability: 'Warcry', kind: 'ability' },
  { page: 'Accelerant', frame: 'Ember', ability: 'Accelerant', kind: 'ability' },
  { page: 'Resupply', frame: 'Cyte-09', ability: 'Resupply', kind: 'ability' },
  { page: 'Electric_Shield', frame: 'Volt', ability: 'Electric Shield', kind: 'ability' },
];

const force = process.argv.includes('--force');

/** Removes `{{Template|...}}` noise so the numbers stay readable. */
const stripTemplates = (text: string): string => text.replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reads every `| key = value` of an ability infobox. Multi-mote abilities
 * (Wisp's Reservoirs) repeat `strength` once per tab, and each tab is a buff.
 */
function templateParam(wikitext: string, key: string): string | null {
  const values = templateParamAll(wikitext, key);
  // Keep the <br> separators: they delimit one stat per mote/tab.
  return values.length ? values.join('<br>') : null;
}

function templateParamAll(wikitext: string, key: string): string[] {
  const re = new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|]+)`, 'gi');
  return [...wikitext.matchAll(re)].map((match) => match[1].trim());
}

interface Segment {
  /** Human label that follows the value, e.g. "damage bonus" or "Fury max damage bonus". */
  label: string;
  /** Max-rank value inside the segment. */
  max: number | null;
  raw: string;
}

/** Splits `a / b / c % (label)<br>d / e % (other label)` into labelled segments. */
function parseSegments(raw: string): Segment[] {
  return raw
    .split(/<br\s*\/?>/i)
    .map((part) => stripTemplates(part))
    .filter(Boolean)
    .map((part) => {
      const numbers = part.match(/-?\d+(?:[.,]\d+)?/g);
      const label = part
        .replace(/[-+]?\d+(?:[.,]\d+)?\s*(?:%|\/s|\/sp|\/hp|x)?/gi, ' ')
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return {
        label,
        max: numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null,
        raw: part,
      };
    });
}

/** Parses the last data row of the first `emodtable` (augment mod layout). */
function augmentTable(wikitext: string): { segments: Segment[]; duration: number | null } {
  const table = /==\s*Stats\s*==([\s\S]*?)\n\|\}/i.exec(wikitext);
  const body = table ? table[1] : wikitext;
  const rows = body
    .split(/\n\|-/)
    .map((row) => row.trim())
    .filter((row) => /^\|\s*\d+\s*\|\|/.test(row));
  if (!rows.length) return { segments: [], duration: null };

  const headerCells = body
    .split('\n')
    .filter((line) => /^!/.test(line.trim()))
    .map((line) => stripTemplates(line.replace(/^!+\s*/, '')).trim().toLowerCase());
  const cells = rows[rows.length - 1]
    .split('||')
    .map((cell) => stripTemplates(cell.replace(/^\|\s*/, '')).trim());
  // Cell 0 is the rank; the remaining cells are stats in the same order as the header.
  const stats = cells.slice(1);
  const values = stats.map((cell) => {
    const numbers = cell.match(/-?\d+(?:[.,]\d+)?/g);
    return numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null;
  });
  const duration = stats.find((cell) => /^\d+(?:\.\d+)?\s*s$/i.test(cell));
  return {
    // Column order differs between augments, so label each value with its table header.
    segments: values.map((max, index) => ({
      label: headerCells[index + 1] ?? `column ${index}`,
      max,
      raw: stats[index] ?? '',
    })),
    duration: duration ? Number(duration.replace(/[^\d.]/g, '')) : null,
  };
}

interface AbilityStats {
  ability: string;
  page: string;
  frame: string;
  kind: 'ability' | 'augment';
  /** The buff value(s) at max rank, one entry per labelled stat. */
  segments: Segment[];
  /** Convenience: the first non-null segment value. */
  value: number | null;
  duration: number | null;
  range: number | null;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out: AbilityStats[] = [];
  let failures = 0;

  for (const entry of ABILITIES) {
    const file = join(OUT_DIR, `${entry.ability.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wiki`);
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

    const rawStrength = templateParam(wikitext, 'strength');
    const rawDuration = templateParam(wikitext, 'duration');
    const rawRange = templateParam(wikitext, 'range');

    let segments: Segment[] = [];
    let duration: number | null = null;
    if (rawStrength) {
      segments = parseSegments(rawStrength);
      const numbers = rawDuration?.match(/-?\d+(?:[.,]\d+)?/g);
      duration = numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null;
    } else {
      const table = augmentTable(wikitext);
      segments = table.segments;
      duration = table.duration;
    }

    const value = segments.find((segment) => segment.max !== null)?.max ?? null;
    const numbers = rawRange?.match(/-?\d+(?:[.,]\d+)?/g);
    out.push({
      ability: entry.ability,
      page: entry.page,
      frame: entry.frame,
      kind: entry.kind,
      segments,
      value,
      duration,
      range: numbers?.length ? Number(numbers[numbers.length - 1].replace(',', '.')) : null,
    });
    console.log(
      `${entry.ability.padEnd(18)} ${String(value).padStart(6)} ${duration ? `${duration}s` : '  -'}  ${segments
        .map((s) => `${s.label}=${s.max}`)
        .slice(0, 3)
        .join(' | ')}`,
    );
  }

  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${out.length} entries -> data/raw/ability-stats.json${failures ? `, ${failures} failed` : ''}`);
}

await main();
