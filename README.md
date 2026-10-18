# wfcalc

Offline damage calculator for WARFRAME. Builds a weapon with mods, a riven later,
and asks what it actually does to a real enemy at a real level.

Not a DPS leaderboard: it uses the game's own formulas (documented on the official
wiki) and the game's own data export, so the numbers answer the question
"is this build better than that one, and why".

Runs on Node ≥ 23 with **no runtime dependencies** — the TypeScript sources are
executed directly through Node's type stripping.

## Quick start

```sh
wfcalc calc "Kuva Bramma" --mod Serration --mod "Split Chamber" --mod "Vital Sense" \
       --mod Hellfire --mod "Cryo Rounds" --enemy Bombard --level 150
```

```
build  —  Kuva Bramma (Bow) vs Bombard lv150
──────────────────────────────────────────────────────────────────────────────
  damage/shot   7,612.92  ×1.90 multishot  ×2.27 crit avg
  crit           35.0% ×4.62   status 21.0%   fire rate 0.67/s
  elements     impact 6.5%, blast 93.5%
  dps          burst 21,860.8   sustained 15,614.8   avg hit 32,791.1
  target       hp 118,480.2  shields 0  armor 2,700   -> 27.4 shots, 57.51s
```

Interactive UI: `wfcalc serve` → <http://127.0.0.1:7777>.

## Commands

| Command | What it does |
|---|---|
| `wfcalc calc <weapon> [options]` | Full damage report |
| `wfcalc compare <weapon> --vs a,b --vs c,d` | Same build, different mod choices |
| `wfcalc weapons [query]` | Search the 622 weapons |
| `wfcalc mods <weapon> [query]` | Mods that fit that weapon |
| `wfcalc arcanes [query]` | Weapon arcanes |
| `wfcalc buffs` | Warframe buffs the calculator models |
| `wfcalc rivens [query]` | Riven attribute ids |
| `wfcalc incarnon <weapon>` | Incarnon evolution options for a weapon |
| `wfcalc enemies [query]` | Search the 479 enemies |
| `wfcalc serve [--port 7777]` | Local web UI + JSON API |
| `wfcalc update` | Re-download sources and rebuild the snapshot |

### Options

| Option | Meaning |
|---|---|
| `--mod NAME` / `--mod NAME:R5` | Equip a mod, optionally under-levelled |
| `--arcane NAME[:R5]` | Equip a weapon arcane (Primary Merciless, Melee Exposure...) |
| `--buff roar,eclipse` | Activate Warframe buffs (see `wfcalc buffs`) |
| `--strength 284` | Caster's Ability Strength in percent (default 100) |
| `--frame-mods "Intensify,Blind Rage"` | Derive Ability Strength from Warframe mods |
| `--riven damage,multishot,-zoom` | Riven stats (`-` marks the malus) |
| `--riven-roll 1.05` / `--riven-rank 6` | Riven random roll (0.9-1.1) and rank |
| `--frame Rhino` | Validate that the frame can actually bring those buffs (Helminth) |
| `--frame-arcane "Arcane Avenger"` | Warframe arcanes (also feed Ability Strength) |
| `--element-bonus heat:60` | Kuva/Tenet elemental bonus (25-60%) |
| `--covenant-damage 4000` | Damage prevented, for Harrow's Covenant |
| `--viral 10`, `--corrosive 10` | Status stacks kept up on the target |
| `--incarnon "EVO2:0,EVO4:1"` | Incarnon evolutions per tier (see `wfcalc incarnon`) |
| `--combo-hits 220` / `--heavy` | Melee combo counter and heavy attack |
| `--aoe-distance 4` | Distance to the blast centre for AoE weapons (falloff) |
| `--enemy NAME`, `--level N` | Target and level (default Bombard at 100) |
| `--faction grineer` | Shorthand for a benchmark enemy of that faction |
| `--mode "Incarnon Form"` | Use an alternative fire mode |
| `--stacks onKill=5` | Activate a conditional effect with N stacks |
| `--status-types 4` | Status types on the target (Galvanized mods) |
| `--headshot` | Every hit is a weak-point hit |
| `--json` | Machine-readable output |

## Data

Everything comes from two upstreams, rebuilt into `data/snapshot.json` (1.7 MB):

- **WARFRAME Wiki** (`wiki.warframe.com`): the authoritative mod list with in-game
  upgrade axes (`Module:Mods/data`), the damage-type modifier matrix
  (`Module:DamageTypes/data`), and the formulas (`Damage/Calculation`, `Armor`,
  `Enemy_Level_Scaling`, `Riven_Mods`).
- **WFCD/warframe-items** (game export): per-rank mod numbers, weapon stat blocks,
  enemy health pools, arcanes.

`wfcalc update` refreshes both. Raw files land in `data/raw/`, the digest in
`data/snapshot.json`. Nothing talks to the network at calculation time.

