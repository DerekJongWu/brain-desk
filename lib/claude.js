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

function run(cwd, prompt, { timeoutMs = 150000, maxTurns = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // never bill an API key by accident
    env.PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(':');
    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence',
      '--strict-mcp-config', '--max-turns', String(maxTurns),
      '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch'];
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

module.exports = { run, draftPrompt, findClaude };
