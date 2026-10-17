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
| `wfcalc enemies [query]` | Search the 479 enemies |
| `wfcalc serve [--port 7777]` | Local web UI + JSON API |
| `wfcalc update` | Re-download sources and rebuild the snapshot |

### Options

| Option | Meaning |
|---|---|
| `--mod NAME` / `--mod NAME:R5` | Equip a mod, optionally under-levelled |
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
- Faction damage mods, conditional mods (on-kill, aiming, weak-point) with stacks.
- Enemy level scaling (the current two-curve smoothstep for health/shields, the
  single armor curve, the 200–2700 armor clamp).
- Damage-type modifiers per health **and** armor type, armor damage reduction,
  Toxin shield bypass.
- Per-type damage breakdown, status proc distribution, shots to kill and time to kill.

## What it does not model yet

- Warframe abilities, buffs and arcanes applied to the weapon (phase 2).
- Rivens with custom rolls (the disposition is in the data, the roll generator is not).
- Status damage over time (slash/heat ticks), Incarnon evolution trees, stances and
  melee combo multipliers.
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
src/engine/         build resolution, enemy scaling, damage
src/cli.ts          CLI
src/server.ts       local API + static web UI
src/web/            the UI (vanilla JS, no build step)
docs/formulas.md    every formula and where it comes from
docs/api.md         the JSON API, for scripts and AI agents
```

Formulas and their sources: [docs/formulas.md](docs/formulas.md).
JSON API: [docs/api.md](docs/api.md).
