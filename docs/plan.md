# Continuation plan

Handover document: a new session should be able to start here with no other context.

Last updated: commit `736ed20`, 2026-10-19.

---

## 1. Verified state

| | |
|---|---|
| Tests | **102 pass, 0 fail** (`npm test`, ~6 s) |
| Invariants | `node tools/validate.ts` → PASS, 0 violations |
| Calibration vs Overframe | **50/50** (`node tools/calibrate.ts`), ranged builds only |
| Types | `npm run check` clean |
| Snapshot | 622 weapons, 1550 mods, 479 enemies, 22 damage abilities, 19 buffs, 74 weapons with an Incarnon form (5 melee) |

Run these four before starting anything and confirm they are still green:

```sh
npm test
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
  Examples: the 22% of armour left after Terrify + Corrosive Projection, `health/totalDps ==
  timeToKill`, and brute force against the Incarnon search's choice.
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
  `~/wfcheck/`), not in `/tmp`.
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
| A3 | **HTTP API lacked `search` and `ability`**, and the build construction was duplicated. `POST /api/search`, `GET /api/ability`, `GET /api/abilities`; shared `buildFromBody`. | `tests/server.test.ts`; documented in `docs/api.md` |
| A4 | **UI had no strip, abilities or build finder**. New Find and Abilities tabs; Build gained Corrosive Projections, direct strip %, Shattering Impact and "strip from ability". Strip resolution moved to `src/engine/strip.ts`, shared by CLI and server. | Screenshots; Bombard 150: 2700 → 0 armour, 644 s → 64 s TTK; a found build loads with its 4 Forma and 57/60 capacity |

Known loose ends from A1:

- The second hit of an Incarnon form (`Incarnon Form AoE`, the melee Spectral explosion) is
  **not added** to the number. It is kept in `incarnonFormExtra` and reported in `incarnon`.
- Ceramic Dagger fires **2 spectral daggers** per heavy attack; the attack table has no
  multishot for melee, so the model counts one. That undercount roughly offsets the missing
  explosion, but both are known inaccuracies.
- Flat EVO2 base damage: Okina's page says the spectral daggers *do* use it, Ceramic Dagger and
  Hate say they do not. The engine keeps flat Incarnon base damage on all three.

### B. Modelling that makes endgame answers false

| # | Gap | Why it matters |
|---|---|---|
| B1 | **Overguard** | No enemy in the snapshot has an overguard pool. It is half of what kills in Steel Path |
| B2 | **Damage attenuation** | Liches, Sisters, Archons, Eidolons. Today the engine says a Rubico melts them |

### C. Pending modelling, by value

| # | Gap |
|---|---|
| C1 | **Statuses abilities apply**: Inferno's guaranteed Heat proc, Miasma's Viral. The last big gap in the ability branch |
| C2 | **Multi-target and real AoE**: ability falloff, Torid chains, and the Incarnon form's second hit |
| C3 | **Shields in ability `castsToKill`** (ignored today: optimistic against Corpus) |

### D. Coverage and confidence

| # | What | Evidence |
|---|---|---|
| D1 | **Partial mods**: Melee 6/122 and **Bow 2/6** (a third of all bows) | `docs/unmatched-mods.txt` |
| D2 | **Calibration is not pinned**: the 50 builds are sampled from Overframe on every run, so the bar moves by itself | `tools/calibrate.ts` |
| D3 | **No melee or secondary calibration**: the golden readings are all Soma Prime | `tests/ingame.test.ts` |

Suggested order: **B1/B2 → C1 → D2/D1**.

### E. Out of scope, decided

Stance slot is not searched; conditional mods are off by default (`--stacks`); rivens take manual
stats with no weights or rerolls; companions, Archwing and Necramech are not supported.

---

## 5. Code map

```
src/engine/build.ts     resolves weapon + mods + buffs -> modified stats
src/engine/damage.ts    damage by type, armour, TTK, DoT, totalDps against the target
src/engine/enemy.ts     level scaling, armour reduction, armour model
src/engine/dot.ts       status ticks, effectiveArmor (the strip lives here)
src/engine/buffs.ts     19 warframe buffs applied to the weapon
src/engine/ability.ts   ability damage, own ticks, strip
src/engine/strip.ts     squad/weapon/ability armour strip -> one additive debuff
src/engine/search.ts    build search (greedy + local search + Incarnon)
src/engine/riven.ts     rivens
src/mods/parse.ts       mod effect parser (97% of the relevant lines)
src/data.ts             snapshot loading, modsForWeapon
src/cli.ts              every command, all with --json
src/server.ts           web + JSON API
tools/sources.ts        the single list of upstream sources (fetch + sync share it)
tools/build-data.ts     WFCD + wiki -> data/snapshot.json
tools/fetch*.ts         downloads (fetch, abilities, damage abilities, Incarnon, sets)
tools/sync.ts           change detection, refresh, validate, calibrate, log
tools/calibrate.ts      Overframe oracle
docs/agent.md           contract for an agent
```

Useful commands: `wfcalc abilities`, `wfcalc ability <name> --strength N --enemy X --level N`,
`wfcalc search <weapon> [--strip-from Avalanche --strength 200]`, `wfcalc calc <weapon> --mod ...
[--cp N] [--shattering-impact N] [--armor-strip N]`, `wfcalc incarnon <weapon>`.

---

## 6. How to resume

```sh
cd wfcalc
git log --oneline | head -5      # 736ed20 or later
npm test                          # 102 tests
node tools/validate.ts            # 0 violations
node tools/calibrate.ts           # 50/50
./tools/dev-server.sh 7801        # only if the web UI is needed
```

Then pick the first item of section B, plan it by reading the code and the real data, and follow
the method in section 2.
