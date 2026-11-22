// Swiftpage — a fast drop-in for makefun-site 1.0.0.
//
// A from-scratch, dependency-free reimplementation of make.fun's static site
// generator (makefun-site 1.0.0): the same front matter, template dialect,
// Markdown subset, slug rule and build report, byte for byte — but written
// for speed. `run(input)` returns the output tree makefun-site's `build`
// returns for one case's input.
//
// Where the speed comes from:
//  - Markdown is lexed and rendered in a single pass over the source lines,
//    dispatching on the first character instead of running a regex per line,
//    and the body's word count is taken in the same walk, so the body text
//    is scanned once instead of twice.
//  - Inline markup renders in one left-to-right scan that escapes HTML as it
//    goes; plain stretches are copied whole, never character by character.
//  - Slugs and long dates are cached per case, and pure-ASCII text skips
//    Unicode normalisation entirely.
//  - Templates are tokenised and parsed into compact node arrays and
//    rendered by a small recursive interpreter over a scope stack, with each
//    page's chunks joined once.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether the UTF-16 code unit `c` is JavaScript whitespace (\s). */
function isWs(c) {
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of one line: its runs of characters other than whitespace. */
function wordsIn(line) {
  let n = 0;
  let w = false;
  for (let i = 0; i < line.length; i++) {
    if (isWs(line.charCodeAt(i))) w = false;
    else if (!w) {
      w = true;
      n++;
    }
  }
  return n;
}

/** Whether `s` holds any JavaScript whitespace. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

// ---------------------------------------------------------------- text

/** `text` with & < > " and ' escaped, by one scan that only copies around escapes. */
function esc(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      out += text.slice(start, i) + e;
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

/** One character escaped, or itself when it needs none. */
function escChar(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left. Pure-ASCII input skips normalisation; results are cached per case.
 */
function slugOf(text, ctx) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  ctx.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. Cached per case. */
function dateLong(date, ctx) {
  const hit = ctx.dateCache.get(date);
  if (hit !== undefined) return hit;
  const s = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  ctx.dateCache.set(date, s);
  return s;
}

// ---------------------------------------------------------------- line helpers

/** A line of spaces and tabs only (an empty line counts). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimSp(line) {
  let a = 0;
  let e = line.length;
  while (a < e && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (e > a && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(a, e);
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let k = line.length;
  while (k > j && (line.charCodeAt(k - 1) === 32 || line.charCodeAt(k - 1) === 9)) k--;
  if (j >= k) return null;
  return { depth: h, text: line.slice(j, k) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text after "- " or "* ", or null. */
function bulletRest(line) {
  if (line.length >= 2 && line.charCodeAt(1) === 32 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42)) return line.slice(2);
  return null;
}

/** An ordered item's text after "digits. ", or null. */
function orderedRest(line) {
  let d = 0;
  while (d < 9 && d < line.length) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return line.slice(d + 2);
  return null;
}

/** A list's first line: { ordered, start, rest }, or null. */
function listFirst(line) {
  const br = bulletRest(line);
  if (br !== null) return { ordered: false, start: 1, rest: br };
  let d = 0;
  while (d < 9 && d < line.length) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d > 0 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, d)), rest: line.slice(d + 2) };
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isCont(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  return !isWs(line.charCodeAt(s));
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsPara(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// ---------------------------------------------------------------- front matter

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a slug: a-z and 0-9, single "-" between. */
function isSlugVal(raw) {
  const n = raw.length;
  if (n === 0) return false;
  let i = 0;
  while (i < n) {
    let seg = 0;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) break;
      i++;
      seg++;
    }
    if (seg === 0) return false;
    if (i >= n) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
    if (i >= n) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringVal(raw);
    if (s.error !== undefined) return { error: 'key "' + key + '": ' + s.error };
    return s;
  }
  if (key === 'date') {
    const bad = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: bad };
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) return { error: bad };
    }
    const y = Number(raw.slice(0, 4));
    const mo = Number(raw.slice(5, 7));
    const d = Number(raw.slice(8, 10));
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: bad };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
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
  if (key === 'slug') {
    return isSlugVal(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: 'unknown key "' + key + '"' };
}

/**
 * A source's front matter and body: { data, bodyStart }, or { error } with
 * the first reason it is refused. `lines` is the source split on "\n".
 */
