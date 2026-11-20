// The vault model: loads People/, Inbound/ and Companies/ notes and writes
// the outreach and inbound changes the app makes. Every write returns the
// vault-relative paths it touched so the git queue can commit exactly those.
'use strict';
const fs = require('fs');
const path = require('path');
const note = require('./note');

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

// They replied and Derek hasn't answered. Same-day ties go to whichever was logged last.
function owes(lastOut, lastIn, log) {
  if (!lastIn) return false;
  if (!lastOut || lastIn > lastOut) return true;
  if (lastIn < lastOut) return false;
  const lastDir = log.filter(l => l.dir !== 'note').map(l => l.dir).pop();
  return lastDir === 'in';
}

const CATEGORIES = ['founder', 'vc', 'operator', 'lp', 'other'];
const CHANNELS = ['linkedin', 'email'];
const INBOUND_STATUSES = ['new', 'pursuing', 'reached-out', 'passed', 'no-reply'];
const LOG_RE = /^(\d{4}-\d{2}-\d{2}), (out|in|note) · ([\w-]+): (.*)$/;
// Outreach to someone Derek hasn't met lives on an Inbound (or Company) note:
// these frontmatter keys name the contact; the outreach fields are the same as People's.
const CONTACT_KEYS = { name: 'contact', role: 'contact_role', category: 'contact_category', linkedin: 'contact_linkedin', email: 'contact_email' };
const OUTREACH_KEYS = ['channel', 'cadence_days', 'last_outbound', 'last_inbound', 'next_follow_up'];
const parseLog = text => note.readList(text, '## Outreach log').map(l => {
  const m = l.match(LOG_RE);
  return m ? { date: m[1], dir: m[2], channel: m[3], text: m[4] } : null;
}).filter(Boolean);
// Passed Inbound notes live in a graveyard subfolder; they're still Inbound notes.
const PASSED_DIR = 'Inbound/Passed';
const isStealth = n => /\(stealth\)\s*$/i.test(n);

const bareDomain = s => String(s || '').toLowerCase().trim()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const normName = s => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, '')
  .replace(/\b(inc|llc|ltd|corp|co|labs?|ai|hq|technologies|technology)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '');
const linkedinSlug = s => {
  const m = String(s || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, '') : '';
};
const safeFilename = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim();
const str = v => (v === undefined || v === null) ? '' : String(v);
const asList = v => Array.isArray(v) ? v.map(String) : (v ? [String(v)] : []);

class Vault {
  constructor(root) { this.root = root; }

  abs(rel) { return path.join(this.root, rel); }
  read(rel) { return fs.readFileSync(this.abs(rel), 'utf8'); }
  write(rel, text) { fs.writeFileSync(this.abs(rel), text); }
  exists(rel) { return fs.existsSync(this.abs(rel)); }

  isVault() {
    return ['People', 'Inbound', 'Companies', 'VAULT_SCHEMA.md'].every(p => this.exists(p));
  }

