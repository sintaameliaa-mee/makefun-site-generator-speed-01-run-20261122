// solve.js — a fast drop-in for makefun-site 1.0.0, written from scratch for
// site-generator-speed-01-run-20261122.
//
// The behaviour it reproduces is makefun-site's own (front matter, template
// dialect, Markdown subset, slug rule and report, as its README states and its
// code pins down), but every line below is my own implementation, tuned for
// CPU time:
//
//   * regex-free hot paths: the Markdown block scan, the front-matter scan
//     and the slug rule all run on charCodeAt dispatch, not regexes;
//   * the Markdown lexer and renderer are fused into one pass, so no token
//     objects are ever built;
//   * inline rendering scans with one native regex for the next interesting
//     character, copies plain runs whole, and only escapes what needs it;
//   * slug results are memoised per run (titles, tags and headings repeat);
//   * templates run on a small array-node interpreter over one mutable
//     scope object per render (loop variables are written in and restored
//     after the loop), with output parts joined once.
//
// run(input) is synchronous and re-entrant-safe only in the sense that it
// resets its per-run memo table on entry; the harness calls it once per case,
// in order, which is all it needs.

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether code unit `c` is JavaScript whitespace (the \s set, BMP). */
function isWs(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of non-whitespace characters. Printable
 *  ASCII (33-126) is never whitespace, so only other code units pay for the
 *  full check. */
function countWords(t) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c > 32 && c < 127 ? false : isWs(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ escaping

const ESC_RE = /[&<>"']/;

/** `s` with & < > " ' escaped; strings needing no escape come back untouched. */
function esc(s) {
  const first = s.search(ESC_RE);
  if (first === -1) return s;
  let out = s.slice(0, first);
  let last = first;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += s.slice(last, i);
      out += '&amp;';
      last = i + 1;
    } else if (c === 60) {
      out += s.slice(last, i);
      out += '&lt;';
      last = i + 1;
    } else if (c === 62) {
      out += s.slice(last, i);
      out += '&gt;';
      last = i + 1;
    } else if (c === 34) {
      out += s.slice(last, i);
      out += '&quot;';
      last = i + 1;
    } else if (c === 39) {
      out += s.slice(last, i);
      out += '&#39;';
      last = i + 1;
    }
  }
  if (last < s.length) out += s.slice(last);
  return out;
}

// ---------------------------------------------------------------------- slugs

const MARKS_RE = /\p{M}/gu;

/** The slug rule, straight: NFKD, combining marks dropped, A-Z lowered, every
 *  run of other characters one "-", none at either end, at most 64 chars (a
 *  "-" left at the cut dropped), "untitled" when nothing is left. Pure ASCII
 *  input skips the normalisation entirely: NFKD is the identity on it and it
 *  holds no combining marks. */
function slugifyRaw(s) {
  let plain = s;
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = s.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c + 32);
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += plain[i];
    } else {
      gap = out.length > 0;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** This run's slug memo table; reset by run() for every case. */
let SLUGS = null;

function slugOf(s) {
  const hit = SLUGS.get(s);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(s);
  SLUGS.set(s, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) {
    out = slug + '-' + n;
    n++;
  }
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-11-09" in words, from the string alone: "9 November 2026". */
function longDate(d) {
  return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** `s` with trailing spaces and tabs dropped. */
function rstripST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

/** A title/summary value: "..." with \" and \\ its only escapes, or bare. */
function fmString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'key "' + key + '": a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'key "' + key + '": a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'key "' + key + '": a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') return fmString(key, raw);
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      const y =
        (raw.charCodeAt(0) - 48) * 1000 +
        (raw.charCodeAt(1) - 48) * 100 +
        (raw.charCodeAt(2) - 48) * 10 +
        (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) ok = false;
    }
    if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i].trim();
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags[i] = t;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters
  let ok = raw.length >= 1 && raw.length <= 64;
  if (ok) {
    let prevDash = true;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else if (c === 45 && !prevDash) prevDash = true;
      else {
        ok = false;
        break;
      }
    }
    if (ok && prevDash) ok = false;
  }
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A source's front matter and body: { data, body }, or { error } with the
 *  first reason it is refused. Two phases, as the reference does them: the
 *  closing line is found first (a source with none is refused as not closed
 *  whatever its lines hold), and only then are the lines between parsed.
 *  Works on line offsets, never splitting the text, so the body is one
 *  slice. */
