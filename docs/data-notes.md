# Data notes

Hard-won details about the upstream data. Read this before touching
`tools/build-data.ts`; every item here was a bug that cost time.

## Sources and authority

| Source | Use for | Notes |
|---|---|---|
| `wiki.warframe.com/w/Module:Mods/data?action=raw` | Master mod list, descriptions, internal upgrade axes | 1550 mods. The wiki's `api.php` is disabled; `?action=raw` still works. |
| `wiki.warframe.com/w/Module:DamageTypes/data` | Damage-type modifier matrix, health type → category | Percentage points per health type |
| `wiki.warframe.com/w/Module:Warframes/data` | Warframe base stats + abilities | Not used yet (phase 2) |
| `wiki.warframe.com/w/Damage/Calculation`, `Armor`, `Enemy_Level_Scaling`, `Riven_Mods` | Formulas | Kept verbatim in `data/raw/` for reference |
| `WFCD/warframe-items` JSON | Per-rank mod numbers, weapon stats, enemies, arcanes | Public repo, MIT-licensed tooling |

The Fandom wiki (`warframe.fandom.com`) is **frozen since 2025-06** and sits behind
Cloudflare. Do not use it.

## Traps found so far

1. **WFCD has duplicate mod names.** "Serration" appears twice: the real one and the
   flawed/beginner variant (`.../Beginner/WeaponDamageAmountModBeginner`, 4 ranks,
   +40%). Picking by name silently gives wrong numbers. The pipeline therefore uses
   the wiki as the master list and joins WFCD by `InternalName` == `uniqueName`.

2. **WFCD line breaks are literal `\n`**, not newlines: `"On Kill:\n+30% Multishot..."`.
   `cleanStatText` converts them. Without this, every Galvanized mod parses as one
   unparseable line.

3. **Multipliers start with `x`**: `x1.3 Damage to Grineer`. A number regex anchored on
   `^[+-]?\d` misses them entirely.

4. **`attacks[]` is not a decomposition.** It mixes parts of one shot (Kuva Bramma:
   "Charged Shot" impact + "Radial Attack" blast) with genuinely different modes
   (Soma Prime: normal + Incarnon). Summing them is wrong; the arsenal `damage` block
   already includes the parts of the main shot. 124 of 197 primaries have a mismatch
   if you sum `attacks`. The engine therefore treats the top-level stat block as the
   canonical mode and `attacks` as selectable alternatives.

5. **Shotgun `damage.total` is per pellet**, and `multishot` is the pellet count
   (Strun Wraith: 40 damage per pellet × 10). Status chance in the dataset is already
   per pellet.

6. **`attacks[].crit_chance` is a percentage** (35) while `criticalChance` is a
   fraction (0.35).

7. **WFCD enemy `resistances[].affectors[].modifier` values do not match the wiki
   matrix** (Bombard's Alloy Armor shows Radiation `0` where the wiki says +75).
   Only `resistances[].type` and `.amount` are trustworthy; modifiers come from the
   wiki module.

8. **Wiki Lua modules are data followed by real code inside a long comment.** The
   parser stops at the first non-`local`/`return` statement and then looks for a
   trailing `return <name>`. `--[= =[` (with a space) is *not* a valid long-bracket
   opener, so code after it is live Lua on the wiki — never execute those modules.

9. **Node runs TypeScript with type stripping only.** No parameter properties, no
   enums, no namespaces, no emit. `erasableSyntaxOnly` in `tsconfig.json` enforces it.
   `import` paths must keep the `.ts` extension.

10. **Mod text needs to be split before parsing**: on newlines, on ` and ` followed by a
    number, and on "+X% Critical Chance and Damage".

11. **Ability pages have two layouts.** Abilities use `{{AbilityU10.x | strength = 10 / 15 / 25 / 50 % }}`;
    augments (Shock Trooper, Freeze Force...) use an `emodtable` whose **column order differs per
    mod** (Freeze Force lists Range before Damage). Column headers must be read; positions cannot
    be trusted.

12. **`Module:Ability/data` builds its per-frame index at runtime** (`table.insert(AbilityData["Warframe"]...)`),
    which a data-only parser cannot execute. Group the flat `Ability` table by its `Powersuit` field instead.

13. **"Stacks up to 240%" is a cap, not a stack count.** Divide by the per-stack value
    (`Melee Exposure`: 240 / 60 = 4 stacks). The parser does this when the cap is a percentage.

14. **Riven base values live in a wikitable with "<br>" and template noise**, and the label
    is what keys the attribute: `{{D|Heat}} Damage` must be expanded *before* stripping
    templates, otherwise "Cold Damage" and "Heat Damage" both collapse to "Damage" and the
    first one wins. Same for `{{Faction|Grineer}}` in "Damage vs. Grineer".

15. **The riven disposition multiplier is `omegaAttenuation`** in the WFCD export (0.5-1.55).
    The 1-5 star rating is only a display bucket; using it directly gives wrong stat values.

16. **Multi-tab ability pages repeat the `| strength =` parameter** (Wisp's Reservoirs has one
    per mote). Read every occurrence and keep the `<br>` separators, or the motes collapse
    into one unparseable stat.

17. **Incarnon trees are prose in a per-weapon table.** The rows alternate perk names (bolded,
    sometimes a bare percentage) with bullet lists; one bullet can hold several stats. Only
    "X Incarnon Genesis" pages exist, so incarnon-native weapons have no data.

18. **`Non-Critical hits deal +240% damage` breaks the "number first" assumption**: the number
    is in the middle of the sentence. Same for "Increase Base Damage by +51". Both need a
    "… by <number>" fallback before giving up on a line.

19. **Incarnon trees are also inherited by variants.** WFCD gives "Incarnon Form" attacks to
    Lex Prime, Strun Wraith and friends, but the wiki only has "Lex Incarnon Genesis".
    Strip the variant affixes (Prime/Wraith/Vandal/Prisma/Mk1/Telos/Rakta/Synoid/Dex) and copy
    the base weapon's tree.

20. **AoE falloff is in the export**: `attacks[].falloff = {start, end, reduction}`. The arsenal
    `damage` block already includes the radial hit at the centre, so applying falloff means
    subtracting that portion and adding it back scaled — not adding the radial on top.

## Coverage

`npm run coverage` prints the current state (83% of weapon-relevant mods fully
parsed). The remainder is mostly pure utility and is listed in
`docs/unmatched-mods.txt`, which is regenerated by `npm run update`. When adding
rules, always re-run coverage and check that the number went up and nothing that
previously parsed broke (`npm test` covers the important cases).

## To verify in game when possible

- Armour-type modifiers acting on the armour value (see docs/formulas.md §4).
- Whether level-scaled armour should be clamped to 200..2700 *before* applying
  damage-type modifiers (currently: after scaling, before modifiers).
- Eximus units: they are separate rows in the dataset, with inflated pools.

## Refresh order

`npm run update` runs, in order: `fetch.ts` (WFCD + wiki pages), `fetch-abilities.ts`
(ability infoboxes), `build-data.ts` (snapshot). `build-data.ts` reads
`data/raw/ability-stats.json`, so running it alone after a fresh checkout fails until
the ability fetch has run once.
