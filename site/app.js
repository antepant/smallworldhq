'use strict';

const S = {
  data: null,
  players: { team: '', pos: '', q: '', maxTsv: null, win: 'season', sort: 'p', dir: -1, showAll: false },
  teams: { sel: null, sort: 'pts', dir: -1, full: false },
  sched: { range: 28, mode: 'busy', metric: 'ptsPct', sort: 'team', weeks: 2 },
};

// ------------------------------------------------------------------ helpers

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = '<span class="muted">–</span>';
function toi(sec) {
  if (sec == null) return dash;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const pct = (x, d = 1) => x == null ? dash : (x * 100).toFixed(d);
const dec3 = x => x == null ? dash : x.toFixed(3).replace(/^0/, '');
const num = (x, d = 1) => x == null ? dash : x.toFixed(d);
const sgn = (x, d = 2) => x == null ? dash : `${x > 0 ? '+' : ''}${x.toFixed(d)}`;
const MP_TIP = 'Expected goals from MoneyPuck.com';

function parseDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(iso, n) { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoDate(d); }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = iso => { const d = parseDate(iso); return `${WD[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`; };
// Dates are shown day/month (en-GB), times on a 24-hour clock
const fmtLong = iso => parseDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const today = () => isoDate(new Date());

function logo(ab) {
  const t = S.data.teams[ab];
  if (!t) return '';
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `<img class="logo" alt="" loading="lazy" src="${esc(dark ? t.logo.replace('_light', '_dark') : t.logo)}">`;
}

// Sortable table. cols: {key, label, num, fmt(row) -> html, val(row) -> sort value}
function sortRows(rows, cols, key, dir) {
  const col = cols.find(c => c.key === key);
  if (!col) return rows;
  const val = col.val || (r => r[key]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}
function tableHtml(cols, rows, { sort, dir, rowAttr = () => '' } = {}) {
  const head = cols.map(c => {
    const cls = ['sortable', c.num ? 'num' : '', c.key === sort ? 'sorted' : '', c.key === sort && dir > 0 ? 'asc' : ''].join(' ');
    return `<th class="${cls}" data-sort="${c.key}" title="${esc(c.title || '')}">${esc(c.label)}</th>`;
  }).join('');
  const body = rows.map(r => `<tr ${rowAttr(r)}>${cols.map(c =>
    `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('');
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function bindSort(el, state, rerender, defaultDir = -1) {
  el.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th || !el.contains(th)) return;
    const k = th.dataset.sort;
    if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = defaultDir; }
    rerender();
  });
}
function seg(name, options, current) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, l]) =>
    `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(current)}">${esc(l)}</button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ tooltip

function initTooltip() {
  const tip = $('#tip');
  const place = e => {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    place(e);
  });
  document.addEventListener('mousemove', e => { if (!tip.hidden) place(e); });
}

// ------------------------------------------------------------------ players

const PLAYER_COLS = [
  { key: 'name', label: 'Player' },
  { key: 'team', label: 'Team', fmt: r => `<button type="button" class="plink team-pick" data-team-pick="${r.team}" title="Show ${esc(r.team)}'s players and depth chart">${logo(r.team)}${esc(r.team)}</button>` },
  { key: 'pos', label: 'Pos' },
  { key: 'line', label: 'Line', title: 'Even-strength line from recent shift charts', fmt: r => r.line ? `<span class="tag">${r.line}</span>` : dash },
  { key: 'pp', label: 'PP', title: 'Power-play unit from recent shift charts', fmt: r => r.pp ? `<span class="tag ${r.pp === 'PP1' ? 'pp1' : ''}">${r.pp}</span>` : dash },
  { key: 'tsv', label: 'TSV', num: true, title: 'Terrier starting value ($ from players.txt; 0 = not in the list)', fmt: r => r.tsv ? r.tsv.toFixed(2) : '<span class="muted">0</span>' },
  { key: 'gp', label: 'GP', num: true },
  { key: 'g', label: 'G', num: true },
  { key: 'a', label: 'A', num: true },
  { key: 'p', label: 'P', num: true },
  { key: 'pm', label: '+/-', num: true },
  { key: 'sog', label: 'SOG', num: true },
  { key: 'xg', label: 'xG', num: true, title: `Individual expected goals. ${MP_TIP}`, fmt: r => num(r.xg, 2) },
  { key: 'gMinusXg', label: 'G−xG', num: true, title: `Goals minus expected goals: above 0 = finishing above expectation. ${MP_TIP}`, fmt: r => sgn(r.gMinusXg) },
  { key: 'pim', label: 'PIM', num: true, title: 'Penalty minutes' },
  { key: 'toi', label: 'TOI', num: true, title: 'Average time on ice per game', fmt: r => toi(r.toi) },
  { key: 'evToi', label: 'EV', num: true, title: 'Even-strength TOI per game', fmt: r => toi(r.evToi) },
  { key: 'ppToi', label: 'PP TOI', num: true, title: 'Power-play TOI per game', fmt: r => toi(r.ppToi) },
  { key: 'shToi', label: 'SH', num: true, title: 'Short-handed TOI per game', fmt: r => toi(r.shToi) },
];

function initPlayers() {
  const v = $('#view-players');
  const teams = Object.values(S.data.teams).sort((a, b) => a.name.localeCompare(b.name));
  v.innerHTML = `
    <h2>Player stats</h2>
    <p class="sub" id="p-sub"></p>
    <div class="controls">
      <label>Search<input id="p-q" type="search" placeholder="Player name"></label>
      <label>Team<select id="p-team"><option value="">All teams</option>${teams.map(t => `<option value="${t.abbrev}">${esc(t.name)}</option>`).join('')}</select></label>
      <div class="ctl"><span>Stats</span>${seg('win', [['season', 'Season'], ['14', 'Last 14 days'], ['7', 'Last 7 days']], S.players.win)}</div>
      <label>Position<select id="p-pos"><option value="">All skaters</option><option value="F">Forwards</option><option value="C">C</option><option value="L">LW</option><option value="R">RW</option><option value="D">D</option></select></label>
      <label title="Only show players whose TSV is below this value. Leave empty for everyone.">TSV under<input id="p-tsv" type="number" min="0" step="0.5" placeholder="Any" class="narrow"></label>
    </div>
    <div id="p-lines"></div>
    <div class="card scroll" id="p-table"></div>`;
  $('#p-q').addEventListener('input', e => { S.players.q = e.target.value; renderPlayers(); });
  $('#p-team').addEventListener('change', e => { S.players.team = e.target.value; renderPlayers(); });
  $('#p-pos').addEventListener('change', e => { S.players.pos = e.target.value; renderPlayers(); });
  $('#p-tsv').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    S.players.maxTsv = Number.isFinite(v) ? v : null;
    renderPlayers();
  });
  $('[data-seg="win"]').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    S.players.win = b.dataset.v;
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderPlayers();
  });
  bindSort($('#p-table'), S.players, renderPlayers);
  $('#p-table').addEventListener('click', e => {
    if (e.target.id === 'p-more') { S.players.showAll = true; renderPlayers(); }
    // A team name works like picking that team in the Team dropdown
    const pick = e.target.closest('[data-team-pick]');
    if (pick) {
      S.players.team = pick.dataset.teamPick;
      $('#p-team').value = S.players.team;
      renderPlayers();
      $('#p-lines').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

// DailyFaceoff team pages are slugged from the team name, e.g. "Montréal Canadiens" -> montreal-canadiens.
// We only link out; their terms don't allow republishing their line charts.
function dfoUrl(ab) {
  const slug = S.data.teams[ab].name.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.dailyfaceoff.com/teams/${slug}/line-combinations`;
}

