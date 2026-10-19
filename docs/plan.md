# Continuation plan

Handover document: a new session should be able to start here with no other context.

Last updated: 2026-10-19.

---

## 1. Verified state

| | |
|---|---|
| Tests | **129 pass, 0 fail** (`npm test`, ~10 s); `npm run eval` 14/14 |
| Invariants | `node tools/validate.ts` → PASS, 0 violations |
| Calibration vs Overframe | **35/35** pinned public builds (`node tools/calibrate.ts`), offline, ranged only |
| Types | `npm run check` clean |
| Snapshot | 622 weapons, 1550 mods, 479 enemies, 23 damage/strip abilities, 19 buffs, 74 weapons with an Incarnon form (5 melee) |
| Coverage | 98% of weapon-relevant mods fully modelled (587/596); 9 unknown lines |
| Search speed | ~55 ms and ~550-780 builds evaluated per search; `--budget` never binds. Speed is **not** the current bottleneck |

Run these four before starting anything and confirm they are still green:

```sh
npm test
npm run eval
node tools/validate.ts
node tools/calibrate.ts
npm run check
```

---

## 2. Method (what has worked)

One change at a time, in this order:

1. **Plan**: read the code and the **real data** before touching anything. Never assume: every time
   an assumption was made (that `Aerial Ace` was an Archwing mod, that a shared link loaded
   empty, that `pools.amount` was the scaled armour, that the wiki called the melee Incarnon
   attack "Incarnon Form") the assumption was wrong.
2. **Implement**: a small change, with the *why* in a comment rather than a cryptic commit.
3. **Test**: a unit test of the new behaviour *and* a check with real data (`wfcalc …` against a
   concrete weapon/enemy), not just "it compiles".
4. **If it fails, fix it there**: do not accumulate. If a test shows the model is wrong
   (Incarnon perks, multiplicative strips), fix the model, not the test.
5. **Measure before/after** when the change is about speed or looks, and put the number in the
   commit message.
6. **Commit** with: what was wrong, what was done, and what evidence backs it.

Rules that have prevented repeated mistakes:

- A test that **pins the right number** is worth more than three that check it does not crash.
  Examples: the 22% of armour left after Terrify + Corrosive Projection, `pools/totalDps ==
  timeToKill` (health alone when there is no Overguard/shield), and brute force against the
  Incarnon search's choice.
- If the result looks absurd, **it is a bug**: "a level 150 Bombard dies to one cast" and "2361
  dps kills in 271 s" were both true and both wrong.
- Everything the engine does not model is said in the answer (`warnings`, `notes`,
  `partialMods`), never glossed over.

---

## 3. Environment traps (these have cost hours)

- **The dev server dies between turns.** If the browser shows a blank page or `chrome-error://`,
  check `curl -m 5` before suspecting the code. Start it with `./tools/dev-server.sh 7801` and
  verify in the same command.
- **Never `pkill -f <pattern>`**: the pattern matches the shell's own command line and kills it
  (exit code 143). Use the PID, or `pkill -x chromium`.
- **`fuser -k` does not work here** (it cannot read `/proc/net/tcp` under proot): it kills
  nothing and the new server dies with `EADDRINUSE` while the old one keeps serving stale data.
  That is why `dev-server.sh` kills with `pgrep -f "server.ts --port N"`, and even then the
  match can hit the invoking shell: prefer `pgrep` + `ps` + `kill <pid>`.
- **`/tmp` is wiped** between sessions: keep scratch files in a home directory (for example
  `~/scratch/`), not in `/tmp`.
- **`agent-browser`** is useful for `eval`, `drag`, `hover` and `screenshot`, but its daemon
  sometimes fails (`Resource temporarily unavailable`), stays on `about:blank`, and **cannot
  drop onto covered slots**. When it fails, use synthetic events (`new DragEvent`) or a small
  CDP script.
- CLI tests used to hang for 96 s because the child inherited `stdin`:
  `stdio: ['ignore','pipe','pipe']`.

