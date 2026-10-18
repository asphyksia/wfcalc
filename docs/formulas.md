# Formulas and where they come from

Every formula here is implemented in `src/engine/` and tested in `tests/engine.test.ts`
against values quoted from the wiki. Sources are the official wiki pages downloaded
by `npm run update` into `data/raw/`.

## 1. Arsenal damage (`Damage/Calculation`)

```
total = base × [1 + Σ elemental bonuses + Σ share_i × physical bonus_i]
              × (1 + Σ damage bonuses)
              × multishot
```

Per damage type:

```
physical type  = base_i × (1 + ips_bonus_i) × (1 + damage_bonus)
element        = (innate_i + base_total × element_bonus) × (1 + damage_bonus)
```

Consequences worth remembering:

- Damage mods (Serration +165%) multiply **everything**, including elements and IPS bonuses.
- Elemental mods add a share of the **unmodded total**, then get multiplied by the
  damage bonus. Verified by test: 100 base + Serration + Hellfire → 90 heat × 2.65.
- Physical (IPS) mods only boost their own type's share.

### Elemental combination order

Elements combine in mod-slot order (top-left to bottom-right), with the weapon's
innate element counting first. Two singles of the same type just add up. A third
single pairs with the earliest pending compatible element.

| Pair | Result | | Pair | Result |
|---|---|---|---|---|
| Heat + Cold | Blast | | Cold + Toxin | Viral |
| Electricity + Toxin | Corrosive | | Cold + Electricity | Magnetic |
| Heat + Toxin | Gas | | Heat + Electricity | Radiation |

### Crit (`Damage/Calculation → Average Shot`)

```
modded crit chance   = base × (1 + Σ bonuses)
modded crit damage   = base × (1 + Σ bonuses)
average multiplier   = 1 + crit_chance × (crit_damage − 1)
```

Crit tiers (orange/red) are only relevant on a per-hit basis; the expected-value
formula above is what every calculator shows as "average damage".

### Mod ranks

Mods have `maxRank + 1` equal steps, so rank `r` of a `maxRank` mod is
`value × (r + 1) / (maxRank + 1)`: Serration R0 = +15%, R9 = +150%, R10 = +165%
(the wiki quotes the R9 example: `18 × (1 + 1.5) = 45`).

### Direct Damage (`Galvanized Aptitude` / `Savvy` / `Shot`)

"Direct Damage" is a **separate multiplier bucket**, not part of the base-damage bucket:
it multiplies the result of the damage mods instead of adding to them.

```
total = base × (1 + damage mods) × (1 + direct damage) × …
```

Verified against Overframe on the Haalvu build: `218.7 × 1.8 = 393.5`, where `1.8` is
Galvanized Aptitude at two stacks. Treating it as additive with Serration gave 284.6.

### Faction damage

`Bane of Grineer` and friends are a separate multiplier bucket
(`x1.3 Damage to Grineer` → ×1.3 against Grineer only), multiplicative with damage
mods, not additive to them.

## 2. Enemy scaling (`Enemy_Level_Scaling`, `Armor`)

Each stat is two endpoint curves blended with a smoothstep, evaluated in binary32:

```
f1(q) = 1 + C1 · q^E1
f2(q) = 1 + C2 · q^E2              q = level − base level
t = clamp((q − L) / (U − L), 0, 1) L = 70, U = 80
s = t² · (3 − 2t)
multiplier = f1 + (f2 − f1) · s
```

| Stat | Curve |
|---|---|
| Grineer/Scaldra health | `1 + 0.015q^2.12` → `1 + 10.7332q^0.72` |
| Corpus health | `1 + 0.015q^2.12` → `1 + 13.4165q^0.55` |
| Infested health | `1 + 0.0225q^2.12` → `1 + 16.0998q^0.72` |
| Corrupted/Orokin health | `1 + 0.015q^2.1` → `1 + 10.7332q^0.685` |
| Murmur/Sentient/Neutral health | `1 + 0.015q^2` → `1 + 10.7332q^0.5` |
| Corpus shields | `1 + 0.02q^1.76` → `1 + 2q^0.76` |
| Corrupted shields | `1 + 0.02q^1.75` → `1 + 2q^0.75` |
| Grineer/Sentient shields | `1 + 0.02q^1.75` → `1 + 1.6q^0.75` |
| Armor (all factions) | `1 + 0.005q^1.75` → `1 + 0.4q^0.75` |

Level-scaled armor is clamped to **200..2700**. Every enemy's base level is taken as
1 unless the dataset says otherwise (that is the case for all normal enemies).

## 3. Armor damage reduction (`Armor`)

```
armor ≤ 2700:  DR = 0.9 · sqrt(armor / 2700)
armor > 2700:  DR = armor / (armor + 300)
```

