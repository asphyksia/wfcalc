# In-game calibration

The engine is verified against the wiki's formulas and invariants (`npm run validate`),
but every model needs to be anchored to the game. Combinatorial testing is impossible —
**fifteen well-chosen captures are better**, because each one isolates a layer, and the
layers compose.

Take these in order and stop at the first mismatch: everything above it is then verified
and you know where the error starts.

| # | What to capture | What it verifies | Compare against |
|---|---|---|---|
| 1 | Arsenal, unmodded weapon, damage figure | Weapon base stats from the export | `wfcalc calc "<weapon>"` → `damage/shot` |
| 2 | Same + Serration R10 | Damage bucket, +165% | same, `--mod Serration` |
| 3 | Same + Hellfire only | Elemental mod = 90% of base | `--mod Hellfire` → `elements` |
| 4 | Same + Hellfire + Cryo | Elemental **combination order** into Blast | `--mod Hellfire --mod "Cryo Rounds"` |
| 5 | Same + Point Strike / Vital Sense | Crit chance/damage multiplication | `--mod "Point Strike"` |
| 6 | Same + Split Chamber | Multishot display and damage/shot | `--mod "Split Chamber"` |
| 7 | A shotgun with a known pellet count | Per-pellet damage and status | `pellets` line |
| 8 | Enemy with **no** armour, one shot | Health-type modifier only | `--enemy` + `--level` |
| 9 | Grineer Bombard, one shot, radiation build | Armour DR + the armour-type modifier model | same |
| 10 | Same Bombard, slash bleed tick | DoT formula + True damage bypassing armour | `status damage` block |
| 11 | Same Bombard with 10 Corrosive stacks | Armour strip (26% + 6%/stack, 80% cap) | `--corrosive 10` |
| 12 | Corpus with shields, toxin build | Toxin shield bypass | `--faction corpus` |
| 13 | Kuva weapon with a known element % | The `--element-bonus` model | `--element-bonus heat:60` |
| 14 | Melee at 12x combo, heavy attack | Combo ladder and heavy multiplier | `--combo-hits 220 --heavy` |
| 15 | Roar at a known Ability Strength | Faction bonus bucket | `--buff roar --strength 284` |

## Reading a mismatch

- **Case 1 fails** → the base data is wrong (WFCD export drift). Stop; nothing downstream
  can be trusted.
- **Cases 2-7 fail** → the arsenal formula or the mod parser. Check the mod's effects with
  `wfcalc mods <weapon> <name>`; a wrong number there is a parser bug.
- **Case 8 passes, 9 fails** → the faction table or the armour DR. Since Damage 3.0
  (`docs/formulas.md §4`) there are no armour types: the class modifier multiplies damage
  and `armorDamageReduction()` only turns armour into DR. Check the enemy's `healthClass`
  first, then the DR curve.
- **Cases 10-12 fail** → the status layer.
- **Case 13 fails** → the Kuva/Tenet bonus, which is a player input rather than data.
- **Cases 14-15 fail** → the buff/combo layer, i.e. the curated registry, not the maths.

Record results in `docs/calibration-results.md` with the patch version, the build and the
numbers seen. Without that, the next data refresh silently un-verifies everything.
