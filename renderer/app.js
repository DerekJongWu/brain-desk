'use strict';
/* global api */

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const diff = (a, b) => Math.round((dt(a) - dt(b)) / 864e5);
const fmt = s => s ? dt(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
const addDays = (s, n) => { const d = dt(s); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const initials = n => String(n).replace(/\(.*?\)/g, '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const hue = n => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const av = n => `<span class="avatar" style="background:hsl(${hue(n)} 50% 86%);color:hsl(${hue(n)} 45% 28%)">${esc(initials(n))}</span>`;
const bareDomain = s => String(s || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const normName = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(inc|llc|ltd|corp|co|labs?|ai|hq|technologies|technology)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
const errMsg = e => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const CATS = { founder: 'Founder', vc: 'VC', operator: 'Operator', lp: 'LP', other: 'Other' };
const STATUSES = [['new', 'New', 'var(--new)'], ['pursuing', 'Pursuing', 'var(--pursue)'], ['reached-out', 'Reached out', 'var(--wait)'], ['passed', 'Passed / no reply', 'var(--pass)']];
const STATUS_LABEL = { new: 'New', pursuing: 'Pursuing', 'reached-out': 'Reached out', passed: 'Passed', 'no-reply': 'No reply' };

// ---------- state ----------
let S = null, INIT = null;
let view = 'today', fSel = null, fTab = 'move', peopleCat = 'all', peopleQ = '', boardQ = '';
let ui = { mode: null, text: '', instructions: '', err: '' };
let openDrawer = null;
let sheetQ = '', sheetPick = false;
let drawerEdit = false;

const T = () => S.today;
const draftOf = p => S.drafts[p.id];
function pState(p) {
  if (draftOf(p)) return 'drafted';
  if (p.owe) return 'owe';
  if (p.next && p.next <= T()) return 'due';
  if (p.next) return 'wait';
  if (p.lastOut || p.lastIn) return 'closed';
  return 'none';
}
const tracked = p => p.category || p.next || p.lastOut || p.lastIn || draftOf(p);
function pPill(p) {
  const s = pState(p);
  if (s === 'drafted') return `<span class="pill drafted">Drafted, not sent</span>`;
  if (s === 'owe') return `<span class="pill owe">${p.lastIn === T() ? 'Replied today' : 'Replied ' + fmt(p.lastIn)}</span>`;
  if (s === 'due') {
    if (!p.lastOut) return `<span class="pill due">Reach out</span>`;
    const d = diff(T(), p.next);
    return `<span class="pill due">${d === 0 ? 'Due today' : d + 'd overdue'}</span>`;
  }
  if (s === 'wait') return `<span class="pill wait">Nudge ${fmt(p.next)}</span>`;
  if (s === 'closed') return `<span class="pill grey">No follow-up</span>`;
  return `<span class="pill grey">Not tracking</span>`;
}
const stat = (v, k, c, to) => `<button class="stat" data-go="${to}"><span class="v">${v}</span><span class="k"><i style="background:${c}"></i>${k}</span></button>`;
const statusPill = s => `<span class="pill ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
// a company Derek wants to reach out to on a set date (cleared once it's reached out)
const reachSet = c => c.reach_out_on && c.status !== 'reached-out';
const reachDue = c => reachSet(c) && c.reach_out_on <= T();
function reachPill(c) {
  if (!reachSet(c)) return '';
  const d = diff(T(), c.reach_out_on);
  if (d > 0) return `<span class="pill due">Reach out · ${d}d overdue</span>`;
  if (d === 0) return '<span class="pill due">Reach out today</span>';
  return `<span class="pill wait">Reach out ${fmt(c.reach_out_on)}</span>`;
}
const byId = id => S.people.find(p => p.id === id);
const inboundById = id => S.inbound.find(c => c.id === id);
function companyMatch(name, website) {
  const n = normName(name), d = bareDomain(website);
  const hit = c => (n && (normName(c.name) === n || c.aliases.some(a => normName(a) === n))) ||
    (d && (bareDomain(c.website) === d || c.aliases.some(a => bareDomain(a) === d)));
  const ib = S.inbound.find(hit); if (ib) return { kind: 'inbound', rec: ib };
  const co = S.companies.find(hit); if (co) return { kind: 'company', rec: co };
  return null;
}
const linkedInbound = p => { if (!p.company) return null; const m = companyMatch(p.company, ''); return m && m.kind === 'inbound' ? m.rec : null; };

// ---------- plumbing ----------
async function call(name, ...args) {
  try { return await api.act(name, ...args); }
  catch (e) { toast(errMsg(e), true); throw e; }
}
async function refresh() { S = await api.snapshot(); if (S) render(); }
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3200);
}
function setGit(st) {
  if (!st) return;
  const el = $('sync');
  el.className = 'sync ' + st.state;
  const label = st.state === 'error' ? st.message
    : st.state === 'idle' && st.today ? `${st.today} commit${st.today > 1 ? 's' : ''} today · pushed`
      : st.state === 'idle' ? 'Vault in sync' : st.message;
  el.querySelector('span').textContent = label;
  el.title = st.lastCommit ? 'Last commit: ' + st.lastCommit : '';
}

// ---------- shell ----------
function go(v) {
  view = v; ui = { mode: null, text: '', instructions: '', err: '' };
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  $('viewTitle').textContent = { today: 'Today', follow: 'Follow-ups', inbound: 'Inbound', sheet: 'Deal sheet', people: 'People' }[v];
  render();
  $('view').scrollTop = 0;
}
function setBadges() {
  const move = S.people.filter(p => ['drafted', 'owe', 'due'].includes(pState(p))).length;
  $('b-today').textContent = (move + S.inbound.filter(reachDue).length) || '';
  $('b-follow').textContent = S.people.filter(p => ['drafted', 'owe', 'due', 'wait'].includes(pState(p))).length || '';
  $('b-inbound').textContent = S.inbound.filter(c => c.status === 'new').length || '';
  $('b-people').textContent = S.people.length;
  $('b-sheet').textContent = sheetRecs().filter(c => c.deal_sheet === 'yes').length || '';
}
function render() {
  if (!S) return;
  setBadges();
  const scroll = $('view').scrollTop;
  const listScroll = document.querySelector('.split > .card')?.scrollTop;
  $('view').innerHTML = ({ today: vToday, follow: vFollow, inbound: vInbound, sheet: vSheet, people: vPeople })[view]();
  $('view').scrollTop = scroll;
  if (listScroll !== undefined && document.querySelector('.split > .card')) document.querySelector('.split > .card').scrollTop = listScroll;
  if (view === 'inbound') wireBoard();
  if (openDrawer) renderDrawer();
}

// ---------- rows ----------
function prow(p, current) {
  const sub = [p.role, p.company].filter(Boolean).join(' · ') || p.relationship || '';
  const last = p.lastOut ? `${p.channel === 'email' ? 'Email' : 'LinkedIn'} · sent ${fmt(p.lastOut)}` : p.category ? CATS[p.category] : '';
  return `<li class="prow" data-person="${esc(p.id)}" tabindex="0" aria-current="${!!current}">${av(p.name)}
    <div class="who"><div class="n">${esc(p.name)}</div><div class="c">${esc(sub)}</div></div>
    <div class="r">${pPill(p)}<span class="small">${esc(last)}</span></div></li>`;
}
function irow(c) {
  return `<li class="prow" data-company="${esc(c.id)}" tabindex="0">${av(c.name)}
    <div class="who"><div class="n">${esc(c.name)}</div><div class="c">${c.description ? esc(c.description) : '<i>No description yet</i>'}</div></div>
    <div class="r">${reachSet(c) ? reachPill(c) : c.round_status ? `<span class="pill ${esc(c.round_status)}">${c.round_status === 'raising' ? 'Raising' + (c.raise ? ' ' + esc(c.raise) : '') : 'Tracking'}</span>` : ''}<span class="small">${esc(c.referred_by || 'Direct')} · ${fmt(c.first_seen)}</span></div></li>`;
}

// ---------- Today ----------
function vToday() {
  const drafted = S.people.filter(p => pState(p) === 'drafted');
  const owe = S.people.filter(p => pState(p) === 'owe');
  const due = S.people.filter(p => pState(p) === 'due').sort((a, b) => a.next.localeCompare(b.next));
  // newest added first: first_seen is a date, so same-day ties go to when the note was created
  const nw = S.inbound.filter(c => c.status === 'new').sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || '') || (b.added || 0) - (a.added || 0));
  const raising = S.inbound.filter(c => c.round_status === 'raising' && !['passed', 'no-reply'].includes(c.status));
  const reachNow = S.inbound.filter(reachDue).sort((a, b) => a.reach_out_on.localeCompare(b.reach_out_on));
  const reachSoon = S.inbound.filter(c => reachSet(c) && !reachDue(c) && diff(c.reach_out_on, T()) <= 30).sort((a, b) => a.reach_out_on.localeCompare(b.reach_out_on));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const bits = [];
  if (due.length) bits.push(`${due.length} follow-up${due.length === 1 ? '' : 's'} due`);
  if (owe.length) bits.push(`${owe.length} waiting on your reply`);
  if (drafted.length) bits.push(`${drafted.length} drafted but not sent`);
  if (reachNow.length) bits.push(`${reachNow.length} compan${reachNow.length > 1 ? 'ies' : 'y'} to reach out to`);
  if (nw.length) bits.push(`${nw.length} new inbound to triage`);
  return `
  <div class="hello"><h2>${greet}, Derek</h2><p>${bits.length ? bits.join(', ') + '.' : 'Nothing waiting on you.'}</p></div>
  <div class="stats">
    ${stat(due.length, 'Follow-ups due', 'var(--due)', 'follow')}
    ${stat(owe.length + drafted.length, 'Replies owed / drafts', 'var(--owe)', 'follow')}
    ${stat(nw.length, 'New inbound', 'var(--new)', 'inbound')}
    ${stat(raising.length, 'Raising now', 'var(--pursue)', 'inbound')}
  </div>
  <div class="cols">
    <div class="card">
      <div class="card-h"><h2>Your move</h2><span class="sub">drafts, replies owed, follow-ups due</span></div>
      <ul class="rowlist">${[...drafted, ...owe, ...due].map(p => prow(p)).join('') || '<li class="empty">Nothing due. Add someone with Quick add (N) to start tracking.</li>'}</ul>
    </div>
    <div style="display:grid;gap:18px;min-width:0">
      ${reachNow.length || reachSoon.length ? `<div class="card">
        <div class="card-h"><h2>Companies to reach out to</h2><span class="sub">dates you set on Inbound notes</span></div>
        <ul class="rowlist">${[...reachNow, ...reachSoon].map(irow).join('')}</ul>
      </div>` : ''}
      <div class="card">
        <div class="card-h"><h2>New inbound</h2><button class="btn sm ghost" data-go="inbound">Open board →</button></div>
        <ul class="rowlist">${nw.slice(0, 8).map(irow).join('') || '<li class="empty">Inbound is clear.</li>'}</ul>
      </div>
      <div class="card">
        <div class="card-h"><h2>Recent activity</h2></div>
        <ul class="feed">${S.activity.length ? S.activity.slice(0, 10).map(a => `<li><span>${esc(a.text)}</span><span class="small">${when(a.ts)}</span></li>`).join('') : '<li class="small">Changes you make here show up in this list.</li>'}</ul>
      </div>
    </div>
  </div>`;
}
function when(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------- Follow-ups ----------
function vFollow() {
  const list = S.people.filter(tracked);
  const groups = {
    move: [['Drafted, not sent', list.filter(p => pState(p) === 'drafted')], ['They replied · your move', list.filter(p => pState(p) === 'owe')],
      ['Due or overdue', list.filter(p => pState(p) === 'due').sort((a, b) => a.next.localeCompare(b.next))]].filter(g => g[1].length),
    wait: [['Waiting on them · by next nudge', list.filter(p => pState(p) === 'wait').sort((a, b) => a.next.localeCompare(b.next))]],
    all: Object.keys(CATS).map(c => [CATS[c], list.filter(p => (p.category || 'other') === c)]).filter(g => g[1].length),
  }[fTab];
  const n = { move: list.filter(p => ['drafted', 'owe', 'due'].includes(pState(p))).length, wait: list.filter(p => pState(p) === 'wait').length, all: list.length };
  let p = fSel && byId(fSel);
  if (!p) { const first = groups.flatMap(g => g[1])[0]; p = first || null; fSel = p ? p.id : null; }
  return `<div class="split">
    <div class="card">
      <div class="card-h"><div class="tabs">
        ${[['move', 'Your move'], ['wait', 'Waiting'], ['all', 'Everyone']].map(([k, l]) => `<button data-ftab="${k}" aria-pressed="${fTab === k}">${l} <b>${n[k]}</b></button>`).join('')}
      </div><button class="btn sm" data-act="qa-person">＋ Person</button></div>
      ${groups.length ? groups.map(([h, l]) => `<div class="group">${esc(h)}</div><ul class="rowlist">${l.map(x => prow(x, p && x.id === p.id)).join('') || '<li class="empty">Nothing here.</li>'}</ul>`).join('')
        : `<div class="empty">${fTab === 'move' ? 'Nothing due right now.' : 'No one here yet.'}</div>`}
    </div>
    <div class="card">${p ? detail(p) : '<div class="empty">Pick someone on the left, or add a person with Quick add.</div>'}</div>
  </div>`;
}

function openUrlFor(p, text) {
  if ((p.channel || 'linkedin') === 'email') return `mailto:${encodeURIComponent(p.email || '')}?body=${encodeURIComponent(text || '')}`;
  if (p.linkedin) return p.linkedin;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([p.name, p.company].filter(Boolean).join(' '))}`;
}

function detail(p) {
  const s = pState(p), ib = linkedInbound(p), d = draftOf(p);
  const ch = p.channel || 'linkedin', isLi = ch === 'linkedin';
  const kindWord = s === 'owe' ? 'reply' : p.lastOut ? 'follow-up' : 'first message';
  const cadOpts = sel => [3, 5, 7, 10, 14, 21, 30, 60].map(n => `<option value="${n}" ${n === sel ? 'selected' : ''}>${n} days</option>`).join('');
  let work = '';

  if (ui.mode === 'thinking') {
    work = `<div class="composer"><div class="thinking"><span class="spinner"></span>Claude is reading ${esc(p.name)}'s page${ib ? ' and ' + esc(ib.name) + "'s note" : ''} and drafting in your voice…</div></div>`;
  } else if (ui.mode === 'compose') {
    work = `<div class="composer">
      <div class="composer-h"><b>${kindWord[0].toUpperCase() + kindWord.slice(1)} · ${isLi ? 'LinkedIn' : 'email'}</b><span class="small">${isLi ? 'You paste and send it, then confirm with the Chrome button' : 'Opens your email app with this text'}</span></div>
      <div class="ask"><input class="in" id="instr" placeholder="Anything to mention? (optional) e.g. congrats on the raise, suggest coffee next week" value="${esc(ui.instructions)}"><button class="btn primary sm" data-act="claude">${ui.text ? 'Redraft' : 'Draft with Claude'}</button></div>
      ${ui.err ? `<div class="ask err">${esc(ui.err)}</div>` : ''}
      <textarea id="draftBox" placeholder="Write it here, or have Claude draft it.">${esc(ui.text)}</textarea>
      <div class="composer-f">
        <label class="small">Follow up again in <select class="sel" id="cad">${cadOpts(p.cadence || 7)}</select></label>
        <div class="actions"><button class="btn ghost sm" data-act="cancel">Cancel</button><button class="btn sm" data-act="sent-now" title="Log it as sent without opening anything">Already sent, log it</button><button class="btn sm ${isLi ? 'li' : 'primary'}" data-act="send">${isLi ? 'Copy & open LinkedIn' : 'Copy & open email'}</button></div>
      </div></div>`;
  } else if (ui.mode === 'snooze') {
    work = `<div class="inline"><span class="small">Next follow-up</span>${[3, 7, 14, 30].map(n => `<button class="btn sm" data-snooze="${n}">+${n}d · ${fmt(addDays(T(), n))}</button>`).join('')}<button class="btn sm ghost" data-act="cancel">Cancel</button></div>`;
  } else if (d) {
    work = `<div class="composer pending">
      <div class="composer-h"><b>Drafted ${fmt(d.createdAt)}, not sent yet</b><span class="small">${isLi ? 'Click the Chrome button on their profile after you send it' : 'Mark it sent once it goes out'}</span></div>
      <textarea id="pendingBox">${esc(d.text)}</textarea>
      <div class="composer-f"><span class="small">Next nudge ${d.cadence} days after sending</span>
        <div class="actions"><button class="btn ghost sm" data-act="discard">Discard</button><button class="btn sm" data-act="reopen">${isLi ? 'Copy & open LinkedIn' : 'Copy & open email'}</button><button class="btn sm primary" data-act="mark-sent">Mark as sent</button></div>
      </div></div>`;
  } else if (s === 'none') {
    work = `<div class="setupbox"><b>Start tracking ${esc(p.name.split(' ')[0])}</b>
      <div class="row">
        <select class="sel" id="su-cat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${(p.category || guessCat(p)) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="sel" id="su-ch"><option value="linkedin">LinkedIn</option><option value="email" ${!p.linkedin && p.email ? 'selected' : ''}>Email</option></select>
        <label class="small">every <select class="sel" id="su-cad">${cadOpts(7)}</select></label>
        <button class="btn sm primary" data-act="setup">Start tracking</button>
      </div><span class="small">They'll show up as "Reach out" today. Nothing is sent.</span></div>`;
  } else {
    work = `<div class="actions">
      <button class="btn primary" data-act="compose">${s === 'owe' ? 'Draft reply' : p.lastOut ? 'Draft follow-up' : 'Draft first message'}</button>
      <button class="btn" data-act="snooze">Push back</button>
      ${p.next || s === 'owe' ? '<button class="btn ghost" data-act="close">Close out</button>' : ''}</div>`;
  }
  const dot = x => x === 'out' ? '↗' : x === 'in' ? '↙' : '•';
  const ctx = [p.relationship, p.location].filter(Boolean).join(' · ');
  return `<div class="detail">
    <div class="dhead">${av(p.name)}<div style="flex:1;min-width:0"><h3>${esc(p.name)}</h3><div class="small">${esc([p.role, p.company].filter(Boolean).join(' · '))}</div></div>${pPill(p)}</div>
    ${ctx || ib ? `<p style="margin:0;color:var(--muted)">${esc(ctx)}${ib ? ` <button class="btn sm ghost" data-company="${esc(ib.id)}">${esc(ib.name)} ${statusPill(ib.status)}</button>` : ''}</p>` : ''}
    <div class="facts">
      <div><span>Category</span><b>${esc(CATS[p.category] || '—')}</b></div>
      <div><span>Channel</span><b>${p.channel ? (p.channel === 'email' ? 'Email' : 'LinkedIn') : '—'}</b></div>
      <div><span>Cadence</span><b>${p.cadence ? 'Every ' + p.cadence + 'd' : '—'}</b></div>
      <div><span>Next follow-up</span><b>${p.next ? fmt(p.next) : '—'}</b></div>
    </div>
    ${work}
    <div><p class="label">Outreach log</p>
      <ul class="timeline">${p.log.slice().reverse().map(l => `<li><span class="tdot ${l.dir}">${dot(l.dir)}</span><div><div>${esc(l.text)}</div><div class="meta">${fmt(l.date)} · ${l.dir === 'note' ? 'note' : (l.dir === 'out' ? 'you' : 'them') + ' · ' + esc(l.channel)}</div></div></li>`).join('') || '<li class="small" style="display:block">Nothing logged yet.</li>'}</ul>
    </div>
    <div class="actions"><button class="btn sm ghost" data-note="${esc(p.id)}">Open in Obsidian</button>${p.linkedin ? `<button class="btn sm ghost" data-url="${esc(p.linkedin)}">LinkedIn profile</button>` : ''}${p.email ? `<span class="small mono">${esc(p.email)}</span>` : ''}</div>
  </div>`;
}
function guessCat(p) {
  const r = (p.role + ' ' + p.company).toLowerCase();
  if (/founder|ceo|cto|coo/.test(r)) return 'founder';
  if (/partner|principal|ventures|capital|associate|vc\b/.test(r)) return 'vc';
  if (/family office|\blp\b|endowment/.test(r)) return 'lp';
  return 'other';
}

// ---------- Inbound board ----------
function vInbound() {
  const q = boardQ.toLowerCase();
  const match = c => !q || [c.name, c.description, c.referred_by, c.website, ...(c.themes || [])].join(' ').toLowerCase().includes(q);
  const sheet = S.inbound.filter(c => c.deal_sheet === 'yes').length;
  return `<div class="toolbar">
      <input class="in" id="boardQ" placeholder="Filter the board" value="${esc(boardQ)}" style="width:220px">
      <span class="small">Drag cards between columns. Changes save to <span class="mono">Inbound/</span> and push.</span>
      <span style="margin-left:auto" class="pill grey">${sheet} queued for deal sheet</span>
      <button class="btn primary sm" data-act="qa-company">＋ Add company</button>
    </div>
    <div class="board">${STATUSES.map(([k, l, c]) => {
      const list = S.inbound.filter(x => (x.status === k || (k === 'passed' && x.status === 'no-reply')) && match(x))
        .sort((a, b) => (b.last_touch || '').localeCompare(a.last_touch || ''));
      return `<div class="col" data-col="${k}"><div class="col-h"><i style="background:${c}"></i>${l} <span>${list.length}</span></div>${list.map(card).join('')}</div>`;
    }).join('')}</div>`;
}
function card(c) {
  return `<div class="ic" draggable="true" data-company="${esc(c.id)}" tabindex="0">
    <div class="top"><div style="min-width:0"><div class="nm">${esc(c.name)}</div><div class="dm">${esc(bareDomain(c.website) || '')}</div></div>${c.round_status ? `<span class="pill ${esc(c.round_status)}">${c.round_status === 'raising' ? 'Raising' : 'Tracking'}</span>` : ''}</div>
    <div class="ds ${c.description ? '' : 'missing'}">${c.description ? esc(c.description) : 'No description yet'}</div>
    ${c.raise || c.themes.length || c.deal_sheet ? `<div class="bot">${c.raise ? `<span class="tag">${esc(c.raise)}</span>` : ''}${c.themes.map(t => `<span class="tag">${esc(t)}</span>`).join('')}${c.deal_sheet === 'yes' ? '<span class="sheet-flag">● deal sheet</span>' : c.deal_sheet === 'sent' ? '<span class="small">sheet sent</span>' : ''}</div>` : ''}
    ${reachSet(c) ? `<div class="bot">${reachPill(c)}</div>` : ''}
    <div class="ref">${esc(c.referred_by || 'Direct')} · ${fmt(c.last_touch)}${c.status === 'no-reply' ? ' · no reply' : ''}${(S.enriching || []).includes(c.id) ? ' · <span class="sheet-flag enr">enriching…</span>' : ''}</div></div>`;
}
function wireBoard() {
  document.querySelectorAll('.ic').forEach(el => {
    el.addEventListener('dragstart', e => { el.classList.add('dragging'); e.dataTransfer.setData('text/plain', el.dataset.company); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  document.querySelectorAll('.col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain'), c = inboundById(id);
      if (!c || c.status === col.dataset.col || (col.dataset.col === 'passed' && c.status === 'no-reply')) return;
      await setStatus(id, col.dataset.col);
    });
  });
  const q = $('boardQ');
  if (q) q.addEventListener('input', () => { boardQ = q.value; const pos = q.selectionStart; render(); const n = $('boardQ'); n.focus(); n.setSelectionRange(pos, pos); });
}
async function setReach(id, date) {
  const c = inboundById(id);
  await call('setReachOut', id, date);
  await refresh();
  toast(date ? `Reach out to ${c.name} on ${fmt(date)}` : 'Reach-out date cleared');
}
async function setStatus(id, status) {
  const c = inboundById(id);
  await call('setInboundStatus', id, status);
  toast(`${c.name} → ${STATUS_LABEL[status]}`);
  await refresh();
  if (status === 'pursuing') { openDrawer = id; renderDrawer(); }
}

// ---------- Deal sheet ----------
// Inbound and Companies notes together; deal_sheet is yes (queued) or sent.
const sheetRecs = () => [...S.inbound.map(c => ({ ...c, src: 'inbound' })), ...S.companies.map(c => ({ ...c, src: 'company' }))];
function roundBits(c) {
  const bits = [];
  if (c.round_status === 'raising') bits.push(`<span class="pill raising">Raising${c.raise ? ' ' + esc(c.raise) : ''}</span>`);
  else if (c.raise) bits.push(`<span class="tag">${esc(c.raise)}</span>`);
  const more = [c.valuation && `${esc(c.valuation)} val`, c.lead && `lead ${esc(c.lead)}`].filter(Boolean).join(' · ');
  if (more) bits.push(`<span class="small">${more}</span>`);
  return bits.join('') || '<span class="small">No round info</span>';
}
function srow(c, actions) {
  const open = c.src === 'inbound' ? `data-company="${esc(c.id)}"` : `data-note="${esc(c.id)}"`;
  return `<div class="srow"><div><div class="n" ${open}>${esc(c.name)}</div><div class="src">${c.src === 'inbound' ? 'Inbound · ' + esc(STATUS_LABEL[c.status] || c.status) : 'Companies' + (c.status ? ' · ' + esc(c.status) : '')}</div></div>
    <div class="ds ${c.description ? '' : 'missing'}">${c.description ? esc(c.description) : 'No description yet: the sheet uses it'}</div>
    <div class="rd">${roundBits(c)}</div><div class="act">${actions}</div></div>`;
}
function vSheet() {
  const all = sheetRecs();
  const queued = all.filter(c => c.deal_sheet === 'yes').sort((a, b) => a.name.localeCompare(b.name));
  const live = queued.filter(c => c.round_status === 'raising'), intel = queued.filter(c => c.round_status !== 'raising');
  const sent = all.filter(c => c.deal_sheet === 'sent').sort((a, b) => (b.last_touch || '').localeCompare(a.last_touch || ''));
  const noDesc = queued.filter(c => !c.description).length;
  const q = sheetQ.toLowerCase();
  const picks = sheetPick ? all.filter(c => c.deal_sheet !== 'yes' && (!q || [c.name, c.description, c.website].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.round_status === 'raising') - (a.round_status === 'raising') || (b.last_touch || '').localeCompare(a.last_touch || '')).slice(0, 30) : [];
  const rm = c => `<button class="btn sm ghost" data-sheet-off="${esc(c.id)}" title="Take it off the next sheet">Remove</button>`;
  return `<div class="sheet-wrap">
    <div class="toolbar">
      <span class="sheet-intro">Companies queued for the next deal sheet you send to VC friends. To send one, ask Claude to compile a deal sheet in the vault: it writes the sheet and marks these as sent.</span>
      <div class="sheet-add" style="margin-left:auto">
        <input class="in" id="sheetQ" placeholder="＋ Add a company to the sheet" value="${esc(sheetQ)}" style="width:260px" autocomplete="off">
        ${sheetPick ? `<div class="picks">${picks.map(c => `<button data-sheet-on="${esc(c.id)}"><span>${esc(c.name)}</span><span class="small">${c.round_status === 'raising' ? 'Raising · ' : ''}${c.src === 'inbound' ? 'Inbound' : 'Companies'}${c.deal_sheet === 'sent' ? ' · sent before' : ''}</span></button>`).join('') || '<div class="small" style="padding:8px 10px">No matches.</div>'}</div>` : ''}
      </div>
    </div>
    <div class="stats">
      ${stat(queued.length, 'Queued for next sheet', 'var(--wait)', 'sheet')}
      ${stat(live.length, 'Raising now', 'var(--due)', 'sheet')}
      ${stat(noDesc, 'Missing a description', 'var(--pursue)', 'sheet')}
      ${stat(S.dealSheets.length, 'Sheets sent', 'var(--pass)', 'sheet')}
    </div>
    <div class="card">
      <div class="card-h"><h2>Next sheet</h2><span class="sub">grouped by round status; Claude makes the final call on sections when it compiles</span></div>
      ${queued.length ? `${live.length ? `<div class="sgroup">Live deals · ${live.length}</div>${live.map(c => srow(c, rm(c))).join('')}` : ''}
        ${intel.length ? `<div class="sgroup">Market intel / other · ${intel.length}</div>${intel.map(c => srow(c, rm(c))).join('')}` : ''}`
        : '<div class="empty">Nothing queued. Add a company above, or tick "Deal sheet" on an Inbound card.</div>'}
    </div>
    <div class="card">
      <div class="card-h"><h2>Already shared</h2><span class="sub">re-queue one after news</span></div>
      ${sent.length ? sent.map(c => srow(c, `<button class="btn sm" data-sheet-on="${esc(c.id)}">Re-share</button>`)).join('') : '<div class="empty">Nothing sent yet.</div>'}
    </div>
    ${S.dealSheets.length ? `<div class="card"><div class="card-h"><h2>Past sheets</h2></div><ul class="rowlist">${S.dealSheets.map(d => `<li class="prow" data-note="${esc(d.id)}"><div class="who"><div class="n">${esc(d.name)}</div><div class="c">${d.companies} companies${d.recipients ? ' · to ' + esc(d.recipients) : ''}</div></div><span class="small">${fmt(d.date)}</span></li>`).join('')}</ul></div>` : ''}
  </div>`;
}

// ---------- People ----------
function vPeople() {
  const q = peopleQ.toLowerCase();
  const list = S.people.filter(p => (peopleCat === 'all' || (peopleCat === 'unset' ? !p.category : p.category === peopleCat)) &&
    (!q || [p.name, p.role, p.company, p.relationship].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cats = [['all', 'All', S.people.length], ...Object.entries(CATS).map(([k, l]) => [k, l, S.people.filter(p => p.category === k).length]).filter(x => x[2]), ['unset', 'No category', S.people.filter(p => !p.category).length]];
  return `<div class="toolbar"><div class="tabs">${cats.map(([k, l, n]) => `<button data-pcat="${k}" aria-pressed="${peopleCat === k}">${l} <b>${n}</b></button>`).join('')}</div>
    <input class="in" id="peopleQ" placeholder="Filter people" value="${esc(peopleQ)}" style="width:200px">
    <button class="btn primary sm" style="margin-left:auto" data-act="qa-person">＋ Add person</button></div>
    <div class="card"><ul class="rowlist">${list.map(p => `<li class="prow" data-person="${esc(p.id)}" tabindex="0">${av(p.name)}
      <div class="who"><div class="n">${esc(p.name)}</div><div class="c">${esc([p.role, p.company].filter(Boolean).join(' · '))}</div></div>
      ${p.category ? `<span class="pill grey">${esc(CATS[p.category])}</span>` : ''}
      <div class="r">${pPill(p)}<span class="small">${p.lastOut || p.lastIn ? 'last touch ' + fmt([p.lastOut, p.lastIn].filter(Boolean).sort().pop()) : ''}</span></div></li>`).join('') || '<li class="empty">No one matches.</li>'}</ul></div>`;
}

// ---------- company drawer ----------
function editForm(c) {
  const f = (k, label, ph = '') => `<label class="f">${label}<input id="e-${k}" value="${esc(c[k] || '')}" placeholder="${esc(ph)}"></label>`;
  return `<div id="editForm" class="editform" data-for="${esc(c.id)}">
    <div class="f2">${f('website', 'Website', 'https://…')}${f('referred_by', 'Referred by', 'Firm - Person')}</div>
    ${f('description', 'Description (one line)', 'What the company does')}
    <label class="f">What it is<textarea id="e-whatItIs" rows="4" placeholder="A few sentences: product, buyer, notable facts">${esc(c.whatItIs === 'One line.' ? '' : c.whatItIs)}</textarea></label>
    <div class="f2"><label class="f">Round status<select id="e-round_status">${[['', '—'], ['tracking', 'Tracking'], ['raising', 'Raising']].map(([k, l]) => `<option value="${k}" ${c.round_status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${f('raise', 'Raise', '$5M seed')}</div>
    <div class="f2">${f('valuation', 'Valuation', '$40M post')}${f('lead', 'Lead', 'Firm')}</div>
    ${f('deck_link', 'Deck link', 'docsend.com/…')}
    <div class="f"><span>Themes</span><div class="chips">${(S.themes || []).map(t => `<button type="button" class="chip" data-theme="${esc(t)}" aria-pressed="${c.themes.includes(t)}">${esc(t)}</button>`).join('')}</div></div>
    <div class="actions"><button class="btn primary" data-act="save-edit">Save</button><button class="btn ghost" data-act="cancel-edit">Cancel</button></div>
  </div>`;
}
function renderDrawer() {
  const c = inboundById(openDrawer);
  if (!c) { closeLayer(); return; }
  // don't wipe an edit in progress when the vault refreshes underneath it
  if (drawerEdit && $('editForm') && $('editForm').dataset.for === c.id) return;
  const busyEnrich = (S.enriching || []).includes(c.id);
  const people = c.team.map(m => ({ m, p: S.people.find(x => x.name.toLowerCase() === m.name.toLowerCase()) }));
  $('layer').innerHTML = `<div class="scrim" data-scrim="1"><aside class="drawer" role="dialog" aria-label="${esc(c.name)}">
    <div class="drawer-h"><div style="display:flex;gap:12px;align-items:center;min-width:0">${av(c.name)}<div style="min-width:0"><h3>${esc(c.name)}</h3><div class="small mono">${esc(bareDomain(c.website) || 'no website')} · ${esc(c.id)}</div></div></div>
      <div style="display:flex;gap:6px;align-items:center">${drawerEdit ? '' : `<button class="btn sm" data-act="enrich" ${busyEnrich ? 'disabled' : ''} title="Look it up in Specter and fill what's blank">${busyEnrich ? 'Enriching…' : '✦ Enrich'}</button><button class="btn sm" data-act="edit">Edit</button>`}<button class="btn ghost sm" data-close="1" aria-label="Close">✕</button></div></div>
    <div class="drawer-b">
      <div><p class="label">Status</p><div class="seg">${['new', 'pursuing', 'reached-out', 'passed', 'no-reply'].map(k => `<button data-setstatus="${k}" aria-pressed="${c.status === k}">${STATUS_LABEL[k]}</button>`).join('')}</div></div>
      ${drawerEdit ? editForm(c) : `${c.description || c.whatItIs ? `<div>${c.description ? `<p style="margin:0 0 6px;font-weight:500">${esc(c.description)}</p>` : ''}${c.whatItIs && c.whatItIs !== c.description && c.whatItIs !== 'One line.' ? `<p class="what small">${esc(c.whatItIs)}</p>` : ''}</div>` : `<p class="small" style="margin:0">${busyEnrich ? 'Looking it up in Specter…' : 'No description yet. Click <b>Enrich</b> to pull it from Specter, or <b>Edit</b> to write it.'}</p>`}
      <dl class="fields">
        <dt>Round</dt><dd>${c.round_status ? statusPill(c.round_status) + ' ' : ''}${esc([c.raise, c.valuation && 'at ' + c.valuation, c.lead && 'led by ' + c.lead].filter(Boolean).join(' ')) || '—'}</dd>
        <dt>Referred by</dt><dd>${esc(c.referred_by) || '—'}</dd>
        <dt>Themes</dt><dd>${c.themes.map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</dd>
        <dt>Deck</dt><dd>${c.deck_link ? `<button class="btn sm ghost" style="padding:0" data-url="${esc(c.deck_link)}">${esc(c.deck_link)}</button>` : '—'}</dd>
      </dl>`}
      <dl class="fields">
        <dt>First seen</dt><dd>${fmt(c.first_seen)} · last touch ${fmt(c.last_touch)}</dd>
        <dt>Reach out on</dt><dd class="reach"><input type="date" class="in" id="reachIn" value="${esc(c.reach_out_on || '')}">
          ${[['2w', 14], ['1m', 30], ['3m', 91], ['6m', 182]].map(([l, n]) => `<button class="btn sm ghost" data-reach="${addDays(T(), n)}" title="${fmt(addDays(T(), n))}">${l}</button>`).join('')}
          ${c.reach_out_on ? '<button class="btn sm ghost" data-reach="">Clear</button>' : ''}
          ${c.status === 'reached-out' ? '' : reachPill(c)}</dd>
        <dt>Deal sheet</dt><dd>${c.deal_sheet === 'sent' ? 'Sent' : `<label class="check"><input type="checkbox" id="sheetBox" ${c.deal_sheet === 'yes' ? 'checked' : ''}> Queue for the next sheet</label>`}</dd>
      </dl>
      <div><p class="label">Team</p>${people.length ? people.map(({ m, p }, i) => `<div class="prow" style="padding:6px 0;border:0;cursor:default">${av(m.name)}<div class="who"><div class="n">${esc(m.name)}</div><div class="c">${esc(m.role)}</div></div>${p ? `<button class="btn sm" data-gotoperson="${esc(p.id)}">Open</button>` : `<button class="btn sm primary" data-outreach="${i}">Start outreach</button>`}</div>`).join('') : `<div class="actions"><span class="small">No team listed.</span><button class="btn sm" data-addfounder="1">Add founder</button></div>`}</div>
      <div><p class="label">Touches</p>
        <div class="inline" style="margin-bottom:10px"><input class="in" id="touchIn" placeholder="Add a touch, e.g. Sam says the round is half committed"><button class="btn sm" data-act="touch">Add</button></div>
        <ul class="timeline">${c.touches.slice().reverse().map(t => `<li><span class="tdot note">•</span><div>${esc(t)}</div></li>`).join('') || '<li class="small" style="display:block">No touches.</li>'}</ul></div>
      <div class="actions"><button class="btn" data-note="${esc(c.id)}">Open in Obsidian</button>${c.website ? `<button class="btn ghost" data-url="${esc(c.website)}">Website</button>` : ''}</div>
    </div></aside></div>`;
}
function closeLayer() { $('layer').innerHTML = ''; openDrawer = null; drawerEdit = false; }

// ---------- quick add ----------
let qa = { mode: 'company' };
function openQuickAdd(mode = 'company', pre = {}) {
  qa = { mode, pre };
  openDrawer = null;
  const company = `
    <div class="modal-b">
      <div class="f2"><label class="f">Company<input id="q-name" required value="${esc(pre.name || '')}" placeholder="e.g. Corvid Systems"></label>
      <label class="f">Website<input id="q-web" value="${esc(pre.website || '')}" placeholder="corvid.ai"></label></div>
      <div id="dupe"></div>
      <div class="f2"><label class="f">Referred by<input id="q-ref" placeholder="Firm - Person"></label>
      <label class="f">How it came in<select id="q-how"><option>Email</option><option>Text</option><option>Intro</option><option>Event</option><option>Told to track</option><option>Outbound</option></select></label></div>
      <label class="f">Note<input id="q-note" placeholder="One line on the ask"></label>
      <div class="f2"><label class="f">Raise (optional)<input id="q-raise" placeholder="$3M seed"></label>
      <label class="f">Deck link (optional)<input id="q-deck" placeholder="docsend.com/…"></label></div>
    </div>
    <div class="modal-f"><span class="small">Saved to Inbound/ as New. Claude can fill in the rest later.</span><div class="actions"><button type="button" class="btn ghost" data-close="1">Cancel</button><button class="btn primary" id="qaSubmit">Add to Inbound</button></div></div>`;
  const person = `
    <div class="modal-b">
      <div class="f2"><label class="f">Name<input id="p-name" required value="${esc(pre.name || '')}" placeholder="Full name"></label>
      <label class="f">Company<input id="p-co" value="${esc(pre.company || '')}" placeholder="Firm or company"></label></div>
      <div id="pdupe"></div>
      <div class="f2"><label class="f">Role<input id="p-role" placeholder="CEO, Partner…"></label>
      <label class="f">LinkedIn URL or email<input id="p-contact" placeholder="linkedin.com/in/… or name@firm.com"></label></div>
      <div class="f2"><label class="f">Category<select id="p-cat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f">Follow up every<select id="p-d">${[3, 5, 7, 10, 14, 21, 30, 60].map(n => `<option ${n === 7 ? 'selected' : ''} value="${n}">${n} days</option>`).join('')}</select></label></div>
      <label class="f">What you sent (leave blank if you haven't reached out yet)<input id="p-note" placeholder="e.g. Cold intro re: their eval tooling launch"></label>
    </div>
    <div class="modal-f"><span class="small">Creates or updates their People/ note.</span><div class="actions"><button type="button" class="btn ghost" data-close="1">Cancel</button><button class="btn primary">Save</button></div></div>`;
  const reply = `
    <div class="modal-b">
      <label class="f">Who replied?<input id="r-q" placeholder="Start typing a name" autocomplete="off"></label>
      <div class="picker" id="r-pick"></div>
      <input type="hidden" id="r-id">
      <label class="f">What did they say? (one line)<input id="r-note" placeholder="e.g. Happy to meet, free Tuesday afternoon"></label>
    </div>
    <div class="modal-f"><span class="small">Clears their follow-up date and puts them under "your move".</span><div class="actions"><button type="button" class="btn ghost" data-close="1">Cancel</button><button class="btn primary">Log reply</button></div></div>`;
  $('layer').innerHTML = `<div class="scrim center" data-scrim="1"><div class="modal" role="dialog" aria-label="Quick add">
    <div class="modal-h"><h3>Quick add</h3><div class="seg">${[['company', 'Inbound company'], ['person', 'Person'], ['reply', 'Log a reply']].map(([k, l]) => `<button type="button" data-qmode="${k}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div></div>
    <form id="qaForm">${{ company, person, reply }[mode]}</form></div></div>`;
  const first = document.querySelector('#qaForm input:not([type=hidden])'); if (first) first.focus();
  if (mode === 'company') {
    const chk = () => {
      const name = $('q-name').value, web = $('q-web').value, m = companyMatch(name, web);
      $('dupe').innerHTML = m ? `<div class="match"><span><b>${esc(m.rec.name)}</b> is already in ${m.kind === 'inbound' ? 'Inbound ' + statusPill(m.rec.status) : 'Companies'}. Saving adds a dated touch to that note instead of creating a duplicate.</span></div>`
        : (name || web) ? '<div class="ok-line">✓ Not in Inbound or Companies yet</div>' : '';
      $('qaSubmit').textContent = m ? 'Add touch' : 'Add to Inbound';
    };
    $('q-name').addEventListener('input', chk); $('q-web').addEventListener('input', chk); chk();
  }
  if (mode === 'person') {
    const chk = () => { const n = $('p-name').value.trim().toLowerCase(); const p = n && S.people.find(x => x.name.toLowerCase() === n); $('pdupe').innerHTML = p ? `<div class="match"><span><b>${esc(p.name)}</b> already has a page. Saving updates it.</span></div>` : ''; };
    $('p-name').addEventListener('input', chk); chk();
  }
  if (mode === 'reply') {
    const pick = () => {
      const q = $('r-q').value.toLowerCase();
      const list = S.people.filter(p => !q || p.name.toLowerCase().includes(q) || (p.company || '').toLowerCase().includes(q))
        .sort((a, b) => (pState(b) === 'wait') - (pState(a) === 'wait') || (b.lastOut || '').localeCompare(a.lastOut || '')).slice(0, 30);
      $('r-pick').innerHTML = list.map(p => `<div class="prow" data-pick="${esc(p.id)}" aria-current="${$('r-id').value === p.id}">${av(p.name)}<div class="who"><div class="n">${esc(p.name)}</div><div class="c">${esc(p.company)}</div></div>${pPill(p)}</div>`).join('') || '<div class="empty">No match.</div>';
    };
    $('r-q').addEventListener('input', pick); pick();
    if (pre.id) { $('r-id').value = pre.id; $('r-q').value = byId(pre.id)?.name || ''; pick(); }
  }
  $('qaForm').onsubmit = e => { e.preventDefault(); submitQuickAdd(); };
}
async function submitQuickAdd() {
  const v = id => ($(id)?.value || '').trim();
  if (qa.mode === 'company') {
    if (!v('q-name')) return toast('Add the company name', true);
    const r = await call('addInbound', { name: v('q-name'), website: v('q-web'), referred_by: v('q-ref'), how: v('q-how'), note: v('q-note'), raise: v('q-raise'), deck_link: v('q-deck') });
    closeLayer(); await refresh();
    toast(r.existed ? `Added a touch to the existing note` : `${v('q-name')} added to Inbound`);
    if (r.existed !== 'company') { if (view !== 'inbound') go('inbound'); openDrawer = r.id; renderDrawer(); }
  } else if (qa.mode === 'person') {
    if (!v('p-name')) return toast('Add their name', true);
    const contact = v('p-contact'), isEmail = /@/.test(contact) && !/linkedin\.com/i.test(contact);
    const r = await call('addPerson', { name: v('p-name'), company: v('p-co'), role: v('p-role'), linkedin: isEmail ? '' : (contact ? (/^https?:/.test(contact) ? contact : 'https://' + contact) : ''), email: isEmail ? contact : '', category: v('p-cat'), channel: isEmail ? 'email' : 'linkedin', cadence: Number(v('p-d')), note: v('p-note') });
    closeLayer(); await refresh();
    fSel = r.id; const p = byId(r.id); fTab = pState(p) === 'wait' ? 'wait' : 'move'; go('follow');
    toast(v('p-note') ? `Logged. Next nudge ${fmt(p.next)}` : `${p.name} added. Reach out when ready.`);
  } else {
    const id = v('r-id');
    if (!id) return toast('Pick who replied', true);
    if (!v('r-note')) return toast('Add a line about what they said', true);
    await call('logReply', id, { note: v('r-note') });
    closeLayer(); await refresh(); fSel = id; fTab = 'move'; go('follow');
    toast('Reply logged');
  }
}

// ---------- Chrome help ----------
function openChromeHelp() {
  $('layer').innerHTML = `<div class="scrim center" data-scrim="1"><div class="modal wide" role="dialog" aria-label="Set up the Chrome button">
    <div class="modal-h"><h3>Set up the Chrome button</h3><button class="btn ghost sm" data-close="1">✕</button></div>
    <div class="modal-b">
      <p style="margin:0">One-time setup, about a minute. The button only works while Brain Desk is open (it can sit in the background with the window closed).</p>
      <ol class="steps">
        <li>In Chrome, go to <span class="code">chrome://extensions</span> <button class="btn sm" data-copy="chrome://extensions">Copy</button></li>
        <li>Turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and choose this folder: <span class="code">${esc(INIT.extensionDir)}</span> <button class="btn sm" data-act="reveal-ext">Show in Finder</button></li>
        <li>Click the puzzle-piece icon in Chrome's toolbar and pin <b>Brain Desk</b>.</li>
      </ol>
      <p class="small" style="margin:0"><b>On a LinkedIn profile</b>, the button confirms a draft you sent ("Mark as sent"), logs a message you wrote on LinkedIn, or logs their reply. <b>On a company website</b>, it adds the company to Inbound or adds a touch if it's already there.</p>
    </div></div></div>`;
}

// ---------- search ----------
function runSearch() {
  const q = $('search').value.trim().toLowerCase(), r = $('results');
  if (!q) { r.hidden = true; return; }
  const hits = [
    ...S.people.filter(p => [p.name, p.company].join(' ').toLowerCase().includes(q)).slice(0, 6).map(p => `<button data-sp="${esc(p.id)}"><span>${esc(p.name)}<span class="small"> · ${esc(p.company || 'Person')}</span></span>${pPill(p)}</button>`),
    ...S.inbound.filter(c => [c.name, c.website, c.description, ...c.aliases].join(' ').toLowerCase().includes(q)).slice(0, 6).map(c => `<button data-sc="${esc(c.id)}"><span>${esc(c.name)}<span class="small"> · Inbound</span></span>${statusPill(c.status)}</button>`),
    ...S.companies.filter(c => [c.name, c.website, ...c.aliases].join(' ').toLowerCase().includes(q)).slice(0, 4).map(c => `<button data-snote="${esc(c.id)}"><span>${esc(c.name)}<span class="small"> · Companies (opens Obsidian)</span></span><span class="pill grey">${esc(c.status || 'company')}</span></button>`),
  ];
  r.innerHTML = hits.join('') || `<div class="small" style="padding:8px">No match. Press N to add it.</div>`;
  r.hidden = false;
}

// ---------- events ----------
function selectPerson(id) {
  fSel = id; ui = { mode: null, text: '', instructions: '', err: '' };
  const p = byId(id);
  if (view !== 'follow') { fTab = ['drafted', 'owe', 'due'].includes(pState(p)) ? 'move' : pState(p) === 'wait' ? 'wait' : 'all'; go('follow'); }
  else render();
}

async function onViewClick(e) {
  const t = e.target;
  const g = t.closest('[data-go]'); if (g) return go(g.dataset.go);
  const son = t.closest('[data-sheet-on]');
  if (son) { const c = sheetRecs().find(x => x.id === son.dataset.sheetOn); await call('setDealSheet', son.dataset.sheetOn, true); sheetPick = false; sheetQ = ''; await refresh(); return toast(`${c ? c.name : 'Company'} queued for the deal sheet`); }
  const soff = t.closest('[data-sheet-off]');
  if (soff) { const c = sheetRecs().find(x => x.id === soff.dataset.sheetOff); await call('setDealSheet', soff.dataset.sheetOff, false); await refresh(); return toast(`${c ? c.name : 'Company'} removed from the deal sheet`); }
  const ft = t.closest('[data-ftab]'); if (ft) { fTab = ft.dataset.ftab; fSel = null; ui.mode = null; return render(); }
  const pc = t.closest('[data-pcat]'); if (pc) { peopleCat = pc.dataset.pcat; return render(); }
  const nt = t.closest('[data-note]'); if (nt) return api.openNote(nt.dataset.note);
  const th = t.closest('[data-theme]'); if (th) { th.setAttribute('aria-pressed', th.getAttribute('aria-pressed') !== 'true'); return; }
  const da = t.closest('[data-act]');
  if (da && openDrawer && ['edit', 'cancel-edit', 'save-edit', 'enrich'].includes(da.dataset.act)) {
    const c = inboundById(openDrawer);
    if (da.dataset.act === 'edit') { drawerEdit = true; return renderDrawer(); }
    if (da.dataset.act === 'cancel-edit') { drawerEdit = false; return renderDrawer(); }
    if (da.dataset.act === 'save-edit') {
      const val = k => ($('e-' + k)?.value || '').trim();
      const fields = Object.fromEntries(['website', 'referred_by', 'description', 'whatItIs', 'round_status', 'raise', 'valuation', 'lead', 'deck_link'].map(k => [k, val(k)]));
      fields.themes = [...document.querySelectorAll('[data-theme][aria-pressed="true"]')].map(b => b.dataset.theme);
      const r = await call('editInbound', c.id, fields);
      drawerEdit = false; await refresh(); renderDrawer();
      return toast(r.changed.length ? `Saved ${c.name}: ${r.changed.join(', ')}` : 'No changes');
    }
    if (da.dataset.act === 'enrich') {
      const p = call('enrich', c.id); await refresh();
      const r = await p; await refresh();
      return toast(!r.found ? `Couldn't find ${c.name} in Specter or on the web` : r.changed.length ? `Enriched ${c.name}: ${r.changed.join(', ')}` : `${c.name}: nothing blank to fill`);
    }
  }
  const rc = t.closest('[data-reach]');
  if (rc && openDrawer) { await setReach(openDrawer, rc.dataset.reach); return; }
  const u = t.closest('[data-url]'); if (u) return api.open(u.dataset.url);
  const co = t.closest('[data-company]'); if (co) { openDrawer = co.dataset.company; return renderDrawer(); }
  const pr = t.closest('[data-person]'); if (pr) return selectPerson(pr.dataset.person);
  const sn = t.closest('[data-snooze]');
  const p = fSel && byId(fSel);
  if (sn && p) { const r = await call('snooze', p.id, Number(sn.dataset.snooze)); ui.mode = null; await refresh(); return toast(`Next follow-up ${fmt(r.next)}`); }
  const a = t.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'qa-person') return openQuickAdd('person');
  if (act === 'qa-company') return openQuickAdd('company');
  if (!p) return;
  const text = () => ($('draftBox')?.value || '').trim();
  switch (act) {
    case 'compose': ui = { mode: 'compose', text: '', instructions: '', err: '' }; render(); $('instr')?.focus(); break;
    case 'cancel': ui = { mode: null, text: '', instructions: '', err: '' }; render(); break;
    case 'snooze': ui.mode = 'snooze'; render(); break;
    case 'claude': {
      ui.instructions = ($('instr')?.value || '').trim(); ui.text = text(); ui.mode = 'thinking'; ui.err = ''; render();
      try { const r = await api.act('draft', p.id, { instructions: ui.instructions }); ui.text = r.text; }
      catch (err) { ui.err = errMsg(err); }
      if (fSel === p.id && ui.mode === 'thinking') { ui.mode = 'compose'; render(); }
      break;
    }
    case 'send': {
      const body = text(); if (!body) return toast('Write or draft the message first', true);
      const cad = Number($('cad').value);
      await api.copy(body);
      await call('saveDraft', p.id, { text: body, cadence: cad });
      api.open(openUrlFor(p, body));
      ui = { mode: null, text: '', instructions: '', err: '' }; await refresh();
      toast((p.channel || 'linkedin') === 'email' ? 'Opened in your email app. Mark it sent once it goes out.' : 'Copied. Paste it in LinkedIn and send, then click the Chrome button to confirm.');
      break;
    }
    case 'sent-now': {
      const body = text(); if (!body) return toast('Write a line about what you sent', true);
      const r = await call('logSent', p.id, { text: body, cadence: Number($('cad').value) });
      ui = { mode: null, text: '', instructions: '', err: '' }; await refresh(); toast(`Logged. Next nudge ${fmt(r.next)}`);
      break;
    }
    case 'reopen': { const body = ($('pendingBox')?.value || '').trim(); await api.copy(body); if (body !== draftOf(p).text) await call('saveDraft', p.id, { text: body, cadence: draftOf(p).cadence }); api.open(openUrlFor(p, body)); toast('Copied again'); break; }
    case 'mark-sent': { const body = ($('pendingBox')?.value || '').trim(); const r = await call('logSent', p.id, { text: body }); await refresh(); toast(`Logged as sent. Next nudge ${fmt(r.next)}`); break; }
    case 'discard': await call('discardDraft', p.id); await refresh(); toast('Draft discarded'); break;
    case 'close': await call('closeOut', p.id); await refresh(); toast(`${p.name} closed out`); break;
    case 'setup': {
      await call('setupOutreach', p.id, { category: $('su-cat').value, channel: $('su-ch').value, cadence: Number($('su-cad').value) });
      await refresh(); toast(`Tracking ${p.name}`); break;
    }
  }
}

async function onLayerClick(e) {
  const t = e.target;
  if (t.dataset.scrim || t.closest('[data-close]')) return closeLayer();
  const qm = t.closest('[data-qmode]'); if (qm) return openQuickAdd(qm.dataset.qmode);
  const pk = t.closest('[data-pick]'); if (pk) { $('r-id').value = pk.dataset.pick; $('r-q').value = byId(pk.dataset.pick).name; document.querySelectorAll('[data-pick]').forEach(x => x.setAttribute('aria-current', x === pk)); $('r-note').focus(); return; }
  const cp = t.closest('[data-copy]'); if (cp) { await api.copy(cp.dataset.copy); return toast('Copied'); }
  const nt = t.closest('[data-note]'); if (nt) return api.openNote(nt.dataset.note);
  const u = t.closest('[data-url]'); if (u) return api.open(/^https?:/.test(u.dataset.url) ? u.dataset.url : 'https://' + u.dataset.url);
  const a = t.closest('[data-act]');
  if (a && a.dataset.act === 'reveal-ext') return api.revealExtension();
  const c = openDrawer && inboundById(openDrawer);
  if (!c) return;
  const ss = t.closest('[data-setstatus]'); if (ss) { if (ss.dataset.setstatus !== c.status) await setStatus(c.id, ss.dataset.setstatus); return; }
  if (t.closest('[data-addfounder]')) { const name = c.name; closeLayer(); openQuickAdd('person', { company: name }); $('p-cat').value = 'founder'; return; }
  const gp = t.closest('[data-gotoperson]'); if (gp) { closeLayer(); return selectPerson(gp.dataset.gotoperson); }
  const or = t.closest('[data-outreach]');
  if (or) {
    const m = c.team[Number(or.dataset.outreach)];
    const r = await call('startOutreach', c.id, m);
    closeLayer(); await refresh(); fTab = 'move'; fSel = r.id; go('follow');
    ui = { mode: 'compose', text: '', instructions: '', err: '' }; render();
    return toast(`${m.name} added. Draft your first message.`);
  }
  if (a && a.dataset.act === 'touch') {
    const line = ($('touchIn').value || '').trim(); if (!line) return;
    await call('addTouch', c.id, line); await refresh(); toast('Touch added');
  }
}

function wire() {
  $('nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
  $('qaBtn').onclick = () => openQuickAdd('company');
  $('extHelp').onclick = openChromeHelp;
  $('loginItem').onchange = async e => { e.target.checked = await api.loginItem(e.target.checked); };
  $('view').addEventListener('click', e => { onViewClick(e).catch(() => {}); });
  $('view').addEventListener('input', e => {
    if (e.target.id === 'draftBox') ui.text = e.target.value;
    if (e.target.id === 'instr') ui.instructions = e.target.value;
    if (e.target.id === 'sheetQ') { sheetQ = e.target.value; sheetPick = true; const pos = e.target.selectionStart; render(); const n = $('sheetQ'); n.focus(); n.setSelectionRange(pos, pos); }
    if (e.target.id === 'peopleQ') { peopleQ = e.target.value; const pos = e.target.selectionStart; render(); const n = $('peopleQ'); n.focus(); n.setSelectionRange(pos, pos); }
  });
  $('view').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.prow, .ic')) e.target.click();
    if (e.key === 'Enter' && e.target.id === 'instr') { e.preventDefault(); document.querySelector('[data-act="claude"]')?.click(); }
  });
  $('layer').addEventListener('click', e => { onLayerClick(e).catch(() => {}); });
  $('layer').addEventListener('change', async e => {
    if (e.target.id === 'reachIn' && openDrawer) { await setReach(openDrawer, e.target.value); return; }
    if (e.target.id === 'sheetBox' && openDrawer) { await call('setDealSheet', openDrawer, e.target.checked); await refresh(); toast(e.target.checked ? 'Queued for the deal sheet' : 'Removed from the deal sheet'); }
  });
  $('layer').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'touchIn') document.querySelector('[data-act="touch"]')?.click(); });
  $('search').addEventListener('input', runSearch);
  $('search').addEventListener('keydown', e => { if (e.key === 'Enter') document.querySelector('#results button')?.click(); if (e.key === 'Escape') { e.target.value = ''; runSearch(); e.target.blur(); } });
  $('results').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $('results').hidden = true; $('search').value = '';
    if (b.dataset.sp) selectPerson(b.dataset.sp);
    else if (b.dataset.sc) { openDrawer = b.dataset.sc; renderDrawer(); }
    else if (b.dataset.snote) api.openNote(b.dataset.snote);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) $('results').hidden = true; });
  $('view').addEventListener('focusin', e => { if (e.target.id === 'sheetQ' && !sheetPick) { sheetPick = true; render(); const n = $('sheetQ'); n.focus(); } });
  document.addEventListener('mousedown', e => { if (sheetPick && view === 'sheet' && !e.target.closest('.sheet-add')) { sheetPick = false; sheetQ = ''; render(); } });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === 'Escape' && $('layer').innerHTML) closeLayer();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); }
    if (!typing && !$('layer').innerHTML && (e.key === 'n' || e.key === 'N') && !e.metaKey) { e.preventDefault(); openQuickAdd('company'); }
  });
  api.onChanged(() => { if (!document.activeElement || !/TEXTAREA|INPUT/.test(document.activeElement.tagName) || ui.mode === null) refresh(); });
  api.onGit(setGit);
}