Armored enemies still take a minimum of 1 damage per damage type per hit.

## 4. Damage type modifiers (`Module:DamageTypes/data`)

Each health type (Cloned Flesh, Alloy Armor, Shield, ...) has positive and negative
modifiers in percentage points, e.g. Alloy Armor: Radiation +75, Cold +25,
Puncture +15, Electricity −50, Magnetic −50. The snapshot stores them as
`modifiers[damage_type][health_type]`.

```
health hit = damage × (1 + health_type_modifier) × (1 − DR)
shield hit = damage × (1 + shield_type_modifier)      (armor does not apply)
```

### Open question: how does an armour modifier interact with armour?

**Status: four in-game observations now favour the default reading.** "Modifier merely
multiplies damage" is eliminated (it predicts 3 where the game shows 4, and 6 where it shows
7). The default fits rows 1, 2 and 4 exactly and row 3 once the display truncates per damage
type. See [verified-in-game.md](verified-in-game.md) for the table and the two loose ends.

**This was the one modelling decision that had not been verified in game, and it is not a
detail.** Against a level 150 Bombard (2700 armour) with a radiation build, the three
readings give:

| reading | shots to kill | relative |
|---|---|---|
| modifier scales the armour value (default) | 28.9 | 1.0x |
| modifier multiplies damage, DR untouched | 113.2 | 3.9x slower |
| modifier does both | 17.2 | 1.7x faster |

The wiki says damage type modifiers are "independent of sources of damage reduction", which
argues for the middle reading, while every open-source calculator does the third. We default
to the first because it reproduces the community experience that radiation shreds Bombards,
but that is reasoning, not evidence.

`--armor-model armor-scaling|multiply|both` switches it at runtime, and
`armorDamageReduction()` is the only function involved.

**How to settle it with one screenshot**: take a radiation-modded weapon with a known
per-shot damage against a level 150 Bombard and read the damage number on screen. The three
models predict ratios of roughly 1 : 0.32 : 1.68, so a single hit discriminates them.

### Modelling decision: armour modifiers act on armour

A vulnerability does two things at once: it increases damage **and** makes armour
protect less. We model that the way the game does — by scaling the armour value:

```
effective_armor = armor × (1 − armor_type_modifier)
```

so `+75%` Radiation vs Alloy Armor turns 2700 armour into 675 (DR 90% → 45%).
The alternative model (armour modifier as a plain damage multiplier) gives visibly
different rankings against high-armour Grineer, so this is the first thing to
re-verify in game if numbers ever look off.

## 5. Warframe buffs and arcanes

Buff numbers come from each ability's wiki infobox (`tools/fetch-abilities.ts`), at max
rank. Ability Strength is a percentage (`--strength 284`), and every buff value is
`base × strength / 100`.

Buffs are classified by **how they enter the damage formula**, which the wikitext
describes in prose and therefore lives in a curated registry (`src/engine/buffs.ts`):

| Kind | Meaning | Examples |
|---|---|---|
| `damage` | Shares the damage-mod bucket with Serration | Eclipse +200%, Vex Armor +275%, Resupply +25% |
| `faction` | Faction damage bonus, multiplicative with everything, applied against the target's faction | Roar +50% |
| `element` | Adds a damage type worth N% of base damage; participates in elemental combination | Toxic Lash +30% Toxin, Nourish +250% Viral, Xata's Whisper +26% Void, the elemental augments +100% |
| `elementMultiplier` | Multiplies one existing damage type | Accelerant ×2.5 Heat |
| `speed` | Fire rate / attack speed | Warcry +50% |
| `weakPoint` | Replaces the weak-point multiplier (default ×2) | Sonar ×5 |

Notes:

- Roar is documented as "considered Faction Damage Bonus, additive with other sources of
  Faction Damage, multiplicative with other types of bonus of damage", so it lands in the
  same bucket as Bane of Grineer and is applied *after* armour.
- Sonar's ×5 is a replacement, not a multiplier on the base ×2 (which would be ×10).
- Elemental infusions add to base damage *after* damage mods, exactly like an elemental
  mod, so `Serration + Toxic Lash` scales the Toxin too.
- Weapon arcanes are parsed from the same text format as mods and obey their stack
  conditions (`--stacks onKill=5`). Arcane slots are enforced (a Melee arcane on a rifle
  gives a warning, not a silent wrong answer).

## 6. Status damage over time (`Damage_over_Time`)

```
tick      = (seed + 1) × C × status_damage_bonus × faction²
total     = tick × ticks
dot_dps   = procs_per_second × total
```

