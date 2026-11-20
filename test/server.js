// Exercises the Chrome-button HTTP endpoints against a throwaway vault copy.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Actions, Store } = require('../lib/actions');
const server = require('../lib/server');
const SRC = path.join(os.homedir(), 'Desktop/canaan-brain');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-srv-')), vault = path.join(tmp, 'v');
for (const p of ['People', 'Inbound', 'Companies', 'VAULT_SCHEMA.md']) fs.cpSync(path.join(SRC, p), path.join(vault, p), { recursive: true });
const A = new Actions({ vaultRoot: vault, store: new Store(path.join(tmp, 's.json')), gitQueue: null });
const PORT = 47899;
const srv = server.start(() => A, { port: PORT });
const req = (p, body, origin) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
(async () => {
  await new Promise(r => setTimeout(r, 200));
  const ext = 'chrome-extension://abcdef';
  assert.equal((await req('/ping', null, ext)).j.ok, true);
  assert.equal((await req('/lookup', { url: 'https://x.com' }, 'https://evil.example')).status, 403, 'web pages refused');
  // new person from a LinkedIn profile
  let r = await req('/lookup', { url: 'https://www.linkedin.com/in/jane-test-9/', name: 'Jane Test', headline: 'Co-founder & CEO at Glimmer Robotics' }, ext);
  assert.equal(r.j.kind, 'new-person'); assert.equal(r.j.guess.company, 'Glimmer Robotics'); assert.equal(r.j.guess.role, 'Co-founder & CEO');
  r = await req('/log-person', { name: 'Jane Test', role: 'Co-founder & CEO', company: 'Glimmer Robotics', linkedin: 'https://www.linkedin.com/in/jane-test-9/', category: 'founder', note: 'Cold intro', days: 5, addCompany: true }, ext);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  // same profile now known, waiting; save a draft and confirm it via the button
  r = await req('/lookup', { url: 'https://www.linkedin.com/in/jane-test-9' }, ext);
  assert.equal(r.j.kind, 'person'); assert.equal(r.j.person.state, 'waiting');
  A.saveDraft(r.j.person.id, { text: 'Following up on my note', cadence: 10 });
  r = await req('/lookup', { url: 'https://www.linkedin.com/in/jane-test-9' }, ext);
  assert.equal(r.j.draft.text, 'Following up on my note');
  r = await req('/log-person', { id: r.j.person.id, note: '', days: 10 }, ext);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const p = A.person('People/Jane Test.md');
  assert.equal(p.log.length, 2); assert.equal(p.log[1].text, 'Following up on my note'); assert.equal(p.cadence, 10);
  r = await req('/log-reply', { id: p.id, note: 'Yes, let us meet' }, ext); assert.equal(r.status, 200);
  // company sites
  const anyInbound = A.vault.load().inbound.find(c => c.website);
  r = await req('/lookup', { url: anyInbound.website + '/pricing', siteName: 'Whatever' }, ext);
  assert.equal(r.j.kind, 'company'); assert.equal(r.j.match.name, anyInbound.name);
  r = await req('/lookup', { url: 'https://never-seen-co.example/', siteName: 'Never Seen' }, ext);
  assert.equal(r.j.kind, 'new-company');
  r = await req('/add-inbound', { name: 'Never Seen', website: 'never-seen-co.example', referred_by: 'A Fund - Pat', how: 'Intro', note: 'pre-seed' }, ext);
  assert.equal(r.j.existed, null);
  assert.equal((await req('/add-inbound', { name: 'Glimmer Robotics, Inc.', website: '' }, ext)).j.existed, 'inbound', 'Inc. variant dedupes');
  r = await req('/log-reply', { id: 'People/Nobody.md', note: 'x' }, ext); assert.equal(r.status, 400);
  // "I want to reach out": new founder + new company -> person due today, company Pursuing
  r = await req('/add-prospect', { name: 'Sam Prospect', role: 'Founder & CEO', company: 'Quiet Harbor', linkedin: 'https://www.linkedin.com/in/sam-prospect/?x=1', category: 'founder', days: 10, addCompany: true }, ext);
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.inbound.status, 'pursuing');
  let qh = fs.readFileSync(path.join(vault, 'Inbound/Quiet Harbor.md'), 'utf8');
  assert.match(qh, /^status: pursuing$/m); assert.match(qh, /- Founder & CEO: Sam Prospect \(https:\/\/www.linkedin.com\/in\/sam-prospect\)/);
  let sam = A.person(r.j.id);
  assert.equal(sam.next, A.vault.load().today); assert.equal(sam.cadence, 10); assert.equal(sam.log.length, 0);
  r = await req('/lookup', { url: 'https://www.linkedin.com/in/sam-prospect/' }, ext);
  assert.equal(r.j.kind, 'person'); assert.equal(r.j.person.due, true); assert.equal(r.j.person.draftKind, 'first');
  // drafting from the button saves a pending draft; sending flips Inbound to Reached out
  A.draft = async () => ({ text: 'Hi Sam, loved the launch.', kind: 'first' });
  r = await req('/draft', { id: sam.id, days: 10 }, ext);
  assert.equal(r.j.text, 'Hi Sam, loved the launch.'); assert.equal(r.j.draft.cadence, 10);
  r = await req('/save-draft', { id: sam.id, text: 'Hi Sam, loved the launch!', days: 14 }, ext);
  assert.equal((await req('/lookup', { url: 'https://www.linkedin.com/in/sam-prospect/' }, ext)).j.draft.text, 'Hi Sam, loved the launch!');
  assert.equal((await req('/save-draft', { id: sam.id, text: '  ' }, ext)).status, 400);
  r = await req('/log-person', { id: sam.id, note: '', days: 14 }, ext); assert.equal(r.status, 200);
  qh = fs.readFileSync(path.join(vault, 'Inbound/Quiet Harbor.md'), 'utf8');
  assert.match(qh, /^status: reached-out$/m);
  // a second founder at a company already in Inbound joins its team; "new" becomes "pursuing"
  const newOne = A.vault.load().inbound.find(c => c.status === 'new');
  if (newOne) {
    r = await req('/add-prospect', { name: 'Riley Cofounder', role: 'CTO', company: newOne.name, linkedin: 'https://www.linkedin.com/in/riley-co/', category: 'founder', days: 7, addCompany: true }, ext);
    assert.equal(r.j.inbound.created, false); assert.equal(r.j.inbound.status, 'pursuing');
    const t = fs.readFileSync(path.join(vault, newOne.id), 'utf8');
    assert.match(t, /^status: pursuing$/m); assert.match(t, /CTO: Riley Cofounder/); assert.match(t, /Derek: want to reach out to Riley Cofounder/);
    const again = await req('/add-prospect', { name: 'Riley Cofounder', role: 'CTO', company: newOne.name, linkedin: 'https://www.linkedin.com/in/riley-co/', addCompany: true }, ext);
    assert.equal(fs.readFileSync(path.join(vault, newOne.id), 'utf8').split('Riley Cofounder (').length, 2, 'no duplicate team line'); assert.equal(again.status, 200);
  }
  const hook = path.join(SRC, '.claude/hooks/check-vocab.sh');
  for (const f of ['Inbound/Quiet Harbor.md', sam.id, ...(newOne ? [newOne.id] : [])]) {
    const out = require('child_process').spawnSync('bash', [hook], { input: JSON.stringify({ tool_input: { file_path: path.join(vault, f) } }), encoding: 'utf8' });
    assert.equal(out.status, 0, f + ' fails vocab hook: ' + out.stderr);
  }
  console.log(fs.readFileSync(path.join(vault, 'Inbound/Quiet Harbor.md'), 'utf8'));
  console.log('SERVER TESTS PASSED');
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error('FAILED', e); srv.close(); process.exit(1); });