function goalieXg(id) {
  const g = S.data.goalies.find(x => x.id === id);
  return g && g.gsax != null ? ` · ${sgn(g.gsax, 1)} GSAx` : '';
}

function linesCard(ab) {
  const ln = S.data.lines[ab];
  if (!ln) return '';
  const who = g => g.players.map((pid, i) => `<button type="button" class="plink" data-pid="${pid}">${esc(g.names[i])}</button>`).join(' – ');
  const unit = (lbl, g, what) => `<div class="unit"><span class="lbl">${lbl}</span><span class="who">${who(g)}</span>
    <span class="sec">${toi(g.sec)} ${what}</span></div>`;
  const ppGame = ln.ppGameId && S.data.gameById[ln.ppGameId];
  const ppWhen = ppGame ? `${fmtLong(ppGame.date)} ${ppGame.home === ab ? 'vs' : '@'} ${ppGame.home === ab ? ppGame.away : ppGame.home}` : '';
  const ROLE = ['Starter', 'Backup', 'Third'];
  const gk = (ln.goalies || []).map((g, i) => `<div class="unit"><span class="lbl">G${i + 1}</span>
    <span class="who"><button type="button" class="plink" data-gid="${g.id}">${esc(g.name)}</button>${g.nextProbable ? '<span class="badge probable">Next start</span>' : ''}</span>
    <span class="sec">${ROLE[i] || ''} · ${g.gp ? `${g.recentStarts} of last ${g.recentGames} starts · ${dec3(g.svPct)} SV% · ${num(g.gaa, 2)} GAA${goalieXg(g.id)}` : 'no games yet'}</span></div>`).join('');
  const nx = ln.next;
  const nextLine = nx ? `<p class="sec muted">Next game ${fmtLong(nx.date)} ${nx.home ? 'vs' : '@'} ${esc(nx.opp)}: ${nx.goalie ? `${esc(nx.goalie.name)} (${nx.goalie.status})` : 'starter not announced'}</p>` : '';
  return `<div class="card">
    <div class="card-head"><h2>${logo(ab)}${esc(S.data.teams[ab].name)} depth chart</h2>
      <a class="ext" href="${dfoUrl(ab)}" target="_blank" rel="noopener noreferrer">Projected lines on DailyFaceoff ↗</a></div>
    <p class="sub">${ln.date ? `Lines rebuilt from shift charts: last game ${fmtLong(ln.date)} vs ${esc(ln.opp)}, plus two games before it at half and quarter weight. PP units are from the last game only${ppGame && ln.ppGameId !== ln.gameIds[0] ? ` with real PP time (${ppWhen})` : ''}. Shows what the coach has been using, not a projection. ` : ''}Goalies are ordered by starts in the last 10 games. Click a name for game-by-game stats.</p>
    <div class="lines">
      <div><h3>Forwards (5v5)</h3>${ln.forwards.map((g, i) => unit(`F${i + 1}`, g, 'together (weighted)')).join('')}</div>
      <div><h3>Defence (5v5)</h3>${ln.defense.map((g, i) => unit(`D${i + 1}`, g, 'together (weighted)')).join('')}</div>
      <div><h3>Power play</h3>${ln.pp.length ? ln.pp.map((g, i) => unit(`PP${i + 1}`, g, `on the PP, ${ppWhen}`)).join('') : '<p class="muted">Not enough PP time yet.</p>'}</div>
      <div><h3>Goalies</h3>${gk || '<p class="muted">No goalies on the roster feed.</p>'}${nextLine}</div>
    </div></div>`;
}

