/**
 * Turns mod stat text into typed effects.
 *
 * Text comes from WFCD (`levelStats`, one array per rank) and looks like:
 *   "+165% Damage"
 *   "+90% <DT_FIRE_COLOR>Heat"
 *   "On Kill:\n+3.6% Direct Damage per Status Type affecting the target for 20s. Stacks up to 2x."
 *   "x1.03 Damage to Grineer"
 *   "+1.2 Punch Through"
 * Colour/markup tags are stripped, the number and its unit are read, and the rest is
 * matched against an ordered rule table. Anything unmatched marks the mod as `partial`
 * instead of silently pretending the mod does nothing.
 */
import { type DamageType, type Effect, type Faction } from '../types.ts';

/** Removes wiki markup tags such as `<DT_ELECTRICITY_COLOR>` and normalises whitespace. */
export function cleanStatText(text: string): string {
  return text
    .replace(/<[A-Z0-9_]+>/g, '')
    .replace(/\\n/g, '\n') // WFCD stores line breaks as a literal backslash + n
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Element name as written in mod text -> damage type key. */
const ELEMENT_BY_NAME: Record<string, DamageType> = {
  impact: 'impact',
  puncture: 'puncture',
  slash: 'slash',
  heat: 'heat',
  fire: 'heat',
  cold: 'cold',
  freeze: 'cold',
  electricity: 'electricity',
  electric: 'electricity',
  toxin: 'toxin',
  poison: 'toxin',
  blast: 'blast',
  corrosive: 'corrosive',
  gas: 'gas',
  magnetic: 'magnetic',
  radiation: 'radiation',
  viral: 'viral',
  true: 'true',
  void: 'void',
  tau: 'tau',
};

/** Faction name as written in mod text -> faction key. */
const FACTION_BY_NAME: Record<string, Faction> = {
  grineer: 'grineer',
  corpus: 'corpus',
  infested: 'infested',
  orokin: 'orokin',
  corrupted: 'orokin',
  murmur: 'murmur',
  sentient: 'sentient',
  sentients: 'sentient',
  narmer: 'narmer',
  tenno: 'tenno',
};

export interface ParsedStats {
  effects: Effect[];
  /** Lines that could not be mapped; an empty list means full coverage. */
  unmatched: string[];
}

type Mapped = Pick<Effect, 'target' | 'element' | 'faction' | 'op' | 'convertsTo'>;

/**
 * Flat list of `rest of line -> what it modifies`, checked in order.
 * The order matters: "Damage to Grineer" must not be read as plain damage, and
 * "Damage on first shot" must not be read as the generic damage rule.
 */
const TARGET_RULES: Array<[RegExp, Mapped]> = [
  // Conditions that live inside the line itself rather than in a header.
  [/^damage on first shot in magazine$/, { target: 'baseDamage', op: 'add' }],
  [/^damage on first shot$/, { target: 'baseDamage', op: 'add' }],

  [/^(?:melee |direct |base |rifle |pistol |shotgun |bow |sniper )?damage$/, { target: 'baseDamage', op: 'add' }],
  [/^damage$/, { target: 'baseDamage', op: 'add' }],

  [/^(?:critical chance|crit chance)$/, { target: 'critChance', op: 'add' }],
  [/^(?:critical damage|critical multiplier|crit damage)$/, { target: 'critDamage', op: 'add' }],
  [/^status chance$/, { target: 'statusChance', op: 'add' }],
  [/^status duration$/, { target: 'statusDuration', op: 'add' }],
  [/^status damage$/, { target: 'statusDamage', op: 'add' }],
  [/^multishot$/, { target: 'multishot', op: 'add' }],
  [/^(?:fire rate|attack speed)$/, { target: 'fireRate', op: 'add' }],
  [/^reload speed$/, { target: 'reloadSpeed', op: 'add' }],
  [/^magazine capacity$/, { target: 'magazine', op: 'add' }],
  [/^(?:ammo maximum|ammo capacity)$/, { target: 'ammoMax', op: 'add' }],
  [/^punch through$/, { target: 'punchThrough', op: 'add' }],
  [/^accuracy$/, { target: 'accuracy', op: 'add' }],
  [/^recoil$/, { target: 'recoil', op: 'add' }],
  [/^zoom$/, { target: 'zoom', op: 'add' }],
  [/^(?:combo duration|combo count chance)$/, { target: 'comboCount', op: 'add' }],
  [/^(?:weak point damage|headshot damage|to headshot multiplier|weak point critical chance)$/, { target: 'headshotMultiplier', op: 'add' }],
  [/^finisher damage$/, { target: 'finisherDamage', op: 'add' }],
  [/^(?:slam attack damage|heavy attack damage)$/, { target: 'heavyAttackDamage', op: 'add' }],
  [/^range$/, { target: 'range', op: 'add' }],
  [/^projectile speed$/, { target: 'projectileSpeed', op: 'add' }],
  [/^(?:weapon )?(?:spread|recoil)$/, { target: 'recoil', op: 'add' }],
  [/^(?:weapon )?zoom(?: while aim gliding)?$/, { target: 'zoom', op: 'add' }],
  [/^(?:weapon )?fire rate$/, { target: 'fireRate', op: 'add' }],
  [/^heavy attack wind ?up speed$/, { target: 'heavyAttackSpeed', op: 'add' }],
  [/^(?:blast radius|blast range)$/, { target: 'blastRadius', op: 'add' }],
  [/^chance to explode.*$/, { target: 'explodeChance', op: 'add' }],
];

/** Maps the descriptive part of a stat line onto an effect target. */
export function mapTarget(rest: string): Mapped | null {
  const text = rest.toLowerCase().trim();

  const converted = /(?:of )?damage converted into (\w+)/i.exec(rest);
  if (converted) {
    const element = ELEMENT_BY_NAME[converted[1].toLowerCase()];
    if (element) return { target: 'convertedDamage', op: 'convert', convertsTo: element };
  }

  const faction = /damage to (?:the )?(\w+)/i.exec(rest);
  if (faction) {
    const key = FACTION_BY_NAME[faction[1].toLowerCase()];
    if (key) return { target: 'factionDamage', faction: key, op: 'add' };
  }

  // Bare element names, and "<Element> Damage" phrasings.
  const elementName = /^(\w+)(?: damage)?$/.exec(text);
  if (elementName && ELEMENT_BY_NAME[elementName[1]]) {
    return { target: 'element', element: ELEMENT_BY_NAME[elementName[1]], op: 'add' };
  }

  for (const [re, mapped] of TARGET_RULES) if (re.test(text)) return mapped;
  return null;
}

export interface ConditionInfo {
  key: string;
  maxStacks?: number;
}

/** Recognises a `Condition:` header line, e.g. "On Kill:" or "On Weak Point Hit:". */
export function readConditionHeader(line: string): ConditionInfo | null {
  if (!line.endsWith(':')) return null;
  const head = line.slice(0, -1).toLowerCase().trim();
  const stacks = /stacks up to (\d+)\s*x?/i.exec(line);
  const matchers: Array<[RegExp, string]> = [
    [/^on weak point kill$|^on headshot kill$/, 'onWeakPointKill'],
    [/^on weak point hit$|^on headshot$|^on headshot hit$/, 'onWeakPointHit'],
    [/^on kill$|^on melee kill$|^on ability kill$/, 'onKill'],
    [/^on hit$/, 'onHit'],
    [/^when aiming$|^while aiming$/, 'aiming'],
    [/^when sliding$|^while sliding$/, 'sliding'],
    [/^on reload from empty$/, 'onReloadEmpty'],
    [/^on reload$/, 'onReload'],
    [/^when holstered$/, 'holstered'],
    [/^when damaged$/, 'whenDamaged'],
    [/^on ability cast$/, 'onAbilityCast'],
    [/^on consecutive throw/, 'consecutiveThrow'],
    [/^while airborne$/, 'airborne'],
    [/^on block$|^when blocking$/, 'blocking'],
  ];
  for (const [re, key] of matchers) if (re.test(head)) return { key, maxStacks: stacks ? Number(stacks[1]) : undefined };
  return { key: head.replace(/\W+/g, '_') };
}

interface NumberMatch {
  value: number;
  /** '%' for percentages, 'x' for multipliers, null for flat values. */
  unit: '%' | 'x' | null;
  rest: string;
}

/** Reads the number of a stat line: `+165% Damage`, `x1.03 Damage to Grineer`, `+1.2 Punch Through`. */
export function readNumber(text: string): NumberMatch | null {
  const m = /^(x?)\s*([+-]?\d+(?:[.,]\d+)?)\s*(%|x|s|m)?\s+(.+)$/i.exec(text);
  if (!m) return null;
  const explicit = m[1].toLowerCase() === 'x';
  const raw = m[3]?.toLowerCase();
  // `s` and `m` are units ("12s Combo Duration", "6m Enemy Radar"), not multipliers.
  const unit = explicit ? 'x' : raw === '%' || raw === 'x' ? (raw as '%' | 'x') : null;
  return { value: Number(m[2].replace(',', '.')), unit, rest: m[4].trim() };
}

/** Strips bookkeeping tails (`for 20s`, `Stacks up to 5x`, parentheticals) from a stat line. */
function stripQualifiers(text: string): string {
  return text
    .replace(/\s*for \d+(?:\.\d+)?\s*s(?:econds)?\.?/gi, '')
    .replace(/\s*stacks? up to \d+\s*(?:x|%)?\.?/gi, '')
    .replace(/\s*per (?:status type|status|unique status|status effect)(?: affecting the target)?/gi, '')
    .replace(/\s*multishot cannot be modified\.?/gi, '')
    .replace(/\s*on (?:your )?(?:next shot|next attack|melee strikes?|strikes?)\b/gi, '')
    .replace(/\s*when (?:aiming|sliding|holstered|airborne|blocking)\b/gi, '')
    .replace(/\s*while (?:aiming|aim gliding|sliding|airborne|blocking|holstered)\b/gi, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\.$/, '')
    .replace(/\s+and$/i, '')
    .trim();
}

/**
 * Stat lines that never affect damage output (utility, syndicate effects, sentinel/K-Drive/
 * Railjack extras). They are dropped silently so `partial` only flags real gaps.
 */
const NOISE_RULES: RegExp[] = [
  /^(?:converts? )?(?:primary|secondary|sniper|shotgun)?\s*ammo pickup/i,
  /^(?:primary|secondary|sniper|shotgun) ammo (?:pickup|conversion)/i,
  /^converts .*ammo/i,
  /^\d+%? ?'[a-z]+'$/i,
  /^reveals? (?:target|enemies)/i,
  /^(?:a )?chance to (?:open|stagger|stun|resist|unlock)/i,
  /^(?:reduced damage by|damage during bleedout|faster knockdown)/i,
  /^\d+%? from health orbs$/i,
  /^health per hit$/i,
  /^movement speed when aiming$/i,
  /^creates? /i,
  /^enemies killed explode/i,
  /^\+?\d+m (?:loot|enemy) radar$/i,
  /^.*turret.*$/i,
  /^.*railjack.*$/i,
  /^.*hijacked.*$/i,
  /^.*sentinel.*$/i,
  /^.*companion.*$/i,
  /^.*ore gaze.*$/i,
  /^.*k-drive.*$/i,
  /^.*conservation.*$/i,
  /^.*fishing.*$/i,
  /^.*mining.*$/i,
  /^.*pickpocket.*$/i,
  /^-?\d+%? (?:chance to )?(?:proc|apply) /i,
  /^instant (?:reload|weapon swap)/i,
  /^(?:on kill|on hit)?:?\s*-?\d+% (?:weapon )?(?:shield|health|energy|overguard|sprint|parkour|mobility|loot|chance)/i,
  /^enables tennokai/i,
  /^refresh double jump/i,
  /^\d+\s*(?:m )?(?:beam range|heal rate)/i,
  /^\d+%? (?:dodge|revive|cast(?:ing)?|sprint|movement|slide|parkour|mobility) speed/i,
  /^\d+ initial combo\b/i,
  /^(?:you will|fatal strikes|this mod|the beauty)/i,
  /^\d+%? (?:heavy attack efficiency|combo efficiency)$/i,
  /^\d+%? magazine reloaded\/s/i,
  /^\d+%? (?:weapon )?recoil and/i,
  /^impact status effects have/i,
  /finisher attacks after warframe blocks/i,
];

/** Returns true when a stat line is known to be irrelevant to damage maths. */
export function isNoise(line: string): boolean {
  const text = line.toLowerCase().trim();
  return NOISE_RULES.some((re) => re.test(text));
}

/**
 * Splits a stat block into individual lines. WFCD packs a whole mod into one entry
 * per rank and multi-line conditions arrive as `"On Kill:\n+30% Multishot ..."`.
 */
export function splitStatLines(stats: string[]): string[] {
  return stats
    .flatMap((s) => cleanStatText(s).split('\n'))
    // Arcanes pack the condition inline: "On Weak Point Hit: Gain +300% damage".
    .flatMap((s) => {
      const inline = /^((?:On|When|While|After)\b[^:]{0,40}?):\s*(.+)$/i.exec(s);
      return inline ? [`${inline[1]}:`, inline[2]] : [s];
    })
    // "+40% Weapon Recoil and +40% Accuracy" is two effects on a single line.
    .flatMap((s) => s.split(/\s+and\s+(?=[+-]?\d)/))
    // "+25% Critical Chance and Damage" means both stats.
    .flatMap((s) => {
      const both = /^(\S+%?) (?:Critical|Crit) Chance and Damage(.*)$/i.exec(s);
      return both ? [`${both[1]} Critical Chance${both[2]}`, `${both[1]} Critical Damage${both[2]}`] : [s];
    })
    .map((s) => s.replace(/^and\s+/i, ''))
    // Arcanes phrase effects as "Gain +60% Corrosive Damage" or "21% chance for +45% Critical Chance".
    .map((s) => s.replace(/^gain\s+/i, ''))
    .map((s) => s.replace(/^\d+(?:[.,]\d+)?%\s+chance\s+(?:for|to gain)\s+/i, ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses one mod's per-rank stat strings into effects.
 * `ranks` is WFCD `levelStats`: `[{stats: [...]}, ...]`, one entry per rank.
 * Effects are read from the highest rank; the engine scales them linearly
 * (`value * rank / maxRank`), which is how Warframe mods grow.
 */
export function parseModEffects(ranks: string[][]): ParsedStats {
  const effects: Effect[] = [];
  const unmatched: string[] = [];
  const top = splitStatLines(ranks[ranks.length - 1] ?? []);

  let header: ConditionInfo | null = null;
  for (const line of top) {
    const nextHeader = readConditionHeader(line);
    if (nextHeader) {
      header = nextHeader;
      continue;
    }
    if (isNoise(line)) continue;

    const num = readNumber(line);
    const rest = num ? stripQualifiers(num.rest) : stripQualifiers(line);
    const mapped = mapTarget(rest);
    if (!num || !mapped) {
      unmatched.push(line);
      continue;
    }

    // A header condition wins; otherwise look for a condition inside the line itself.
    // Both can apply: "On Kill:\n+120% Critical Damage when Aiming" needs both toggles.
    const inline = /\bwhen (aiming|sliding|holstered)\b|\bwhile (aiming|sliding)\b/i.exec(num.rest);
    const inlineKey = inline ? (inline[1] ?? inline[2] ?? '').toLowerCase() : undefined;
    let condition = header?.key;
    if (inlineKey) condition = condition ? `${condition}+${inlineKey}` : inlineKey;
    if (!condition && /^damage on first shot/i.test(num.rest)) condition = 'firstShot';
    const perStatusType = /\bper (?:status type|status|unique status|status effect)/i.test(num.rest);
    // "Stacks up to 240%" is a cap on the total, "Stacks up to 5x" is a stack count.
    const stacks = /stacks? up to (\d+)\s*(x|%)?/i.exec(num.rest);
    let maxStacks = stacks ? Number(stacks[1]) : undefined;
    if (stacks && stacks[2] === '%' && num.unit === '%' && num.value > 0) {
      maxStacks = Math.max(1, Math.round(Number(stacks[1]) / num.value));
    }

    const effect: Effect = {
      ...mapped,
      value: num.unit === '%' ? num.value / 100 : num.unit === 'x' ? num.value - 1 : num.value,
      raw: line,
    };
    if (condition) effect.condition = condition;
    if (header?.maxStacks) effect.maxStacks = header.maxStacks;
    if (maxStacks !== undefined) effect.maxStacks = maxStacks;
    if (perStatusType) effect.perStatusType = true;
    if (num.unit === null) effect.flat = true;
    if (mapped.op === 'convert') effect.value = Math.abs(effect.value);
    effects.push(effect);
  }

  return { effects, unmatched };
}
