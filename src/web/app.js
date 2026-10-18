/**
 * wfcalc web UI. Vanilla JS, no build step: the server serves this file directly.
 * All damage maths happens server-side through POST /api/calc, which keeps the
 * browser in sync with the CLI by construction.
 */

const MAX_SLOTS = 8;

const ELEMENT_COLORS = {
  impact: '#8b93a8',
  puncture: '#a08a6a',
  slash: '#c0504d',
  heat: '#f0793a',
  cold: '#5bbcec',
  electricity: '#7f7fdc',
  toxin: '#9fc03a',
  blast: '#c6502a',
  corrosive: '#93c203',
  gas: '#7fb04a',
  magnetic: '#7f8fd0',
  radiation: '#c8b23c',
  viral: '#4aa88a',
  true: '#dcdcdc',
  void: '#b07fd0',
  tau: '#d0a05b',
};

const state = {
  weapon: '',
  mods: [], // [{ name, rank }]
  arcanes: [], // [{ name, rank }]
  buffs: [], // registry ids, e.g. ['roar', 'toxic-lash']
  frameMods: [], // [{ name, rank }] for the caster's Warframe
  abilityStrength: 100,
  riven: null, // { stats: [], malus }
  incarnon: [], // ['EVO2:0']
  comboHits: 0,
  heavyAttack: false,
  aoeDistance: null,
  elementBonus: null, // { type, value }
  debuffs: { viralStacks: 0, corrosiveStacks: 0 },
  enemy: 'Bombard',
  level: 100,
  mode: '',
  conditions: {},
  headshot: false,
};

const $ = (id) => document.getElementById(id);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** ---------- state <-> URL ---------- */

function saveToUrl() {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
  history.replaceState(null, '', `#${payload}`);
}

function loadFromUrl() {
  if (!location.hash || location.hash.length < 2) return false;
  try {
    Object.assign(state, JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1))))));
    return true;
  } catch {
    return false;
  }
}

/** ---------- data loading ---------- */

let allMods = [];
let allBuffs = [];

async function loadStaticLists() {
  const [weapons, enemies, buffs] = await Promise.all([
    getJson('/api/weapons'),
    getJson('/api/enemies'),
    getJson('/api/buffs'),
  ]);
  allBuffs = buffs;
  renderBuffList();
  $('weapon-list').innerHTML = weapons.map((w) => `<option value="${w.name}">${w.type}</option>`).join('');
  $('enemy-list').innerHTML = enemies
    .map((e) => `<option value="${e.name}">${e.faction ?? ''} hp${e.health}</option>`)
    .join('');
}

async function loadModsForWeapon() {
  if (!state.weapon) return;
  const [mods, arcanes] = await Promise.all([
    getJson(`/api/mods?weapon=${encodeURIComponent(state.weapon)}`),
    getJson(`/api/arcanes?weapon=${encodeURIComponent(state.weapon)}`),
  ]);
  allMods = mods;
  renderModList('');
  $('arcane-list').innerHTML = arcanes
    .map((a) => `<option value="${a.name}">${(a.description || '').split('\n')[0].slice(0, 44)}</option>`)
    .join('');
}

/** Checkbox per modelled Warframe buff. */
function renderBuffList() {
  $('buff-list').innerHTML = allBuffs
    .map(
      (buff) => `<label>
        <input type="checkbox" value="${buff.id}" ${state.buffs.includes(buff.id) ? 'checked' : ''} />
        <span>${buff.ability}${buff.augments ? ' †' : ''} <span class="frame">${buff.frame}</span></span>
      </label>`,
    )
    .join('');
  $('buff-list').querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', () => {
      state.buffs = [...$('buff-list').querySelectorAll('input:checked')].map((el) => el.value);
      recalc();
    });
  });
}

const renderModList = debounce((filter) => {
  const list = allMods.filter((m) => m.name.toLowerCase().includes(filter));
  $('mod-list').innerHTML = list
    .slice(0, 400)
    .map((m) => `<option value="${m.name}">${(m.description || '').split('\n')[0].slice(0, 48)}</option>`)
    .join('');
}, 120);

