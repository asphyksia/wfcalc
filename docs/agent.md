# Driving wfcalc from an agent

`wfcalc` is an offline Warframe damage calculator. It answers two different questions, and
confusing them is the main way to get a bad answer:

- **"How good is this build?"** → `calc` (and `compare`). Exact, deterministic.
- **"What build should I use?"** → `search`. It optimises with the same engine.

Everything runs locally against a snapshot of WFCD and the WARFRAME Wiki. No network, no
account, no rate limit. `wfcalc` is on `PATH`.

## The three rules

1. **Always pass `--json`.** Every command takes it. Text output is for humans.
2. **Quote the assumptions that came with the numbers.** Every response carries `warnings`,
   `assumptions` and `notes`. A build without its capacity, Forma cost and target level is not
   an answer.
3. **`partial: true` means lower bound, not value.** Such a mod has at least one line the
   calculator does not model. Say so instead of presenting the number as exact.

## Commands

| Command | Answers |
|---|---|
| `search <weapon>` | Which mods make the best build for a target |
| `calc <weapon> --mod ...` | Damage of a build you already have |
| `compare <weapon> --vs A,B` | Same weapon under several mod sets |
| `mods <weapon> [query]` | Which mods fit, with effects and conditions |
| `weapons [query]`, `enemies [query]`, `arcanes`, `buffs`, `rivens`, `incarnon <weapon>` | The pieces to build with |

`search` is the only command that *chooses*. The rest evaluate or enumerate.

## Recipe: the best build for a weapon

```sh
wfcalc search "Soma Prime" --enemy Bombard --level 150 --json
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--objective ttk\|dps` | Kill the target fastest (default) or maximise sustained DPS |
| `--enemy NAME --level N` | The target; armour makes the answer change completely |
| `--capacity 30\|60` | 60 = with an Orokin Catalyst (default) |
| `--forma N` | Maximum Forma the search may spend |
| `--must "Serration,Split Chamber"` | Mods that must stay in the build |
| `--exclude "Primed X,Galvanized Y"` | Mods the player does not own |
| `--frame Rhino --frame-mods Intensify --buff roar` | Warframe buffs applied to the weapon |
| `--viral 10 --corrosive 0 --headshot` | Target debuffs and headshots |
| `--top N` | How many alternatives to return (default 3) |

The response:

```jsonc
{
  "weapon": "Soma Prime", "objective": "ttk", "enemy": "Bombard", "level": 150,
  "evaluated": 840, "elapsedMs": 161,
  "builds": [{
    "mods": [{"name": "Serration", "rank": 10, "drain": 7, "halvedByPolarity": true}, ...],
    "capacityUsed": 60, "capacity": 60, "formaNeeded": 2, "fits": true,
    "sustainedDps": 37200,        // direct damage only
    "totalDps": 41000,            // against this target, status damage included
    "timeToKill": 11.94, "shotsToKill": 240,
    "critChance": 0.9, "critMultiplier": 6.6, "statusChance": 0.1, "multishot": 1.9,
    "incarnon": ["EVO2:0", "EVO3:2", "EVO4:0"],
    "incarnonNames": ["EVO2 Final Fusillade", "EVO3 Extended Volley", "EVO4 +20%"],
    "warnings": [], "partialMods": []
  }],
  "assumptions": ["All mods at max rank, 60 capacity (Orokin Catalyst)", "Objective: ..."],
  "notes": ["The Exilus and stance slots are not searched..."]
}
```

A returned build is **legal by construction**: at most eight mods, within capacity, within the
Forma budget, no two mods of the same family (Pressure Point and Primed Pressure Point), no
Exilus mod in a standard slot, and no trigger-locked mod (Cannonade) on a weapon whose trigger
does not match.

`--objective dps` scores **`totalDps`**, the damage against the given target including status
procs: scoring direct damage alone makes Weeping Wounds, slash and heat builds invisible
(measured on a Nikana Prime, 33.6k real damage per second scored the same as 17.9k).

## Recipe: judge a build the player already has

```sh
wfcalc calc "Soma Prime" --mod Serration --mod "Split Channel" ... --enemy Bombard --level 150 --json
```

Read `sustainedDps`, `timeToKill`, and `unsupportedMods` / `inactiveConditions`. The last one
lists conditional effects that are switched off: if a build relies on them, say which
condition has to be true.

## Recipe: with a warframe

```sh
wfcalc search "Soma Prime" --frame Rhino --frame-mods Intensify --buff roar --enemy Bombard --level 150 --json
```

Ability Strength comes from the frame mods and arcanes, and is reported back in `assumptions`.
`wfcalc buffs --json` lists every buff modelled, with the ability it comes from and whether it
is subsumable.

## What the calculator does not do

State these when they matter instead of guessing:

- **The Exilus and stance slots are not searched.** An Exilus mod is never worth a standard slot.
- **Melee assumes a 12x combo** (220 hits), because Blood Rush and Weeping Wounds are worth
  nothing at 1x. Pass `--combo-hits 0` to score raw swings instead; the assumption is reported.
- **The Incarnon form is never assumed.** It is an endgame unlock, so the search reports that
  the weapon has one and leaves it alone unless asked. `--incarnon auto` lets the search pick:
  it replaces the weapon's profile with the transformed one (the wiki's weapon database carries
  it; WFCD does not) and tries every combination of perks, which is exact because the largest
  tree has 18. On a Torid against a level 150 Bombard that is 13.7k → 71.7k dps.
  Perks with no parsed stats are invisible to the optimiser; read the tree with
  `wfcalc incarnon <weapon> --json` and force a choice with `--incarnon "EVO2:0,EVO4:1"`.
- **Rivens must be spelled out**: `--riven damage,multishot,-zoom --riven-roll 1.05`.
- **Conditional mods default to inactive.** Galvanized stacks, on-kill effects and "while
  aiming" need `--stacks onKill=5` or similar; otherwise the build is scored lower than it plays.
  This matters most for search results: say which conditions your answer assumes.
- **One target, average damage.** No spread, no multi-target, no enemy AI. Time to kill is a
  model of sustained fire including reloads, not a stopwatch.
- **A meta is not a calculation.** If a mod is not in the snapshot, the tool cannot know it.

## Failure modes

- `weapon not found: X (did you mean: ...)` → fix the name; do not retry blindly.
- An empty `builds` array means no combination fits the capacity/Forma budget; relax `--forma`.
- `warnings` entries like `mod does not fit a ...` mean the payload contradicted the data.