---

## 4. Backlog, by value

### A. Done in this cycle (kept here for the evidence)

| # | What | Evidence |
|---|---|---|
| A1 | **Melee Incarnon forms were missing**: the wiki does not call the transformed melee attack "Incarnon Form" but "Spectral Axe/Dagger/Blade". All 5 (Ack & Brunt, Ceramic Dagger, Hate, Okina, Okina Prime) now carry a profile. | `snapshot.weapons[*].incarnonForm` count for melee: 0 → 5; `tests/incarnon.test.ts` pins the wiki numbers |
| A1b | **Spectral hits ignore melee damage bonuses** (Pressure Point, Arcane Fury, riven damage, stance, combo multiplier) but take Condition Overload. Found while checking A1. | Ceramic Dagger + Pressure Point: 770 → 350 per hit; CO with 3 status types: 350 × 3.4 = 1190 |
| A1c | **Condition Overload never applied**: `conditionStacks` returned early when an effect had no condition, so a mod whose only gate is `perStatusType` added nothing. | `tests/engine.test.ts` pins 1 status → +80%, 3 → +240% |
| A2 | **`sync` did not watch the weapon modules** and, worse, called the fetchers without `--force`, so a detected change rebuilt from stale files. Source lists now live in `tools/sources.ts` (shared by `fetch` and `sync`); categories are compared by a hash because the API sends no `Last-Modified`. | `sync --check` went from "category changed" on every run to "up to date" in 2 s; a forced run rebuilt the snapshot and calibrated 60/60 |
| A3 | **HTTP API lacked `search` and `ability`**, and the build construction was duplicated. `POST /api/search`, `GET /api/ability`, `GET /api/abilities`; shared `buildFromJson` in `src/request.ts`. | `tests/server.test.ts`; documented in `docs/api.md` |
| A4 | **UI had no strip, abilities or build finder**. New Find and Abilities tabs; Build gained Corrosive Projections, direct strip %, Shattering Impact and "strip from ability". Strip resolution moved to `src/engine/strip.ts`, shared by CLI and server. | Screenshots; Bombard 150: 2700 → 0 armour, 644 s → 64 s TTK; a found build loads with its 4 Forma and 57/60 capacity |
| A5 | **Agent contract**: the CLI is the interface, not MCP. `--brief` one-line output for calc/search/ability/compare, `--brief=answer` for repeated calls, JSON only when parsing, expected failures exit 2 with no stack trace (JSON `{error:{code,message,suggestions}}` under `--json`), and `skills/wfcalc/SKILL.md` + `docs/agent.md` as the operating manual. | `tests/cli.test.ts` pins the brief shape and the error contract; the skill ships in the repo |
| A6 | **`wfcalc batch`**: JSONL of calc/ability records priced in one process, one line per record, `--json` as compact rounded JSONL. Bad records do not abort the batch; exit 1. The JSON->Build mapping moved to `src/request.ts`, shared with the server. | `tests/cli.test.ts`; `tools/agent-eval.ts` case "batch" |
| A7 | **Agent eval**: `npm run eval` pins ten real questions (best build, strip, melee Incarnon, CO, ability, errors, partial mods, batch) and fails if an answer or the brief size regresses. Runs in CI. | `tools/agent-eval.ts`, 10/10 |
| A17 | **Conditional mods are named (F3)**: search builds carry `conditionalMods`, the brief says `conditional Galvanized Chamber, ...`, and the human output says which flag activates them. | A search with `--must "Galvanized Chamber"` lists it as conditional; tests pin the field and the brief |
| A16 | **Incarnon second hits and ability targets (C2, first half)**: the form's AoE/explosion is merged into the shot at the blast centre, with its own falloff under `--aoe-distance`; direct-only multipliers (Condition Overload, Galvanized Aptitude) are scaled by the direct share so they do not inflate the radial hit. Abilities accept `--targets N` (all at full damage inside the radius). | Braton form 50 → 100 total, 95 at 3 m; Ceramic Dagger + CO 3 statuses = direct 1,190 + explosion 350 = 1,540; Miasma 5 targets = 1,575 per cast; tests pin all three |
| A15 | **Mod coverage (D1)**: utility lines were being counted as unknown, so Bow had 2/6 partial mods and Melee 6/122. Parenthetical qualifiers, secondary-weapon buffs, range, Tennokai, block/damage-taken, slam pull and Shattering Impact's armour chip are now out of scope, not unknown; Split Flights' multishot is fully applied. | Bow 2/6 → **0/6**, Melee 6/122 → **1/122** (Strain Infection), weapon-relevant unknown lines 16 → 9 (98% fully modelled); `tests/coverage.test.ts` pins it |
| A14 | **Pinned calibration (D2)**: `tools/calibrate.ts` now reads `data/calibration-builds.json` (35 public Overframe builds with weapon, mods, arcanes and the oracle block) instead of sampling a new set on every run. `--refresh` fetches and rewrites the battery; only builds whose weapon and mods resolve are kept, and the list API's page bug is deduplicated. | Two consecutive runs produce the same report hash; CI runs the calibration offline; 35/35 |
| A13 | **Shields in ability `castsToKill` (C3)**: a cast now removes shields first, with the shield type's damage modifiers and no armour; Toxin bypasses them. `castsToKill` sums Overguard, shield and health casts, and the target exposes `shield`, `shieldPerCast` and `bypassesShield`. | Avalanche at 200% vs a level 150 Corpus Tech: 22,668 shields at 3,000/cast = 8 casts, plus 50 for health = 58 (was 50); the test recomputes the phases independently |
| A12 | **Ability statuses (C1)**: Inferno's guaranteed Heat, Miasma's Viral (one stack, doubling health damage) and Shuriken's guaranteed Bleed are resolved against the target and folded into `perCast`/`castsToKill`. Targets expose `statusPerCast`, `statusProcs` and `viralStacks`; `--viral N` seeds existing stacks. | Miasma 150/s x 6 = 900 → 315 per cast after its own Viral and Bombard armour (was 157); Shuriken's Bleed is 1,577.1 True per proc; Inferno's Heat proc is 469 on a Bombard. Tests pin all three |
| A11 | **Damage attenuation (B2, caps)**: `--attenuation archon` applies MDPT 460,000, MDPS 935,000, 20% flat DR and 50% status DR; Eidolons get 200%/100% of max health automatically; `--mdpt/--mdps/--flat-dr/--status-dr` cover a known custom boss. Caps apply per instance and per second before the phase model; TTK is conservative because the exponential smoothing is not modelled. | Synthetic 1M hit on a 1M dummy: 1s → 2.72s under Archon; Eidolon 5M hit on 1M health: 0.2s → 1s; tests pin both and the CLI/API fields |
| A10 | **Overguard (B1)**: Eximus targets get the wiki's level-scaled Overguard (base 12, q = level - 1, curves blended 45-50) or an explicit `--overguard N`; it is a separate layer before shields/health, neutral to all types except Void (+50%), no armour, for weapons **and** ability casts. | Bombard 150 Eximus: 281,865 Overguard; Soma Prime + Serration 776s → 1,229s; Avalanche at 200% needs 94 casts to break it plus 180 for health = 274; tests pin the formula, the Void multiplier, the TTK and the ability casts |
| A9 | **Search efficacy (F1/F2/F5/F6)**: `search --arcane auto` tries every arcane whose slot fits and keeps the best (an explicit arcane still wins; a conditional arcane only wins if its condition is active); `calc` reports `capacityUsed/capacity`, `formaNeeded`, `fits` and the equipped arcane in text, brief and JSON; `--mod "A,B"` is the same as repeated `--mod`; Psychic Bolts is now a strip ability (80% at 100% strength, capped at 125%). | Haalvu auto: no arcane without stacks, Primary Merciless with `onKill=12`; calc Haalvu + Serration/Chamber = 15/60, 0F; Psychic Bolts at 125% = 100% strip; tests pin all four |
| A8 | **The text report showed the wrong armour**: with `--armor-strip 100` it printed the enemy's own pool (2,700) while the damage used 0. Found while pricing a Haalvu build for Nyx. Now prints `armor 0 (base 2,700)`. | Test pins the stripped line; brief/JSON were already correct |