// ---------- setup ----------
async function showSetup(msg) {
  $('app').hidden = true; $('setup').hidden = false;
  const sug = INIT.suggestion;
  $('setupBody').innerHTML = `${sug ? `<button class="btn primary" id="useSug">Use ${esc(sug.replace(/^\/Users\/[^/]+/, '~'))}</button>` : ''}<button class="btn" id="choose">Choose a folder…</button>`;
  if (msg) { $('setupErr').textContent = msg; $('setupErr').hidden = false; }
  const done = async r => { if (!r) return; if (!r.git.ok) toast('Connected, but git isn\'t set up in that folder: changes won\'t be pushed', true); await start(); };
  if (sug) $('useSug').onclick = () => api.connect(sug).then(done).catch(e => { $('setupErr').textContent = errMsg(e); $('setupErr').hidden = false; });
  $('choose').onclick = () => api.chooseVault().then(done).catch(e => { $('setupErr').textContent = errMsg(e); $('setupErr').hidden = false; });
}
async function start() {
  INIT = await api.init();
  if (!INIT.connected) return showSetup(INIT.error);
  $('setup').hidden = true; $('app').hidden = false;
  $('loginItem').checked = INIT.loginItem;
  $('vaultName').textContent = INIT.vaultPath.split('/').pop();
  S = await api.snapshot();
  setGit(await api.gitStatus());
  go(view);
}
wire();
start();