function parseFM(text) {
  const nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstEnd + 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    const line = text.slice(pos, end);
    if (line === '---') {
      bodyStart = end + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) break;
    pos = end + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const lineNo = i + 2;
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) {
        return { error: 'line ' + lineNo + ' is not "key: value"' };
      }
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: 'line ' + lineNo + ' is not "key: value"' };
      raw = rstripST(raw);
      if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = fmValue(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ----------------------------------------------------------------- markdown

/** `line` with spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence opener's language ("" when none), or null when `line` — which
 *  starts with three backticks — is not a fence: the language is
 *  [A-Za-z0-9_+-]*, then spaces or tabs only. */
function fenceLang(line) {
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null: 1 to 6 "#", at least one space
 *  or tab, then text (trailing spaces and tabs dropped); no text, or 7 or
 *  more "#", is not a heading. */
function headingParse(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0 || line.charCodeAt(h) === 35) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h + 1;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` (opening on "-" or "*") is a thematic break: "---" or
 *  "***", then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list opener: 1 to 9 digits, ". ", then its text — or null. */
function orderedParse(line) {
  let i = 0;
  while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a
 *  non-space character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWs(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  if (isBlank(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && fenceLang(line) !== null) return true;
  if (c0 === 35 && headingParse(line) !== null) return true;
  if ((c0 === 45 || c0 === 42) && isHr(line)) return true;
  return false;
}

// ------------------------------------------------------------ inline rendering

/** The next interesting character while rendering inline: a backslash, a
 *  backtick, a star, an opening bracket, or one of the escaped characters.
 *  One native scan, shared by every inline call; lastIndex is saved and
 *  restored around recursion. */
const SCAN_RE = /[\\`*\[&<>"']/g;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the character at `j` is backslash-escaped, scanning from `from`:
 *  escape pairs are consumed left to right, so it is escaped exactly when an
 *  odd run of backslashes stands immediately before it. */
function isEscapedAt(s, j, from) {
  let k = j - 1;
  let n = 0;
  while (k >= from && s.charCodeAt(k) === 92) {
    n++;
    k--;
  }
  return (n & 1) === 1;
}

/** The first "**" from `from` that is not escaped, or -1. */
function findStrongClose(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1 && isEscapedAt(s, j, from)) j = s.indexOf('**', j + 1);
  return j;
}

/** The first single "*" from `from` (one whose run is not "**"), not escaped,
 *  or -1. */
function findEmClose(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscapedAt(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The first "]" from `from` that is not escaped, or -1. */
function findBracketClose(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1 && isEscapedAt(s, j, from)) j = s.indexOf(']', j + 1);
  return j;
}

const WS_RE = /\s/;

/** `s` rendered inline: code spans, strong, emphasis, links and backslash
 *  escapes, everything else escaped. Plain runs are copied whole; only the
 *  characters the scan stops at are ever handled one by one. */
function inline(s, ctx) {
  const saved = SCAN_RE.lastIndex;
  SCAN_RE.lastIndex = 0;
  let out = '';
  let run = 0;
  let m;
  while ((m = SCAN_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash: an escapable next character is written (escaped); any
      // other backslash stays in the plain run
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        if (j > run) out += s.slice(run, j);
        out += nx === '>' ? '&gt;' : nx;
        run = j + 2;
        SCAN_RE.lastIndex = j + 2;
      }
      continue;
    }
    if (c === 96) {
      // code span: a closer past the next character, else a literal backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > run) out += s.slice(run, j);
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        run = k + 1;
        SCAN_RE.lastIndex = k + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findStrongClose(s, j + 2);
        if (k > j + 2) {
          if (j > run) out += s.slice(run, j);
          SCAN_RE.lastIndex = k + 2;
          out += '<strong>' + inline(s.slice(j + 2, k), ctx) + '</strong>';
          run = k + 2;
        } else {
          SCAN_RE.lastIndex = j + 2; // a literal "**", both stars skipped
        }
      } else {
        const k = findEmClose(s, j + 1);
        if (k > j + 1) {
          if (j > run) out += s.slice(run, j);
          SCAN_RE.lastIndex = k + 1;
          out += '<em>' + inline(s.slice(j + 1, k), ctx) + '</em>';
          run = k + 1;
        }
      }
      continue;
    }
    if (c === 91) {
      // [text](target): the first unescaped "]", "(" at once after it, the
      // next ")" closing a target that is not empty and holds no whitespace
      const k = findBracketClose(s, j + 1);
      const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > run) out += s.slice(run, j);
        SCAN_RE.lastIndex = q + 1;
        out += '<a href="' + esc(resolveLink(target, ctx)) + '">' + inline(s.slice(j + 1, k), ctx) + '</a>';
        run = q + 1;
      }
      continue;
    }
    // & < > " ' — the entity, and the plain run before it
    if (j > run) out += s.slice(run, j);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    run = j + 1;
  }
  if (run < s.length) out += s.slice(run);
  SCAN_RE.lastIndex = saved;
  return out;
}

