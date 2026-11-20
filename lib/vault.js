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
      return { rel, name: f.slice(0, -3), fm, text };
    });
  }

  // ---------- load ----------
  person({ rel, name, fm, text }) {
    const log = note.readList(text, '## Outreach log').map(l => {
      const m = l.match(LOG_RE);
      return m ? { date: m[1], dir: m[2], channel: m[3], text: m[4] } : null;
    }).filter(Boolean);
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

  inboundRec({ rel, name, fm, text }) {
    const team = note.readList(text, '## Team').map(l => {
      const m = l.match(/^([^:]+):\s*(.*)$/);
      if (!m) return null;
      const rest = m[2];
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
      team, touches: note.readList(text, '## Touches'), whatItIs,
    };
  }

  load() {
    const people = this.readFolder('People').map(r => this.person(r));
    const inbound = this.readFolder('Inbound').filter(r => r.fm.type === 'inbound').map(r => this.inboundRec(r));
    const companies = this.readFolder('Companies').map(({ rel, name, fm }) => ({
      id: rel, name, website: str(fm.website), aliases: asList(fm.aliases), status: str(fm.status),
    }));
    return { people, inbound, companies, today: today() };
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
  updatePerson(rel, changes, logItem) {
    let text = this.read(rel);
    if (changes && Object.keys(changes).length) text = note.setKeys(text, changes);
    if (logItem) {
      const line = `${logItem.date || today()}, ${logItem.dir} · ${logItem.channel || 'app'}: ${String(logItem.text || '').replace(/\s*\n\s*/g, ' ').trim()}`;
      text = note.appendToSection(text, '## Outreach log', line, { beforeHeading: '## Mentions Across Vault', divider: true });
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

  // ---------- inbound writes ----------
  updateInbound(rel, changes, touch) {
    let text = this.read(rel);
    if (changes && Object.keys(changes).length) text = note.setKeys(text, changes);
    if (touch) text = note.appendToSection(text, '## Touches', touch);
    this.write(rel, text);
    return [rel];
  }

  // Add someone to an Inbound note's ## Team (replacing the "not stated" placeholder).
  addTeamMember(rel, { role = 'Founder', name, linkedin = '' }) {
    let text = this.read(rel);
    const line = `${role}: ${name}${linkedin ? ` (${linkedin})` : ''}`;
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

  createInbound({ name, website = '', referred_by = '', raise = '', deck_link = '', round_status = '', status = 'new', touch = '', team = [] }) {
    if (!name) throw new Error('A company needs a name');
    if (!INBOUND_STATUSES.includes(status)) throw new Error('bad status');
    const rel = `Inbound/${safeFilename(name)}.md`;
    if (this.exists(rel)) throw new Error(`${rel} already exists`);
    const s = note.scalar, t = today();
    const site = website ? (/^https?:\/\//.test(website) ? website : 'https://' + bareDomain(website)) : '';
    const text = [
      '---', 'type: inbound', `name: ${s(name)}`, 'aliases: []', `website:${site ? ' ' + site : ''}`, 'description:', 'themes: []',
      `status: ${status}`, `round_status:${round_status ? ' ' + round_status : ''}`, 'deal_sheet:',
      `referred_by:${referred_by ? ' ' + s(referred_by) : ''}`, `first_seen: ${t}`, `last_touch: ${t}`,
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

module.exports = { Vault, today, addDays, bareDomain, normName, linkedinSlug, CATEGORIES, CHANNELS, INBOUND_STATUSES };
