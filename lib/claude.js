// Drafts messages by running Claude Code headless (`claude -p`) inside the
// vault, so it uses Derek's logged-in Claude subscription (no API key), reads
// the person's notes, and writes in his voice via the derek-voice skill.
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Electron apps launched from Finder don't inherit the shell PATH.
function findClaude() {
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ];
  return candidates.find(p => fs.existsSync(p)) || 'claude';
}

// allowTools: extra tools (e.g. Specter) to permit; turns MCP connectors on.
function run(cwd, prompt, { timeoutMs = 150000, maxTurns = 8, allowTools = null } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // never bill an API key by accident
    env.PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(':');
    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--max-turns', String(maxTurns)];
    if (allowTools) args.push('--allowedTools', ['Read', 'Grep', 'Glob', ...allowTools].join(','), '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash');
    else args.push('--strict-mcp-config', '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch');
    const child = spawn(findClaude(), args, { cwd, env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude took too long. Try again.')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new Error('Could not start Claude Code: ' + e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error || j.subtype !== 'success') return reject(new Error(j.result || 'Claude returned an error'));
        resolve(String(j.result || '').trim());
      } catch (_) {
        reject(new Error(err.trim().split('\n').pop() || `Claude exited with code ${code}`));
      }
    });
  });
}

function draftPrompt({ person, kind, channel, instructions, companyNote }) {
  const where = channel === 'email' ? 'an email (body only, no subject line)' : 'a LinkedIn message (no subject; keep it short, LinkedIn-length)';
  const what = {
    first: 'a first outreach message',
    followup: 'a follow-up nudge. They have not replied to the earlier message(s) in the outreach log',
    reply: 'a reply to their latest message in the outreach log',
  }[kind] || 'a message';
  const log = person.log.length
    ? person.log.map(l => `- ${l.date} ${l.dir === 'out' ? 'Derek →' : l.dir === 'in' ? '→ Derek' : 'note'} (${l.channel}): ${l.text}`).join('\n')
    : '(no outreach logged yet)';
  return [
    'Use the anthropic-skills:derek-voice skill.',
    `Draft ${what}, written as Derek, to ${person.name}${person.role ? ` (${person.role}${person.company ? ', ' + person.company : ''})` : ''}. Format: ${where}.`,
    `Read "${person.id}" for context${companyNote ? ` and "${companyNote}" for their company` : ''}. Skim only what you need.`,
    'Outreach log so far:', log,
    instructions ? `Derek's instructions for this message: ${instructions}` : '',
    'Output ONLY the message text, ready to paste. No preamble, no quotes, no notes, no alternatives.',
  ].filter(Boolean).join('\n');
}

const SPECTER_TOOLS = ['find_company', 'get_company_profile', 'get_company_funding_rounds', 'find_person', 'get_person_profile'].map(t => 'mcp__claude_ai_Specter__' + t);

function enrichPrompt(rel) {
  return [
    `Enrich the Inbound note "${rel}" in this vault. Read it, plus the Inbound section and the "Markets and themes" table in VAULT_SCHEMA.md.`,
    'Look the company up in Specter: find_company by the website domain if the note has one, otherwise by name, then get_company_profile (and get_company_funding_rounds if useful).',
    'If Specter has nothing, do one or two quick web searches. Never guess: use "" for anything you cannot confirm, and if you cannot confidently identify the company, return {"found": false}.',
    'Reply with ONLY one JSON object, no prose and no code fence:',
    '{"found": true, "website": "https://…", "description": "one short sentence on what the company does", "what_it_is": "2-4 plain sentences: product, buyer, HQ, founded, headcount, total raised and last round (amount, stage, month/year, lead)", "themes": ["only slugs from the table that clearly fit, else empty"], "team": [{"role": "CEO", "name": "…", "linkedin": "https://www.linkedin.com/in/…"}]}',
    'Team: founders and the CEO only, at most 4.',
  ].join('\n');
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Claude did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}

module.exports = { SPECTER_TOOLS, enrichPrompt, parseJson, run, draftPrompt, findClaude };
