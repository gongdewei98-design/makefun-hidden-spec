// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write,
// in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches and JSON tool calls), to a tree of text
// files. It finds the lines an edit names at the first of three matching tiers, and changes every file or
// none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a line break (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order, as [old, new] pairs (for the `R` output lines). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Line matching at three tiers (SPEC.md section 5). */

const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}

/** Every 0-based position at which O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface FoundTier {
  tier: number;
  positions: number[];
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs in `lines` at or
 * after `from`, with every occurrence at that tier. With `eofOnly`, only occurrences that end at
 * the file's last line count.
 */
function findTier(O: string[], lines: string[], strict: boolean, from = 0, eofOnly = false): FoundTier | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let positions = occurrences(O, lines, tier, from);
    if (eofOnly) positions = positions.filter((p) => p + O.length === lines.length);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line, `ctx` its index in O) or a new line. */
interface NewItem {
  text: string;
  ctx: number;
}

/**
 * Build the lines that replace a matched occurrence: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line's leading whitespace to
 * the file's first matched line's (SPEC.md section 5).
 */
function buildNew(O: string[], N: NewItem[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && O.length > 0;
  const f = reindent ? leadWs(fileLines[pos]!) : '';
  const p = reindent ? leadWs(O[0]!) : '';
  for (const item of N) {
    if (item.ctx >= 0) {
      out.push(fileLines[pos + item.ctx]!);
    } else if (reindent) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/**
 * Split a hunk or chunk body into its old lines O (context and `-` lines) and its new lines N
 * (context and `+` lines, in body order), and whether a `\` line follows the hunk's last context
 * or `+` line (SPEC.md section 6).
 */
function parseBodyLines(body: string[]): { O: string[]; N: NewItem[]; noEol: boolean } {
  const O: string[] = [];
  const N: NewItem[] = [];
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push({ text: l.slice(1), ctx: -1 });
      lastCtxPlus = k;
    }
    // a `\` line refers to the body line before it and carries no line of its own.
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  return { O, N, noEol };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Unified diffs (SPEC.md section 6). */

interface Hunk {
  a: number;
  body: string[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** A leading `a/` or `b/` is removed; `/dev/null` means no file. */
function normDiffPath(raw: string | null, strip: boolean): string | null {
  if (raw === null) return null;
  let p = raw;
  if (strip && (p.startsWith('a/') || p.startsWith('b/'))) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function resolveUPaths(sec: USection): { oldP: string | null; newP: string | null } {
  if (sec.hasPair) {
    return { oldP: normDiffPath(sec.pairOld, true), newP: normDiffPath(sec.pairNew, true) };
  }
  return {
    oldP: normDiffPath(sec.renameOld ?? sec.gitOld, false),
    newP: normDiffPath(sec.renameNew ?? sec.gitNew, false),
  };
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path) on failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const parsed = parseBodyLines(h.body);
    const O = parsed.O;
    const N = parsed.N;
    if (O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      const ins = N.map((it) => it.text);
      f.lines.splice(pos, 0, ...ins);
      if (atEnd && ins.length > 0) f.final = !parsed.noEol;
      d += N.length;
      continue;
    }
    const found = findTier(O, f.lines, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const hasCtxPlus = N.length > 0;
    const newLines = buildNew(O, N, f.lines, pos, found.tier);
    const runsToEnd = pos + O.length === f.lines.length;
    f.lines.splice(pos, O.length, ...newLines);
    if (runsToEnd) {
      if (hasCtxPlus) f.final = !parsed.noEol;
      else f.final = f.lines.length > 0;
    }
    d += N.length - O.length;
  }
  return renderFile(f);
}

/** The content a creation section writes: the `+` lines of all its hunks, in order. */
function creationContent(sec: USection): string {
  const plus: string[] = [];
  let finalBr = true;
  for (const h of sec.hunks) {
    let lastPlus = -1;
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k]![0] === '+') lastPlus = k;
    }
    for (const l of h.body) {
      if (l[0] === '+') plus.push(l.slice(1));
    }
    if (lastPlus >= 0) {
      const after = h.body[lastPlus + 1];
      finalBr = !(after !== undefined && after[0] === '\\');
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (finalBr ? '\n' : '');
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const { oldP, newP } = resolveUPaths(sec);
  const isCreate = sec.newFile || oldP === null;
  const isDelete = !isCreate && (sec.deletedFile || newP === null);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, creationContent(sec));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const t = tree.get(oldP);
      if (t === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(t, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.recordMove(oldP, newP);
      return;
    }
    const p = oldP!;
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(t, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!, gitNew: m[2]!, pairOld: null, pairNew: null, hasPair: false,
        renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader && cur !== null && !cur.hasPair) {
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
        } else {
          cur = {
            gitOld: null, gitNew: null, pairOld: headerPath(l), pairNew: headerPath(lines[i + 1]!),
            hasPair: true, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [],
          };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/* SEARCH/REPLACE blocks (SPEC.md section 7). */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevRep = -1;
  let prevPath: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevRep; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    prevRep = rep;
    prevPath = path;
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      const f = parseFile(t);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const items: NewItem[] = newLines.map((text) => ({ text, ctx: -1 }));
      const out = buildNew(oldLines, items, f.lines, pos, found.tier);
      f.lines.splice(pos, oldLines.length, ...out);
      tree.now.set(p, renderFile(f));
    });
    i = rep + 1;
  }
  return edits;
}

/* V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  hasAnchor: boolean;
  eof: boolean;
  body: string[];
}

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function isVSectionStart(l: string): boolean {
  return l.startsWith(ADD_PREFIX) || l.startsWith(DELETE_PREFIX) || l.startsWith(UPDATE_PREFIX);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isVSectionStart(header)) throw new Exit2(`error: parse ${i + 1}`);
    const start = i;
    let j = i + 1;
    while (j < last && !isVSectionStart(lines[j]!)) j += 1;
    const raw: Array<{ text: string; num: number }> = [];
    for (let k = start + 1; k < j; k++) raw.push({ text: lines[k]!, num: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSectionEdit(header, raw, start + 1, strict));
    i = j;
  }
  return edits;
}

function v4aSectionEdit(header: string, raw: Array<{ text: string; num: number }>, headerNum: number, strict: boolean): Edit {
  if (header.startsWith(ADD_PREFIX)) {
    const p = header.slice(ADD_PREFIX.length).trim();
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.num}`);
    }
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (header.startsWith(DELETE_PREFIX)) {
    const p = header.slice(DELETE_PREFIX.length).trim();
    for (const r of raw) {
      if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
    }
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = header.slice(UPDATE_PREFIX.length).trim();
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_PREFIX)) {
    moveTo = raw[0]!.text.slice(MOVE_PREFIX.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const text = r.text;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), hasAnchor: true, eof: false, body: [] };
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) cur = { anchor: null, hasAnchor: false, eof: false, body: [] };
      cur.body.push(text);
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
  const dest = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
    const f = parseFile(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.hasAnchor && ch.anchor !== null && ch.anchor !== '') {
        const anchor = ch.anchor;
        let foundIdx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(anchor, f.lines[k]!, tier)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', p);
        cursor = foundIdx + 1;
      }
      const parsed = parseBodyLines(ch.body);
      const O = parsed.O;
      const N = parsed.N;
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = N.map((it) => it.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findTier(O, f.lines, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', p);
      const pos = found.positions[0]!;
      const out = buildNew(O, N, f.lines, pos, found.tier);
      f.lines.splice(pos, O.length, ...out);
      cursor = pos + out.length;
    }
    const content = renderFile(f);
    if (dest !== null) {
      tree.now.set(p, null);
      tree.now.set(dest, content);
      tree.recordMove(p, dest);
    } else {
      tree.now.set(p, content);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