/** `damage,multishot,-zoom` -> { stats, malus } */
function parseRivenInput(text) {
  const stats = [];
  let malus = null;
  for (const token of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (token.startsWith('-')) malus = token.slice(1);
    else stats.push(token);
  }
  return stats.length ? { stats, malus } : null;
}

/** ---------- rendering ---------- */

function renderWeaponMeta(result) {
  const meta = $('weapon-meta');
  if (!result?.weapon) {
    meta.innerHTML = '';
    $('mode-field').hidden = true;
    return;
  }
  const w = result.weapon;
  meta.innerHTML = `<span class="chip">${w.type}</span><span class="chip">MR ${w.masteryRank}</span>
    <span class="chip">${(w.disposition ?? 1).toFixed(1)}★ riven</span>
    <span class="chip">${w.modClasses.join(' / ')}</span>`;
  const modes = w.modes ?? [];
  $('mode-field').hidden = modes.length === 0;
  if (modes.length) {
    $('mode-select').innerHTML = ['<option value="">arsenal (default)</option>', ...modes.map((m) => `<option value="${m}">${m}</option>`)].join('');
    $('mode-select').value = state.mode;
  }
}

function renderSlots() {
  const container = $('slots');
  container.innerHTML = '';
  state.mods.forEach((mod, index) => {
    const info = allMods.find((m) => m.name === mod.name);
    const maxRank = info?.maxRank ?? 0;
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `
      <input class="mod-name" list="mod-list" value="${mod.name.replace(/"/g, '&quot;')}" data-index="${index}" />
      <input class="rank" type="range" min="0" max="${maxRank}" value="${mod.rank ?? maxRank}" data-index="${index}" title="mod rank" />
      <span class="rank-value">R${mod.rank ?? maxRank}</span>
      <button class="remove" data-index="${index}" title="remove">×</button>`;
    container.appendChild(row);
  });
  if (state.mods.length < MAX_SLOTS) {
    const add = document.createElement('button');
    add.className = 'add-slot';
    add.textContent = '+ add mod';
    add.onclick = () => {
      state.mods.push({ name: '', rank: undefined });
      renderSlots();
    };
    container.appendChild(add);
  }
  $('mod-count').textContent = state.mods.filter((m) => m.name).length;

  container.querySelectorAll('.mod-name').forEach((input) => {
    input.addEventListener('input', (event) => {
      const index = Number(event.target.dataset.index);
      state.mods[index].name = event.target.value;
      state.mods[index].rank = undefined;
      renderModList(event.target.value.toLowerCase());
      recalc();
    });
    input.addEventListener('change', () => {
      renderSlots();
      recalc();
    });
  });
  container.querySelectorAll('.rank').forEach((input) => {
    input.addEventListener('input', (event) => {
      const index = Number(event.target.dataset.index);
      state.mods[index].rank = Number(event.target.value);
      event.target.parentElement.querySelector('.rank-value').textContent = `R${event.target.value}`;
      recalc();
    });
  });
  container.querySelectorAll('.remove').forEach((button) => {
    button.onclick = () => {
      state.mods.splice(Number(button.dataset.index), 1);
      renderSlots();
      recalc();
    };
  });
}

