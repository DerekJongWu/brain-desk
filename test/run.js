// Runs every action against a throwaway copy of the vault with a local bare
// git remote, then validates each touched note with the vault's own
// check-vocab hook. Usage: node test/run.js [/path/to/vault]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');
const { Actions, Store } = require('../lib/actions');
const { GitQueue } = require('../lib/git');
const { today, addDays } = require('../lib/vault');

const SRC = process.argv[2] || path.join(os.homedir(), 'Desktop/canaan-brain');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-desk-test-'));
const vault = path.join(tmp, 'vault'), remote = path.join(tmp, 'remote.git');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });

for (const p of ['People', 'Inbound', 'Companies', 'VAULT_SCHEMA.md', '.claude/hooks']) {
  fs.cpSync(path.join(SRC, p), path.join(vault, p), { recursive: true });
}
sh('git', ['init', '-q', '--bare', remote]);
sh('git', ['init', '-q'], vault);
sh('git', ['add', '-A'], vault);
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], vault);
sh('git', ['remote', 'add', 'origin', remote], vault);
sh('git', ['push', '-q', '-u', 'origin', 'HEAD'], vault);

const hook = file => {
  try {
    execFileSync(path.join(vault, '.claude/hooks/check-vocab.sh'), { input: JSON.stringify({ tool_input: { file_path: path.join(vault, file) } }), encoding: 'utf8' });
    return null;
  } catch (e) { return e.stderr; }
};