// --------------------------------------------------------------- link targets

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source,
 *  or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link's href: a target with a scheme, opening on "/" or "#", is kept as
 *  written; any other names a page built from that source, or a static file,
 *  its fragment after it; one naming neither is reported broken and kept. */
function resolveLink(target, ctx) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolveRel(ctx.dir, rel);
  if (path !== null) {
    const page = ctx.bySource.get(path);
    if (page !== undefined) return page.url + frag;
    if (ctx.statics.has(path)) return ctx.base + '/' + path + frag;
  }
  ctx.broken.add('broken-link ' + ctx.src + ' -> ' + target);
  return target;
}

// ------------------------------------------------------------- block rendering

/** `src` rendered: its HTML (each block on its own lines, a "\n" after the
 *  last), its table of contents (every level 2 and 3 heading: level, id and
 *  its inline HTML) and its excerpt (the first paragraph's inline HTML, or
 *  ""). Lexing and rendering run in one pass; no token objects are built. */
function mdRender(src, ctx) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        let code = '';
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          code += esc(lines[i]);
          code += '\n';
          i++;
        }
        i++;
        blocks.push(
          lang === ''
            ? '<pre><code>' + code + '</code></pre>'
            : '<pre><code class="language-' + lang + '">' + code + '</code></pre>',
        );
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingParse(line);
      if (h !== null) {
        const id = uniqSlug(slugOf(h.text), ids);
        const html = inline(h.text, ctx);
        blocks.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const t = trimST(lines[i].charCodeAt(1) === 32 ? lines[i].slice(2) : lines[i].slice(1));
        if (t !== '') q.push(t);
        i++;
      }
      blocks.push(
        q.length === 0
          ? '<blockquote>\n</blockquote>'
          : '<blockquote>\n<p>' + inline(q.join('\n'), ctx) + '</p>\n</blockquote>',
      );
      continue;
    }
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimST(l.slice(2))]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
        } else break;
      }
      let b = '<ul>\n';
      for (let k = 0; k < items.length; k++) b += '<li>' + inline(items[k].join('\n'), ctx) + '</li>\n';
      blocks.push(b + '</ul>');
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const o = orderedParse(line);
      if (o !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const mo = orderedParse(l);
          if (mo !== null) {
            items.push([trimST(mo.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimST(l));
            i++;
          } else break;
        }
        let b = o.num !== 1 ? '<ol start="' + o.num + '">\n' : '<ol>\n';
        for (let k = 0; k < items.length; k++) b += '<li>' + inline(items[k].join('\n'), ctx) + '</li>\n';
        blocks.push(b + '</ol>');
        continue;
      }
    }
    const parts = [trimST(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      parts.push(trimST(lines[i]));
      i++;
    }
    const html = inline(parts.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs (or is empty). */
function allST(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: [0, text], [1, path] for {{ }}, [2, path] for {{{ }}},
 *  [3, tag] for {% %}; a standalone tag's line is taken with it. Tokenising
 *  runs whole before the tree is built, so a token error anywhere beats a
 *  tree error anywhere, as the reference does. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (text !== '') tokens.push([0, text]);
      text = '';
      tokens.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = allST(src.slice(lineStart, open)) && allST(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push([0, text]);
    text = '';
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push([0, text]);
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not
 *  parse). Nodes are small arrays, switched on by their first element:
 *  0 text [0, string], 1 var [1, path], 2 raw [2, path],
 *  3 if [3, not, path, then, else|null], 4 for [4, name, path, body],
 *  5 include [5, name]. The root is [6, body] and exists only while parsing. */
function parseTemplate(name, src) {
  const tokens = tokenize(name, src);
  const root = [6, []];
  const stack = [root];
  let body = root[1];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    const k = tok[0];
    if (k === 0) {
      body.push([0, tok[1]]);
      continue;
    }
    if (k === 1 || k === 2) {
      body.push([k, tok[1]]);
      continue;
    }
    const tag = tok[1];
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [4, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if (tag === 'else') {
      if (top[0] !== 3 || top[4] !== null) {
        throw new TemplateError('template "' + name + '": an else outside an if');
      }
      top[4] = [];
      body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 4 : 3;
      if (top[0] !== want) {
        throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent[0] === 6 ? parent[1] : parent[0] === 4 ? parent[3] : parent[4] === null ? parent[3] : parent[4];
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push([5, m[1]]);
    } else {
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError('template "' + name + '": a ' + (top[0] === 4 ? 'for' : 'if') + ' is not closed');
  }
  return root[1];
}

/** A value as text: a string itself, a number in JavaScript's digits, true
 *  or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "",
 *  0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope: its first name an own property of the
 *  scope object (loop variables are written into it and restored after the
 *  loop), then own properties of the value so far. */
function lookup(scope, path) {
  if (!Object.hasOwn(scope, path[0])) return undefined;
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** `nodes` rendered into `parts`, in the scope object. A for-loop writes its
 *  element and its loop record into the scope and restores what was there
 *  before when it ends (a name the scope did not hold is left undefined,
 *  which reads exactly as absent), so a lookup is one property read; the
 *  save and restore nest correctly when the same node runs inside itself
 *  through an include. The loop record is one object per execution, its
 *  fields rewritten each iteration. */
function renderNodes(nodes, scope, ctx, depth, parts) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const kind = nd[0];
    if (kind === 0) {
      parts.push(nd[1]);
      continue;
    }
    if (kind === 1) {
      const v = lookup(scope, nd[1]);
      parts.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
      continue;
    }
    if (kind === 2) {
      const v = lookup(scope, nd[1]);
      parts.push(typeof v === 'string' ? v : textOf(v));
      continue;
    }
    if (kind === 3) {
      const br = truthy(lookup(scope, nd[2])) !== nd[1] ? nd[3] : nd[4];
      if (br !== null) renderNodes(br, scope, ctx, depth, parts);
      continue;
    }
    if (kind === 4) {
      const xs = lookup(scope, nd[2]);
      if (!Array.isArray(xs)) continue;
      const name = nd[1];
      const prevName = scope[name];
      const prevLoop = scope.loop;
      const loop = { index: 0, first: false, last: false, length: xs.length };
      for (let x = 0; x < xs.length; x++) {
        scope[name] = xs[x];
        scope.loop = loop;
        loop.index = x + 1;
        loop.first = x === 0;
        loop.last = x === xs.length - 1;
        renderNodes(nd[3], scope, ctx, depth, parts);
      }
      scope[name] = prevName;
      scope.loop = prevLoop;
      continue;
    }
    // include: the template rendered in the same scope, at most 8 deep
    const t = ctx.templates.get(nd[1]);
    if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, parts);
  }
}

/** A render's scope object: null-prototype, so a loop variable named
 *  "__proto__" lands as an own property, not on the scope's prototype. */
function scopeOf(site, tags, recent, extra) {
  const s = Object.create(null);
  s.site = site;
  s.tags = tags;
  s.recent = recent;
  if (extra !== undefined) {
    const keys = Object.keys(extra);
    for (let i = 0; i < keys.length; i++) s[keys[i]] = extra[keys[i]];
  }
  return s;
}

/** Template `name` rendered over `topVars`, or null when it is missing. The
 *  scope object is fresh per render, so a loop's writes never leak into the
 *  next render. */
function renderTemplate(name, topVars, ctx) {
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return null;
  const parts = [];
  renderNodes(nodes, topVars, ctx, 0, parts);
  return parts.join('');
}

// ------------------------------------------------------------------- pipeline

/** A path's directory: up to its last "/", or "". */
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** A source's tags, each slug once (the first spelling kept), in its own
 *  order. */
function ownTags(s) {
  const list = s.data.tags;
  if (list === undefined) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const slug = slugOf(list[i]);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(list[i]);
    }
  }
  return out;
}

/** A page's link record as templates read it. Built once per post and shared:
 *  the same record is a post's newer link in one page and its older link in
 *  another. */
function linkOf(s) {
  if (s === null) return null;
  let link = s.link;
  if (link === undefined) {
    link = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    };
    s.link = link;
  }
  return link;
}

