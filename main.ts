// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, in four
// formats: unified diff, SEARCH/REPLACE blocks, the V4A patch format, and
// text-editor tool calls as JSON. See SPEC.md for the whole contract.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Node 22+, standard library only.
//
// When MAKEFUN_ENV_URL is set, the trial runner takes over instead: the
// kit's runner.ts exports runTrial, and main.ts hands the trial to it.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  try {
    await runTrial(process.env.MAKEFUN_ENV_URL as string);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- utilities

type FormatName = 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json';
const FORMATS: FormatName[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

function out(text: string): void {
  writeSync(1, text);
}

/** A file's text, split at its own line break. */
interface FileText {
  lines: string[];
  brk: string;
  eol: boolean;
}

function parseText(text: string): FileText {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(brk);
  const body = eol ? text.slice(0, text.length - brk.length) : text;
  return { lines: body.split(brk), brk, eol };
}

function serializeText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.eol ? f.brk : '');
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.trim();
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.indexOf('\\') !== -1) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ------------------------------------------------------------- line matching

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isWsOnly(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions where o matches lines[from..], at one tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** First tier (0, then 1, then 2; only 0 when strict) where o occurs at/after from. */
function findFirstTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  raw: string;
  backslashAfter: boolean;
}

function rawToItems(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const r of raw) {
    if (r.startsWith('\\')) {
      // A backslash line refers to the body line before it.
      if (items.length > 0) items[items.length - 1].backslashAfter = true;
      continue;
    }
    if (r === '') items.push({ kind: 'ctx', text: '', raw: r, backslashAfter: false });
    else if (r[0] === ' ') items.push({ kind: 'ctx', text: r.slice(1), raw: r, backslashAfter: false });
    else if (r[0] === '-') items.push({ kind: 'old', text: r.slice(1), raw: r, backslashAfter: false });
    else if (r[0] === '+') items.push({ kind: 'new', text: r.slice(1), raw: r, backslashAfter: false });
  }
  return items;
}

/** Split a hunk/chunk's items into old lines O and new lines N. */
function splitItems(items: BodyItem[]): {
  o: string[];
  n: string[];
  nCtx: boolean[];
  nCtxOIndex: number[];
} {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nCtxOIndex: number[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push(it.text);
      nCtx.push(true);
      nCtxOIndex.push(oIdx);
      oIdx++;
    } else if (it.kind === 'old') {
      o.push(it.text);
      oIdx++;
    } else {
      n.push(it.text);
      nCtx.push(false);
      nCtxOIndex.push(-1);
    }
  }
  return { o, n, nCtx, nCtxOIndex };
}

/** The hunk/chunk's last context or new line, if any. */
function lastCtxOrPlus(items: BodyItem[]): BodyItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'ctx' || items[i].kind === 'new') return items[i];
  }
  return null;
}

/**
 * Replace lines[at .. at+oLen) with n. Context lines of n are written as the
 * file's own matched lines; at tier 2 the other lines of n are re-indented
 * from O's first line's leading whitespace to the file's.
 */
function applyLineEdit(
  lines: string[],
  at: number,
  oLen: number,
  n: string[],
  nCtx: boolean[],
  nCtxOIndex: number[],
  tier: number,
  oFirst: string,
  fileFirst: string,
): string[] {
  const result: string[] = lines.slice(0, at);
  const p = oLen > 0 ? leadWs(oFirst) : '';
  const f = oLen > 0 ? leadWs(fileFirst) : '';
  for (let j = 0; j < n.length; j++) {
    if (nCtx[j]) {
      result.push(lines[at + nCtxOIndex[j]]);
    } else if (tier === 2) {
      const t = n[j];
      if (t !== '' && !isWsOnly(t) && t.startsWith(p)) result.push(f + t.slice(p.length));
      else result.push(t);
    } else {
      result.push(n[j]);
    }
  }
  for (let k = at + oLen; k < lines.length; k++) result.push(lines[k]);
  return result;
}

// ------------------------------------------------------------------- edits

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface VChunk {
  anchor: string;
  eof: boolean;
  items: BodyItem[];
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; create: boolean; del: boolean; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-del'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

// ------------------------------------------------------------- unified diffs

interface SectionBuild {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null, diffNew: string | null): SectionBuild {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld,
    diffNew,
    createFlag: false,
    delFlag: false,
    hunks: [],
  };
}

