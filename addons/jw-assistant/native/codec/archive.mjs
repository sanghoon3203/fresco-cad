// MFC CArchive primitives (TN002). Tags: 0 null, 0xFFFF new class, 0x8000|pid old class, 0x7FFF + DWORD big pid.
// PIDs are shared by classes and objects and start at 1.
export const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };
export const NULL_TAG = 0, NEW_CLASS = 0xffff, CLASS_TAG = 0x8000, BIG_OBJECT = 0x7fff, BIG_CLASS = 0x80000000;

let sjis;
const sjisDecoder = () => sjis ??= new TextDecoder('shift_jis', { fatal: true });
let encodeTable;
// CP932 reverse table built from the platform decoder. ED/EE (NEC-selected IBM) are visited last so
// U+7E8A etc. map to FAxx like Windows WideCharToMultiByte; first hit otherwise wins (81CA over EEF9).
function cp932Table() {
  if (encodeTable) return encodeTable;
  const table = new Map(), d = new TextDecoder('shift_jis', { fatal: true }), pair = Buffer.alloc(2);
  for (let b = 0; b < 0x80; b++) table.set(b, b);
  for (let b = 0xa1; b <= 0xdf; b++) table.set(d.decode(Buffer.of(b)).codePointAt(0), b);
  const leads = [];
  for (let b = 0x81; b <= 0xfc; b++) if (b < 0xa0 || b >= 0xe0) leads.push(b);
  leads.sort((a, b) => (a === 0xed || a === 0xee) - (b === 0xed || b === 0xee) || a - b);
  for (const lead of leads) for (let t = 0x40; t <= 0xfc; t++) {
    if (t === 0x7f) continue;
    pair[0] = lead; pair[1] = t;
    let s; try { s = d.decode(pair); } catch { continue; }
    const cp = s.codePointAt(0);
    if (s.length === 1 && !table.has(cp)) table.set(cp, lead << 8 | t);
  }
  return encodeTable = table;
}
export function encodeCp932(text) {
  const table = cp932Table(), out = [];
  for (const ch of text) {
    const code = table.get(ch.codePointAt(0));
    if (code === undefined) return null;
    if (code > 0xff) out.push(code >> 8, code & 0xff); else out.push(code);
  }
  return Buffer.from(out);
}
export const decodeCp932 = bytes => { try { return sjisDecoder().decode(bytes); } catch { return new TextDecoder('shift_jis').decode(bytes); } };

