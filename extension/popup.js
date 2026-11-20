'use strict';
/* global chrome */
const API = 'http://127.0.0.1:47817';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('main');
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
  const out = { siteName: '', name: '', headline: '', profileUrl: '' };
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
    info = await post('/lookup', { url: page.profileUrl || page.url, name: page.name, headline: page.headline, siteName: page.siteName });
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

// ---------- a person already in the vault ----------
function personView({ person: p, draft }, page) {
  $('kind').textContent = 'LinkedIn profile';
  const head = `<div class="who"><b>${esc(p.name)}</b><span class="muted">${esc([p.role, p.company].filter(Boolean).join(' · '))}</span></div>`;
  if (draft) {
    main.innerHTML = `${head}
      <div class="draft"><b>Drafted ${esc(fmt(draft.createdAt))}</b>${esc(draft.text)}</div>
      <label>Follow up again in<select id="days">${dayOpts(draft.cadence)}</select></label>
      <button class="li" id="sent">Mark as sent</button>
      <button class="link" id="other">I sent something different</button>`;
    $('sent').onclick = e => busy(e.target, async () => {
      const r = await post('/log-person', { id: p.id, note: '', days: Number($('days').value), linkedin: p.linkedinMissing ? (page.profileUrl || page.url) : '' });
      done('Logged as sent', `Next nudge ${fmt(r.next)}`);
    });
    $('other').onclick = () => personForms(p, page, head, 'sent');
    return;
  }
  personForms(p, page, head, p.state === 'waiting' ? 'reply' : 'sent');
}
function personForms(p, page, head, tab) {
  const status = p.state === 'waiting' ? `Waiting on them · nudge ${fmt(p.next)}` : p.state === 'owe' ? 'They replied · your move' : p.lastOut ? `Last message ${fmt(p.lastOut)}` : 'Not contacted yet';
  main.innerHTML = `${head}<div class="muted">${esc(status)}</div>
    <div class="seg"><button data-tab="sent" aria-pressed="${tab === 'sent'}">I sent a message</button><button data-tab="reply" aria-pressed="${tab === 'reply'}">They replied</button></div>
    <div id="form"></div>`;
  const render = t => {
    main.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === t));
    if (t === 'sent') {
      $('form').innerHTML = `<label>What you sent (one line)<textarea id="note" placeholder="e.g. Following up on the deck"></textarea></label>
        <label>Follow up again in<select id="days">${dayOpts(p.cadence || 7)}</select></label><button class="li" id="go">Log message</button>`;
      $('go').onclick = e => busy(e.target, async () => {
        if (!$('note').value.trim()) throw new Error('Add a line about what you sent.');
        const r = await post('/log-person', { id: p.id, note: $('note').value.trim(), days: Number($('days').value), linkedin: p.linkedinMissing ? (page.profileUrl || page.url) : '' });
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

// ---------- someone new ----------
function newPersonView({ guess, company }, page) {
  $('kind').textContent = 'LinkedIn profile';
  main.innerHTML = `
    <div class="two"><label>Name<input id="name" value="${esc(guess.name)}"></label><label>Company<input id="co" value="${esc(guess.company)}"></label></div>
    <label>Role<input id="role" value="${esc(guess.role)}"></label>
    <label>What you sent (one line)<textarea id="note" placeholder="e.g. Cold intro re: their launch, asked for 20 min"></textarea></label>
    <div class="two"><label>Category<select id="cat">${CATS.map(([k, l]) => `<option value="${k}" ${k === (/(founder|ceo|cto)/i.test(guess.role) ? 'founder' : /(partner|principal|ventures|capital)/i.test(guess.role + guess.company) ? 'vc' : 'other') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Follow up in<select id="days">${dayOpts(7)}</select></label></div>
    <div id="coLine"></div>
    <button class="li" id="go">Log message</button>`;
  const coLine = () => {
    const co = $('co').value.trim();
    if (company && co.toLowerCase() === (guess.company || '').toLowerCase()) $('coLine').innerHTML = `<div class="muted">${esc(company.name)} is already in ${company.kind === 'inbound' ? 'Inbound' : 'Companies'}.</div>`;
    else $('coLine').innerHTML = co ? `<label class="check"><input type="checkbox" id="addCo" ${$('cat').value === 'founder' ? 'checked' : ''}> Also add ${esc(co)} to Inbound as Reached out</label>` : '';
  };
  $('co').addEventListener('input', coLine); $('cat').addEventListener('change', coLine); coLine();
  $('go').onclick = e => busy(e.target, async () => {
    if (!$('name').value.trim()) throw new Error('Add their name.');
    if (!$('note').value.trim()) throw new Error('Add a line about what you sent.');
    const r = await post('/log-person', { name: $('name').value.trim(), role: $('role').value.trim(), company: $('co').value.trim(), linkedin: guess.linkedin || page.profileUrl || page.url,
      category: $('cat').value, note: $('note').value.trim(), days: Number($('days').value), addCompany: !!($('addCo') && $('addCo').checked) });
    done('Logged', `Added a page for ${$('name').value.trim()} · next nudge ${fmt(r.next)}`);
  });
  $('note').focus();
}

// ---------- company websites ----------
function inboundFields(withName, guess) {
  return `${withName ? `<div class="two"><label>Company<input id="name" value="${esc(guess.name)}"></label><label>Website<input id="web" value="${esc(guess.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}"></label></div>` : ''}
    <div class="two"><label>Referred by<input id="ref" placeholder="Firm - Person"></label>
    <label>How<select id="how"><option>Email</option><option>Text</option><option>Intro</option><option>Event</option><option>Told to track</option><option>Outbound</option></select></label></div>
    <label>Note<input id="note" placeholder="One line on the ask"></label>
    ${withName ? '<label>Raise (optional)<input id="raise" placeholder="$3M seed"></label>' : ''}`;
}
const v = id => ($(id) ? $(id).value.trim() : '');
function companyView({ match }, page) {
  $('kind').textContent = 'Company site';
  main.innerHTML = `<div class="who"><b>${esc(match.name)}</b><span class="muted">Already in ${match.kind === 'inbound' ? `Inbound · ${esc(match.status)}` : 'Companies'}</span></div>
    ${match.description ? `<div class="note">${esc(match.description)}</div>` : ''}
    ${inboundFields(false)}<button class="primary" id="go">Add touch</button>`;
  $('go').onclick = e => busy(e.target, async () => {
    await post('/add-inbound', { name: match.name, website: page.url, referred_by: v('ref'), how: v('how'), note: v('note') });
    done('Touch added', `${match.name} · ${match.kind === 'inbound' ? 'Inbound' : 'Companies'}`);
  });
}
function newCompanyView({ guess }) {
  $('kind').textContent = 'Company site';
  main.innerHTML = `<div class="muted">Not in your vault yet.</div>${inboundFields(true, guess)}<button class="primary" id="go">Add to Inbound</button>`;
  $('go').onclick = e => busy(e.target, async () => {
    if (!v('name')) throw new Error('Add the company name.');
    await post('/add-inbound', { name: v('name'), website: v('web'), referred_by: v('ref'), how: v('how'), note: v('note'), raise: v('raise') });
    done('Added to Inbound', v('name'));
  });
  $('ref').focus();
}
function unknownView() {
  $('kind').textContent = '';
  main.innerHTML = `<div class="note">Open a <b>LinkedIn profile</b> to log a message or reply, or a <b>company's website</b> to add it to Inbound.</div>`;
}

run();
