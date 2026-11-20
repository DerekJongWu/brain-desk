// Reading and surgically editing Obsidian notes.
// Edits touch only the lines they change, so a note's other formatting,
// comments and key order survive. Frontmatter values follow the quoting
// rule in VAULT_SCHEMA.md ("Quote free-text values").
'use strict';
const yaml = require('js-yaml');

function splitFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { lines, fmEnd: -1 };
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') return { lines, fmEnd: i };
  return { lines, fmEnd: -1 };
}

function parse(text) {
  const { lines, fmEnd } = splitFrontmatter(text);
  if (fmEnd < 0) return { fm: {}, ok: false };
  try {
    const fm = yaml.load(lines.slice(1, fmEnd).join('\n'), { schema: yaml.JSON_SCHEMA }) || {};
    for (const k of Object.keys(fm)) if (fm[k] === null) fm[k] = '';
    return { fm, ok: true };
  } catch (e) {
    return { fm: {}, ok: false, error: e.message };
  }
}

// YAML scalar per the vault's quoting rule.
function scalar(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).replace(/\s*\n\s*/g, ' ').trim();
  if (s === '') return '';
  const needs =
    /: |\s#/.test(s) || /:$/.test(s) ||
    /^[\[\]{}"'*&!%@|>\-?`#,]/.test(s) ||
    /^(true|false|null|~)$/i.test(s);
  return needs ? `'${s.replace(/'/g, "''")}'` : s;
}

// Set top-level scalar keys. Existing lines are replaced in place; missing
// keys go just before `tags:` (or before the closing ---).
function setKeys(text, changes) {
  const { lines, fmEnd } = splitFrontmatter(text);
  if (fmEnd < 0) throw new Error('note has no frontmatter');
  let end = fmEnd;
  for (const [key, value] of Object.entries(changes)) {
    const line = `${key}:${scalar(value) === '' ? '' : ' ' + scalar(value)}`;
    let idx = -1;
    for (let i = 1; i < end; i++) if (lines[i].startsWith(key + ':')) { idx = i; break; }
    if (idx >= 0) {
      // drop any indented block value that followed (e.g. a list we are replacing)
      let j = idx + 1;
      while (j < end && /^\s+\S/.test(lines[j])) j++;
      lines.splice(idx, j - idx, line);
      end -= (j - idx - 1);
    } else {
      let at = end;
      for (let i = 1; i < end; i++) if (lines[i].startsWith('tags:')) { at = i; break; }
      lines.splice(at, 0, line);
      end += 1;
    }
  }
  return lines.join('\n');
}

// Find a markdown section by exact heading text ("## Touches").
function sectionRange(lines, heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = lines.findIndex(l => l.trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if ((m && m[1].length <= level) || /^---\s*$/.test(lines[i]) || /^%%/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function readList(text, heading) {
  const lines = text.split('\n');
  const r = sectionRange(lines, heading);
  if (!r) return [];
  return lines.slice(r.start + 1, r.end).filter(l => /^- /.test(l)).map(l => l.slice(2));
}

function readText(text, heading) {
  const lines = text.split('\n');
  const r = sectionRange(lines, heading);
  if (!r) return '';
  return lines.slice(r.start + 1, r.end).join('\n').trim();
}

// Append a list line to a section. If the section is missing, create it
// before `beforeHeading` when given (with the --- divider People notes use),
// otherwise at the end of the note.
function appendToSection(text, heading, item, opts = {}) {
  const lines = text.split('\n');
  const r = sectionRange(lines, heading);
  if (r) {
    let at = r.start + 1;
    for (let i = r.start + 1; i < r.end; i++) if (/^\s*- /.test(lines[i]) || /^\s{2,}\S/.test(lines[i])) at = i + 1;
    if (at === r.start + 1 && lines[at] === '') at += 1; // keep a blank line under the heading
    lines.splice(at, 0, '- ' + item);
    return lines.join('\n');
  }
  const block = [heading, '', '- ' + item, ''];
  if (opts.beforeHeading) {
    const b = lines.findIndex(l => l.trim() === opts.beforeHeading);
    if (b >= 0) {
      const insert = opts.divider ? [...block, '---', ''] : block;
      lines.splice(b, 0, ...insert);
      return lines.join('\n');
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('', ...block);
  return lines.join('\n');
}

module.exports = { parse, scalar, setKeys, readList, readText, appendToSection, splitFrontmatter };
