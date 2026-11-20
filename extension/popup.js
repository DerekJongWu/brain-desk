'use strict';
/* global chrome */
const API = 'http://127.0.0.1:47817';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('main');
const v = id => ($(id) ? $(id).value.trim() : '');
const CATS = [['founder', 'Founder'], ['vc', 'VC'], ['operator', 'Operator'], ['lp', 'LP'], ['other', 'Other']];
const DAYS = [3, 5, 7, 10, 14, 21, 30];
const dayOpts = sel => DAYS.map(n => `<option value="${n}" ${n === sel ? 'selected' : ''}>${n} days</option>`).join('');
const fmt = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Brain Desk returned ${r.status}`);
  return j;
}

// Runs inside the page: pull what we can identify from it.
function scrape() {
  const txt = el => (el && el.innerText || '').trim();
  const meta = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || '';
  const out = { siteName: '', name: '', headline: '', profileUrl: '', website: '' };
  if (/linkedin\.com$/.test(location.hostname) && location.pathname.startsWith('/company/')) {
    out.siteName = txt(document.querySelector('main h1, h1')) || document.title.replace(/^\(\d+\)\s*/, '').split('|')[0].trim();
    // "Visit website" on the top card, or the Website row on the About tab
    const ext = [...document.querySelectorAll('main a[href^="http"]')].map(a => a.href)
      .map(h => { try { const u = new URL(h); return u.hostname.endsWith('linkedin.com') && u.searchParams.get('url') ? u.searchParams.get('url') : h; } catch (_) { return h; } })
      .find(h => !/linkedin\.com|lnkd\.in|licdn\.com|bing\.com|microsoft\.com/i.test(h));
    out.website = ext || '';
    out.description = txt(document.querySelector('.org-top-card-summary__tagline, .org-top-card-summary-info-list__info-item'));
    return out;
  }
  if (/linkedin\.com$/.test(location.hostname)) {
    if (location.pathname.startsWith('/in/')) {
      out.name = txt(document.querySelector('main h1, h1'));
      out.headline = txt(document.querySelector('main .text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium'));
    } else if (location.pathname.startsWith('/messaging')) {
      const head = document.querySelector('.msg-thread__link-to-profile, .msg-entity-lockup__entity-title, .msg-overlay-bubble-header__title');
      out.name = txt(document.querySelector('.msg-entity-lockup__entity-title') || head);
      const a = document.querySelector('a.msg-thread__link-to-profile[href*="/in/"], .msg-title-bar a[href*="/in/"], .msg-thread a[href*="/in/"]');
      out.profileUrl = a ? a.href : '';
      out.headline = txt(document.querySelector('.msg-entity-lockup__entity-info'));
    }
    if (!out.name) out.name = document.title.replace(/^\(\d+\)\s*/, '').split('|')[0].trim();
  } else {
    out.siteName = meta('og:site_name') || document.title.split(/\s[|–—·:-]\s/)[0].trim();
  }
  return out;
}

async function run() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page = { url: tab.url || '', title: tab.title || '' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrape });
    page = { ...page, ...result };
  } catch (_) { /* chrome:// pages etc. */ }

  let info;
  try {
    info = await post('/lookup', { url: page.profileUrl || page.url, name: page.name, headline: page.headline, siteName: page.siteName, website: page.website, description: page.description });
  } catch (e) {
    main.innerHTML = /Failed to fetch|NetworkError/.test(e.message)
      ? `<div class="note"><b>Brain Desk isn't running.</b><br>Open the app (it can stay in the background with its window closed), then click this button again.</div>`
      : `<div class="note err">${esc(e.message)}</div>`;
    return;
  }
  ({ person: personView, 'new-person': newPersonView, company: companyView, 'new-company': newCompanyView }[info.kind] || unknownView)(info, page);
}

function done(title, sub) {
  main.innerHTML = `<div class="done"><div class="big">✓</div><b>${esc(title)}</b><div class="muted">${esc(sub || '')}</div></div>`;
  setTimeout(() => window.close(), 1800);
}
async function busy(btn, fn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Saving…';
  try { await fn(); } catch (e) { btn.disabled = false; btn.textContent = label; let el = $('err'); if (!el) { el = document.createElement('div'); el.id = 'err'; el.className = 'err'; main.appendChild(el); } el.textContent = e.message; }
}

// ---------- a person already in the vault: draft, confirm, log ----------
const KIND_LABEL = { first: 'Draft first message', followup: 'Draft follow-up', reply: 'Draft reply' };
function head(p) {
  return `<div class="who"><b>${esc(p.name)}</b><span class="muted">${esc([p.role, p.company].filter(Boolean).join(' · '))}</span></div>`;
}
function statusLine(p) {
  if (p.state === 'owe') return 'They replied · your move';
  if (p.state === 'waiting') return p.due ? `Follow-up due ${fmt(p.next)}` : `Waiting on them · nudge ${fmt(p.next)}`;
  return p.lastOut ? `Last message ${fmt(p.lastOut)}` : 'Not contacted yet';
}
const liField = (p, page) => (p.linkedinMissing ? (page.profileUrl || page.url) : '');

