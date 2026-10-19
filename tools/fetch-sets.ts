/**
 * Downloads Set Mod bonuses.
 *
 * Warframe sets work two ways, and both are on the "<Set> Set" wiki page:
 *  - **amplify**: the bonus scales the effects of the set's own mods
 *    ("The Sacrificial Set enhances all equipped mods within the set. Increases the effects
 *    of both mods by 25% when both are equipped together.").
 *  - **table**: the bonus is its own effect, listed per number of pieces equipped
 *    (Vigilante: +5% chance per piece to enhance crits; Gladiator: +10% crit chance per
 *    combo stack per piece).
 *
 * Set *membership* is not here: each mod in Module:Mods/data carries a `Set` field, which
 * tools/build-data.ts reads directly.
 *
 * Run: node tools/fetch-sets.ts [--force]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'data/raw/sets');
const OUT_JSON = join(ROOT, 'data/raw/set-bonuses.json');

/** Every set in Module:Mods/data, with the page that documents its bonus. */
const SETS = [
  'Aero Set', 'Amar Set', 'Augur Set', 'Boreal Set', 'Carnis Set', 'Gladiator Set',
  'Hunter Set', 'Jugulus Set', 'Mecha Set', 'Motus Set', 'Nira Set', 'Proton Set',
  'Sacrificial Set', 'Saxum Set', 'Strain Set', 'Synth Set', 'Tek Set', 'Umbral Set',
  'Vigilante Set', 'Archon Set',
];

const force = process.argv.includes('--force');

const clean = (text: string): string =>
  text
    .replace(/'''?/g, '')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface SetBonus {
  set: string;
  kind: 'amplify' | 'table';
  /** amplify: pieces equipped -> { modName or '*' -> percentage bonus }. */
  amplify?: Record<string, Record<string, number>>;
  /** table: pieces equipped -> value (fraction). */
  table?: Record<string, number>;
  /** First sentence of the section, kept for review. */
  description: string;
}

/** Parses the "Set Bonus" section of a set page. */
function parseSetPage(set: string, wikitext: string): SetBonus | null {
  const start = wikitext.search(/==\s*Set Bonus\s*==/);
  if (start < 0) return null;
  const after = wikitext.slice(start + 14);
  const end = after.search(/\n==[^=]/);
  const section = end < 0 ? after : after.slice(0, end);
  const description = clean(section.split('\n').filter((line) => line.trim() && !line.startsWith('{|') && !line.startsWith('|') && !line.startsWith('!'))[0] ?? '');

  // Void: "enhances all equipped mods within the set" + per-piece bullets naming mods.
  if (/enhances? (all )?equipped mods|enhances all mods/i.test(section)) {
    const amplify: Record<string, Record<string, number>> = {};
    for (const bullet of section.split('\n')) {
      // "With 2 equipped", "when both are equipped", "with all 3 equipped".
      const piecesMatch = /with (\d+) equipped|when (?:both|all \d*) are equipped|with all (\d+) equipped/i.exec(bullet);
      if (!piecesMatch) continue;
      const pieces = piecesMatch[1] ?? piecesMatch[2] ?? (/both/i.test(bullet) ? '2' : '');
      const targets: Record<string, number> = {};
      // "increases the effects of A and B by 30%, and C by 25%"
      for (const chunk of clean(bullet).split(/,\s*and\s*|\s+and\s+/)) {
        const value = /by (\d+(?:\.\d+)?)\s*%/i.exec(chunk);
        if (!value) continue;
        const names = chunk.split(/\s+and\s+|,\s*/)[0]?.replace(/^.*effects? of\s*/i, '').trim() ?? '';
        for (const name of names.split(/\s*,\s*/)) {
          let mod = name.replace(/\s+by\s+.*$/i, '').trim();
          // "the effects of both mods" names no mod: it means every member of the set.
          if (/^(both|all|the)?\s*mods?$/i.test(mod)) mod = '*';
          if (mod) targets[mod] = Number(value[1]) / 100;
        }
      }
      // "Increases the effects of both mods by 25%" names no mods: apply to every member.
      if (!Object.keys(targets).length) {
        const value = /by (\d+(?:\.\d+)?)\s*%/i.exec(clean(bullet));
        if (value) targets['*'] = Number(value[1]) / 100;
      }
      if (Object.keys(targets).length) amplify[pieces] = targets;
    }
    if (Object.keys(amplify).length) return { set, kind: 'amplify', amplify, description };
  }

  // Table: "| 2 || 10% || 220%": first column is pieces, use the first numeric column.
  const table: Record<string, number> = {};
  for (const row of section.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|\|([^|]*)/.exec(row.trim());
    if (!match) continue;
    const value = /(\d+(?:\.\d+)?)\s*%/.exec(match[2]);
    if (value) table[match[1]] = Number(value[1]) / 100;
  }
  if (Object.keys(table).length) return { set, kind: 'table', table, description };
  return null;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out: Record<string, SetBonus> = {};
  let failures = 0;

  for (const set of SETS) {
    const file = join(OUT_DIR, `${set.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wiki`);
    let wikitext: string;
    try {
      wikitext = await readFile(file, 'utf8');
      if (force) throw new Error('force');
    } catch {
      const url = `https://wiki.warframe.com/w/${encodeURIComponent(set).replace(/%2F/g, '/')}?action=raw`;
      const response = await fetch(url, {
        headers: { 'user-agent': 'wfcalc/0.1 (offline damage calculator)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        failures++;
        continue;
      }
      wikitext = await response.text();
      if (/<!DOCTYPE html>/i.test(wikitext)) {
        failures++;
        continue;
      }
      await writeFile(file, wikitext);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const parsed = parseSetPage(set, wikitext);
    if (!parsed) {
      console.log(`${set.padEnd(18)} no bonus section`);
      continue;
    }
    out[set] = parsed;
    const detail =
      parsed.kind === 'amplify'
        ? Object.entries(parsed.amplify ?? {})
            .map(([pieces, targets]) => `${pieces}p: ${Object.entries(targets).map(([mod, value]) => `${mod}=${(value * 100).toFixed(0)}%`).join(', ')}`)
            .join(' | ')
        : Object.entries(parsed.table ?? {}).map(([pieces, value]) => `${pieces}p=${(value * 100).toFixed(0)}%`).join(' ');
    console.log(`${set.padEnd(18)} ${parsed.kind.padEnd(8)} ${detail}`);
  }

  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${Object.keys(out).length} set bonus(es) -> data/raw/set-bonuses.json${failures ? ` (${failures} failed)` : ''}`);
}

await main();
