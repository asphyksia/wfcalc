# Verified in game

Numbers read from the arsenal by the user, compared against `data/snapshot.json`. This is the
only ground truth the project has; everything else is the wiki, the export, or Overframe.

| Weapon | Stat | In game | Our data | Verdict |
|---|---|---|---|---|
| Ocucor | Multishot | 1 | 1 | ✅ |
| Ocucor | Critical chance | 16% | 16% | ✅ |
| Ocucor | Status chance | 24% | 24% | ✅ |
| Phantasma Prime | Multishot, primary beam | 6 | 6 | ✅ |
| Phantasma Prime | Status chance, beam | 22.2% | 22.2% | ✅ |
| Phantasma Prime | Critical chance, beam | 11% | 11% | ✅ |
| Phantasma Prime | Multishot, alt-fire | 1 | 6 → **now 1** | 🔧 fixed |
| Phantasma Prime | Alt-fire crit / status (bomb and radial) | 3% / 37% | 3% / 37% | ✅ |

## What this settled

- **Ocucor and Phantasma Prime are correct in our data.** Overframe's oracle is wrong for their
  multishot (exactly +1.0 for Ocucor; 11.5 where neither 6 nor 5 predicts it). Both are now
  listed in `data/oracle-exceptions.json` with this evidence and skipped by the calibration,
  so a green run keeps meaning something.
- **Acceltra's status is also an oracle artefact**: their number is the chance of at least one
  proc per shot, `1-(1-0.06)^1.9`, exact to eight decimals. 112 of 120 builds show the oracle
  is per-projectile, so we keep ours.
- **A real bug was found and fixed**: fire modes inherited the weapon's multishot, so
  Phantasma Prime's alt-fire was modelled with 6 projectiles instead of 1. Fire modes can now
  be corrected per mode in `data/weapon-overrides.json`.

## Still open

- **Tenet Arca Plasmor**: does a Cannonade mod block the fire rate penalty? Our answer (blocked,
  following the mod text) is the last failing comparison, ratio x1.25.
- **The armour-modifier model**: needs one damage number from a level 150 Bombard. See
  `docs/formulas.md`.

## Armour floor (verified 2026-10)

Unmodded **Soma Prime** (12 damage: 1.2 impact / 4.8 puncture / 6 slash, three damage types)
against an **Elite Frontier Lancer, level 101**: **3 damage**.

At that level the enemy sits at the 2700 armour cap, so every damage type works out below 1.
The wiki states the rule explicitly ("a Braton will always do a minimum of 3 damage against
an armored target"). The observation therefore **confirms the minimum-of-1-per-damage-type
rule**, which the engine was not implementing, and it is now enforced in `damage.ts`.

It does **not** discriminate between the three armour-modifier models: with all three types
floored, every model predicts exactly 3.

To settle the model we need a case that does *not* hit the floor — a modded weapon, or a
lower-level target. Predicted ratios against a Bombard with pure Radiation:

| Level | armour | modifier scales armour | modifier multiplies damage | both |
|---|---|---|---|---|
| 20 | 932 | 0.74 | 0.82 | 1.29 |
| 40 | 2022 | 0.61 | 0.39 | 1.07 |
| 60 | 2700 | 0.55 | 0.17 | 0.96 |