/** The path after `--- ` / `+++ `: text after four chars, up to first tab, trimmed. */
function parseDiffPathField(s: string): string {
  const rest = s.slice(4);
  const tab = rest.indexOf('\t');
  return (tab === -1 ? rest : rest.slice(0, tab)).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: SectionBuild[] = [];
  let cur: SectionBuild | null = null;
  let state: 'outside' | 'header' | 'hunks' = 'outside';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new ParseErr(i + 1);
      cur = newSection(m[1], m[2]);
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (state === 'header' && cur) {
        cur.pairOld = parseDiffPathField(line);
        cur.pairNew = parseDiffPathField(lines[i + 1]);
        i += 2;
        continue;
      }
      cur = newSection(null, null);
      sections.push(cur);
      state = 'header';
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseErr(i + 1);
      const hunk: Hunk = { a: parseInt(m[1], 10), items: [] };
      i++;
      const raw: string[] = [];
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          i++;
        } else {
          break;
        }
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      hunk.items = rawToItems(raw);
      cur.hunks.push(hunk);
      state = 'hunks';
      continue;
    }
    if (state === 'header' && cur) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.createFlag = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  for (const s of sections) {
    let oldPath: string | null =
      s.pairOld !== null ? stripAB(s.pairOld) : s.renameFrom !== null ? s.renameFrom : s.diffOld;
    let newPath: string | null =
      s.pairNew !== null ? stripAB(s.pairNew) : s.renameTo !== null ? s.renameTo : s.diffNew;
    if (oldPath === '/dev/null') oldPath = null;
    if (newPath === '/dev/null') newPath = null;
    const create = oldPath === null || s.createFlag;
    const del = newPath === null || s.delFlag;
    edits.push({ kind: 'unified', oldPath, newPath, create, del, hunks: s.hunks });
  }
  return edits;
}

// --------------------------------------------------------- SEARCH / REPLACE