const fmt = (value, digits = 0) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (value) => `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;

function renderResults(result) {
  if (result.error) {
    $('stats').innerHTML = `<p class="error">${result.error}</p>`;
    return;
  }
  const critMultiplier = 1 + result.critChance * (result.critMultiplier - 1);
  const target = result.target;
  const dot = target?.dot ?? [];
  const dotDps = dot.reduce((sum, entry) => sum + entry.dps, 0);

  $('stats').innerHTML = `
    <div class="card"><span>damage / projectile</span><b>${fmt(result.projectileTotal, 1)}</b></div>
    <div class="card"><span>damage / shot</span><b>${fmt(result.averageShotDamage, 0)}</b></div>
    <div class="card"><span>crit</span><b>${pct(result.critChance)} ×${fmt(result.critMultiplier, 2)}</b><small>avg ×${critMultiplier.toFixed(2)}</small></div>
    <div class="card"><span>status</span><b>${pct(result.statusChance)}</b><small>${fmt(result.statusChance * result.multishot, 2)} procs/shot</small></div>
    <div class="card"><span>multishot</span><b>×${fmt(result.multishot, 2)}</b><small>${fmt(result.fireRate, 2)} shots/s</small></div>
    <div class="card"><span>burst dps</span><b>${fmt(result.burstDps, 0)}</b></div>
    <div class="card"><span>sustained dps</span><b>${fmt(result.sustainedDps, 0)}</b><small>reload ${fmt(result.reloadTime, 2)}s</small></div>
    ${result.activeBuffs?.length ? `<div class="card"><span>buffs</span><b>${result.activeBuffs.length}</b><small>${result.activeBuffs.join(', ')}</small></div>` : ''}
    ${target && target.factionMultiplier && Math.abs(target.factionMultiplier - 1) > 0.001 ? `<div class="card"><span>faction</span><b>×${target.factionMultiplier.toFixed(2)}</b><small>${target.faction ?? ''}</small></div>` : ''}
    ${result.critVariance && result.critVariance.pellets >= 2 ? `<div class="card"><span>crit spread</span><b>${result.critVariance.expectedCrits.toFixed(1)} / ${result.critVariance.pellets.toFixed(0)}</b><small>${pct(result.critVariance.atLeastOneCrit)} of shots crit</small></div>` : ''}
    ${dotDps > 0 ? `<div class="card"><span>status dps</span><b>${fmt(dotDps, 0)}</b><small>${dot.length} type(s)</small></div>` : ''}
    ${result.comboMultiplier > 1 ? `<div class="card"><span>combo</span><b>${result.comboMultiplier.toFixed(1)}x</b><small>${state.comboHits} hits</small></div>` : ''}
    ${target ? `<div class="card accent"><span>time to kill lv${target.level}</span><b>${target.timeToKill === null ? '—' : fmt(target.timeToKill, 2) + 's'}</b><small>${fmt(target.shotsToKill, 1)} shots</small></div>` : ''}
  `;

  $('damage-bars').innerHTML = result.elements
    .sort((a, b) => b.share - a.share)
    .map(
      (element) => `
      <div class="bar-row">
        <span class="bar-label">${element.type}</span>
        <div class="bar"><i style="width:${(element.share * 100).toFixed(1)}%;background:${ELEMENT_COLORS[element.type] ?? '#888'}"></i></div>
        <span class="bar-value">${fmt(result.damage[element.type], 1)} <small>${pct(element.share)}</small></span>
      </div>`,
    )
    .join('');

  if (target) {
    $('target-report').innerHTML = `
      <div class="meta">
        <span class="chip">${target.name}</span>
        <span class="chip">${fmt(target.health)} hp</span>
        ${target.shield ? `<span class="chip">${fmt(target.shield)} shields</span>` : ''}
        ${target.armor ? `<span class="chip">${fmt(target.armor)} armor</span>` : ''}
        ${target.pools.map((p) => `<span class="chip subtle">${p.type}</span>`).join('')}
      </div>
      <table class="breakdown">
        <thead><tr><th>type</th><th>raw</th><th>vs health</th><th>dmg to health</th><th>procs</th></tr></thead>
        <tbody>
        ${target.breakdown
          .slice()
          .sort((a, b) => b.toHealth - a.toHealth)
          .map(
            (entry) => `<tr>
              <td><i class="dot" style="background:${ELEMENT_COLORS[entry.type] ?? '#888'}"></i>${entry.type}</td>
              <td>${fmt(entry.raw, 1)}</td>
              <td>×${entry.healthMultiplier.toFixed(2)}</td>
              <td>${fmt(entry.toHealth, 1)}</td>
              <td>${pct(entry.procShare)}</td>
            </tr>`,
          )
          .join('')}
        </tbody>
      </table>`;
  } else {
    $('target-report').innerHTML = '';
  }

  const notes = [...result.warnings];
  if (result.unsupportedMods.length) notes.push(`Unknown mod effects (numbers are a lower bound): ${result.unsupportedMods.join(', ')}`);
  if (result.inactiveConditions.length) notes.push(`${result.inactiveConditions.length} conditional effect(s) inactive — raise the stacks to activate`);
  if (result.weapon.mode) notes.push(`Using fire mode: ${result.weapon.mode}`);
  if (result.incarnon?.length) notes.push(`Incarnon: ${result.incarnon.join(' / ')}`);
  if (dot.length) {
    $('target-report').innerHTML += `
      <table class="breakdown">
        <thead><tr><th>status</th><th>proc/s</th><th>tick</th><th>ticks</th><th>dps</th></tr></thead>
        <tbody>${dot
          .slice()
          .sort((a, b) => b.dps - a.dps)
          .map(
            (entry) => `<tr><td><i class="dot" style="background:${ELEMENT_COLORS[entry.type] ?? '#888'}"></i>${entry.type}</td>
              <td>${fmt(entry.procsPerSecond, 2)}</td><td>${fmt(entry.tickDamage, 1)}</td><td>${entry.ticks}</td><td>${fmt(entry.dps, 0)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  }
  $('notes').innerHTML = notes.map((note) => `<p>· ${note}</p>`).join('');
}

/** ---------- calculation ---------- */

let calculationId = 0;

async function recalc() {
  saveToUrl();
  if (!state.weapon) {
    $('stats').innerHTML = '<p class="hint">Pick a weapon to start.</p>';
    $('damage-bars').innerHTML = '';
    $('target-report').innerHTML = '';
    $('notes').innerHTML = '';
    return;
  }
  const id = ++calculationId;
  const mods = state.mods.filter((m) => m.name);
  const result = await fetch('/api/calc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...state, mods, arcanes: state.arcanes.filter((a) => a.name) }),
  }).then((r) => r.json());
  if (id !== calculationId) return; // a newer request is in flight
  renderWeaponMeta(result);
  renderResults(result);
  if (result.target) {
    $('enemy-meta').innerHTML = `<span class="chip">${fmt(result.target.health)} hp</span>
      <span class="chip">${fmt(result.target.armor)} armor</span>${result.target.shield ? `<span class="chip">${fmt(result.target.shield)} shields</span>` : ''}`;
  }
}

/** ---------- events ---------- */

function bindEvents() {
  $('weapon-input').addEventListener('change', async (event) => {
    const name = event.target.value;
    if (name === state.weapon) return;
    state.weapon = name;
    state.mods = [];
    allMods = [];
    await loadModsForWeapon();
    renderSlots();
    recalc();
  });

  $('mod-filter').addEventListener('input', (event) => renderModList(event.target.value.toLowerCase()));

  $('element-bonus').addEventListener('change', (event) => {
    const [type, raw] = event.target.value.split(':');
    const amount = Number((raw ?? '').replace('%', ''));
    state.elementBonus = type && Number.isFinite(amount)
      ? { type: type.trim().toLowerCase(), value: amount > 1 ? amount / 100 : amount }
      : null;
    recalc();
  });

  $('arcane-input').addEventListener('change', (event) => {
    const name = event.target.value.trim();
    state.arcanes = name ? [{ name }] : [];
    recalc();
  });

  $('strength-input').addEventListener('input', (event) => {
    state.abilityStrength = Number(event.target.value);
    $('strength-value').textContent = `${state.abilityStrength}%`;
    recalc();
  });

  $('mode-select').addEventListener('change', (event) => {
    state.mode = event.target.value;
    recalc();
  });

  $('enemy-input').addEventListener('change', (event) => {
    state.enemy = event.target.value;
    recalc();
  });

  $('level-input').addEventListener('input', (event) => {
    state.level = Number(event.target.value);
    $('level-value').textContent = state.level;
    recalc();
  });

  $('framemods-input').addEventListener('change', (event) => {
    state.frameMods = event.target.value.split(',').map((name) => name.trim()).filter(Boolean).map((name) => ({ name }));
    recalc();
  });

  $('incarnon-input').addEventListener('change', (event) => {
    state.incarnon = event.target.value.split(',').map((part) => part.trim()).filter(Boolean);
    recalc();
  });

  $('combo-input').addEventListener('input', (event) => {
    state.comboHits = Number(event.target.value);
    $('combo-value').textContent = String(state.comboHits);
    recalc();
  });

  $('aoe-input').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    // 0 means "at the blast centre", which is what the arsenal numbers already show.
    state.aoeDistance = value === 0 ? null : value;
    $('aoe-value').textContent = value === 0 ? 'centre' : `${value} m`;
    recalc();
  });

  $('heavy').addEventListener('change', (event) => {
    state.heavyAttack = event.target.checked;
    recalc();
  });

  $('riven-input').addEventListener('change', (event) => {
    state.riven = parseRivenInput(event.target.value);
    recalc();
  });

  const debuffInput = (id, key) => {
    $(id).addEventListener('change', (event) => {
      state.debuffs[key] = Number(event.target.value);
      recalc();
    });
  };
  debuffInput('viral', 'viralStacks');
  debuffInput('corrosive', 'corrosiveStacks');

  $('headshot').addEventListener('change', (event) => {
    state.headshot = event.target.checked;
    recalc();
  });

  const conditionInput = (id, key) => {
    $(id).addEventListener('change', (event) => {
      const value = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value);
      if (value) state.conditions[key] = value;
      else delete state.conditions[key];
      recalc();
    });
  };
  conditionInput('onkill', 'onKill');
  conditionInput('status-types', 'statusTypes');
  conditionInput('aiming', 'aiming');

  $('share').addEventListener('click', async () => {
    saveToUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = 'copied';
      setTimeout(() => ($('share').textContent = 'copy link'), 1200);
    } catch {
      prompt('Copy this link', location.href);
    }
  });
}

/** Restores the widget values from state (used after loading a shared link). */
function syncInputsFromState() {
  $('weapon-input').value = state.weapon;
  $('enemy-input').value = state.enemy;
  $('level-input').value = String(state.level);
  $('level-value').textContent = String(state.level);
  $('headshot').checked = Boolean(state.headshot);
  $('onkill').value = String(state.conditions.onKill ?? 0);
  $('status-types').value = String(state.conditions.statusTypes ?? 1);
  $('aiming').checked = Boolean(state.conditions.aiming);
  $('arcane-input').value = state.arcanes?.[0]?.name ?? '';
  $('strength-input').value = String(state.abilityStrength ?? 100);
  $('strength-value').textContent = `${state.abilityStrength ?? 100}%`;
  $('framemods-input').value = (state.frameMods ?? []).map((mod) => mod.name).join(', ');
  $('riven-input').value = state.riven ? [...state.riven.stats, state.riven.malus ? `-${state.riven.malus}` : ''].filter(Boolean).join(',') : '';
  $('incarnon-input').value = (state.incarnon ?? []).join(',');
  $('combo-input').value = String(state.comboHits ?? 0);
  $('combo-value').textContent = String(state.comboHits ?? 0);
  $('heavy').checked = Boolean(state.heavyAttack);
  $('element-bonus').value = state.elementBonus ? `${state.elementBonus.type}:${(state.elementBonus.value * 100).toFixed(0)}` : '';
  $('aoe-input').value = String(state.aoeDistance ?? 0);
  $('aoe-value').textContent = state.aoeDistance ? `${state.aoeDistance} m` : 'centre';
  $('viral').value = String(state.debuffs?.viralStacks ?? 0);
  $('corrosive').value = String(state.debuffs?.corrosiveStacks ?? 0);
}

async function main() {
  loadFromUrl();
  await loadStaticLists();
  bindEvents();
  syncInputsFromState();
  if (state.weapon) {
    await loadModsForWeapon();
    renderSlots();
  } else {
    $('stats').innerHTML = '<p class="hint">Pick a weapon to start.</p>';
  }
  recalc();
}

main();