function renderPlayers() {
  const st = S.players;
  const q = st.q.trim().toLowerCase();
  const recent = st.win !== 'season' && S.data.players_recent[st.win];
  const sub = recent
    ? `Stats from games ${fmtLong(recent.from)} – ${fmtLong(recent.to)} only; TOI columns are per game in that window. Players without a game in the window are hidden.`
    : 'Season totals and ice time from the NHL stats API.';
  const xgNote = S.data.xgThrough ? ` xG from MoneyPuck.com, games through ${fmtLong(S.data.xgThrough)}.` : '';
  $('#p-sub').textContent = `${sub} Line labels come from the NHL's shift charts for each team's last three games; PP units from the last game.${xgNote}`;
  const base = recent
    ? S.data.players.filter(p => recent.players[p.id]).map(p => ({ ...p, ...recent.players[p.id] }))
    : S.data.players;
  let rows = base.filter(p =>
    (!st.team || p.team === st.team) &&
    (!st.pos || (st.pos === 'F' ? p.pos !== 'D' : p.pos === st.pos)) &&
    (st.maxTsv == null || (p.tsv || 0) < st.maxTsv) &&
    (!q || p.name.toLowerCase().includes(q)));
  rows = sortRows(rows, PLAYER_COLS, st.sort, st.dir);
  const limit = st.showAll || st.team ? rows.length : 100;
  $('#p-lines').innerHTML = st.team ? linesCard(st.team) : '';
  $('#p-table').innerHTML = tableHtml(PLAYER_COLS, rows.slice(0, limit), { ...st, rowAttr: r => `class="clickable" data-pid="${r.id}"` }) +
    (rows.length > limit ? `<button class="link" id="p-more">Show all ${rows.length} players</button>` : '');
}

// ------------------------------------------------------------------ teams

const TEAM_COLS = [
  { key: 'name', label: 'Team', fmt: r => `${logo(r.abbrev)}${esc(r.name)}` },
  { key: 'gp', label: 'GP', num: true },
  { key: 'w', label: 'W', num: true },
  { key: 'l', label: 'L', num: true },
  { key: 'otl', label: 'OTL', num: true },
  { key: 'pts', label: 'PTS', num: true, val: r => r.pts + r.ptsPct / 10 },
  { key: 'ptsPct', label: 'P%', num: true, fmt: r => dec3(r.ptsPct) },
  { key: 'gf', label: 'GF', num: true },
  { key: 'ga', label: 'GA', num: true },
  { key: 'diff', label: 'DIFF', num: true, val: r => r.gf - r.ga, fmt: r => { const d = r.gf - r.ga; return d > 0 ? `+${d}` : d; } },
  { key: 'ppPct', label: 'PP%', num: true, fmt: r => pct(r.ppPct) },
  { key: 'pkPct', label: 'PK%', num: true, fmt: r => pct(r.pkPct) },
  { key: 'sfPerGame', label: 'SF/GP', num: true, fmt: r => num(r.sfPerGame) },
  { key: 'saPerGame', label: 'SA/GP', num: true, fmt: r => num(r.saPerGame) },
  { key: 'xgfPct', label: 'xGF%', num: true, title: `Share of expected goals at 5v5. ${MP_TIP}`, fmt: r => pct(r.xgfPct) },
  { key: 'xgfPerGame', label: 'xGF/GP', num: true, title: `Expected goals for per game, all situations. ${MP_TIP}`, fmt: r => num(r.xgfPerGame, 2) },
  { key: 'xgaPerGame', label: 'xGA/GP', num: true, title: `Expected goals against per game, all situations. ${MP_TIP}`, fmt: r => num(r.xgaPerGame, 2) },
  { key: 'l10', label: 'L10' },
  { key: 'streak', label: 'STRK' },
];

function initTeams() {
  const v = $('#view-teams');
  v.innerHTML = `
    <h2>Team stats</h2>
    <p class="sub">Click a team for its schedule with starting goalies. Past starters come from NHL boxscores; upcoming ones are ESPN's probables.</p>
    <div class="card scroll" id="t-table"></div>
    <div id="t-detail"></div>`;
  bindSort($('#t-table'), S.teams, renderTeams);
  $('#t-table').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-team]');
    if (!tr) return;
    S.teams.sel = tr.dataset.team;
    renderTeams();
    $('#t-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#t-detail').addEventListener('click', e => {
    if (e.target.id === 't-full') { S.teams.full = !S.teams.full; renderTeams(); }
  });
}

function goalieCell(g, final) {
  if (!g) return final ? dash : '<span class="muted">TBD</span>';
  const badge = g.status === 'confirmed' ? '<span class="badge confirmed">Started</span>' : '<span class="badge probable">Probable</span>';
  return `${esc(g.name)}${badge}${g.sv ? ` <span class="muted">${esc(g.sv)}</span>` : ''}`;
}

