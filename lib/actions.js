// Every change the app can make, shared by the window (IPC) and the Chrome
// button (local server). Each action writes the vault, queues a git commit,
// and records a line in the app's activity feed.
'use strict';
const fs = require('fs');
const path = require('path');
const { Vault, today, addDays, CATEGORIES, CHANNELS, INBOUND_STATUSES, linkedinSlug } = require('./vault');
const claude = require('./claude');

class Store {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { this.data = {}; }
    this.data.drafts = this.data.drafts || {};
    this.data.activity = this.data.activity || [];
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
}

const channelLabel = c => (c === 'email' ? 'email' : 'LinkedIn');

class Actions {
  constructor({ vaultRoot, store, gitQueue, onChange, autoEnrich = false }) {
    this.vault = new Vault(vaultRoot);
    this.autoEnrich = autoEnrich; // enrich new Inbound notes in the background
    this.enriching = new Set();
    this.store = store;
    this.git = gitQueue;
    this.onChange = onChange || (() => {});
  }

  done(files, commit, activity) {
    if (files && files.length && this.git) this.git.add(files, commit);
    if (activity) {
      const a = this.store.data.activity;
      a.unshift({ ts: new Date().toISOString(), text: activity });
      a.length = Math.min(a.length, 60);
      this.store.save();
    }
    this.onChange();
  }

  snapshot() {
    const data = this.vault.load();
    // drop drafts whose note has disappeared
    const drafts = this.store.data.drafts;
    for (const k of Object.keys(drafts)) if (!data.people.find(p => p.id === k)) delete drafts[k];
    return { ...data, drafts, activity: this.store.data.activity.slice(0, 25), git: this.git ? this.git.status : null,
      enriching: [...this.enriching], themes: this.vault.knownThemes() };
  }

  person(id) {
    const p = this.vault.load().people.find(x => x.id === id);
    if (!p) throw new Error(`No note at ${id}`);
    return p;
  }

  linkedInbound(p, data = this.vault.load()) {
    if (!p.company) return null;
    const m = this.vault.findCompany(p.company, '', data);
    return m && m.kind === 'inbound' ? m.rec : null;
  }

  // ---------- drafting ----------
  async draft(id, { instructions = '' } = {}) {
    const p = this.person(id);
    const kind = p.owe ? 'reply' : p.lastOut ? 'followup' : 'first';
    const data = this.vault.load();
    const m = p.company ? this.vault.findCompany(p.company, '', data) : null;
    const prompt = claude.draftPrompt({ person: p, kind, channel: p.channel || 'linkedin', instructions, companyNote: m ? m.rec.id : '' });
    const text = await claude.run(this.vault.root, prompt);
    return { text, kind };
  }

  saveDraft(id, { text, cadence }) {
    const p = this.person(id);
    this.store.data.drafts[id] = { text, cadence: Number(cadence) || p.cadence || 7, channel: p.channel || 'linkedin', createdAt: today() };
    this.store.save();
    this.done([], null, `Drafted a message to ${p.name}, waiting for you to send it`);
    return this.store.data.drafts[id];
  }

  discardDraft(id) {
    delete this.store.data.drafts[id];
    this.store.save();
    this.onChange();
  }