/** A post's card, as lists show it. A tag's {name, slug, url} view is built
 *  once per tag and shared by every card that lists it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.view),
  };
}

/** A page as its layout reads it. A post reuses the card the lists already
 *  built for it — the same values, without counting its words twice. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer !== undefined ? s.newer : null),
    older: linkOf(s.older !== undefined ? s.older : null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  SLUGS = new Map();
  const report = [];
  const templates = new Map();
  const tnames = Object.keys(input.templates).sort(cmpStr);
  for (let i = 0; i < tnames.length; i++) {
    const name = tnames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  //    a source that is not .md is static.
  const files = [...input.files].sort((a, b) => cmpStr(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  //    and so is a draft. The checks run in order; the first that fails is
  //    the one reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFM(s.text);
    if (fm.error !== undefined) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    s.srcDir = dirOf(s.path);
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  //    directory, in source order.
  const bySource = new Map();
  const takenByDir = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : s.srcDir;
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqSlug(s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  //    files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const ctx = {
    templates,
    dir: '',
    src: '',
    bySource,
    statics: staticPaths,
    base,
    broken: new Set(),
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    ctx.dir = s.srcDir;
    ctx.src = s.path;
    const md = mdRender(s.body, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older
  //    neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the
  //    posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let k = 0; k < names.length; k++) {
      const slug = slugOf(names[k]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[k], slug, url: base + '/tags/' + slug + '/', posts: [] };
        tag.view = { name: tag.name, slug: tag.slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    const refs = [];
    for (let k = 0; k < names.length; k++) {
      const slug = slugOf(names[k]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[k], slug, url: '', posts: [] };
        tag.view = { name: tag.name, slug: tag.slug, url: '' };
      }
      refs.push(tag);
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  //    through theirs, then each static file at its own path.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = renderTemplate(
      s.layout,
      scopeOf(site, allTags, recent, { page: pageOf(s, cards) }),
      ctx,
    );
  }
  const per = input.site.per_page;
  const npages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= npages; k++) {
    const html = renderTemplate(
      'index',
      scopeOf(site, allTags, recent, {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: {
          number: k,
          total: npages,
          url: indexUrl(k),
          newer_url: k === 1 ? '' : indexUrl(k - 1),
          older_url: k === npages ? '' : indexUrl(k + 1),
        },
      }),
      ctx,
    );
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = renderTemplate(
      'tag',
      scopeOf(site, allTags, recent, {
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
      }),
      ctx,
    );
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderTemplate('tags', scopeOf(site, allTags, recent), ctx);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  //    not parse, sorted, then the counts.
  const lines = [...report, ...ctx.broken].sort(cmpStr);
  let npagesCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) npagesCount++;
  lines.push(
    'built ' + npagesCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files',
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