function parseFm(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let keyOk = true;
    for (let k = 0; k < ci; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = line.slice(0, ci);
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let re = raw.length;
    while (re > 0 && (raw.charCodeAt(re - 1) === 32 || raw.charCodeAt(re - 1) === 9)) re--;
    raw = raw.slice(0, re);
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: 'unknown key "' + key + '"' };
    }
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target's href: kept as written, or resolved to the page or static file it names. */
function resolveLink(ctx, dir, src, target) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const h = target.indexOf('#');
  const rel = h === -1 ? target : target.slice(0, h);
  const frag = h === -1 ? '' : target.slice(h);
  const path = rel === '' ? null : resolveRel(dir, rel);
  if (path !== null && ctx.bySource.has(path)) return ctx.bySource.get(path).url + frag;
  if (path !== null && ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  ctx.broken.add('broken-link ' + src + ' -> ' + target);
  return target;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, in one left-to-right pass: backslash escapes, code
 * spans, strong, emphasis and links, with HTML escaping folded into the pass
 * (plain runs are pushed whole; only markup and the five escaped characters
 * break them).
 */
function inlineMd(s, ctx, dir, src) {
  // No markup at all: only HTML escaping is needed.
  if (!/[\\`*\[]/.test(s)) return esc(s);
  const n = s.length;
  const out = [];
  let i = 0;
  let start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // Backslash: an escapable character after it is written (escaped).
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > start) out.push(s.slice(start, i));
        out.push(escChar(s[i + 1]));
        i += 2;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      // Backtick: a code span closed by the next backtick, with at least one character between.
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>' + esc(s.slice(i + 1, j)) + '</code>');
        i = j + 1;
        start = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      // Star: ** opens strong, a single * opens emphasis; with no closer the mark is itself.
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>' + inlineMd(s.slice(i + 2, j), ctx, dir, src) + '</strong>');
          i = j + 2;
          start = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>' + inlineMd(s.slice(i + 1, j), ctx, dir, src) + '</em>');
        i = j + 1;
        start = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      // Bracket: [text](target), the first unescaped ] closing the text.
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="' + esc(resolveLink(ctx, dir, src, target)) + '">' + inlineMd(s.slice(i + 1, k), ctx, dir, src) + '</a>');
        i = m + 1;
        start = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out.push(s.slice(start, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
      start = i;
      continue;
    }
    i++;
  }
  if (n > start) out.push(s.slice(start, n));
  return out.join('');
}

/**
 * The body's lines from `start` rendered in one walk: its HTML (each block
 * on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML), its excerpt (the
 * first paragraph's inline HTML, or "") and its word count. Every body line
 * is visited exactly once, so the word count rides along for free.
 */
function renderBody(lines, start, ctx, dir, src) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    words += wordsIn(line);
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) {
        words += wordsIn(lines[i]);
        body.push(lines[i++]);
      }
      if (i < n) {
        words += wordsIn(lines[i]);
        i++;
      }
      let inner = '';
      for (let k = 0; k < body.length; k++) inner += esc(body[k]) + '\n';
      blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>' + inner + '</code></pre>');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqSlug(slugOf(hd.text, ctx), ids);
      const html = inlineMd(hd.text, ctx, dir, src);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [trimSp(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1))];
      i++;
      while (i < n && lines[i].charCodeAt(0) === 62) {
        words += wordsIn(lines[i]);
        const l = lines[i++];
        body.push(trimSp(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      let joined = '';
      for (let k = 0; k < body.length; k++) {
        if (body[k] !== '') joined += (joined === '' ? '' : '\n') + body[k];
      }
      blocks.push(joined === '' ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inlineMd(joined, ctx, dir, src) + '</p>\n</blockquote>');
      continue;
    }
    const lm = listFirst(line);
    if (lm !== null) {
      // The first line was already counted above; take its item here, then
      // walk the lines after it.
      const items = [[trimSp(lm.rest)]];
      i++;
      while (i < n) {
        const m = lm.ordered ? orderedRest(lines[i]) : bulletRest(lines[i]);
        if (m !== null) {
          words += wordsIn(lines[i]);
          items.push([trimSp(m)]);
          i++;
        } else if (isCont(lines[i])) {
          words += wordsIn(lines[i]);
          items[items.length - 1].push(trimSp(lines[i]));
          i++;
        } else break;
      }
      const tag = lm.ordered ? 'ol' : 'ul';
      const open = lm.ordered && lm.start !== 1 ? '<ol start="' + lm.start + '">' : '<' + tag + '>';
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += '<li>' + inlineMd(items[k].join('\n'), ctx, dir, src) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const body = [trimSp(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      words += wordsIn(lines[i]);
      body.push(trimSp(lines[i++]));
    }
    const html = inlineMd(body.join('\n'), ctx, dir, src);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const P_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const P_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const P_IF = /^if (not )?(\S+)$/;
const P_INC = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

// Node arrays: [0, text] text, [1, path] escaped var, [2, path] raw var,
// [3, not, path, then, else|null] if, [4, name, path, body] for,
// [5, name] include. Token arrays: [0, text] text, [1, path] var,
// [2, path] raw, [3, tag] tag.

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!P_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push([0, text]);
      text = '';
      tokens.push([raw ? 2 : 1, pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push([0, text]);
    text = '';
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push([0, text]);
  return tokens;
}

/** Tokens parsed into a tree of nodes (a TemplateError when it does not parse). */
function parseTokens(name, tokens) {
  const root = [];
  const stack = [{ body: root, kind: 0, node: null }];
  let cur = root;
  for (const tok of tokens) {
    if (tok[0] === 0) {
      cur.push([0, tok[1]]);
      continue;
    }
    if (tok[0] === 1 || tok[0] === 2) {
      cur.push([tok[0], tok[1]]);
      continue;
    }
    const tag = tok[1];
    const top = stack[stack.length - 1];
    let m;
    if ((m = P_FOR.exec(tag)) !== null) {
      const node = [4, m[1], pathParts(name, m[2]), []];
      cur.push(node);
      stack.push({ body: node[3], kind: 4, node });
      cur = node[3];
    } else if ((m = P_IF.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, pathParts(name, m[2]), [], null];
      cur.push(node);
      stack.push({ body: node[3], kind: 3, node });
      cur = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 3 || top.node[4] !== null) throw new TemplateError('template "' + name + '": an else outside an if');
      top.node[4] = [];
      top.body = top.node[4];
      cur = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 4 : 3;
      if (top.kind !== want) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      stack.pop();
      cur = stack[stack.length - 1].body;
    } else if ((m = P_INC.exec(tag)) !== null) {
      cur.push([5, m[1]]);
    } else {
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError('template "' + name + '": a ' + (top.kind === 4 ? 'for' : 'if') + ' is not closed');
  }
  return root;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  return parseTokens(name, tokenize(name, src));
}

// The renderer's working state, set per case in run(): TMPLS the parsed
// templates, SCOPES the scope stack (its bottom is the root vars ROOTV),
// IDEPTH the include depth of the render in progress.
let TMPLS;
let SCOPES;
let ROOTV;
let IDEPTH;

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(path) {
  const first = path[0];
  let v;
  for (let k = SCOPES.length - 1; k >= 0; k--) {
    // Scope objects are null-prototype, so a missing name reads undefined;
    // a name bound to undefined reads the same as absent, which matches the
    // reference: the only undefined-valued bindings are the root's
    // page/posts/pager/tag, at the bottom of the chain.
    v = SCOPES[k][first];
    if (v !== undefined) break;
    if (k === 0) return undefined;
  }
  for (let j = 1; j < path.length; j++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[j])) return undefined;
    v = v[path[j]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into the `out` chunks, in the current scope chain. */
function renderNodes(nodes, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    const k = nd[0];
    if (k === 0) {
      out.push(nd[1]);
    } else if (k === 1) {
      const v = lookup(nd[1]);
      out.push(typeof v === 'string' ? esc(v) : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : Array.isArray(v) ? esc(textOf(v)) : '');
    } else if (k === 2) {
      const v = lookup(nd[1]);
      out.push(typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : Array.isArray(v) ? textOf(v) : '');
    } else if (k === 3) {
      const br = truthy(lookup(nd[2])) !== nd[1] ? nd[3] : nd[4];
      if (br !== null) renderNodes(br, out);
    } else if (k === 4) {
      const xs = lookup(nd[2]);
      if (Array.isArray(xs)) {
        for (let j = 0; j < xs.length; j++) {
          const vars = Object.create(null);
          vars[nd[1]] = xs[j];
          vars.loop = { index: j + 1, first: j === 0, last: j === xs.length - 1, length: xs.length };
          SCOPES.push(vars);
          renderNodes(nd[3], out);
          SCOPES.pop();
        }
      }
    } else {
      const t = TMPLS.get(nd[1]);
      if (t !== undefined && IDEPTH < INCLUDE_DEPTH) {
        IDEPTH++;
        renderNodes(t, out);
        IDEPTH--;
      }
    }
  }
}

/**
 * Template `name` rendered with `vars` (page, posts, pager, tag — whichever
 * the page carries) in the root scope: its text, or null when it is missing.
 */
function renderTemplate(name, vars) {
  const nodes = TMPLS.get(name);
  if (nodes === undefined) return null;
  ROOTV.page = vars.page;
  ROOTV.posts = vars.posts;
  ROOTV.pager = vars.pager;
  ROOTV.tag = vars.tag;
  SCOPES.length = 0;
  SCOPES.push(ROOTV);
  IDEPTH = 0;
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// ---------------------------------------------------------------- the pipeline

/** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
function readSources(ctx) {
  const files = [...ctx.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      ctx.sources.push({ path: f.path, lines: text.split('\n') });
    } else ctx.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatterStep(ctx) {
  const kept = [];
  for (const s of ctx.sources) {
    const fm = parseFm(s.lines);
    if (fm.error !== undefined) {
      ctx.report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      ctx.report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      ctx.report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!TMPLS.has(layout)) {
      ctx.report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      ctx.report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  ctx.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinksStep(ctx) {
  const taken = new Map();
  for (const s of ctx.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqSlug(s.data.slug ?? slugOf(s.data.title, ctx), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = ctx.base + '/' + s.outDir + '/';
    ctx.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdownStep(ctx) {
  ctx.staticPaths = new Set(ctx.statics.map((f) => f.path));
  for (const s of ctx.sources) {
    const r = renderBody(s.lines, s.bodyStart, ctx, dirOf(s.path), s.path);
    s.html = r.html;
    s.toc = r.toc;
    s.excerpt = r.excerpt;
    s.words = r.words;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collectionsStep(ctx) {
  const posts = [];
  for (const s of ctx.sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  ctx.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

/** A source's tags as { name, slug } pairs, each slug once, in its own order. */
function tagPairs(ctx, s) {
  const seen = new Set();
  const out = [];
  const names = s.data.tags ?? [];
  for (const name of names) {
    const slug = slugOf(name, ctx);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug });
  }
  return out;
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tagsStep(ctx) {
  const bySlug = new Map();
  for (const p of ctx.posts) {
    p.tagRefs = [];
    for (const pr of tagPairs(ctx, p)) {
      let tag = bySlug.get(pr.slug);
      if (tag === undefined) {
        tag = { name: pr.name, slug: pr.slug, url: ctx.base + '/tags/' + pr.slug + '/', posts: [] };
        bySlug.set(pr.slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of ctx.sources) {
    if (s.post) continue;
    s.tagRefs = tagPairs(ctx, s).map((pr) => bySlug.get(pr.slug) ?? { name: pr.name, slug: pr.slug, url: '', posts: [] });
  }
  ctx.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(ctx, s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date, ctx) };
}

/** A post's card, as lists show it (computed once per source). */
function cardOf(ctx, s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateLong(s.data.date, ctx),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(ctx, s) {
  const c = cardOf(ctx, s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(ctx, s.newer ?? null),
    older: linkOf(ctx, s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layoutsStep(ctx) {
  const site = { title: ctx.input.site.title, base_url: ctx.base };
  const allTags = ctx.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = ctx.posts.slice(0, ctx.input.site.recent).map((p) => cardOf(ctx, p));
  ROOTV = Object.create(null);
  ROOTV.site = site;
  ROOTV.tags = allTags;
  ROOTV.recent = recent;
  ROOTV.page = undefined;
  ROOTV.posts = undefined;
  ROOTV.pager = undefined;
  ROOTV.tag = undefined;
  SCOPES = [ROOTV];
  for (const s of ctx.sources) {
    ctx.output[s.outDir + '/index.html'] = renderTemplate(s.layout, { page: pageOf(ctx, s) });
  }
  const per = ctx.input.site.per_page;
  const pages = Math.max(1, Math.ceil(ctx.posts.length / per));
  const indexUrl = (k) => (k === 1 ? ctx.base + '/' : ctx.base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderTemplate('index', {
      posts: ctx.posts.slice((k - 1) * per, k * per).map((p) => cardOf(ctx, p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) ctx.output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of ctx.tags) {
    const html = renderTemplate('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(ctx, p)) },
    });
    if (html !== null) ctx.output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderTemplate('tags', {});
  if (tagsHtml !== null) ctx.output['tags/index.html'] = tagsHtml;
  for (const f of ctx.statics) {
    if (Object.hasOwn(ctx.output, f.path)) ctx.report.push('shadowed ' + f.path + ': a built page has its path');
    else ctx.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportStep(ctx) {
  const lines = [...ctx.report, ...ctx.broken].sort(byCodeUnits);
  let pages = 0;
  for (const s of ctx.sources) if (!s.post) pages++;
  lines.push('built ' + pages + ' pages, ' + ctx.posts.length + ' posts, ' + ctx.tags.length + ' tags and ' + ctx.statics.length + ' static files');
  ctx.output['build-report.txt'] = lines.join('\n') + '\n';
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    slugCache: new Map(),
    dateCache: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    staticPaths: null,
    broken: new Set(),
    report: [],
    posts: [],
    tags: [],
    output: {},
  };
  TMPLS = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      TMPLS.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) ctx.report.push(err.message);
      else throw err;
    }
  }
  readSources(ctx);
  frontMatterStep(ctx);
  permalinksStep(ctx);
  markdownStep(ctx);
  collectionsStep(ctx);
  tagsStep(ctx);
  layoutsStep(ctx);
  reportStep(ctx);
  return ctx.output;
}