function isMarker(line: string, marker: string): boolean {
  return trimEndWs(line) === marker;
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let k = i + 1; k < n; k++) {
      if (isMarker(lines[k], '=======')) {
        eq = k;
        break;
      }
      if (isMarker(lines[k], '>>>>>>> REPLACE')) break;
    }
    if (eq === -1) throw new ParseErr(searchLine + 1);
    let rep = -1;
    for (let k = eq + 1; k < n; k++) {
      if (isMarker(lines[k], '>>>>>>> REPLACE')) {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new ParseErr(searchLine + 1);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (trimWs(l).startsWith('```')) continue;
      path = trimWs(l);
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(searchLine + 1);
    }
    blocks.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(searchLine + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseErr(1);
  return blocks;
}

// --------------------------------------------------------------------- V4A

function isSectionHeader(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (trimWs(lines[first]) !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (trimWs(lines[last]) !== '*** End Patch') throw new ParseErr(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = trimWs(line.slice('*** Add File:'.length));
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (isBlank(l)) {
          fileLines.push('');
          i++;
        } else {
          throw new ParseErr(i + 1);
        }
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push({ kind: 'v4a-add', path, lines: fileLines });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = trimWs(line.slice('*** Delete File:'.length));
      i++;
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      edits.push({ kind: 'v4a-del', path });
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = trimWs(line.slice('*** Update File:'.length));
      const updateLineNo = i + 1;
      i++;
      // `*** Move to: <path>` may be the section's first line (blank lines may precede it).
      let moveTo: string | null = null;
      let j = i;
      while (j < last && isBlank(lines[j])) j++;
      if (j < last && lines[j].startsWith('*** Move to:')) {
        moveTo = trimWs(lines[j].slice('*** Move to:'.length));
        i = j + 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let closed = false;
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        if (l.startsWith('@@')) {
          curChunk = { anchor: trimWs(l.slice(2)), eof: false, items: [] };
          chunks.push(curChunk);
          closed = false;
          i++;
          continue;
        }
        if (trimEndWs(l) === '*** End of File') {
          if (!curChunk) throw new ParseErr(i + 1);
          curChunk.eof = true;
          closed = true;
          i++;
          continue;
        }
        if (closed && isBlank(l)) {
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (closed) throw new ParseErr(i + 1);
          if (!curChunk) {
            curChunk = { anchor: '', eof: false, items: [] };
            chunks.push(curChunk);
          }
          curChunk.items.push(...rawToItems([l]));
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1];
        if (!lc.eof) {
          while (lc.items.length > 0 && isBlank(lc.items[lc.items.length - 1].raw)) lc.items.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLineNo);
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// --------------------------------------------------------------------- JSON

function validateJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'json-create', path, fileText: o.file_text as string };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') return null;
    let newStr = '';
    if (o.new_str !== undefined) {
      if (typeof o.new_str !== 'string') return null;
      newStr = o.new_str as string;
    }
    return { kind: 'json-str', path, oldStr: o.old_str as string, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json-insert', path, insertLine: o.insert_line as number, newStr: o.new_str as string };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseErr(first + 1);
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (!e) throw new ParseErr(first + 1);
      edits.push(e);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        throw new ParseErr(i + 1);
      }
      const e = validateJsonEdit(obj);
      if (!e) throw new ParseErr(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// --------------------------------------------------------- format detection

function detectFormat(lines: string[]): FormatName {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(0);
  const firstLine = lines[first];
  if (trimWs(firstLine) === '*** Begin Patch') return 'v4a';
  const firstNonWs = firstLine.trimStart();
  if (firstNonWs[0] === '[' || firstNonWs[0] === '{') return 'json';
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  throw new ParseErr(0);
}

// ------------------------------------------------------------------ applying

interface ApplyResult {
  ok: boolean;
  code?: string;
  path?: string;
  move?: [string, string];
}

function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

function applyUnified(
  e: Extract<Edit, { kind: 'unified' }>,
  tree: Map<string, string>,
  strict: boolean,
): ApplyResult {
  const mode = e.create ? 'create' : e.del ? 'delete' : e.oldPath !== e.newPath ? 'move' : 'change';
  if (mode === 'create') {
    const np = e.newPath as string;
    if (!isSafePath(np)) return fail('unsafe', np);
    if (tree.has(np)) return fail('exists', np);
    let lastPlus: BodyItem | null = null;
    const plusLines: string[] = [];
    for (const h of e.hunks) {
      for (const it of h.items) {
        if (it.kind === 'new') {
          plusLines.push(it.text);
          lastPlus = it;
        }
      }
    }
    const eol = lastPlus ? !lastPlus.backslashAfter : true;
    tree.set(np, plusLines.length === 0 ? '' : plusLines.join('\n') + (eol ? '\n' : ''));
    return { ok: true };
  }
  if (mode === 'delete') {
    const op = e.oldPath as string;
    if (!isSafePath(op)) return fail('unsafe', op);
    if (!tree.has(op)) return fail('missing', op);
    tree.delete(op);
    return { ok: true };
  }
  const op = e.oldPath as string;
  const np = e.newPath as string;
  if (!isSafePath(op)) return fail('unsafe', op);
  if (!isSafePath(np)) return fail('unsafe', np);
  if (!tree.has(op)) return fail('missing', op);
  if (mode === 'move' && tree.has(np)) return fail('exists', np);
  const f = parseText(tree.get(op) as string);
  let lines = f.lines.slice();
  let eol = f.eol;
  let d = 0;
  for (const h of e.hunks) {
    const { o, n, nCtx, nCtxOIndex } = splitItems(h.items);
    const last = lastCtxOrPlus(h.items);
    if (o.length > 0) {
      const found = findFirstTier(lines, o, strict, 0);
      if (!found) return fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const touchesEnd = best + o.length === lines.length;
      lines = applyLineEdit(lines, best, o.length, n, nCtx, nCtxOIndex, found.tier, o[0], lines[best]);
      if (touchesEnd) eol = last ? !last.backslashAfter : true;
      d += n.length - o.length;
    } else {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      lines = [...lines.slice(0, idx), ...n, ...lines.slice(idx)];
      if (atEnd) eol = last ? !last.backslashAfter : true;
      d += n.length;
    }
  }
  const text = serializeText({ lines, brk: f.brk, eol });
  if (mode === 'move') {
    tree.delete(op);
    tree.set(np, text);
    return { ok: true, move: [op, np] };
  }
  tree.set(op, text);
  return { ok: true };
}

function applySr(e: Extract<Edit, { kind: 'sr' }>, tree: Map<string, string>, strict: boolean): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.oldLines.length === 0) {
    if (tree.has(e.path)) return fail('exists', e.path);
    tree.set(e.path, e.newLines.length === 0 ? '' : e.newLines.join('\n') + '\n');
    return { ok: true };
  }
  if (!tree.has(e.path)) return fail('missing', e.path);
  const f = parseText(tree.get(e.path) as string);
  const found = findFirstTier(f.lines, e.oldLines, strict, 0);
  if (!found) return fail('no-match', e.path);
  if (found.occ.length > 1) return fail('ambiguous', e.path);
  const at = found.occ[0];
  const n = e.newLines;
  const lines = applyLineEdit(
    f.lines,
    at,
    e.oldLines.length,
    n,
    n.map(() => false),
    n.map(() => -1),
    found.tier,
    e.oldLines[0],
    f.lines[at],
  );
  tree.set(e.path, serializeText({ lines, brk: f.brk, eol: f.eol }));
  return { ok: true };
}

function applyV4aAdd(e: Extract<Edit, { kind: 'v4a-add' }>, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (tree.has(e.path)) return fail('exists', e.path);
  tree.set(e.path, e.lines.length === 0 ? '' : e.lines.join('\n') + '\n');
  return { ok: true };
}

function applyV4aDel(e: Extract<Edit, { kind: 'v4a-del' }>, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (!tree.has(e.path)) return fail('missing', e.path);
  tree.delete(e.path);
  return { ok: true };
}

function applyV4aUpdate(
  e: Extract<Edit, { kind: 'v4a-update' }>,
  tree: Map<string, string>,
  strict: boolean,
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.moveTo !== null && !isSafePath(e.moveTo)) return fail('unsafe', e.moveTo);
  if (!tree.has(e.path)) return fail('missing', e.path);
  if (e.moveTo !== null && tree.has(e.moveTo)) return fail('exists', e.moveTo);
  const f = parseText(tree.get(e.path) as string);
  let lines = f.lines.slice();
  let cursor = 0;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const ch of e.chunks) {
    if (ch.anchor !== '') {
      let foundAt = -1;
      for (const t of tiers) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(lines[k], ch.anchor, t)) {
            foundAt = k;
            break;
          }
        }
        if (foundAt !== -1) break;
      }
      if (foundAt === -1) return fail('no-match', e.path);
      cursor = foundAt + 1;
    }
    const { o, n, nCtx, nCtxOIndex } = splitItems(ch.items);
    if (o.length > 0) {
      const found = findFirstTier(lines, o, strict, cursor);
      if (!found) return fail('no-match', e.path);
      let at = -1;
      if (ch.eof) {
        for (const pos of found.occ) {
          if (pos + o.length === lines.length) {
            at = pos;
            break;
          }
        }
        if (at === -1) return fail('no-match', e.path);
      } else {
        at = found.occ[0];
      }
      lines = applyLineEdit(lines, at, o.length, n, nCtx, nCtxOIndex, found.tier, o[0], lines[at]);
      cursor = at + n.length;
    } else {
      const idx = ch.eof ? lines.length : cursor;
      lines = [...lines.slice(0, idx), ...n, ...lines.slice(idx)];
      cursor = idx + n.length;
    }
  }
  const text = serializeText({ lines, brk: f.brk, eol: f.eol });
  if (e.moveTo !== null) {
    tree.delete(e.path);
    tree.set(e.moveTo, text);
    return { ok: true, move: [e.path, e.moveTo] };
  }
  tree.set(e.path, text);
  return { ok: true };
}

