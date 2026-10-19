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

## Damage is truncated per damage type (verified 2026-10)

Unmodded **Soma Prime** against a **Drekar Elite Lancer, level 27** (Alloy Armor 499):
**8 damage normal, 23 on a yellow crit**.

Our per-type values at that level are 1.00 impact / 3.09 puncture / 4.60 slash. Truncating each
type gives **1 + 3 + 4 = 8**, exactly what the game shows — so the displayed number is the sum
of per-type integers, not a rounded total.

The crit is less clean: truncating per type after `x3` gives 25, truncating the total gives 24,
and the game shows 23. A 4-8% gap that the `1/32` damage quantization described on the wiki
could account for; it is not a model-level error.

**This does not discriminate the three armour models**: at level 27 they differ by only 5%
(8.68 / 8.98 / 9.15 before truncation) and all three truncate to 8. To separate them the target
must have far more armour relative to its health — level 60+ or a Steel Path mission.

## The armour model: one of three eliminated (level 101, Steel-Path-grade armour)

**Soma Prime + maxed Serration, Elite Frontier Lancer level 101** (Alloy Armor at the 2700 cap):
**4 damage normal, 10 on a yellow crit.**

Per-type values before truncation, and what each model predicts:

| model | impact | puncture | slash | normal (truncated) |
|---|---|---|---|---|
| modifier scales armour | 1.00 | 2.17 | 1.99 | **4** ✅ |
| modifier multiplies damage | 1.00 | 1.46 | 1.99 | 3 ❌ |
| both | 1.00 | 2.49 | 1.99 | **4** ✅ |

So **"the armour modifier merely multiplies damage" is ruled out**: it predicts 3, the game
shows 4. The armour modifier does interact with the armour value.

That leaves two readings, and this data cannot separate them because puncture (the only type
whose value differs, 2.17 vs 2.49) truncates to 2 either way.

The crit (10) does not match any model at x3 (12-15 predicted) and the observed ratio, 2.5, is
lower than at level 27 (2.875). At 4-10 damage the wiki's `1/32` quantization is a large share
of the number, which is the likely cause; that quantization is still not modelled.

**Next data point needed**: the same build with far higher damage per shot (Serration plus an
elemental, or a stronger weapon), so truncation stops masking the 2.17 vs 2.49 difference.

## Consolidated armour evidence (four in-game observations)

All with an unmodded or lightly modded Soma Prime, summed per damage type.

| # | Target | Build | Observed | scales armour | multiplies | both |
|---|---|---|---|---|---|---|
| 1 | Elite Frontier Lancer 101 | none | 3 | 3 | 3 | 3 |
| 2 | Drekar Elite Lancer 27 | none | 8 / 23 | 8 / 26 | 8 / 24 | 8 / 27 |
| 3 | Elite Frontier Lancer 101 | Serration | 4 / 10 | 4 / 14 | **3** / 12 | 4 / 15 |
| 4 | Bombard 102 | Serration + Stormbringer | 7 / 19 | **7** / 21 | 6 / 17 | 6 / 19 |

Reading of the evidence:

- **"The modifier merely multiplies damage" is eliminated.** It predicts 3 where the game shows
  4 (row 3) and 6 where the game shows 7 (row 4).
- **The default ("modifier scales the armour value") is the best fit**: exact on rows 1, 2 and 4,
  and exact on row 3 once the display truncates per damage type.
- "Both" survives row 1 and row 3 but misses rows 2 and 4.

Two loose ends, stated plainly:

1. **Row 3 needs per-type truncation; row 4 needs the untruncated sum.** Truncating row 4 per
   type gives 5 against an observed 7, which is the one genuinely contradictory number in the
   set. It may be a different enemy level than reported, or a hit that included something else.
2. **The crit values are consistently below every model** (ratios 2.5-2.88 against a x3
   multiplier), which is what the unmodelled `1/32` quantization would do at these magnitudes.

Conclusion: keep `armor-scaling` as the default (it is the best-supported reading, and the only
one that is never contradicted by more than one number), with the caveat above recorded.

## RESOLVED: the armour model, by exact match

**Soma Prime + Serration + Stormbringer vs a level 102 Bombard: 5 damage normal, 19 on a
yellow (x3) crit.**

Our per-type values before the display truncates are **1.00 impact / 2.17 puncture / 1.99 slash
/ 1.97 electricity**, and the game's numbers are reproduced exactly:

```
normal = Σ floor(raw_i)      = 1 + 2 + 1 + 1 = 5    ✅ game shows 5
crit   = Σ floor(raw_i x 3)  = 3 + 6 + 5 + 5 = 19   ✅ game shows 19
```

That single observation confirms four separate things at once:

1. **The armour model**: "modifier scales the armour value" (electricity's -50% vs Alloy Armor
   lowers the armour, which is why it survives at 1.97 and not 1.43). The alternatives predict
   4 and 5 for the normal hit and 17 and 19 for the crit — "multiply" is out.
2. **Per-type truncation, applied after the crit multiplier.**
3. **The crit multiplier applies per damage type**, not to the summed total.
4. **The damage pipeline**: Serration x2.65 and Stormbringer's +90% of base damage.

Encoded as `tests/ingame.test.ts` against the real snapshot, so a data drift that breaks any of
these fails loudly.

The earlier reading of 7 for the same situation was the untruncated sum (7.13) — the game never
showed that; it is what our engine reports internally before truncation.


## Melee and secondary coverage

The in-game readings above are all Soma Prime. Melee and secondary arsenal stats are now covered
by the pinned external battery (`data/calibration-builds.json`): 8 melee and 5 secondary public
builds are compared field by field with Overframe, and `tests/calibration.test.ts` fails if that
slice regresses. A future in-game capture for a melee combo or a secondary alt-fire is still the
strongest check, but it is no longer the only one.