  readFolder(folder) {
    const dir = this.abs(folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
      const rel = `${folder}/${f}`;
      const text = this.read(rel);
      const { fm } = note.parse(text);
      let added = 0;
      try { added = fs.statSync(this.abs(rel)).birthtimeMs; } catch (_) { /* gone mid-read */ }
      return { rel, name: f.slice(0, -3), fm, text, added };
    });
  }

  // ---------- load ----------
  // Someone Derek hasn't met, tracked on an Inbound/Company note (id = that note).
  contact({ rel, name, fm, text }) {
    const log = parseLog(text);
    return {
      id: rel, unmet: true, noteName: str(fm.name) || name, noteKind: rel.startsWith('Inbound/') ? 'inbound' : 'company',
      name: str(fm.contact), role: str(fm.contact_role), company: isStealth(name) ? '' : (str(fm.name) || name),
      linkedin: str(fm.contact_linkedin), email: str(fm.contact_email), relationship: '', location: '',
      category: str(fm.contact_category), channel: str(fm.channel),
      cadence: parseInt(fm.cadence_days, 10) || 0,
      lastOut: str(fm.last_outbound), lastIn: str(fm.last_inbound), next: str(fm.next_follow_up),
      log, owe: owes(str(fm.last_outbound), str(fm.last_inbound), log), metPage: '',
    };
  }

  person({ rel, name, fm, text }) {
    const log = parseLog(text);
    return {
      id: rel, name: str(fm.name) || name, role: str(fm.role), company: str(fm.company),
      linkedin: str(fm.linkedin), email: str(fm.email), relationship: str(fm.relationship),
      location: str(fm.location),
      category: str(fm.category), channel: str(fm.channel),
      cadence: parseInt(fm.cadence_days, 10) || 0,
      lastOut: str(fm.last_outbound), lastIn: str(fm.last_inbound), next: str(fm.next_follow_up),
      log, owe: owes(str(fm.last_outbound), str(fm.last_inbound), log),
    };
  }

  inboundRec({ rel, name, fm, text, added = 0 }) {
    const team = note.readList(text, '## Team').map(l => {
      const m = l.match(/^([^:]+):\s*(.*)$/);
      if (!m) return null;
      const rest = m[2].replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1');
      const personName = rest.split(/\s[(—–-]\s?|\s\(/)[0].trim();
      if (!personName || /not stated|unknown|^n\/?a$/i.test(personName)) return null;
      const li = (rest.match(/https?:\/\/(www\.)?linkedin\.com\/in\/[^\s)·,]+/i) || [])[0] || '';
      const email = (rest.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '';
      return { role: m[1].trim(), name: personName, linkedin: li, email, raw: l };
    }).filter(Boolean);
    const whatItIs = note.readText(text, '## What it is');
    return {
      id: rel, name, website: str(fm.website), aliases: asList(fm.aliases),
      description: str(fm.description), themes: asList(fm.themes),
      status: str(fm.status) || 'new', round_status: str(fm.round_status), deal_sheet: str(fm.deal_sheet),
      referred_by: str(fm.referred_by), first_seen: str(fm.first_seen), last_touch: str(fm.last_touch),
      deck_link: str(fm.deck_link), raise: str(fm.raise), valuation: str(fm.valuation), lead: str(fm.lead),
      reach_out_on: str(fm.reach_out_on),
      team, touches: note.readList(text, '## Touches'), whatItIs, added,
    };
  }

  load() {
    const pages = this.readFolder('People').map(r => this.person(r));
    const ibRaw = [...this.readFolder('Inbound'), ...this.readFolder(PASSED_DIR)].filter(r => r.fm.type === 'inbound');
    const coRaw = this.readFolder('Companies');
    const contacts = [...ibRaw, ...coRaw].filter(r => str(r.fm.contact).trim()).map(r => this.contact(r));
    for (const c of contacts) {
      const page = pages.find(p => p.name.toLowerCase() === c.name.toLowerCase());
      if (page) c.metPage = page.id; // they've met since: the history should move to the People page
    }
    const people = [...pages, ...contacts];
    const inbound = ibRaw.map(r => this.inboundRec(r));
    const companies = coRaw.map(({ rel, name, fm }) => ({
      id: rel, name, website: str(fm.website), aliases: asList(fm.aliases), status: str(fm.status),
      description: str(fm.description), deal_sheet: str(fm.deal_sheet), round_status: str(fm.round_status),
      raise: str(fm.raise), valuation: str(fm.valuation), lead: str(fm.lead), last_touch: str(fm.last_touch),
    }));
    const dealSheets = this.readFolder('Deal Sheets').filter(r => r.fm.type === 'deal-sheet').map(({ rel, name, fm }) => ({
      id: rel, name, date: str(fm.date), companies: asList(fm.companies).length, recipients: str(fm.recipients),
    })).sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
    return { people, inbound, companies, dealSheets, today: today() };
  }

  // ---------- matching ----------
  findCompany(name, website, data = this.load()) {
    const n = normName(name), d = bareDomain(website);
    const hit = c => {
      if (n && (normName(c.name) === n || c.aliases.some(a => normName(a) === n || bareDomain(a) === d && d))) return true;
      if (d && (bareDomain(c.website) === d || c.aliases.some(a => bareDomain(a) === d))) return true;
      return false;
    };
    const ib = data.inbound.find(hit);
    if (ib) return { kind: 'inbound', rec: ib };
    const co = data.companies.find(hit);
    if (co) return { kind: 'company', rec: co };
    return null;
  }

  findPerson({ linkedin, name, email }, data = this.load()) {
    const slug = linkedinSlug(linkedin);
    if (slug) { const p = data.people.find(x => linkedinSlug(x.linkedin) === slug); if (p) return p; }
    if (email) { const p = data.people.find(x => x.email && x.email.toLowerCase() === email.toLowerCase()); if (p) return p; }
    if (name) {
      const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
      return data.people.find(x => x.name.toLowerCase() === n || x.id.toLowerCase() === `people/${n}.md`);
    }
    return null;
  }

  // ---------- person writes ----------
  // Works for People pages and for contacts on Inbound/Company notes (person-style keys are mapped).
  updatePerson(rel, changes, logItem) {
    let text = this.read(rel);
    const onNote = !rel.startsWith('People/');
    if (changes && Object.keys(changes).length) {
      const ch = {};
      for (const [k, v] of Object.entries(changes)) ch[onNote && CONTACT_KEYS[k] ? CONTACT_KEYS[k] : k] = v;
      text = note.setKeys(text, ch);
    }
    if (logItem) {
      const line = `${logItem.date || today()}, ${logItem.dir} · ${logItem.channel || 'app'}: ${String(logItem.text || '').replace(/\s*\n\s*/g, ' ').trim()}`;
      const before = onNote ? (['## Touches', '## Inbound history'].find(h => text.split('\n').some(l => l.trim() === h)) || null) : '## Mentions Across Vault';
      text = note.appendToSection(text, '## Outreach log', line, { beforeHeading: before, divider: !onNote });
    }
    this.write(rel, text);
    return [rel];
  }

  createPerson({ name, role = '', company = '', linkedin = '', email = '', location = '', relationship = '', category = '', channel = '', cadence = '' }) {
    if (!name) throw new Error('A person needs a name');
    if (category && !CATEGORIES.includes(category)) throw new Error(`category must be one of ${CATEGORIES.join(', ')}`);
    if (channel && !CHANNELS.includes(channel)) throw new Error(`channel must be one of ${CHANNELS.join(', ')}`);
    const rel = `People/${safeFilename(name)}.md`;
    if (this.exists(rel)) return rel;
    const s = note.scalar;
    const companyLink = company ? `[[${company}]]` : '';
    const text = [
      '---', 'type: person', `name: ${s(name)}`, `role:${role ? ' ' + s(role) : ''}`, `company:${company ? ' ' + s(company) : ''}`,
      `linkedin:${linkedin ? ' ' + s(linkedin) : ''}`, `email:${email ? ' ' + s(email) : ''}`, `location:${location ? ' ' + s(location) : ''}`,
      `relationship:${relationship ? ' ' + s(relationship) : ''}`,
      `category:${category ? ' ' + category : ''}`, `channel:${channel ? ' ' + channel : ''}`, `cadence_days:${cadence ? ' ' + cadence : ''}`,
      'last_outbound:', 'last_inbound:', 'next_follow_up:',
      `created: ${today()}`, 'tags:', '  - person', '---', '',
      `# ${name}`, '', `**${role || 'Role'}** | ${companyLink || 'Company'}${location ? ' | ' + location : ''}`, '', '---', '',
      '## Background', '', '- ', '', '---', '',
      '## Relationship Notes', '', `- **How we know them:**${relationship ? ' ' + relationship : ''}`, '- **Warm paths:**', '- **Last interaction:**', '', '---', '',
      '## Outreach log', '', '---', '',
      '## Mentions Across Vault', '', '```dataview', 'TABLE date, type', `FROM [[${name}]]`, 'WHERE type = "meeting"', 'SORT date DESC', '```', '',
    ].join('\n');
    this.write(rel, text);
    return rel;
  }

  // Put a contact on a note (an Inbound/Company note becomes where their outreach is tracked).
  setContact(rel, { name, role = '', category = '', linkedin = '', email = '', channel = 'linkedin', cadence = 7, next = '' }) {
    const ch = { contact: name, contact_role: role, contact_category: category, contact_linkedin: linkedin, contact_email: email, channel, cadence_days: cadence };
    if (next) ch.next_follow_up = next;
    let text = note.setKeys(this.read(rel), ch);
    this.write(rel, text);
    return [rel];
  }

  // After a meeting: drop the contact, its outreach fields and log from the note.
  clearContact(rel) {
    let text = note.removeKeys(this.read(rel), [...Object.values(CONTACT_KEYS), ...OUTREACH_KEYS]);
    text = note.removeSection(text, '## Outreach log');
    this.write(rel, text);
    return [rel];
  }

  // Turn "Founder: Name (…)" into "Founder: [[Name]] (…)" on a note's Team.
  linkTeamMember(rel, name) {
    const text = this.read(rel);
    const lines = text.split('\n');
    const r = note.readList(text, '## Team');
    if (!r.length) return [];
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(- [^:]+:\s*)(.*)$/);
      if (m && m[2].startsWith(name) && !m[2].startsWith('[[')) { lines[i] = m[1] + `[[${name}]]` + m[2].slice(name.length); changed = true; break; }
    }
    if (!changed) return [];
    this.write(rel, lines.join('\n'));
    return [rel];
  }

  // File a Passed note in the graveyard, or bring it back out. Returns [old, new] paths.
  fileByStatus(rel, status) {
    const name = path.basename(rel);
    const want = status === 'passed' ? `${PASSED_DIR}/${name}` : `Inbound/${name}`;
    if (want === rel || !rel.startsWith('Inbound/')) return { id: rel, files: [] };
    if (this.exists(want)) throw new Error(`${want} already exists`);
    fs.mkdirSync(path.dirname(this.abs(want)), { recursive: true });
    fs.renameSync(this.abs(rel), this.abs(want));
    return { id: want, files: [rel, want] };
  }

  // ---------- inbound writes ----------
  updateInbound(rel, changes, touch) {
    let text = this.read(rel);
    if (changes && Object.keys(changes).length) text = note.setKeys(text, changes);
    if (touch) text = note.appendToSection(text, '## Touches', touch);
    this.write(rel, text);
    return [rel];
  }

  // Theme slugs from VAULT_SCHEMA.md's "Markets and themes" table (the hook reads the same table).
  knownThemes() {
    let t = '';
    try { t = this.read('VAULT_SCHEMA.md'); } catch (_) { return []; }
    return [...t.matchAll(/^\| `([a-z0-9-]+)` \| [^|`]+ \| (?:yes|no) \|\s*$/gm)].map(m => m[1]);
  }

  // Frontmatter edits plus, optionally, the ## What it is text.
  editInbound(rel, changes, whatItIs) {
    let text = this.read(rel);
    if (changes && Object.keys(changes).length) text = note.setKeys(text, changes);
    if (whatItIs !== undefined) text = note.setSectionText(text, '## What it is', whatItIs, '## Team');
    this.write(rel, text);
    return [rel];
  }

  // Add someone to an Inbound note's ## Team (replacing the "not stated" placeholder).
  addTeamMember(rel, { role = 'Founder', name, linkedin = '', link = false }) {
    let text = this.read(rel);
    const line = `${role}: ${link ? `[[${name}]]` : name}${linkedin ? ` (${linkedin})` : ''}`;
    const team = note.readList(text, '## Team');
    if (team.some(l => l.toLowerCase().includes(name.toLowerCase()))) return [];
    const lines = text.split('\n');
    const ph = lines.findIndex(l => /^- [^:]+:\s*(not stated|unknown)\s*$/i.test(l.trim()));
    if (ph >= 0) { lines[ph] = '- ' + line; text = lines.join('\n'); } else text = note.appendToSection(text, '## Team', line);
    this.write(rel, text);
    return [rel];
  }

  addCompanyTouch(rel, touch) {
    let text = this.read(rel);
    text = note.setKeys(text, { last_touch: today() });
    if (text.split('\n').some(l => l.trim() === '### Touches')) {
      text = note.appendToSection(text, '### Touches', touch);
    } else {
      const lines = text.split('\n');
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (!lines.some(l => l.trim() === '## Inbound history')) lines.push('', '## Inbound history');
      lines.push('', '### Touches', '', '- ' + touch, '');
      text = lines.join('\n');
    }
    this.write(rel, text);
    return [rel];
  }

  createInbound({ name, website = '', referred_by = '', raise = '', deck_link = '', round_status = '', status = 'new', touch = '', team = [], reach_out_on = '' }) {
    if (!name) throw new Error('A company needs a name');
    if (!INBOUND_STATUSES.includes(status)) throw new Error('bad status');
    const rel = `Inbound/${safeFilename(name)}.md`;
    if (this.exists(rel) || this.exists(`${PASSED_DIR}/${safeFilename(name)}.md`)) throw new Error(`${name} already has an Inbound note`);
    const s = note.scalar, t = today();
    const site = website ? (/^https?:\/\//.test(website) ? website : 'https://' + bareDomain(website)) : '';
    const text = [
      '---', 'type: inbound', `name: ${s(name)}`, 'aliases: []', `website:${site ? ' ' + site : ''}`, 'description:', 'themes: []',
      `status: ${status}`, `round_status:${round_status ? ' ' + round_status : ''}`, 'deal_sheet:',
      `referred_by:${referred_by ? ' ' + s(referred_by) : ''}`, `first_seen: ${t}`, `last_touch: ${t}`, `reach_out_on:${reach_out_on ? ' ' + reach_out_on : ''}`,
      `deck_link:${deck_link ? ' ' + s(deck_link) : ''}`, `raise:${raise ? ' ' + s(raise) : ''}`, 'valuation:', 'lead:',
      `created: ${t}`, 'tags:', '  - inbound', '---', '',
      `# ${name}`, '', '## What it is', '', '', '## Team',
      ...(team.length ? team.map(m => `- ${m.role}: ${m.name}${m.linkedin ? ` (${m.linkedin})` : ''}`) : ['- CEO: not stated']),
      '', '## Touches', `- ${touch || `${t}, Derek: added from Brain Desk`}`, '',
      '%% Each time the company resurfaces, add a line here; never create a second note. %%', '',
    ].join('\n');
    this.write(rel, text);
    return rel;
  }
}

module.exports = { Vault, today, addDays, bareDomain, normName, linkedinSlug, isStealth, PASSED_DIR, CATEGORIES, CHANNELS, INBOUND_STATUSES };