function personView({ person: p, draft }, page, flash) {
  $('kind').textContent = 'LinkedIn profile';
  if (draft) return pendingView(p, draft, page, flash);
  const tab = p.state === 'waiting' && !p.due ? 'reply' : 'draft';
  personTabs(p, page, tab, flash);
}

// A saved draft: paste it, send it, come back and confirm.
function pendingView(p, draft, page, flash) {
  main.innerHTML = `${head(p)}
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
    <div class="draft"><b>Draft, not sent yet · ${esc(fmt(draft.createdAt))}</b>${esc(draft.text)}</div>
    <div class="two"><button id="copy">Copy again</button><button id="edit">Edit or redraft</button></div>
    <label>Follow up again in<select id="days">${dayOpts(draft.cadence)}</select></label>
    <button class="li" id="sent">Mark as sent</button>
    <button class="link" id="other">I sent something different</button>`;
  $('copy').onclick = async e => { await navigator.clipboard.writeText(draft.text); e.target.textContent = 'Copied'; };
  $('edit').onclick = () => personTabs(p, page, 'draft', '', draft);
  $('sent').onclick = e => busy(e.target, async () => {
    const r = await post('/log-person', { id: p.id, note: '', days: Number($('days').value), linkedin: liField(p, page) });
    done('Logged as sent', `Next nudge ${fmt(r.next)}`);
  });
  $('other').onclick = () => personTabs(p, page, 'sent');
}

function personTabs(p, page, tab, flash, draft) {
  main.innerHTML = `${head(p)}<div class="muted">${esc(statusLine(p))}</div>
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
    <div class="seg"><button data-tab="draft">Draft</button><button data-tab="sent">I sent one</button><button data-tab="reply">They replied</button></div>
    <div id="form"></div>`;
  const render = t => {
    main.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === t));
    if (t === 'draft') return composer(p, page, draft);
    if (t === 'sent') {
      $('form').innerHTML = `<label>What you sent (one line)<textarea id="note" placeholder="e.g. Following up on the deck"></textarea></label>
        <label>Follow up again in<select id="days">${dayOpts(p.cadence || 7)}</select></label><button class="li" id="go">Log message</button>`;
      $('go').onclick = e => busy(e.target, async () => {
        if (!$('note').value.trim()) throw new Error('Add a line about what you sent.');
        const r = await post('/log-person', { id: p.id, note: $('note').value.trim(), days: Number($('days').value), linkedin: liField(p, page) });
        done('Message logged', `Next nudge ${fmt(r.next)}`);
      });
    } else {
      $('form').innerHTML = `<label>What did they say? (one line)<textarea id="note" placeholder="e.g. Happy to meet, free Tuesday"></textarea></label><button class="primary" id="go">Log reply</button>`;
      $('go').onclick = e => busy(e.target, async () => {
        if (!$('note').value.trim()) throw new Error('Add a line about what they said.');
        await post('/log-reply', { id: p.id, note: $('note').value.trim() });
        done('Reply logged', 'They\'re under "your move" in Brain Desk');
      });
    }
    $('note').focus();
  };
  main.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => render(b.dataset.tab); });
  render(tab);
}

