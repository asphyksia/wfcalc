# Calibration results

Independent verification against **Overframe** (`overframe.gg/api/v1/builds/<id>`), which
exposes the game's own modifier block (`WEAPON_CRIT_CHANCE`, `WEAPON_FIRE_ITERATIONS`, …).

## Verified builds

### 1036746 — Haalvu, "Split Atom Prime - Altfire Steel path Melt"

Mods: Galvanized Chamber, Galvanized Aptitude, Hellfire, Thermite Rounds, Critical Delay,
Primed Shred, Vital Sense, Serration · Arcane: Primary Crux.

| stat | Overframe | wfcalc |
|---|---|---|
| multishot | 1.8000 | 1.8000 |
| critical chance | 0.7500 | 0.7500 |
| critical damage | 5.500 | 5.500 |
| status chance | 0.4560 | 0.4560 |
| fire rate | 17.5526 | 17.5500 |
| magazine | 150 | 150 |
| reload | 1.00 | 1.00 |
| total damage (Aptitude active) | 394 | 393.53 |

Result: **8/8**. This build is what exposed the *Direct Damage* bucket bug (Galvanized
Aptitude multiplies Serration's result instead of sharing its bucket).

## Automation status

`npm run calibrate --discover N` / `--battery N` fetches public builds, compares them and
writes this file. Two things block unattended runs:

1. **No mod catalogue.** Overframe's `slots` reference internal item ids (shared with
   weapons: Haalvu is `8015`) and there is no `/api/v1/mods` endpoint. `robots.txt`
   disallows crawling and the sitemap is behind Cloudflare.
2. **Ids cannot be solved from a build alone.** The drain/rank constraints narrow each slot
   to ~20-40 candidates, and the `rank` field does not match the mod ranks implied by the
   stats, so cross-checking is unreliable.

What *does* work: give the mod list once per build (`tools/overframe.ts --mods "…"`) and the
comparison is fully automatic and machine-checkable, including a solver that tries to learn
the ids (it refuses to write anything it cannot verify).

## To grow coverage

Each build compared by name teaches us its ids. Ten or so builds across rifles, shotguns,
melee and Incarnon would cover the mods that appear in most public builds.