(async () => {
  const git = new GitQueue(vault, { delayMs: 50 });
  const touched = new Set();
  const origAdd = git.add.bind(git);
  git.add = (files, msg) => { files.forEach(f => touched.add(f)); origAdd(files, msg); };
  const A = new Actions({ vaultRoot: vault, store: new Store(path.join(tmp, 'state.json')), gitQueue: git });
  const T = today();
  let snap = A.snapshot();
  console.log(`loaded ${snap.people.length} people, ${snap.inbound.length} inbound, ${snap.companies.length} companies`);
  assert(snap.people.length > 0 && snap.inbound.length > 0);

  // existing person: set up outreach, draft, mark sent
  const p0 = snap.people.find(p => p.name === 'Ben Colman') || snap.people[0];
  A.setupOutreach(p0.id, { category: 'founder', channel: 'linkedin', cadence: 5 });
  A.saveDraft(p0.id, { text: 'Hi Ben: checking in on the deck #followup', cadence: 5 });
  assert(A.lookup({ url: 'https://www.linkedin.com/in/nobody-xyz/', name: p0.name }).draft, 'lookup by name finds pending draft');
  A.logSent(p0.id, {});
  let p = A.person(p0.id);
  assert.equal(p.lastOut, T); assert.equal(p.next, addDays(T, 5)); assert.equal(p.cadence, 5);
  assert.equal(p.log.at(-1).dir, 'out'); assert(p.log.at(-1).text.includes('checking in'));
  assert(!A.store.data.drafts[p0.id], 'draft cleared after send');
  A.logReply(p0.id, { note: 'Sent the deck: wants to meet Tuesday' });
  p = A.person(p0.id); assert.equal(p.lastIn, T); assert.equal(p.next, '');
  A.snooze(p0.id, 3); assert.equal(A.person(p0.id).next, addDays(T, 3));
  A.closeOut(p0.id); assert.equal(A.person(p0.id).next, '');

  // new person with a message, plus a new Inbound company (Chrome path)
  const r = A.chromeLogPerson({ name: 'Test Founder', role: 'CEO', company: 'Zzyzx Robotics', linkedin: 'https://www.linkedin.com/in/test-founder-123/?x=1', category: 'founder', note: 'Cold intro: liked the launch', days: 7, addCompany: true });
  p = A.person(r.id); assert.equal(p.linkedin, 'https://www.linkedin.com/in/test-founder-123'); assert.equal(p.next, addDays(T, 7));
  const z = A.vault.load().inbound.find(x => x.name === 'Zzyzx Robotics'); assert(z && z.status === 'reached-out', 'company added as reached-out');
  assert.equal(A.lookup({ url: 'https://www.linkedin.com/in/test-founder-123' }).person.state, 'waiting');

  // inbound: add, dedupe by domain and by name, status, deal sheet, start outreach
  const ib = A.addInbound({ name: 'Quokka Data', website: 'https://www.quokka-data.example/about', referred_by: 'Brightline - Sam: K', how: 'Email', note: 'raising soon', raise: '$3M seed' });
  assert.equal(ib.existed, null);
  assert.equal(A.addInbound({ name: 'Something Else', website: 'quokka-data.example', note: 'again' }).existed, 'inbound');
  assert.equal(A.addInbound({ name: 'Quokka Data Inc.', note: 'third' }).existed, 'inbound');
  const firstCo = snap.companies.find(c => c.website);
  if (firstCo) assert.equal(A.addInbound({ name: 'whatever', website: firstCo.website, note: 'resurfaced' }).existed, 'company');
  A.setInboundStatus(ib.id, 'pursuing'); A.setDealSheet(ib.id, true);
  const q = A.vault.load().inbound.find(x => x.id === ib.id);
  assert.equal(q.status, 'pursuing'); assert.equal(q.deal_sheet, 'yes'); assert.equal(q.touches.length, 3);
  const so = A.startOutreach(ib.id, { role: 'CEO', name: 'Quinn Okafor', linkedin: '', email: 'quinn@quokka.example' });
  assert.equal(A.person(so.id).next, T);
  A.logSent(so.id, { text: 'Intro email' });
  assert.equal(A.vault.load().inbound.find(x => x.id === ib.id).status, 'reached-out', 'sending flips inbound to reached-out');

  // deal sheet on a Companies note, and re-sharing a sent one
  const co2 = A.vault.load().companies.find(c => !c.deal_sheet);
  A.setDealSheet(co2.id, true);
  assert.equal(A.vault.load().companies.find(c => c.id === co2.id).deal_sheet, 'yes');
  A.setDealSheet(co2.id, false);
  assert.equal(A.vault.load().companies.find(c => c.id === co2.id).deal_sheet, '');
  A.vault.updateInbound(ib.id, { deal_sheet: 'sent' });
  A.setDealSheet(ib.id, 'yes');
  assert.equal(A.vault.load().inbound.find(x => x.id === ib.id).deal_sheet, 'yes', 're-share');
  assert(Array.isArray(A.vault.load().dealSheets));
  touched.add(co2.id);

  // reach-out date: set, show, cleared when the company is reached out
  const later = A.addInbound({ name: 'Later Co', website: 'later-co.example', how: 'Outbound', note: 'too early', reach_out_on: '2027-03-01' });
  assert.equal(A.vault.load().inbound.find(x => x.id === later.id).reach_out_on, '2027-03-01');
  assert.throws(() => A.setReachOut(later.id, 'next march'));
  A.setReachOut(later.id, T);
  assert.equal(A.vault.load().inbound.find(x => x.id === later.id).reach_out_on, T);
  A.addInbound({ name: 'Later Co', note: 'resurfaced', reach_out_on: '2027-06-01' });
  assert.equal(A.vault.load().inbound.find(x => x.id === later.id).reach_out_on, '2027-06-01');
  A.setInboundStatus(later.id, 'reached-out');
  assert.equal(A.vault.load().inbound.find(x => x.id === later.id).reach_out_on, '', 'cleared on reached-out');

  // company site lookup
  assert.equal(A.lookup({ url: 'https://quokka-data.example/', siteName: 'Quokka' }).kind, 'company');
  assert.equal(A.lookup({ url: 'https://brand-new.example/', siteName: 'Brand New' }).kind, 'new-company');

  // every touched note passes the vault's own frontmatter hook
  for (const f of touched) { const e = hook(f); assert(!e, `${f}: ${e}`); }
  console.log(`hook OK on ${touched.size} notes`);

  // git: commits land and push to the remote
  await new Promise(r => setTimeout(r, 400));
  await git.flush();
  for (let i = 0; i < 40 && (git.running || git.pending.length); i++) await new Promise(r => setTimeout(r, 100));
  console.log('remote log:\n' + sh('git', ['--git-dir', remote, 'log', '--oneline', '-n', '4']));
  assert.equal(git.status.state, 'idle', 'git status: ' + JSON.stringify(git.status));
  assert.equal(sh('git', ['status', '--porcelain'], vault).trim(), '', 'nothing left uncommitted');

  console.log('\nSample note after edits:\n' + fs.readFileSync(path.join(vault, p0.id), 'utf8').split('\n').slice(0, 22).join('\n'));
  console.log('...\n' + fs.readFileSync(path.join(vault, p0.id), 'utf8').match(/## Outreach log[\s\S]*?---/)[0]);
  console.log('\nALL TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); console.error('temp vault kept at', vault); process.exit(1); });