// Draft with Claude (or write it), then copy and keep it as a pending draft.
function composer(p, page, draft) {
  $('form').innerHTML = `
    <div class="two-btn"><input id="ins" placeholder="Steer it (optional): e.g. mention their seed"><button class="primary" id="gen">✦ ${esc(KIND_LABEL[p.draftKind] || 'Draft')}</button></div>
    <textarea id="text" class="big-text" placeholder="Claude writes it here in your voice, or type your own."></textarea>
    <div id="hint" class="muted"></div>
    <label>Follow up in<select id="days">${dayOpts((draft && draft.cadence) || p.cadence || 7)}</select></label>
    <button class="li" id="copy">Copy & save draft</button>`;
  if (draft) $('text').value = draft.text;
  $('gen').onclick = async e => {
    const btn = e.target, label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Drafting…';
    $('hint').textContent = 'Usually about 10 seconds. It\'s saved as a draft when done, so you can close this.';
    try {
      const r = await post('/draft', { id: p.id, instructions: $('ins').value.trim(), days: Number($('days').value) });
      $('text').value = r.text;
      $('hint').textContent = 'Edit it if you like, then copy.';
    } catch (err) { $('hint').innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    btn.disabled = false; btn.textContent = label;
  };
  $('copy').onclick = e => busy(e.target, async () => {
    const text = $('text').value.trim();
    if (!text) throw new Error('Draft something first.');
    await navigator.clipboard.writeText(text);
    const r = await post('/save-draft', { id: p.id, text, days: Number($('days').value) });
    pendingView(p, r.draft, page, 'Copied. Paste it into LinkedIn and send it, then come back and click Mark as sent.');
  });
  (draft ? $('text') : $('ins')).focus();
}

// ---------- someone new: add them (and their company to Inbound), then draft ----------
function guessCategory(g) {
  return /(founder|ceo|cto)/i.test(g.role) ? 'founder' : /(partner|principal|ventures|capital)/i.test(g.role + g.company) ? 'vc' : 'other';
}
function newPersonView({ guess, company }, page, mode = 'reach') {
  $('kind').textContent = 'LinkedIn profile';
  const cat = $('cat') ? $('cat').value : guessCategory(guess);
  main.innerHTML = `<div class="muted">Not in your vault yet.</div>
    <div class="seg"><button data-mode="reach" aria-pressed="${mode === 'reach'}">I want to reach out</button><button data-mode="sent" aria-pressed="${mode === 'sent'}">Already messaged</button></div>
    <div class="two"><label>Name<input id="name" value="${esc(guess.name)}"></label><label>Company<input id="co" value="${esc(guess.company)}"></label></div>
    <label>Role<input id="role" value="${esc(guess.role)}"></label>
    ${mode === 'sent' ? '<label>What you sent (one line)<textarea id="note" placeholder="e.g. Cold intro re: their launch, asked for 20 min"></textarea></label>' : ''}
    <div class="two"><label>Category<select id="cat">${CATS.map(([k, l]) => `<option value="${k}" ${k === cat ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Follow up every<select id="days">${dayOpts(7)}</select></label></div>
    <div id="coLine"></div>
    <button class="li" id="go">${mode === 'reach' ? 'Add & draft a message' : 'Log message'}</button>`;
  main.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => newPersonView({ guess: { ...guess, name: v('name'), company: v('co'), role: v('role') }, company }, page, b.dataset.mode); });
  const as = mode === 'reach' ? 'Pursuing' : 'Reached out';
  const coLine = () => {
    const co = v('co');
    const known = company && co.toLowerCase() === (guess.company || '').toLowerCase() ? company : null;
    const on = $('cat').value === 'founder' ? 'checked' : '';
    if (known && known.kind === 'company') $('coLine').innerHTML = `<div class="muted">${esc(known.name)} is already in Companies.</div>`;
    else if (known) $('coLine').innerHTML = mode === 'reach'
      ? `<label class="check"><input type="checkbox" id="addCo" ${on}> Add ${esc(v('name') || 'them')} to ${esc(known.name)}'s team in Inbound (${esc(known.status)})</label>`
      : `<div class="muted">${esc(known.name)} is in Inbound (${esc(known.status)}); it moves to Reached out.</div>`;
    else $('coLine').innerHTML = co ? `<label class="check"><input type="checkbox" id="addCo" ${on}> Add ${esc(co)} to Inbound as ${as}</label>` : '';
  };
  $('co').addEventListener('input', coLine); $('cat').addEventListener('change', coLine); coLine();
  const body = () => ({ name: v('name'), role: v('role'), company: v('co'), linkedin: guess.linkedin || page.profileUrl || page.url,
    category: $('cat').value, days: Number($('days').value), addCompany: !!($('addCo') && $('addCo').checked) });
  $('go').onclick = e => busy(e.target, async () => {
    if (!v('name')) throw new Error('Add their name.');
    if (mode === 'sent') {
      if (!v('note')) throw new Error('Add a line about what you sent.');
      const r = await post('/log-person', { ...body(), note: v('note') });
      return done('Logged', `Added a page for ${v('name')} · next nudge ${fmt(r.next)}`);
    }
    const r = await post('/add-prospect', body());
    const info = await post('/lookup', { url: guess.linkedin || page.profileUrl || page.url, name: v('name') });
    if (info.kind !== 'person') return done('Added', v('name'));
    const where = r.inbound ? ` · ${r.inbound.name} ${r.inbound.created ? 'added to' : 'is in'} Inbound as ${r.inbound.status}` : '';
    personTabs(info.person, page, 'draft', `Added to your vault${where}.`);
  });
  (mode === 'sent' ? $('note') : $('go')).focus();
}

// ---------- companies: websites and LinkedIn company pages ----------
const STATUS_OPTS = [['new', 'New (just track it)'], ['pursuing', 'Pursuing (want to reach out)']];
const HOWS = ['Outbound', 'Email', 'Text', 'Intro', 'Event', 'Told to track'];
const isoIn = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
function reachField(val) {
  return `<label>Reach out on (optional)<div class="two-btn" style="grid-template-columns:1fr auto auto auto"><input type="date" id="reach" value="${esc(val || '')}">${[['1m', 30], ['3m', 91], ['6m', 182]].map(([l, n]) => `<button type="button" data-in="${isoIn(n)}">${l}</button>`).join('')}</div></label>`;
}
function wireReach() { main.querySelectorAll('[data-in]').forEach(b => { b.onclick = () => { $('reach').value = b.dataset.in; }; }); }
const isLiCompany = page => /linkedin\.com\/company\//i.test(page.url);
function inboundFields(withName, guess, page) {
  const how = isLiCompany(page) ? 'Outbound' : 'Email';
  return `${withName ? `<div class="two"><label>Company<input id="name" value="${esc(guess.name)}"></label><label>Website<input id="web" value="${esc((guess.website || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}" placeholder="acme.com"></label></div>` : ''}
    <div class="two"><label>Referred by<input id="ref" placeholder="Firm - Person, or blank"></label>
    <label>How<select id="how">${HOWS.map(h => `<option ${h === how ? 'selected' : ''}>${h}</option>`).join('')}</select></label></div>
    <label>Note<input id="note" placeholder="One line: why it's interesting, or the ask"></label>
    ${withName ? '<label>Raise (optional)<input id="raise" placeholder="$3M seed"></label>' : ''}`;
}
function companyView({ match }, page) {
  $('kind').textContent = isLiCompany(page) ? 'LinkedIn company' : 'Company site';
  const inInbound = match.kind === 'inbound';
  main.innerHTML = `<div class="who"><b>${esc(match.name)}</b><span class="muted">Already in ${inInbound ? `Inbound · ${esc(match.status)}` : 'Companies'}</span></div>
    ${match.description ? `<div class="note">${esc(match.description)}</div>` : ''}
    ${inInbound && ['new', 'no-reply', 'passed'].includes(match.status) ? `<label class="check"><input type="checkbox" id="pursue" ${match.status === 'new' ? 'checked' : ''}> Move to Pursuing (I want to reach out)</label>` : ''}
    ${inboundFields(false, {}, page)}
    ${inInbound ? reachField(match.reach_out_on) : ''}
    <button class="primary" id="go">Add touch</button>
    ${inInbound ? '<div class="muted">To reach out to a founder, open their LinkedIn profile and click Brain Desk there.</div>' : ''}`;
  $('go').onclick = e => busy(e.target, async () => {
    const pursue = $('pursue') && $('pursue').checked;
    await post('/add-inbound', { name: match.name, website: page.website || (isLiCompany(page) ? '' : page.url), referred_by: v('ref'), how: v('how'), note: v('note'), setStatus: pursue ? 'pursuing' : '', reach_out_on: v('reach') });
    done(pursue ? 'Moved to Pursuing' : 'Touch added', `${match.name} · ${inInbound ? 'Inbound' : 'Companies'}${v('reach') ? ' · reach out ' + fmt(v('reach')) : ''}`);
  });
  wireReach();
}
function newCompanyView({ guess }, page) {
  $('kind').textContent = isLiCompany(page) ? 'LinkedIn company' : 'Company site';
  main.innerHTML = `<div class="muted">Not in your vault yet.</div>
    ${guess.description ? `<div class="note">${esc(guess.description)}</div>` : ''}
    ${inboundFields(true, guess, page)}
    <label>Status<select id="status">${STATUS_OPTS.map(([k, l]) => `<option value="${k}" ${k === (isLiCompany(page) ? 'pursuing' : 'new') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${reachField('')}
    <button class="primary" id="go">Add to Inbound</button>`;
  wireReach();
  $('go').onclick = e => busy(e.target, async () => {
    if (!v('name')) throw new Error('Add the company name.');
    await post('/add-inbound', { name: v('name'), website: v('web'), referred_by: v('ref'), how: v('how'), note: v('note'), raise: v('raise'), status: $('status').value, reach_out_on: v('reach') });
    done('Added to Inbound', `${v('name')} · ${$('status').value === 'pursuing' ? 'Pursuing' : 'New'}${v('reach') ? ' · reach out ' + fmt(v('reach')) : ''}`);
  });
  (v('name') ? $('note') : $('name')).focus();
}
function unknownView() {
  $('kind').textContent = '';
  main.innerHTML = `<div class="note">Open a <b>LinkedIn profile</b> to add someone you want to reach out to, draft a message, or log one. Open a <b>company's website</b> or <b>LinkedIn company page</b> to add it to Inbound.</div>`;
}

run();