function lengthPrefix(n) {
  if (n < 0xff) return Buffer.of(n);
  if (n < 0xfffe) { const b = Buffer.alloc(3); b[0] = 0xff; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(7); b[0] = 0xff; b.writeUInt16LE(0xffff, 1); b.writeUInt32LE(n, 3); return b;
}
// Canonical MFC CString bytes; CP932 when representable, else Unicode (FF FE FF prefix + UTF-16LE).
export function encodeCString(text, { unicode = false } = {}) {
  const ansi = unicode ? null : encodeCp932(text);
  if (ansi) return Buffer.concat([lengthPrefix(ansi.length), ansi]);
  const wide = Buffer.from(text, 'utf16le');
  return Buffer.concat([Buffer.of(0xff, 0xfe, 0xff), lengthPrefix(wide.length / 2), wide]);
}

export class Reader {
  constructor(bytes, offset = 0) { this.b = bytes; this.o = offset; this.pids = [null]; }
  need(n) { if (this.o + n > this.b.length) fail('E_JWW_TRUNCATED', `offset ${this.o}+${n}`); const o = this.o; this.o += n; return o; }
  u8() { return this.b[this.need(1)]; }
  u16() { return this.b.readUInt16LE(this.need(2)); }
  u32() { return this.b.readUInt32LE(this.need(4)); }
  i32() { return this.b.readInt32LE(this.need(4)); }
  i64() { return this.b.readBigInt64LE(this.need(8)); }
  f64() { return this.b.readDoubleLE(this.need(8)); }
  bytes(n) { const o = this.need(n); return this.b.subarray(o, o + n); }
  count() {
    const w = this.u16(); if (w !== 0xffff) return w;
    const d = this.u32(); if (d !== 0xffffffff) return d;
    return Number(this.i64());
  }
  cstring() {
    const start = this.o;
    let unicode = false, n = this.u8();
    if (n === 0xff) {
      n = this.u16();
      if (n === 0xfffe) { unicode = true; n = this.u8(); if (n === 0xff) n = this.u16(); }
      if (n === 0xffff) n = this.u32();
    }
    const body = this.bytes(unicode ? n * 2 : n);
    return { text: unicode ? body.toString('utf16le') : decodeCp932(body), raw: this.b.subarray(start, this.o), unicode };
  }
  // Returns { kind:'null'|'new'|'class'|'object', pid, name, schema, tagBytes }.
  tag() {
    const start = this.o, w = this.u16();
    let tag;
    if (w === NULL_TAG) tag = { kind: 'null' };
    else if (w === NEW_CLASS) {
      const schema = this.u16(), len = this.u16(), name = this.bytes(len).toString('latin1');
      const pid = this.pids.length; this.pids.push({ kind: 'class', name, schema });
      tag = { kind: 'new', pid, name, schema };
    } else {
      const big = w === BIG_OBJECT, v = big ? this.u32() : ((w & CLASS_TAG) << 16 | (w & ~CLASS_TAG)) >>> 0;
      const isClass = (v & BIG_CLASS) !== 0, pid = (v & ~BIG_CLASS) >>> 0, entry = this.pids[pid];
      if (!entry || (entry.kind === 'class') !== isClass) fail('E_JWW_TAG', `pid ${pid} at ${start}`);
      tag = isClass ? { kind: 'class', pid, name: entry.name, schema: entry.schema } : { kind: 'object', pid };
      tag.big = big;
    }
    tag.tagBytes = this.b.subarray(start, this.o);
    return tag;
  }
  registerObject(name) { const pid = this.pids.length; this.pids.push({ kind: 'object', name }); return pid; }
}

export class Writer {
  constructor(size = 1 << 16) { this.b = Buffer.alloc(size); this.o = 0; this.classes = new Map(); this.nextPid = 1; }
  room(n) { if (this.o + n > this.b.length) { const next = Buffer.alloc(Math.max(this.b.length * 2, this.o + n)); this.b.copy(next, 0, 0, this.o); this.b = next; } const o = this.o; this.o += n; return o; }
  // room() may reallocate this.b, so it must run before this.b is dereferenced.
  u8(v) { const o = this.room(1); this.b[o] = v; }
  u16(v) { const o = this.room(2); this.b.writeUInt16LE(v, o); }
  u32(v) { const o = this.room(4); this.b.writeUInt32LE(v >>> 0, o); }
  i32(v) { const o = this.room(4); this.b.writeInt32LE(v, o); }
  i64(v) { const o = this.room(8); this.b.writeBigInt64LE(BigInt(v), o); }
  f64(v) { const o = this.room(8); this.b.writeDoubleLE(v, o); }
  bytes(buf) { const o = this.room(buf.length); buf.copy(this.b, o); }
  count(n) {
    if (n < 0xffff) return this.u16(n);
    this.u16(0xffff);
    if (n < 0xffffffff) return this.u32(n);
    this.u32(0xffffffff); this.i64(n);
  }
  cstring(text, raw) { this.bytes(raw ?? encodeCString(text)); }
  pidTag(pid, isClass) {
    if (pid < BIG_OBJECT) this.u16(isClass ? CLASS_TAG | pid : pid);
    else { this.u16(BIG_OBJECT); this.u32(isClass ? (BIG_CLASS | pid) >>> 0 : pid); }
  }
  // WriteObject for a not-yet-stored object: class tag (defining the class on first use), then object pid.
  beginObject(name, schema) {
    const known = this.classes.get(name);
    if (known) this.pidTag(known.pid, true);
    else {
      this.u16(NEW_CLASS); this.u16(schema); this.u16(name.length); this.bytes(Buffer.from(name, 'latin1'));
      this.classes.set(name, { pid: this.nextPid++, schema });
    }
    return this.nextPid++;
  }
  result() { return Buffer.from(this.b.subarray(0, this.o)); }
}