## What it does model

- Arsenal damage formula: base damage, physical (IPS) mods, elemental mods and their
  **combination order**, multishot, crit chance/damage, status chance.
- Faction damage mods and **Roar**, applied multiplicatively against the matching faction.
- Weapon arcanes (Primary Merciless, Melee Exposure, Cascadia Flare...) with their stacks.
- **Kuva/Tenet elemental bonus**: the player-chosen element, baked in as innate damage
  (which is what really decides the elemental combination on those 35 weapons).
- **Warframe arcanes**: Arcane Avenger (flat crit chance), Arcane Acceleration, Arcane Rage,
  Molt Augmented (which feeds Ability Strength and therefore every buff).
- **Helminth awareness**: a buff from another frame is flagged when it is not subsumable.
- **Crit spread**: expected crits per shot and the chance of at least one, which matters
  for shotguns where the average hides a wide range.
- **Warframe buffs**: Roar, Eclipse, Vex Armor, Xata's Whisper, Toxic Lash, Nourish, the
  elemental augments (Shock Trooper, Freeze Force, Fireball Frenzy, Smite Infusion,
  Venom Dose), Warcry, Accelerant, Sonar and Resupply — scaled by Ability Strength.
- Conditional mods (on-kill, aiming, weak-point) with stacks.
- Enemy level scaling (the current two-curve smoothstep for health/shields, the
  single armor curve, the 200–2700 armor clamp).
- Damage-type modifiers per health **and** armor type, armor damage reduction,
  Toxin shield bypass.
- **Rivens** with real values: wiki base table × the weapon's own disposition × the
  bonus/malus weights × an optional roll.
- **Incarnon evolutions**: per-weapon perk trees scraped from the wiki, with the parsed
  stat bonuses applied (flat base damage included). Variants (Prime/Wraith/Vandal...)
  inherit the tree of their base weapon, which is how the game works.
- **AoE falloff**: the game's own `{start, end, reduction}` per attack, so a Bramma at
  4 m from the blast does what it does in game.
- **Melee combo**: the 2x-12x multiplier ladder, combo-scaling mods (Blood Rush,
  Weeping Wounds) and heavy attacks — normal attacks are deliberately *not* multiplied.
- **Damage over time** from status procs (Slash, Heat, Toxin, Electricity, Gas, Blast)
  including the faction double-dip, plus **Viral** and **Corrosive** stacks on the target.
- Forced procs (Hunter Munitions, Internal Bleeding) and Status Damage mods.
- Per-type damage breakdown, status proc distribution, shots to kill and time to kill,
  with status damage counted into the kill time.

## What it does not model yet

- Elemental Ward and Provoke do not buff weapon damage, so they are intentionally absent.
- Boss damage attenuation (Archons, Liches) is not modelled: the game caps damage per hit.
- Umbral set bonuses, Archon Shards and Helminth invigorations for Ability Strength.
- **Stances**: stance damage multipliers are per-combo-hit execution, not a build
  property, and the wiki keeps them in prose. Out of scope by design.
- Punch-through multi-hits: punch-through changes how many *targets* one shot hits, not
  the damage a single target takes, so it does not enter a single-target TTK.
- Per-pellet status variance (damage uses expectations; crit spread is reported).
- Incarnon perks that are mechanics rather than stats (they are stored as text, not applied).
- 15 of the 69 weapons whose data mentions an Incarnon mode have no evolution table;
  with variant inheritance 54 are covered, and the remainder look like export noise.
- 17% of weapon mods are only partially understood — mostly pure utility
  (beam range, dodge speed, combo efficiency). They are reported as
  `unsupportedMods` and the result is flagged as a lower bound rather than silently
  wrong. `npm run coverage` prints the current state.

## Development

```sh
npm run update     # refresh data
npm test           # engine tests (values quoted from the wiki)
npm run check      # tsc --noEmit
npm run coverage   # how much of the mod dataset is understood
```

Layout:

```
tools/fetch.ts      download upstream sources into data/raw/
tools/parse-lua.ts  parser for the wiki's Lua data modules
tools/build-data.ts normalise everything into data/snapshot.json
src/mods/parse.ts   mod text -> typed effects (the long-tail part)
src/engine/         build resolution, buffs, enemy scaling, damage
tools/fetch-abilities.ts  ability/augment numbers from the wiki infoboxes
tools/fetch-incarnon.ts   Incarnon evolution trees per weapon
src/cli.ts          CLI
src/server.ts       local API + static web UI
src/web/            the UI (vanilla JS, no build step)
docs/formulas.md    every formula and where it comes from
docs/api.md         the JSON API, for scripts and AI agents
```

Formulas and their sources: [docs/formulas.md](docs/formulas.md).
JSON API: [docs/api.md](docs/api.md).