Known loose ends from A1:

- Ceramic Dagger fires **2 spectral daggers** per heavy attack; the attack table has no
  multishot for melee, so the model counts one. With the explosion now included, the melee form
  is a lower bound by roughly a factor of two on that pair.
- Flat EVO2 base damage: Okina's page says the spectral daggers *do* use it, Ceramic Dagger and
  Hate say they do not. The engine keeps flat Incarnon base damage on all three.

### B. Modelling that makes endgame answers false

| # | Gap | Why it matters |
|---|---|---|
| B2b | **Attenuation beyond the caps**: the exponential smoothing (lambda = 2/3), Lich/Sister cap values, Eidolon joints/invulnerability and Lich ranks | The caps alone already stop a sniper one-shotting an Archon, but sustained TTK and real boss phases are still approximate |

### C. Pending modelling, by value

| # | Gap |
|---|---|
| C1b | **More ability statuses**: Spores' Corrosive, Thermal Sunder's Heat/Cold, Fireball's AoE Heat, and Inferno's direct damage split (the wiki has 1,250 Impact + 1,250 Heat, the engine still one 2,500 Impact block) |
| C2b | **Weapon multi-target and ability distance falloff**: Torid chains to five enemies at 75% per link, one AoE shot hitting a group, and abilities whose damage falls off with distance |