function countOccurrences(hay: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let pos = 0;
  for (;;) {
    const j = hay.indexOf(needle, pos);
    if (j === -1) break;
    count++;
    if (first === -1) first = j;
    pos = j + 1;
  }
  return { count, first };
}

function applyJsonCreate(e: Extract<Edit, { kind: 'json-create' }>, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (tree.has(e.path)) return fail('exists', e.path);
  tree.set(e.path, e.fileText);
  return { ok: true };
}

function applyJsonStr(e: Extract<Edit, { kind: 'json-str' }>, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (!tree.has(e.path)) return fail('missing', e.path);
  const text = tree.get(e.path) as string;
  const f = parseText(text);
  let work: string;
  let oldS: string;
  let newS: string;
  const crlf = f.brk === '\r\n';
  if (crlf) {
    work = text.replace(/\r\n/g, '\n');
    oldS = e.oldStr.replace(/\r\n/g, '\n');
    newS = e.newStr.replace(/\r\n/g, '\n');
  } else {
    work = text;
    oldS = e.oldStr;
    newS = e.newStr;
  }
  const { count, first } = countOccurrences(work, oldS);
  if (count === 0) return fail('no-match', e.path);
  if (count > 1) return fail('ambiguous', e.path);
  let result = work.slice(0, first) + newS + work.slice(first + oldS.length);
  if (crlf) result = result.replace(/\n/g, '\r\n');
  tree.set(e.path, result);
  return { ok: true };
}