function teamDetail(ab) {
  const D = S.data, t = D.teams[ab];
  const games = D.byTeam[ab] || [];
  const now = today();
  const firstUpcoming = games.findIndex(g => !g.final);
  const pivot = firstUpcoming < 0 ? games.length : firstUpcoming;
  const shown = S.teams.full ? games : games.slice(Math.max(0, pivot - 5), pivot + 10);
  const rows = shown.map(x => {
    const g = x.game, home = x.home;
    const mine = home ? g.homeGoalie : g.awayGoalie, theirs = home ? g.awayGoalie : g.homeGoalie;
    let result;
    if (x.final) {
      const us = home ? g.homeScore : g.awayScore, them = home ? g.awayScore : g.homeScore;
      const ot = g.lastPeriod && g.lastPeriod !== 'REG' ? ` ${g.lastPeriod}` : '';
      result = `<span class="${us > them ? 'win' : 'loss'}">${us > them ? 'W' : 'L'}</span> ${us}–${them}${ot}`;
    } else {
      result = new Date(g.startUTC).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    return `<tr${x.date === now ? ' class="selected"' : ''}><td>${fmtLong(x.date)}</td>
      <td>${home ? 'vs' : '@'} ${logo(x.opp)}${esc(x.opp)}</td><td>${result}</td>
      <td>${goalieCell(mine, x.final)}</td><td>${goalieCell(theirs, x.final)}</td></tr>`;
  }).join('');
  const gk = D.goalies.filter(g => g.team === ab).sort((a, b) => b.gs - a.gs);
  return `<div class="card">
    <div class="team-head">${logo(ab).replace('class="logo"', '')}<div><h2>${esc(t.name)}</h2>
      <span class="muted">${t.w}-${t.l}-${t.otl} · ${t.pts} pts · ${esc(t.division)} · L10 ${t.l10}</span></div></div>
    <div class="team-detail">
      <div class="scroll"><h3>Schedule & starting goalies</h3>
        <table class="data"><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>${esc(ab)} goalie</th><th>Opp. goalie</th></tr></thead><tbody>${rows}</tbody></table>
        <button class="link" id="t-full">${S.teams.full ? 'Show recent and upcoming only' : `Show full season (${games.length} games)`}</button>
      </div>
      <div class="scroll"><h3>Goalies</h3>
        <table class="data"><thead><tr><th>Goalie</th><th class="num">GP</th><th class="num">GS</th><th class="num">W-L-OT</th><th class="num">SV%</th><th class="num">GAA</th><th class="num" title="Goals saved above expected. ${MP_TIP}">GSAx</th></tr></thead>
        <tbody>${gk.map(g => `<tr class="clickable" data-gid="${g.id}"><td>${esc(g.name)}</td><td class="num">${g.gp}</td><td class="num">${g.gs}</td><td class="num">${g.w}-${g.l}-${g.otl}</td><td class="num">${dec3(g.svPct)}</td><td class="num">${num(g.gaa, 2)}</td><td class="num">${sgn(g.gsax, 1)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div></div>`;
}

function renderTeams() {
  const st = S.teams;
  const rows = sortRows(Object.values(S.data.teams), TEAM_COLS, st.sort, st.dir);
  if (!st.sel) st.sel = rows[0].abbrev;
  $('#t-table').innerHTML = tableHtml(TEAM_COLS, rows, {
    ...st, rowAttr: r => `class="clickable${r.abbrev === st.sel ? ' selected' : ''}" data-team="${r.abbrev}"`,
  });
  $('#t-detail').innerHTML = teamDetail(st.sel);
}

// ------------------------------------------------------------------ schedule

const METRICS = {
  ptsPct: { label: 'Points %', fmt: dec3, softSign: -1, desc: 'points %' },        // low points % = soft
  gaPerGame: { label: 'Goals against / GP', fmt: x => num(x, 2), softSign: 1, desc: 'goals against per game' }, // leaky = soft
};

function strengthModel(metric) {
  const vals = Object.values(S.data.teams).map(t => t.strength[metric]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const sign = METRICS[metric].softSign;
  // Softness z-score: positive = easier opponent
  const z = ab => sign * (S.data.teams[ab].strength[metric] - mean) / sd;
  return { mean, sd, z };
}
function softBin(z) {
  const a = Math.abs(z), b = a < 0.4 ? 0 : a < 1.0 ? 1 : a < 1.6 ? 2 : 3;
  return z < 0 ? -b : b;
}
const SOFT_WORD = { '-3': 'very tough', '-2': 'tough', '-1': 'slightly tough', '0': 'average', '1': 'slightly soft', '2': 'soft', '3': 'very soft' };
const softCls = b => `s${b < 0 ? '-' + -b : b}`;

function initSchedule() {
  const v = $('#view-schedule');
  v.innerHTML = `
    <h2>Schedule</h2>
    <p class="sub">Teams down the side, dates across. Colour each game by how busy the team's next 7 days are, or by how soft the opponent is. In softness mode a corner marker flags a rest edge: the opponent played yesterday and the team didn't.</p>
    <div class="controls" id="s-controls"></div>
    <div class="card"><div class="legend" id="s-legend"></div><div class="scroll" id="s-heat"></div></div>
    <div class="card"><div class="card-head"><h2>Schedule breakdown</h2><div class="ctl" id="s-weeks"></div></div>
      <p class="sub">Games per Monday–Sunday week from today on, most games first. The first week only counts the days left in it.
        Day by day: each character is one day; a digit (the date's last digit) means a game, <b class="home-ink">bold orange</b> = home, plain = away, · = no game. Hover for the opponent.</p>
      <div class="scroll" id="s-week"></div></div>`;
  $('#s-weeks').addEventListener('click', e => {
    const b = e.target.closest('.seg button');
    if (!b) return;
    S.sched.weeks = Number(b.dataset.v);
    renderSchedule();
  });
  $('#s-controls').addEventListener('click', e => {
    const b = e.target.closest('.seg button');
    if (!b) return;
    const k = b.parentElement.dataset.seg;
    S.sched[k] = k === 'range' ? Number(b.dataset.v) : b.dataset.v;
    renderSchedule();
  });
  $('#s-controls').addEventListener('change', e => {
    if (e.target.id === 's-metric') S.sched.metric = e.target.value;
    if (e.target.id === 's-sort') S.sched.sort = e.target.value;
    renderSchedule();
  });
}

function scheduleDates(range) {
  const start = today();
  const last = S.data.schedule.length ? S.data.schedule[S.data.schedule.length - 1].date : start;
  const end = range === 0 ? last : addDays(start, range - 1);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function renderSchedule() {
  const st = S.sched, D = S.data, M = METRICS[st.metric];
  const model = strengthModel(st.metric);
  const dates = scheduleDates(st.range);
  const dateSet = new Set(dates);
  const leagueCount = d => (D.byDate[d] || []).length;

  $('#s-controls').innerHTML = `
    <div class="ctl"><span>Range</span>${seg('range', [[7, '7 days'], [14, '14 days'], [28, '28 days'], [0, 'Rest of season']], st.range)}</div>
    <div class="ctl"><span>Colour by</span>${seg('mode', [['soft', 'Opponent softness'], ['busy', 'Busyness']], st.mode)}</div>
    <label>Opponent strength<select id="s-metric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}"${k === st.metric ? ' selected' : ''}>${m.label}</option>`).join('')}</select></label>
    <label>Sort teams<select id="s-sort">${[['team', 'Alphabetical'], ['games', 'Most games'], ['soft', 'Softest schedule']].map(([k, l]) => `<option value="${k}"${k === st.sort ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;

  const ramp = cls => `<span class="ramp">${cls.map(c => `<span class="sw ${c}"></span>`).join('')}</span>`;
  $('#s-legend').innerHTML = (st.mode === 'soft'
    ? `<span>Tough</span>${ramp(['s-3', 's-2', 's-1', 's0', 's1', 's2', 's3'])}<span>Soft</span>
       <span class="muted">opponent ${M.desc}, blended with last season (${D.meta.priorGames}-game weight)</span>`
    : `<span>Games in next 7 days:</span><span>1</span>${ramp(['d1', 'd2', 'd3', 'd4', 'd5'])}<span>5+</span>`) +
    (st.mode === 'soft' ? '<span><span class="rest-sw"></span> rest edge: opponent played yesterday, team rested</span>' : '') +
    '<span class="muted">"@" = away</span>';

  // Rest edge: the opponent played the day before, the team itself did not
  const played = Object.fromEntries(Object.keys(D.teams).map(ab => [ab, new Set((D.byTeam[ab] || []).map(g => g.date))]));
  const restEdge = (ab, opp, d) => played[opp].has(addDays(d, -1)) && !played[ab].has(addDays(d, -1));

  // Per-team rows
  const rows = Object.keys(D.teams).map(ab => {
    const games = (D.byTeam[ab] || []);
    const byDate = Object.fromEntries(games.map(g => [g.date, g]));
    const inRange = games.filter(g => dateSet.has(g.date));
    const zs = inRange.map(g => model.z(g.opp));
    const avgZ = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
    const avgVal = inRange.length ? inRange.reduce((a, g) => a + D.teams[g.opp].strength[st.metric], 0) / inRange.length : null;
    const b2b = inRange.filter(g => byDate[addDays(g.date, -1)]).length;
    const rest = inRange.filter(g => restEdge(ab, g.opp, g.date)).length;
    return { ab, byDate, inRange, avgZ, avgVal, b2b, rest };
  });
  const sorters = {
    team: (a, b) => a.ab.localeCompare(b.ab),
    games: (a, b) => b.inRange.length - a.inRange.length || b.avgZ - a.avgZ,
    soft: (a, b) => b.avgZ - a.avgZ,
  };
  rows.sort(sorters[st.sort]);

  const density = (r, d) => {
    let n = 0;
    for (let i = 0; i < 7; i++) if (r.byDate[addDays(d, i)]) n++;
    return n;
  };
  const head = `<tr><th class="team">Team</th>${dates.map(d => `<th class="${parseDate(d).getDay() === 1 ? 'week-start' : ''}"
      data-tip="${esc(`${fmtLong(d)}: ${leagueCount(d)} games`)}">${WD[parseDate(d).getDay()]}<span class="d">${fmtDay(d).split(' ')[1]}</span><span class="n">${leagueCount(d)}g</span></th>`).join('')}
    <th>GP</th><th data-tip="Back-to-backs (second game)">B2B</th><th data-tip="Rest edges: games where the opponent played yesterday and this team didn't">Rest+</th><th data-tip="Average opponent strength over the range">Opp</th></tr>`;
  const body = rows.map(r => {
    const cells = dates.map(d => {
      const g = r.byDate[d];
      const wk = parseDate(d).getDay() === 1 ? ' week-start' : '';
      if (!g) return `<td class="c empty${wk}">·</td>`;
      const z = model.z(g.opp), b = softBin(z), n = density(r, d);
      const cls = st.mode === 'soft' ? softCls(b) : `d${Math.min(5, Math.max(1, n))}`;
      const b2b = r.byDate[addDays(d, -1)] || r.byDate[addDays(d, 1)];
      const edge = restEdge(r.ab, g.opp, d);
      const tip = `${r.ab} ${g.home ? 'vs' : '@'} ${g.opp} · ${fmtLong(d)}\n` +
        `${D.teams[g.opp].name}: ${M.fmt(D.teams[g.opp].strength[st.metric])} ${M.desc} (${SOFT_WORD[b]})\n` +
        `${r.ab} plays ${n} game${n === 1 ? '' : 's'} in the 7 days from here` +
        (b2b ? '\nPart of a back-to-back' : '') +
        (edge ? `\nRest edge: ${g.opp} played yesterday, ${r.ab} didn't. ${g.opp} may start its backup goalie.` : '');
      return `<td class="c ${cls}${edge && st.mode === 'soft' ? ' rest' : ''}${wk}" data-tip="${esc(tip)}">${g.home ? '' : '@'}${g.opp}</td>`;
    }).join('');
    const avg = r.avgVal == null ? dash : M.fmt(r.avgVal);
    return `<tr><th class="team">${logo(r.ab)}${r.ab}</th>${cells}
      <td class="sum">${r.inRange.length}</td><td class="sum">${r.b2b}</td><td class="sum">${r.rest}</td>
      <td class="sum c ${softCls(softBin(r.avgZ * 1.5))}" data-tip="${esc(`Average opponent ${M.desc}: ${r.avgVal == null ? '–' : M.fmt(r.avgVal)} (${SOFT_WORD[softBin(r.avgZ * 1.5)]})`)}">${avg}</td></tr>`;
  }).join('');
  $('#s-heat').innerHTML = `<table class="heat"><thead>${head}</thead><tbody>${body}</tbody></table>`;

  renderWeeks(rows, model);
}

function renderWeeks(rows, model) {
  const D = S.data, M = METRICS[S.sched.metric], n = S.sched.weeks;
  $('#s-weeks').innerHTML = `<span>Weeks</span>${seg('weeks', [1, 2, 3, 4, 6, 8].map(w => [w, String(w)]), n)}`;
  const start = today();
  const monday = d => { const x = parseDate(d); const back = (x.getDay() + 6) % 7; x.setDate(x.getDate() - back); return isoDate(x); };
  const weeks = [...Array(n)].map((_, i) => addDays(monday(start), 7 * i));
  const days = [];
  for (let d = start; d < addDays(weeks[n - 1], 7); d = addDays(d, 1)) days.push(d);

  const stats = rows.map(r => {
    const gs = days.filter(d => r.byDate[d]).map(d => ({ d, g: r.byDate[d] }));
    return {
      r, gs,
      home: gs.filter(x => x.g.home).length,
      b2b: gs.filter(x => r.byDate[addDays(x.d, -1)]).length,
    };
  }).sort((a, b) => b.gs.length - a.gs.length || b.home - a.home || a.r.ab.localeCompare(b.r.ab));

  const head = `<tr><th class="team">Team</th>${weeks.map((w, i) => `<th>${fmtDay(w).split(' ')[1]}<span class="d">${i === 0 ? 'rest of wk' : 'week'}</span></th>`).join('')}
    <th>Games</th><th>Home</th><th data-tip="Back-to-backs (second game)">B2B</th>
    <th class="dbd-head">Day by day<span class="d">${fmtLong(days[0])} – ${fmtLong(days[days.length - 1])}</span></th></tr>`;
  const body = stats.map(({ r, gs, home, b2b }) => {
    const cells = weeks.map(w => {
      const wk = gs.filter(x => x.d >= w && x.d < addDays(w, 7));
      if (!wk.length) return '<td class="c empty">0</td>';
      const tip = `${r.ab}, week of ${fmtLong(w)}: ${wk.length} games\n` + wk.map(x =>
        `${WD[parseDate(x.d).getDay()]} ${x.g.home ? 'vs' : '@'} ${x.g.opp} · ${M.fmt(D.teams[x.g.opp].strength[S.sched.metric])} (${SOFT_WORD[softBin(model.z(x.g.opp))]})`).join('\n');
      // A partial first week is coloured by its pace (games per 7 days) so it compares with full weeks
      const span = days.filter(d => d >= w && d < addDays(w, 7)).length;
      const pace = Math.round(wk.length * 7 / span);
      return `<td class="c d${Math.min(5, Math.max(1, pace))}" data-tip="${esc(tip)}">${wk.length}</td>`;
    }).join('');
    const dbd = days.map(d => {
      const g = r.byDate[d];
      if (!g) return `<span class="no" data-tip="${esc(`${fmtLong(d)}: no game`)}">·</span>`;
      return `<span class="${g.home ? 'h' : 'a'}" data-tip="${esc(`${fmtLong(d)}: ${g.home ? 'vs' : '@'} ${g.opp}`)}">${parseDate(d).getDate() % 10}</span>`;
    }).join('');
    return `<tr><th class="team">${logo(r.ab)}${r.ab}</th>${cells}<td class="sum">${gs.length}</td><td class="sum">${home}</td><td class="sum">${b2b}</td><td class="dbd">${dbd}</td></tr>`;
  }).join('');
  $('#s-week').innerHTML = `<table class="heat week"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ------------------------------------------------------------------ player panel

let gamelogsPromise = null;
function loadGamelogs() {
  gamelogsPromise ||= fetch('data/gamelogs.json').then(r => {
    if (!r.ok) throw new Error(`data/gamelogs.json: HTTP ${r.status}`);
    return r.json();
  });
  return gamelogsPromise;
}

// Turn compact rows into objects joined with the schedule (date, opponent, result), newest first
function logRows(rows, cols) {
  return rows.map(r => {
    const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    const g = S.data.gameById[o.gameId];
    const home = o.side === 'h';
    const us = home ? g.homeScore : g.awayScore, them = home ? g.awayScore : g.homeScore;
    return { ...o, date: g.date, home, team: home ? g.home : g.away, opp: home ? g.away : g.home,
      won: us > them, score: `${us}–${them}`, ot: g.lastPeriod && g.lastPeriod !== 'REG' ? g.lastPeriod : '' };
  }).sort((a, b) => b.date.localeCompare(a.date));
}
const resultCell = r => `<span class="${r.won ? 'win' : 'loss'}">${r.won ? 'W' : 'L'}</span> ${r.score}${r.ot ? ` ${r.ot}` : ''}`;
const oppCell = r => `${r.home ? 'vs' : '@'} ${logo(r.opp)}${esc(r.opp)}`;

// Ice time per game, oldest -> newest, stacked EV / PP / SH, with the average as a dashed reference line
const TOI_PARTS = [['evToi', 'EV', 'seg-ev'], ['ppToi', 'PP', 'seg-pp'], ['shToi', 'SH', 'seg-sh']];
function toiChart(rows) {
  const games = [...rows].reverse();
  if (!games.length) return '';
  const W = 720, H = 150, L = 34, B = 20, T = 8, GAP = 2;
  const max = Math.max(20 * 60, ...games.map(g => g.toi || 0));
  const top = Math.ceil(max / 300) * 300;
  const y = v => T + (H - T - B) * (1 - v / top);
  const step = (W - L) / games.length, bw = Math.max(3, Math.min(22, step - 2));
  const avg = games.reduce((a, g) => a + (g.toi || 0), 0) / games.length;
  let grid = '';
  for (let v = 0; v <= top; v += 300) {
    grid += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="ax" text-anchor="end">${v / 60}</text>`;
  }
  // rect with only the top corners rounded (the data end); square at the baseline
  const topRounded = (x, y0, y1, r) => `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z`;
  const bars = games.map((g, i) => {
    const x = L + i * step + (step - bw) / 2;
    const hasSplit = g.evToi != null;
    const parts = hasSplit ? TOI_PARTS.map(([k, , cls]) => [g[k] || 0, cls]).filter(([v]) => v > 0) : [[g.toi || 0, 'seg-ev']];
    let acc = 0;
    const segs = parts.map(([v, cls], j) => {
      const y0 = y(acc) - (j ? GAP / 2 : 0), y1 = y(acc + v) + (j < parts.length - 1 ? GAP / 2 : 0);
      acc += v;
      if (y0 - y1 <= 0) return '';
      return j === parts.length - 1
        ? `<path d="${topRounded(x, y0, y1, Math.min(4, bw / 2, y0 - y1))}" class="${cls}"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${y0 - y1}" class="${cls}"/>`;
    }).join('');
    const split = hasSplit ? ` (EV ${toi(g.evToi)} · PP ${toi(g.ppToi)} · SH ${toi(g.shToi)})` : '';
    const tip = `${fmtLong(g.date)} ${g.home ? 'vs' : '@'} ${g.opp}\nTOI ${toi(g.toi)}${split}\n${g.g} G, ${g.a} A · ${g.sog} SOG`;
    return `<g data-tip="${esc(tip)}"><rect x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" fill="transparent"/>${segs}</g>`;
  }).join('');
  const every = Math.ceil(games.length / 12);
  const labels = games.map((g, i) => i % every === 0
    ? `<text x="${L + i * step + step / 2}" y="${H - 5}" class="ax" text-anchor="middle">${fmtDay(g.date).split(' ')[1]}</text>` : '').join('');
  const legend = TOI_PARTS.map(([, l, cls]) => `<span><span class="sw ${cls}"></span>${l}</span>`).join('');
  return `<div class="card-head"><h3>Ice time by game <span class="muted">(minutes)</span></h3><div class="legend chart-legend">${legend}</div></div>
    <svg class="toi-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Time on ice per game, split into even strength, power play and short-handed">${grid}
      <line x1="${L}" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" class="avg"/>
      <text x="${W - 2}" y="${y(avg) - 4}" class="ax" text-anchor="end">avg ${toi(avg)}</text>${bars}${labels}</svg>`;
}

async function openPlayer({ pid, gid }) {
  const D = S.data;
  $('#panel').hidden = false;
  document.body.classList.add('no-scroll');
  const body = $('#panel-body');
  body.innerHTML = '<p class="muted">Loading game log…</p>';
  let logs;
  try { logs = await loadGamelogs(); } catch (e) { body.innerHTML = `<p>${esc(e.message)}</p>`; return; }

  if (pid) {
    const p = D.players.find(x => x.id === pid) || { name: String(pid), team: '', pos: '' };
    const rows = logRows(logs.skaters[pid] || [], logs.skaterCols);
    body.innerHTML = `
      <div class="team-head">${p.team ? logo(p.team).replace('class="logo"', '') : ''}<div><h2>${esc(p.name)}</h2>
        <span class="muted">${esc(p.team)} · ${esc(p.pos)}${p.line ? ` · <span class="tag">${p.line}</span>` : ''}${p.pp ? ` <span class="tag ${p.pp === 'PP1' ? 'pp1' : ''}">${p.pp}</span>` : ''}
        · ${p.gp ?? 0} GP · ${p.g ?? 0} G · ${p.a ?? 0} A · ${p.p ?? 0} P · ${toi(p.toi)} TOI/GP
        ${p.xg != null ? `· <span title="${MP_TIP}">${num(p.xg, 2)} xG · ${sgn(p.gMinusXg)} G−xG</span>` : ''}</span></div></div>
      ${toiChart(rows)}
      <div class="scroll"><table class="data"><thead><tr><th>Date</th><th>Opp</th><th>Result</th>
        <th class="num">G</th><th class="num">A</th><th class="num">P</th><th class="num">+/-</th><th class="num">SOG</th><th class="num" title="${MP_TIP}">xG</th><th class="num" title="Goals minus expected goals">G−xG</th>
        <th class="num">Hits</th><th class="num">BLK</th><th class="num">PPG</th><th class="num">PIM</th><th class="num">TOI</th><th class="num">EV</th><th class="num">PP</th><th class="num">SH</th><th class="num">Shifts</th><th class="num">FO%</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${fmtLong(r.date)}</td><td>${oppCell(r)}</td><td>${resultCell(r)}</td>
          <td class="num">${r.g}</td><td class="num">${r.a}</td><td class="num"><b>${r.p}</b></td><td class="num">${r.pm > 0 ? '+' + r.pm : r.pm}</td>
          <td class="num">${r.sog}</td><td class="num">${num(r.xg, 2)}</td><td class="num">${r.xg == null ? dash : sgn(r.g - r.xg)}</td><td class="num">${r.hits}</td><td class="num">${r.blk}</td><td class="num">${r.ppg}</td><td class="num">${r.pim}</td>
          <td class="num">${toi(r.toi)}</td><td class="num">${toi(r.evToi)}</td><td class="num"><b>${toi(r.ppToi)}</b></td><td class="num">${toi(r.shToi)}</td><td class="num">${r.shifts}</td><td class="num">${r.fo == null ? dash : pct(r.fo, 0)}</td></tr>`).join('')
          || '<tr><td colspan="20" class="muted">No games yet.</td></tr>'}</tbody></table></div>`;
  } else {
    const g = D.goalies.find(x => x.id === gid) || {};
    const depthTeam = Object.entries(D.lines).find(([, ln]) => (ln.goalies || []).some(x => x.id === gid));
    const dg = depthTeam && depthTeam[1].goalies.find(x => x.id === gid);
    const team = (depthTeam && depthTeam[0]) || g.team || '';
    const rows = logRows(logs.goalies[gid] || [], logs.goalieCols);
    body.innerHTML = `
      <div class="team-head">${team ? logo(team).replace('class="logo"', '') : ''}<div><h2>${esc(g.name || (dg && dg.name) || gid)}</h2>
        <span class="muted">${esc(team)} · G · ${g.gp ?? 0} GP · ${g.gs ?? 0} GS · ${g.w ?? 0}-${g.l ?? 0}-${g.otl ?? 0} · ${dec3(g.svPct)} SV% · ${num(g.gaa, 2)} GAA${g.gsax != null ? ` · <span title="${MP_TIP}">${sgn(g.gsax, 1)} GSAx</span>` : ''}</span></div></div>
      <div class="scroll"><table class="data"><thead><tr><th>Date</th><th>Opp</th><th>Result</th><th>Start</th><th>Dec</th>
        <th class="num">SA</th><th class="num">SV</th><th class="num">GA</th><th class="num">SV%</th><th class="num" title="${MP_TIP}">xGA</th><th class="num" title="Goals saved above expected">GSAx</th><th class="num">EV GA</th><th class="num">PP GA</th><th class="num">TOI</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${fmtLong(r.date)}</td><td>${oppCell(r)}</td><td>${resultCell(r)}</td>
          <td>${r.starter ? 'Started' : '<span class="muted">Relief</span>'}</td><td>${esc(r.decision || '–')}</td>
          <td class="num">${r.sa}</td><td class="num">${r.sv}</td><td class="num">${r.ga}</td><td class="num">${r.sa ? dec3(r.sv / r.sa) : dash}</td>
          <td class="num">${num(r.xga, 2)}</td><td class="num">${r.xga == null ? dash : sgn(r.xga - r.ga)}</td><td class="num">${r.evGa ?? dash}</td><td class="num">${r.ppGa ?? dash}</td><td class="num">${toi(r.toi)}</td></tr>`).join('')
          || '<tr><td colspan="14" class="muted">No games played yet.</td></tr>'}</tbody></table></div>`;
  }
}

function closePlayer() {
  $('#panel').hidden = true;
  document.body.classList.remove('no-scroll');
  $('#tip').hidden = true;
}

function initPanel() {
  document.addEventListener('click', e => {
    if (e.target.closest('#panel')) {
      if (e.target.id === 'panel' || e.target.closest('#panel-close')) closePlayer();
      return;
    }
    if (e.target.closest('[data-team-pick]')) return;  // handled by the Players table
    const t = e.target.closest('[data-pid], [data-gid]');
    if (!t || e.target.closest('th')) return;
    if (t.dataset.pid) openPlayer({ pid: Number(t.dataset.pid) });
    else openPlayer({ gid: Number(t.dataset.gid) });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#panel').hidden) closePlayer(); });
}

// ------------------------------------------------------------------ boot

const VIEWS = {
  players: { init: initPlayers, render: renderPlayers },
  teams: { init: initTeams, render: renderTeams },
  schedule: { init: initSchedule, render: renderSchedule },
};
const inited = new Set();

function route() {
  const name = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'players';
  for (const k of Object.keys(VIEWS)) $(`#view-${k}`).hidden = k !== name;
  document.querySelectorAll('.tabs a').forEach(a => a.setAttribute('aria-selected', String(a.dataset.view === name)));
  if (!inited.has(name)) { VIEWS[name].init(); inited.add(name); }
  VIEWS[name].render();
}

async function boot() {
  const names = ['meta', 'teams', 'players', 'players_recent', 'goalies', 'schedule', 'lines'];
  try {
    const parts = await Promise.all(names.map(n => fetch(`data/${n}.json`).then(r => {
      if (!r.ok) throw new Error(`data/${n}.json: HTTP ${r.status}`);
      return r.json();
    })));
    S.data = Object.fromEntries(names.map((n, i) => [n, parts[i]]));
  } catch (e) {
    $('#meta').textContent = 'Could not load data';
    $('main').innerHTML = `<div class="card"><h2>No data yet</h2><p>Run <code>python fetch/fetch_data.py</code> and serve the <code>site/</code> folder (${esc(e.message)}).</p></div>`;
    return;
  }
  const D = S.data;
  D.byTeam = {};
  D.gameById = Object.fromEntries(D.schedule.map(g => [g.id, g]));
  D.byDate = {};
  for (const g of D.schedule) {
    const final = g.state === 'OFF' || g.state === 'FINAL';
    (D.byDate[g.date] ||= []).push(g);
    for (const [ab, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      (D.byTeam[ab] ||= []).push({ date: g.date, opp, home, final, game: g });
    }
  }
  D.xgThrough = D.meta.xgThrough || null;
  const s = String(D.meta.season);
  $('#meta').textContent = `${s.slice(0, 4)}–${s.slice(6)} season · data updated ${new Date(D.meta.generated).toLocaleString('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  initTooltip();
  initPanel();
  addEventListener('hashchange', route);
  route();
}

boot();