- `seed`: the modded damage of that type (the **whole** damage for Bleed).
- `C`: 0.35 for Slash, 0.5 for Heat / Electricity / Toxin / Gas.
- Faction damage is applied **twice** (it is already inside the seed), as the wiki notes.
- `ticks`: 6 for Slash/Heat/Toxin/Electricity/Gas, 1 for Blast's detonation.
- Bleed is **True** damage: no armour DR, no health-type modifier.
- `procs_per_second = fireRate × multishot × statusChance × damageShare`, plus forced
  procs such as Hunter Munitions (`+30% chance on crit` → crit-gated rate).

Verified by test against the wiki's worked example shape
(`(100 + 1) × 0.35` for a pure-Slash weapon).

### Target debuffs

| Effect | Rule |
|---|---|
| Viral (N stacks) | damage to health ×(1 + 100% first stack, +25% each further, cap 325%) |
| Corrosive (N stacks) | armour ×(1 − 26% first stack, −6% each further, cap 80%) |

These apply to direct hits and to DoT ticks alike.

## 7. Melee combo (`Melee_Combo`)

```
hits < 20        -> multiplier 1.0
hits >= 20       -> min(12, 2 + floor((hits - 20) / 20))     (2x at 20, 12x at 220)
```

The wiki is explicit: **the combo multiplier does not scale normal melee attacks**. It
scales heavy attacks (which spend the counter) and combo-scaling effects:

- Blood Rush: `+40% critical chance × (multiplier − 1)` — at 12x that is +440%.
- Weeping Wounds: same shape for status chance.

Mods marked `scalesWithCombo` by the parser are multiplied by `(multiplier − 1)`.

## 8. Incarnon evolutions

Each weapon's tree comes from its "X Incarnon Genesis" wiki page. Perk bullets are
parsed with the same number/target rules as mods, so percentage bonuses and flat base
damage both land correctly:

- `+60% Damage` → additive damage bonus.
- `Increase Base Damage by +51` → flat base damage, distributed over the weapon's damage
  composition and then multiplied by damage mods (verified: Torid 140 Toxin + Serration
  + 51 flat = 506.15 per projectile).

Perks whose text describes a mechanic (chaining beams, ammo pooling) are stored as text
and shown in the UI/CLI, but not applied.

Variants (Prime, Wrath, Vandal, Prisma, Mk1, Telos, Rakta, Synoid, Dex) inherit the tree
of their base weapon, because an Incarnon Genesis installs on the base weapon *and* its
variants. That is what turns 25 scraped trees into 54 usable ones.

## 9. Rivens (`Riven_Mods → Attributes`)

```
value = base × disposition × weight × roll
```

- `base` comes from the wiki base-value table, per weapon class (rifle / shotgun /
  pistol / archgun / melee). Bows, snipers and launchers use the rifle table.
- `disposition` is the game's own multiplier (`omegaAttenuation`), e.g. 0.7.
- `weight`: 2 bonuses 0.99 · 3 bonuses 0.75 · 2+malus 1.2375/−0.495 · 3+malus 0.9375/−0.75.
- `roll`: 0.9–1.1, default 1.0 (average riven).
- Rank scales as `(rank + 1) / 9`, matching the 8-rank riven scale.

## 10. AoE damage falloff

WFCD ships a `falloff: { start, end, reduction }` per attack. The arsenal stat block
counts the radial hit **at the centre of the blast**, so:

```
factor(d) = 1                                    d <= start
          = 1 - reduction × (d - start)/(end - start)   otherwise
          = 1 - reduction                        d >= end

total(d) = arsenal - radial + radial × factor(d)
```

Verified: Kuva Bramma at the centre 2718.9 per projectile, at 4 m 1754.6, at 9 m 717.9
(end 8.3 m, reduction 0.9 → the radial part keeps 10%).

## 11. Flat bonuses, crit spread and arcanes

- **Flat vs multiplicative**: mods scale the base stat (`crit × (1 + Σ)`) while a few
  effects are added to the final value. Arcane Avenger is flat: `30% base + 45% = 75%`,
  not `30% × 1.45 = 43.5%`.
- **Warframe arcanes** go through the same effect pipeline as mods, so their conditions
  (`on_damaged`, `on_critical_hit`, `onWeakPointHit`) use the same stack toggles.
- **Molt Augmented** grants Ability Strength, which is computed *before* buffs are
  resolved, so it raises Roar/Eclipse automatically.
- **Crit spread** (display only, the maths stays on expectations):

```
expected crits   = pellets × critChance
P(at least one)  = 1 - (1 - critChance)^pellets
```

- **Helminth**: the ability dataset carries a `Subsumable` flag; asking for a buff the
  chosen frame cannot have produces a warning instead of a silent wrong answer.

