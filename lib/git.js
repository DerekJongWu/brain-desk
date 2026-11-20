// Commits the files the app touched and pushes, in the background.
// Changes made within a short window are batched into one commit. Only the
// app's own paths are committed, so anything else in progress in the vault
// (an open Claude session, Obsidian edits) is left alone.
'use strict';
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout));
    });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class GitQueue extends EventEmitter {
  constructor(cwd, { delayMs = 2500, push = true } = {}) {
    super();
    this.cwd = cwd; this.delayMs = delayMs; this.push = push;
    this.pending = []; this.timer = null; this.running = false;
    this.status = { state: 'idle', message: 'Vault in sync', lastCommit: null, today: 0 };
  }

  setStatus(patch) { Object.assign(this.status, patch); this.emit('status', { ...this.status }); }

  add(files, message) {
    this.pending.push({ files: [...new Set(files)], message });
    this.setStatus({ state: 'pending', message: 'Saving to git…' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  async flush() {
    if (this.running) { this.timer = setTimeout(() => this.flush(), 1000); return; }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    this.running = true;
    const files = [...new Set(batch.flatMap(b => b.files))];
    const msgs = [...new Set(batch.map(b => b.message))];
    const subject = msgs.length === 1 ? msgs[0] : `[file] Brain Desk — ${msgs.length} updates`;
    const body = msgs.length === 1 ? [] : ['-m', msgs.map(m => '- ' + m).join('\n')];
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await git(this.cwd, ['add', '--all', '--', ...files]);
          const staged = await git(this.cwd, ['diff', '--cached', '--name-only', '--', ...files]);
          if (!staged.trim()) break;
          await git(this.cwd, ['commit', '-m', subject, ...body, '--', ...files]);
          break;
        } catch (e) {
          if (/index\.lock/.test(e.stderr) && attempt < 5) { await sleep(1000); continue; }
          throw e;
        }
      }
      this.setStatus({ state: 'committed', message: 'Committed', lastCommit: subject, today: this.status.today + 1 });
      if (this.push) {
        this.setStatus({ state: 'pushing', message: 'Pushing…' });
        try {
          await git(this.cwd, ['push', '--quiet']);
          this.setStatus({ state: 'idle', message: 'Pushed to GitHub' });
        } catch (e) {
          this.setStatus({ state: 'error', message: 'Push failed: ' + firstLine(e.stderr || e.message) });
        }
      }
    } catch (e) {
      this.setStatus({ state: 'error', message: 'Commit failed: ' + firstLine(e.stderr || e.message) });
    } finally {
      this.running = false;
    }
  }

  async check() {
    try {
      await git(this.cwd, ['rev-parse', '--is-inside-work-tree']);
      const remote = (await git(this.cwd, ['remote'])).trim();
      return { ok: true, remote: remote.split('\n')[0] || null };
    } catch (e) {
      return { ok: false, error: firstLine(e.stderr || e.message) };
    }
  }
}
const firstLine = s => String(s).trim().split('\n').filter(Boolean).pop() || 'unknown error';

module.exports = { GitQueue, git };
