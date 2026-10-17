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

## 11. Time to kill

Computed as rates rather than shots so status damage counts: shields first (only
shield-capable damage), then health using direct damage plus DoT DPS. Toxin bypasses
shields (except Treasurer and Hounds). Time comes from the sustained fire rate, which
accounts for the magazine and reload cycle.

## Known approximations

- Buff uptime is not modelled: a buff is either on or off. "Fury at maximum" means the
  value assuming full ramp-up.

- Quantization (`1/32` of base damage) is **not** applied: it shifts things by well
  under 1% except for the Shattering Impact edge case.
- Multishot and crit are treated as expectations, not per-pellet rolls.
- Fire rate is the trigger rate; charge weapons use the dataset's charge-inclusive rate.
- Area-of-effect falloff and punch-through multi-hits are not modelled.