## 12. Kuva and Tenet elemental bonus

Kuva and Tenet weapons carry a player-chosen element worth 25-60% of **base damage**.
It behaves exactly like innate damage: it is added before anything else, counts as part
of base damage for elemental mods, and joins the combination first.

```
element_amount = base_total × bonus
```

Example (Kuva Bramma, 1026 base, 60% Heat): +615.6 Heat, which then combines with any
Cold mod into Blast — and that changes which element the build actually ends up with.

## 13. Harrow's Covenant (Retaliation)

```
bonus = (5% + 1.50% × damage_prevented/100) × strength     as FLAT crit chance
cap   = 50% on body shots, 200% on weak-point hits         (the page's 4x weak-point factor)
```

Flat means it is added after mods: `10% base × (1 + Point Strike 150%) + 200%`. The
damage prevented is the player's input (`--covenant-damage`); the calculator cannot know it.

## 14. Time to kill

Computed as rates rather than shots so status damage counts: shields first (only
shield-capable damage), then health using direct damage plus DoT DPS. Toxin bypasses
shields (except Treasurer and Hounds). Time comes from the sustained fire rate, which
accounts for the magazine and reload cycle.

## Calibration result (2026-10)

Validated against an independent calculator (Overframe) on a real Haalvu build:

| Stat | Overframe | wfcalc |
|---|---|---|
| Multishot | 1.80 | 1.80 |
| Critical chance | 75% | 75% |
| Critical damage | 5.5x | 5.5x |
| Status / projectile | 45.6% | 45.6% |
| Fire rate | 17.55 | 17.55 |
| Tau damage | 87.5 | 87.5 |
| Heat damage | 131.2 | 131.2 |
| Total (Aptitude active) | 393.5 | 393.5 |

That exercise found two real bugs: fire modes with an empty export damage dict resolving to
zero, and "Direct Damage" being merged into the base-damage bucket.

## Calibration

`npm run calibrate` compares public Overframe builds against wfcalc field by field using the
game's own modifier keys. Latest runs: **170/200** and **222/250** builds match.

`npm run audit` goes further: it looks for *causes* rather than counting symptoms (failure
rate per weapon category and per field, mods over-represented in failures). Its 250-build
sweep found that all 28 mismatches belong to four weapons — one field each — so the engine is
consistent across the other ~618.

Two cheap mechanics it surfaced, both now modelled: "(x2 for Bows)" doubling and the
Cannonade "Fire Rate cannot be modified" lock. Per-weapon data errors live in
`data/weapon-overrides.json`, each with the evidence that justifies it.

## Set Mod bonuses

Two shapes, both parsed from the set page:

- **amplify** (Umbral, Sacrificial): with 2+ pieces equipped, the set's own mods have their
  effect values scaled by the listed percentage. Verified: Sacrificial Steel 220% x 1.25 =
  275%, so a 0.24 crit weapon reaches 0.9 (matches the game).
- **table** (Vigilante, Gladiator): the value depends on the pieces equipped.
  Gladiator adds crit chance per combo step (`value x (multiplier - 1)`); Vigilante is a
  chance to upgrade a hit one crit tier, so a non-crit becomes a crit with probability X
  and the expectation is `1 + (cc + (1-cc) x X) x (cd - 1)`.

## Verification

Three layers, in `npm run validate` and `tests/`:

1. **Invariants** that any correct implementation satisfies, checked over all 622 weapons
   and 479 enemies: linearity in base damage, monotonicity, armour bounds, unit-sum
   shares, determinism, no NaN/negatives, breakdown sums.
2. **Golden values** quoted from the wiki, asserted to the decimal: Serration's
   `18 x (1 + 1.5) = 45`, armour `0.9 x sqrt(2700/2700) = 0.9`, the combo ladder, and the
   five DoT tick examples (`((40 x 1.55) + 1) x 0.5 x 3.25 x 1.55 = 158.68`).
3. **In-game calibration**: [calibration.md](calibration.md), fifteen isolating captures.

## Known approximations

- Buff uptime is not modelled: a buff is either on or off. "Fury at maximum" means the
  value assuming full ramp-up.

- Quantization (`1/32` of base damage) is **not** applied: it shifts things by well
  under 1% except for the Shattering Impact edge case. DoT ticks are not quantized in
  the game either, so the golden DoT examples match to the decimal.
- The DoT `+1` accumulator uses the seed before the elemental multiplier, which is what
  the wiki's worked examples do; treating it as a flat +1 would drift ~1%.
- Multishot and crit are treated as expectations, not per-pellet rolls.
- Fire rate is the trigger rate; charge weapons use the dataset's charge-inclusive rate.
- Area-of-effect falloff and punch-through multi-hits are not modelled.