  // Log a message as sent: the outreach log, dates, and the company's Inbound status.
  logSent(id, { text, cadence, channel, source = 'app' } = {}) {
    const p = this.person(id);
    const draft = this.store.data.drafts[id];
    const body = (text || (draft && draft.text) || '').trim();
    if (!body) throw new Error('Nothing to log: add a line about what you sent.');
    const ch = channel || (draft && draft.channel) || p.channel || 'linkedin';
    const cad = Number(cadence) || (draft && draft.cadence) || p.cadence || 7;
    const t = today();
    const wasReply = p.owe;
    const short = body.length > 220 ? body.slice(0, 217).trimEnd() + '…' : body;
    const files = this.vault.updatePerson(id, {
      channel: p.channel || ch, cadence_days: cad, last_outbound: t, next_follow_up: addDays(t, cad),
    }, { dir: 'out', channel: ch, text: (wasReply ? 'Replied: ' : '') + short });
    delete this.store.data.drafts[id];
    this.store.save();
    let extra = '';
    const ib = this.linkedInbound(p);
    if (ib) {
      // the company's note records the outreach: touch line, the person on its Team, and the status
      const flip = ['new', 'pursuing'].includes(ib.status);
      const ch2 = { last_touch: t, ...(flip ? { status: 'reached-out' } : {}), ...(flip && ib.reach_out_on ? { reach_out_on: '' } : {}) };
      files.push(...this.vault.updateInbound(ib.id, ch2, `${t}, Derek: ${wasReply ? 'replied to' : 'messaged'} [[${p.name}]] on ${channelLabel(ch)}`));
      this.vault.addTeamMember(ib.id, { role: p.role || 'Founder', name: p.name, linkedin: p.linkedin, link: true });
      extra = flip ? `; ${ib.name} moved to Reached out` : `; logged on ${ib.name}`;
    }
    this.done(files, `[file] ${p.name} — outreach logged`, `Logged a ${channelLabel(ch)} message to ${p.name}${source === 'chrome' ? ' from the Chrome button' : ''}${extra}`);
    return { next: addDays(t, cad) };
  }

  logReply(id, { note: text, channel } = {}) {
    const p = this.person(id);
    if (!text) throw new Error('Add a line about what they said.');
    const ch = channel || p.channel || 'linkedin';
    const files = this.vault.updatePerson(id, { last_inbound: today(), next_follow_up: '' }, { dir: 'in', channel: ch, text });
    this.done(files, `[file] ${p.name} — reply logged`, `${p.name} replied: ${text}`);
  }

  snooze(id, days) {
    const p = this.person(id);
    const next = addDays(today(), Number(days));
    this.done(this.vault.updatePerson(id, { next_follow_up: next }), `[file] ${p.name} — follow-up moved`, `Moved ${p.name}'s follow-up to ${next}`);
    return { next };
  }

  closeOut(id) {
    const p = this.person(id);
    const files = this.vault.updatePerson(id, { next_follow_up: '' }, { dir: 'note', channel: 'app', text: 'Closed out, no more follow-ups' });
    delete this.store.data.drafts[id]; this.store.save();
    this.done(files, `[file] ${p.name} — closed out`, `Closed out ${p.name}`);
  }

  setupOutreach(id, { category, channel, cadence }) {
    const p = this.person(id);
    if (category && !CATEGORIES.includes(category)) throw new Error('Unknown category');
    if (channel && !CHANNELS.includes(channel)) throw new Error('Unknown channel');
    const ch = {};
    if (category) ch.category = category;
    if (channel) ch.channel = channel;
    if (cadence) ch.cadence_days = Number(cadence);
    if (!p.next && !p.lastOut) ch.next_follow_up = today();
    this.done(this.vault.updatePerson(id, ch), `[file] ${p.name} — outreach set up`, `Set up outreach for ${p.name}`);
  }

  // Create (or reuse) a person and optionally log a message already sent.
  addPerson({ name, role, company, linkedin, email, category = 'other', channel = 'linkedin', cadence = 7, note: sent, relationship, source = 'app' }) {
    const data = this.vault.load();
    let p = this.vault.findPerson({ linkedin, name, email }, data);
    const files = [];
    let created = false;
    if (!p) {
      const rel = this.vault.createPerson({ name, role, company, linkedin, email, category, channel, cadence, relationship });
      files.push(rel); created = true;
      p = this.person(rel);
    } else {
      const ch = {};
      if (!p.category && category) ch.category = category;
      if (!p.channel && channel) ch.channel = channel;
      if (!p.cadence && cadence) ch.cadence_days = Number(cadence);
      if (!p.linkedin && linkedin) ch.linkedin = linkedin;
      if (Object.keys(ch).length) files.push(...this.vault.updatePerson(p.id, ch));
    }
    if (sent) {
      if (files.length) this.git && this.git.add(files, `[file] ${name} — person page`);
      this.logSent(p.id, { text: sent, cadence, channel, source });
    } else {
      if (!p.next && !p.lastOut) files.push(...this.vault.updatePerson(p.id, { next_follow_up: today() }));
      this.done(files, `[file] ${p.name} — ${created ? 'person page' : 'outreach set up'}`, `${created ? 'Added' : 'Updated'} ${p.name}${source === 'chrome' ? ' from the Chrome button' : ''}`);
    }
    return { id: p.id, created };
  }