### D. Coverage and confidence

| # | What | Evidence |
|---|---|---|
| D3 | **No melee or secondary calibration**: the golden readings are all Soma Prime | `tests/ingame.test.ts` |

Suggested order: **C1b/B2b**, then F3/F4/F7. B1 (Overguard), B2's documented caps, C1's curated
ability statuses, C2's Incarnon second hits and ability targets, C3's shield phase, D1/D2
(coverage and pinned calibration), the cheap search wins (F1/F2/F5/F6) and the agent contract are
done. Overguard's remaining gaps are deliberate: status DoT and Magnetic's
amplification are not credited to it.

### E. Out of scope, decided

Stance slot is not searched; conditional mods are off by default (`--stacks`); rivens take manual
stats with no weights or rerolls; companions, Archwing and Necramech are not supported.

### F. Search friction found in real use (2026-10-19)

Measured: a search is ~55 ms for 550-780 builds and `--budget` does not bind. The issue is not
CPU; it is what the search does and does not consider, and what the answer fails to say.

| # | Friction | Evidence / why it matters |
|---|---|---|
| F1 | **Arcanes are outside the search and invisible in the output.** `search` optimises mods only; the arcane is a manual `--arcane`, and neither the brief nor the search assumptions echo it. | Haalvu, same mods, Bombard 150: **325k dps without an arcane vs 896k with Primary Merciless at 12 stacks**. A "best build" answer can silently omit a 3x multiplier. Fix: `--arcane auto` (try the arcanes whose slot fits) + report the chosen arcane in `assumptions`. |
| F2 | **`calc` does not report capacity or Forma.** Only `search` does; the UI computes it client-side. | Judging an existing build without knowing whether it fits (59/60, 3F) is half an answer. Export the search's capacity calculation and print `capacityUsed/capacity`, `formaNeeded` and `fits` in `calc` text/JSON. |
| F3 | **Conditional mods are not identified.** Search says `Conditions: onKill=12, statusTypes=2` but not that Galvanized Chamber/Aptitude are the mods whose value depends on it. | The agent cannot tell the player what has to be true, and `--stacks` enables several effects at once. Add a per-build `conditionalMods` list (and `inactiveConditions` already exists in `calc`). |
| F4 | **Tie-break ignores unmodelled drawbacks.** Heavy Caliber (+165% damage, -55% accuracy) ties with Serration because accuracy is not priced, and the search can pick either. | The Haalvu answer initially came out with Heavy Caliber. Prefer mods with fewer unsupported lines, or add `--prefer`/`--exclude` to the recommendation. |
| F5 | **`--mod` does not accept a comma list.** `search --must "A,B"` splits, `calc --mod "A,B"` treats it as one name. | We hit it twice in one session. No mod name in the snapshot contains a comma, so splitting is safe. |
| F6 | **Nyx's Psychic Bolts is not a strip ability in the data.** The curated strip list has Avalanche, Terrify, Seeking Shuriken and Polarize only. | The user had to pass `--armor-strip 100`; `--strip-from "Psychic Bolts"` fails. Add the known 100% strips (Psychic Bolts, Fusion Strike...) to the curated list. |
| F7 | **`--status-types` is a global manual assumption.** Galvanized Aptitude's damage scales with it; the build itself applies Viral + Tau (2), but the caller must know and pass it. | A self-consistent search could infer the status types from the build's own damage profile (and known external procs) instead of a flag. Careful: this is circular with the optimiser, so measure before changing. |

