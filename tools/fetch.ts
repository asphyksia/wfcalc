/**
 * Downloads every upstream source into data/raw/.
 *
 * Two kinds of sources:
 *  - WFCD/warframe-items JSON (game export data: weapons, mods, enemies, arcanes)
 *  - WARFRAME Wiki raw wikitext/Lua modules (mechanics, modifier axes, damage matrix)
 *
 * Run: node tools/fetch.ts [--force]
 * Existing files are skipped unless --force, so a partial download can be resumed.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW = join(ROOT, 'data/raw');

const WFCD = 'https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json';
const WIKI = 'https://wiki.warframe.com/w';
// The MediaWiki API lives at the site root, not under /w like the raw wikitext.
const WIKI_API = 'https://wiki.warframe.com/api.php';

/** WFCD game-export datasets. `as` is the local file name. */
const wfcdItems = [
  'Primary',
  'Secondary',
  'Melee',
  'Arch-Gun',
  'Arch-Melee',
  'Archwing',
  'Warframes',
  'Arcanes',
  'Enemy',
  'Mods',
  'SentinelWeapons',
  'Sentinels',
  'Pets',
];

/** Wiki pages worth keeping verbatim: they document the formulas we implement. */
const wikiPages: Array<[page: string, file: string]> = [
  ['Module:Mods/data', 'module-mods.lua'],
  ['Module:DamageTypes/data', 'module-damagetypes.lua'],
  ['Module:Warframes/data', 'module-warframes.lua'],
  ['Damage/Calculation', 'wiki-damage-calculation.wiki'],
  ['Damage_Type_Modifier', 'wiki-damage-type-modifier.wiki'],
  ['Enemy_Level_Scaling', 'wiki-enemy-level-scaling.wiki'],
  ['Riven_Mods', 'wiki-riven-mods.wiki'],
  // The wiki's weapon database. Its primary/secondary/melee subpages carry the Incarnon form
  // as an attack of its own ("Incarnon Form"), which WFCD does not export at all.
  ['Module:Weapons/data/primary', 'module-weapons-primary.lua'],
  ['Module:Weapons/data/secondary', 'module-weapons-secondary.lua'],
  ['Module:Weapons/data/melee', 'module-weapons-melee.lua'],
];

/** Wiki categories: the wiki is the only source that says which mods are Exilus-only. */
const wikiCategories: Array<[category: string, file: string]> = [
  ['Exilus Weapon Mods', 'wiki-exilus-mods.json'],
];

const force = process.argv.includes('--force');

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function fetchTo(url: string, out: string, validate?: (text: string) => void): Promise<void> {
  if (!force && (await exists(out))) {
    console.log(`skip   ${out.slice(ROOT.length)}`);
    return;
  }
  const res = await fetch(url, {
    headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  if (text.length < 200) throw new Error(`suspiciously small response (${text.length} bytes) for ${url}`);
  validate?.(text);
  await writeFile(out, text);
  console.log(`ok     ${out.slice(ROOT.length)}  ${(text.length / 1024).toFixed(0)}KB`);
}

/**
 * Category members through the MediaWiki API, following the continuation token until the wiki
 * stops handing out batches. Written as a JSON array of page titles.
 */
async function fetchCategory(category: string, out: string): Promise<void> {
  if (!force && (await exists(out))) {
    console.log(`skip   ${out.slice(ROOT.length)}`);
    return;
  }
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'categorymembers');
    url.searchParams.set('cmtitle', `Category:${category}`);
    url.searchParams.set('cmlimit', '500');
    url.searchParams.set('format', 'json');
    if (cont) url.searchParams.set('cmcontinue', cont);
    const res = await fetch(url, { headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const body = (await res.json()) as { query?: { categorymembers?: Array<{ title: string }> }; continue?: { cmcontinue?: string } };
    for (const member of body.query?.categorymembers ?? []) titles.push(member.title);
    cont = body.continue?.cmcontinue;
  } while (cont);
  if (titles.length < 10) throw new Error(`category ${category} returned only ${titles.length} members`);
  const text = `${JSON.stringify([...new Set(titles)].sort(), null, 0)}\n`;
  await writeFile(out, text);
  console.log(`ok     ${out.slice(ROOT.length)}  ${titles.length} members`);
}

async function main(): Promise<void> {
  await mkdir(RAW, { recursive: true });

  const jobs: Array<Promise<void>> = [];
  for (const item of wfcdItems) {
    jobs.push(
      fetchTo(`${WFCD}/${item}.json`, join(RAW, `wfcd-${item}.json`), (text) => {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${item}.json is not a non-empty array`);
      }),
    );
  }
  for (const [page, file] of wikiPages) {
    jobs.push(
      fetchTo(`${WIKI}/${encodeURIComponent(page).replace(/%2F/g, '/')}?action=raw`, join(RAW, file), (text) => {
        // Missing pages come back as an HTML error page with status 200.
        if (/<!DOCTYPE html>/i.test(text)) throw new Error(`${page} is missing on the wiki (HTML error page)`);
      }),
    );
  }

  for (const [category, file] of wikiCategories) {
    jobs.push(fetchCategory(category, join(RAW, file)));
  }

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) console.error(`FAIL   ${(f as PromiseRejectedResult).reason.message}`);
  if (failed.length) {
    console.error(`\n${failed.length} source(s) failed. Re-run 'node tools/fetch.ts' to retry missing files.`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${jobs.length} sources present in data/raw/`);
  }
}

await main();
void dirname;