  // ---------- inbound ----------
  addInbound({ name, website, referred_by = '', how = 'Email', note: line = '', raise = '', deck_link = '', status = 'new', setStatus = '', team = [], reach_out_on = '', enrich, source = 'app' }) {
    if (!name) throw new Error('Company name is required');
    if (!INBOUND_STATUSES.includes(status) || (setStatus && !INBOUND_STATUSES.includes(setStatus))) throw new Error('Unknown status');
    if (reach_out_on && !/^\d{4}-\d{2}-\d{2}$/.test(reach_out_on)) throw new Error('Use a date like 2027-03-01');
    const t = today();
    const [firm, person] = referred_by.includes(' - ') ? referred_by.split(' - ') : ['', referred_by];
    const who = referred_by ? (firm ? `${person.trim()} (${firm.trim()})` : person.trim()) : 'Derek';
    const verb = { outbound: 'found it', email: 'emailed', text: 'texted', intro: 'intro', event: 'met at an event', 'told to track': 'told to track' }[String(how || '').toLowerCase()] || String(how || '').toLowerCase();
    const what = [verb, line].filter(Boolean).join(' — ') || 'resurfaced';
    const touch = `${t}, ${who}: ${what}${raise ? `; raise ${raise}` : ''}`;
    const match = this.vault.findCompany(name, website);
    if (match) {
      let files;
      if (match.kind === 'inbound') {
        const ch = { last_touch: t };
        if (raise && !match.rec.raise) ch.raise = raise;
        if (deck_link && !match.rec.deck_link) ch.deck_link = deck_link;
        if (setStatus && setStatus !== match.rec.status) ch.status = setStatus;
        if (reach_out_on) ch.reach_out_on = reach_out_on;
        files = this.vault.updateInbound(match.rec.id, ch, touch);
      } else {
        files = this.vault.addCompanyTouch(match.rec.id, touch);
      }
      this.done(files, `[file] ${match.rec.name} — new touch`, `Added a touch to ${match.rec.name}${source === 'chrome' ? ' from the Chrome button' : ''}`);
      return { id: match.rec.id, existed: match.kind };
    }
    const rel = this.vault.createInbound({ name, website, referred_by, raise, deck_link, round_status: raise ? 'raising' : '', status, touch, team, reach_out_on });
    this.done([rel], `[file] Inbound quick-add — ${name}`, `Added ${name} to Inbound${source === 'chrome' ? ' from the Chrome button' : ''}`);
    const enriching = this.autoEnrich && enrich !== false;
    if (enriching) this.enrichLater(rel);
    return { id: rel, existed: null, enriching };
  }

  setInboundStatus(id, status) {
    if (!INBOUND_STATUSES.includes(status)) throw new Error('Unknown status');
    const rec = this.vault.load().inbound.find(x => x.id === id);
    if (!rec) throw new Error(`No note at ${id}`);
    if (rec.status === status) return;
    const ch = { status };
    if (status === 'reached-out' && rec.reach_out_on) ch.reach_out_on = '';
    this.done(this.vault.updateInbound(id, ch), `[file] ${rec.name} — status ${status}`, `${rec.name} → ${status}`);
  }

  // Hand edits from the drawer. Only these fields; themes must be in the vault's registry.
  editInbound(id, fields = {}) {
    const rec = this.vault.load().inbound.find(x => x.id === id);
    if (!rec) throw new Error(`No note at ${id}`);
    const EDITABLE = ['website', 'description', 'referred_by', 'round_status', 'raise', 'valuation', 'lead', 'deck_link', 'themes'];
    const ch = {};
    for (const k of EDITABLE) {
      if (!(k in fields)) continue;
      if (k === 'themes') {
        const list = (Array.isArray(fields.themes) ? fields.themes : String(fields.themes || '').split(/[,\s]+/)).map(t => t.trim()).filter(Boolean);
        const known = this.vault.knownThemes(), bad = list.filter(t => !known.includes(t));
        if (bad.length) throw new Error(`Unknown theme: ${bad.join(', ')}. Themes come from the table in VAULT_SCHEMA.md.`);
        if (list.join(',') !== rec.themes.join(',')) ch.themes = [...new Set(list)];
        continue;
      }
      const v = String(fields[k] ?? '').replace(/\s+/g, ' ').trim();
      if (k === 'round_status' && v && !['tracking', 'raising'].includes(v)) throw new Error('Round status is tracking, raising or blank');
      if (v !== (rec[k] || '')) ch[k] = v;
    }
    let what;
    if ('whatItIs' in fields && String(fields.whatItIs || '').trim() !== rec.whatItIs.trim()) what = String(fields.whatItIs || '').trim();
    if (!Object.keys(ch).length && what === undefined) return { changed: [] };
    const changed = [...Object.keys(ch), ...(what !== undefined ? ['what it is'] : [])];
    this.done(this.vault.editInbound(id, ch, what), `[file] ${rec.name} — edited ${changed.join(', ')}`, `Edited ${rec.name}: ${changed.join(', ')}`);
    return { changed };
  }