function applyJsonInsert(e: Extract<Edit, { kind: 'json-insert' }>, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (!tree.has(e.path)) return fail('missing', e.path);
  const f = parseText(tree.get(e.path) as string);
  if (e.insertLine < 0 || e.insertLine > f.lines.length) return fail('no-match', e.path);
  const newLines = patchLines(e.newStr);
  const lines = [...f.lines.slice(0, e.insertLine), ...newLines, ...f.lines.slice(e.insertLine)];
  tree.set(e.path, serializeText({ lines, brk: f.brk, eol: f.eol }));
  return { ok: true };
}

function applyEdit(edit: Edit, tree: Map<string, string>, strict: boolean): ApplyResult {
  switch (edit.kind) {
    case 'unified':
      return applyUnified(edit, tree, strict);
    case 'sr':
      return applySr(edit, tree, strict);
    case 'v4a-add':
      return applyV4aAdd(edit, tree);
    case 'v4a-del':
      return applyV4aDel(edit, tree);
    case 'v4a-update':
      return applyV4aUpdate(edit, tree, strict);
    case 'json-create':
      return applyJsonCreate(edit, tree);
    case 'json-str':
      return applyJsonStr(edit, tree);
    case 'json-insert':
      return applyJsonInsert(edit, tree);
  }
}

// ------------------------------------------------------------ tree and output

function readTree(dir: string): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        try {
          tree.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
        } catch {
          // An unreadable file is left out of the tree.
        }
      }
    }
  };
  walk(dir);
  return tree;
}

function writeTree(original: Map<string, string>, working: Map<string, string>): void {
  for (const [p, text] of working) {
    if (!original.has(p) || original.get(p) !== text) {
      const full = join(process.cwd(), ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    }
  }
  for (const p of original.keys()) {
    if (!working.has(p)) {
      rmSync(join(process.cwd(), ...p.split('/')), { force: true });
    }
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Change lines for exit 0, in byte order of the paths (R lines sort by new path). */
function computeOutputLines(
  original: Map<string, string>,
  working: Map<string, string>,
  moves: [string, string][],
): string[] {
  const rPairs: [string, string][] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, nw] of moves) {
    if (original.has(o) && !working.has(o) && !original.has(nw) && working.has(nw)) {
      rPairs.push([o, nw]);
      rOld.add(o);
      rNew.add(nw);
    }
  }
  const items: { key: string; line: string }[] = [];
  for (const [o, nw] of rPairs) items.push({ key: nw, line: `R ${o} -> ${nw}` });
  const allPaths = new Set<string>([...original.keys(), ...working.keys()]);
  for (const p of allPaths) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const inO = original.has(p);
    const inW = working.has(p);
    if (!inO && inW) items.push({ key: p, line: `A ${p}` });
    else if (inO && !inW) items.push({ key: p, line: `D ${p}` });
    else if (inO && inW && original.get(p) !== working.get(p)) items.push({ key: p, line: `M ${p}` });
  }
  items.sort((a, b) => byteCompare(a.key, b.key));
  return items.map((x) => x.line);
}

// --------------------------------------------------------------------- main

function usage(): number {
  out('error: usage\n');
  return 2;
}

function run(): number {
  const args = process.argv.slice(2);
  let formatOpt: FormatName = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.length > 1 && a[0] === '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v as FormatName)) return usage();
        formatOpt = v as FormatName;
      } else if (a === '--check') {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
      } else {
        return usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usage();
  const patchPath = positional[0];

  let patchText: string;
  if (patchPath === undefined || patchPath === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchPath, 'utf8');
    } catch {
      out('error: no-patch\n');
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let format = formatOpt;
  if (format === 'auto') {
    try {
      format = detectFormat(lines);
    } catch {
      out('error: format\n');
      return 2;
    }
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseErr) {
      out(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }

  const original = readTree(process.cwd());
  const working = new Map(original);
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const e of edits) {
    const r = applyEdit(e, working, strict);
    if (!r.ok) failures.push({ code: r.code as string, path: r.path as string });
    else if (r.move) moves.push(r.move);
  }
  if (failures.length > 0) {
    let text = '';
    for (const f of failures) text += `error: ${f.code} ${f.path}\n`;
    text += `failed: ${failures.length} of ${edits.length} edits\n`;
    out(text);
    return 1;
  }
  const changeLines = computeOutputLines(original, working, moves);
  let text = '';
  for (const l of changeLines) text += l + '\n';
  text += `ok: ${changeLines.length} ${changeLines.length === 1 ? 'file' : 'files'}\n`;
  out(text);
  if (!check) writeTree(original, working);
  return 0;
}

process.exit(run());