F1, F2, F3, F5 and F6 are **done** (A9, A17). Remaining: **F4** (tie-break around unmodelled
drawbacks such as Heavy Caliber's accuracy) and **F7** (infer status types instead of a global
flag). F4 and F7 need a model decision.


---

## 5. Code map

```
src/engine/build.ts     resolves weapon + mods + buffs -> modified stats
src/engine/damage.ts    damage by type, armour, TTK, DoT, totalDps against the target
src/engine/enemy.ts     level scaling (health, shield, armour, Overguard), armour model
src/engine/dot.ts       status ticks, effectiveArmor (the strip lives here)
src/engine/buffs.ts     19 warframe buffs applied to the weapon
src/engine/ability.ts   ability damage, own ticks, strip
src/engine/strip.ts     squad/weapon/ability armour strip -> one additive debuff
src/engine/search.ts    build search (greedy + local search + Incarnon)
src/engine/riven.ts     rivens
src/request.ts          JSON request -> Build (HTTP API and batch share it)
src/mods/parse.ts       mod effect parser (97% of the relevant lines)
src/data.ts             snapshot loading, modsForWeapon
src/cli.ts              every command, all with --json
src/server.ts           web + JSON API
tools/sources.ts        the single list of upstream sources (fetch + sync share it)
tools/build-data.ts     WFCD + wiki -> data/snapshot.json
tools/fetch*.ts         downloads (fetch, abilities, damage abilities, Incarnon, sets)
tools/sync.ts           change detection, refresh, validate, calibrate, log
tools/calibrate.ts      Overframe oracle on a pinned battery
data/calibration-builds.json  the pinned battery (refresh with calibrate:refresh)
tools/agent-eval.ts     pinned agent questions (npm run eval, CI)
skills/wfcalc/          agent operating manual (SKILL.md)
docs/agent.md           contract for an agent
```

Useful commands: `wfcalc abilities`, `wfcalc ability <name> --strength N --enemy X --level N`,
`wfcalc search <weapon> [--strip-from Avalanche --strength 200]`, `wfcalc calc <weapon> --mod ...
[--cp N] [--shattering-impact N] [--armor-strip N]`, `wfcalc incarnon <weapon>`.

---

## 6. How to resume

```sh
cd wfcalc
git log --oneline | head -5      # the top commit
npm test                          # 129 tests
npm run eval                      # 10 pinned agent cases
node tools/validate.ts            # 0 violations
node tools/calibrate.ts           # 35/35 pinned, offline
./tools/dev-server.sh 7801        # only if the web UI is needed
```

Then pick the first item of section B, plan it by reading the code and the real data, and follow
the method in section 2.