  // Look the company up in Specter (via headless Claude) and fill what's blank:
  // website, description, What it is, themes (added), founders on the Team.
  async enrich(id) {
    if (this.enriching.has(id)) throw new Error('Already enriching this one');
    const rec0 = this.vault.load().inbound.find(x => x.id === id);
    if (!rec0) throw new Error(`No note at ${id}`);
    this.enriching.add(id); this.onChange();
    try {
      const out = await claude.run(this.vault.root, claude.enrichPrompt(id), { allowTools: [...claude.SPECTER_TOOLS, 'WebSearch', 'WebFetch'], maxTurns: 14, timeoutMs: 240000 });
      const j = claude.parseJson(out);
      if (!j.found) { this.done([], null, `Couldn't find ${rec0.name} in Specter or on the web`); return { found: false, changed: [] }; }
      const rec = this.vault.load().inbound.find(x => x.id === id); // re-read: the note may have changed meanwhile
      if (!rec) throw new Error('The note was moved while enriching');
      const ch = {}, changed = [];
      const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
      if (!rec.website && /^https?:\/\//.test(clean(j.website))) { ch.website = clean(j.website); changed.push('website'); }
      if (!rec.description && clean(j.description)) { ch.description = clean(j.description); changed.push('description'); }
      const known = this.vault.knownThemes();
      const themes = [...new Set([...rec.themes, ...(j.themes || []).filter(t => known.includes(t))])];
      if (themes.length > rec.themes.length) { ch.themes = themes; changed.push('themes'); }
      const what = !rec.whatItIs.trim() && clean(j.what_it_is) ? clean(j.what_it_is) : undefined;
      if (what) changed.push('what it is');
      let files = [];
      if (Object.keys(ch).length || what) files = this.vault.editInbound(id, ch, what);
      let added = 0;
      for (const m of (j.team || []).slice(0, 4)) {
        if (!clean(m.name)) continue;
        const li = /linkedin\.com\/in\//i.test(m.linkedin || '') ? cleanLinkedin(m.linkedin) : '';
        const f = this.vault.addTeamMember(id, { role: clean(m.role) || 'Founder', name: clean(m.name), linkedin: li });
        if (f.length) { added++; files = [...new Set([...files, ...f])]; }
      }
      if (added) changed.push(`${added} on the team`);
      this.done(files, `[file] ${rec.name} — enriched (Specter)`, changed.length ? `Enriched ${rec.name}: ${changed.join(', ')}` : `Enriched ${rec.name}: nothing blank to fill`);
      return { found: true, changed };
    } finally {
      this.enriching.delete(id); this.onChange();
    }
  }

  enrichLater(id) {
    this.enrich(id).catch(e => this.done([], null, `Couldn't enrich ${id.replace(/^Inbound\/|\.md$/g, '')}: ${e.message}`));
  }

  // The date Derek wants to reach out to a company he's tracking for later ('' clears it).
  setReachOut(id, date) {
    const d = String(date || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Use a date like 2027-03-01');
    const rec = this.vault.load().inbound.find(x => x.id === id);
    if (!rec) throw new Error(`No note at ${id}`);
    if ((rec.reach_out_on || '') === d) return;
    this.done(this.vault.updateInbound(id, { reach_out_on: d }), `[file] ${rec.name} — reach out ${d || 'date cleared'}`, d ? `Reach out to ${rec.name} on ${d}` : `Cleared the reach-out date for ${rec.name}`);
  }

  // deal_sheet on an Inbound or Companies note: true/'yes' queues it, false/'' removes it.
  setDealSheet(id, on) {
    const data = this.vault.load();
    const rec = data.inbound.find(x => x.id === id) || data.companies.find(x => x.id === id);
    if (!rec) throw new Error(`No note at ${id}`);
    const v = on === true || on === 'yes' ? 'yes' : '';
    const verb = v ? (rec.deal_sheet === 'sent' ? 're-queued for' : 'queued for') : 'removed from';
    this.done(this.vault.updateInbound(id, { deal_sheet: v }), `[file] ${rec.name} — deal_sheet ${v || 'cleared'}`, `${rec.name} ${verb} the deal sheet`);
  }

  addTouch(id, line) {
    const rec = this.vault.load().inbound.find(x => x.id === id);
    if (!rec) throw new Error(`No note at ${id}`);
    const t = today();
    this.done(this.vault.updateInbound(id, { last_touch: t }, `${t}, Derek: ${line}`), `[file] ${rec.name} — new touch`, `Added a touch to ${rec.name}`);
  }

  // Start outreach to someone on an Inbound note's team.
  startOutreach(inboundId, member) {
    const rec = this.vault.load().inbound.find(x => x.id === inboundId);
    if (!rec) throw new Error(`No note at ${inboundId}`);
    const res = this.addPerson({
      name: member.name, role: member.role, company: rec.name, linkedin: member.linkedin, email: member.email,
      category: 'founder', channel: member.linkedin || !member.email ? 'linkedin' : 'email', cadence: 7,
      relationship: `Inbound${rec.referred_by ? ', referred by ' + rec.referred_by : ''}`,
    });
    return res;
  }

  // ---------- Chrome button ----------
  lookup({ url = '', name = '', headline = '', siteName = '', website = '', description = '' }) {
    const data = this.vault.load();
    if (/linkedin\.com\/company\//i.test(url)) {
      const guessName = (siteName || '').trim();
      if (!guessName && !website) return { kind: 'unknown' };
      const m = this.vault.findCompany(guessName, website, data);
      if (m) return { kind: 'company', match: { id: m.rec.id, name: m.rec.name, kind: m.kind, status: m.rec.status, description: m.rec.description || '', reach_out_on: m.rec.reach_out_on || '' } };
      return { kind: 'new-company', guess: { name: guessName, website, description } };
    }
    if (/linkedin\.com\/in\//i.test(url) || (/linkedin\.com\/messaging/i.test(url) && name)) {
      const slugUrl = linkedinSlug(url) ? url : '';
      const p = this.vault.findPerson({ linkedin: slugUrl, name }, data);
      if (p) {
        const draft = this.store.data.drafts[p.id] || null;
        const state = p.owe ? 'owe' : p.next ? 'waiting' : p.lastOut ? 'closed' : 'new';
        const draftKind = p.owe ? 'reply' : p.lastOut ? 'followup' : 'first';
        return { kind: 'person', person: { id: p.id, name: p.name, role: p.role, company: p.company, lastOut: p.lastOut, next: p.next, due: !!p.next && p.next <= data.today, cadence: p.cadence || 7, state, draftKind, linkedinMissing: !p.linkedin }, draft };
      }
      const parsed = parseHeadline(headline);
      const companyMatch = parsed.company ? this.vault.findCompany(parsed.company, '', data) : null;
      return { kind: 'new-person', guess: { name, role: parsed.role, company: parsed.company, linkedin: slugUrl ? cleanLinkedin(slugUrl) : '' },
        company: companyMatch ? { name: companyMatch.rec.name, kind: companyMatch.kind, status: companyMatch.rec.status } : null,
        // every company in the vault, so the popup can match and spell-check what's typed
        companies: [...data.inbound.map(c => ({ name: c.name, aliases: c.aliases, kind: 'inbound', status: c.status })),
          ...data.companies.map(c => ({ name: c.name, aliases: c.aliases, kind: 'company', status: c.status }))] };
    }
    if (/^https?:/i.test(url) && !/linkedin\.com|google\.com|mail\.|outlook\./i.test(url)) {
      const guessName = (siteName || '').trim();
      const m = this.vault.findCompany(guessName, url, data);
      if (m) return { kind: 'company', match: { id: m.rec.id, name: m.rec.name, kind: m.kind, status: m.rec.status, description: m.rec.description || '', reach_out_on: m.rec.reach_out_on || '' } };
      return { kind: 'new-company', guess: { name: guessName, website: url } };
    }
    return { kind: 'unknown' };
  }

  // A LinkedIn profile from the Chrome button: someone Derek wants to reach out to.
  // Creates their People page (due today) and puts the company in Inbound as Pursuing.
  chromeAddProspect({ name, role, company, linkedin, category = 'founder', days = 7, addCompany }) {
    if (!name) throw new Error('Add their name.');
    const li = cleanLinkedin(linkedin);
    let inbound = null;
    if (addCompany && company) {
      const m = this.vault.findCompany(company, '');
      const member = { role: role || 'Founder', name, linkedin: li };
      const t = today();
      if (!m) {
        this.addInbound({ name: company, status: 'pursuing', how: '', note: `want to reach out to ${name}`, team: [member], source: 'chrome' });
        inbound = { name: company, status: 'pursuing', created: true };
      } else if (m.kind === 'inbound') {
        const ch = { last_touch: t };
        if (m.rec.status === 'new') ch.status = 'pursuing';
        const files = [...this.vault.updateInbound(m.rec.id, ch, `${t}, Derek: want to reach out to ${name}`), ...this.vault.addTeamMember(m.rec.id, member)];
        this.done([...new Set(files)], `[file] ${m.rec.name} — outreach planned`, `Added ${name} to ${m.rec.name}'s team from the Chrome button`);
        inbound = { name: m.rec.name, status: ch.status || m.rec.status, created: false };
      }
    }
    const r = this.addPerson({ name, role, company, linkedin: li, category, channel: 'linkedin', cadence: Number(days) || 7, relationship: 'Outbound (LinkedIn)', source: 'chrome' });
    return { id: r.id, created: r.created, inbound };
  }

  // Draft from the Chrome button. The result is saved as a pending draft right
  // away, so closing the popup mid-draft loses nothing.
  async chromeDraft({ id, instructions = '', days }) {
    const { text, kind } = await this.draft(id, { instructions });
    const draft = this.saveDraft(id, { text, cadence: days });
    return { text, kind, draft };
  }

  chromeSaveDraft({ id, text, days }) {
    if (!String(text || '').trim()) throw new Error('The draft is empty.');
    return { draft: this.saveDraft(id, { text: String(text).trim(), cadence: days }) };
  }

  // A LinkedIn profile from the Chrome button: confirm a pending draft, or log a message written on LinkedIn.
  chromeLogPerson({ id, name, role, company, linkedin, category, note: sent, days, addCompany }) {
    let personId = id;
    if (personId) {
      if (linkedin && !this.person(personId).linkedin) this.vault.updatePerson(personId, { linkedin: cleanLinkedin(linkedin) });
      this.logSent(personId, { text: sent, cadence: days, channel: 'linkedin', source: 'chrome' });
    } else {
      if (addCompany && company && !this.vault.findCompany(company, '')) {
        this.addInbound({ name: company, status: 'reached-out', how: '', note: `messaged ${name} on LinkedIn`, team: [{ role: role || 'Founder', name, linkedin: cleanLinkedin(linkedin) }], source: 'chrome' });
      }
      personId = this.addPerson({ name, role, company, linkedin: cleanLinkedin(linkedin), category, channel: 'linkedin', cadence: days, note: sent, relationship: 'Outbound (LinkedIn)', source: 'chrome' }).id;
    }
    return { id: personId, next: this.person(personId).next };
  }
}

function cleanLinkedin(u) {
  const m = String(u || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : '';
}
function parseHeadline(h) {
  const s = String(h || '').trim();
  const m = s.match(/^(.*?)\s+(?:at|@)\s+([^|·,]+)/i);
  if (m) return { role: m[1].trim(), company: m[2].trim() };
  return { role: s.split('|')[0].trim(), company: '' };
}

module.exports = { Actions, Store, cleanLinkedin };
