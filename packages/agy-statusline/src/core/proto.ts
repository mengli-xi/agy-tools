const textDecoder = new TextDecoder('utf-8', { fatal: false });
const textEncoder = new TextEncoder();

export type ProtoValue = number | Uint8Array;

export function parseProto(buf: Uint8Array): Map<number, ProtoValue> {
  let i = 0;
  const out = new Map<number, ProtoValue>();
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > buf.length) break;
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

export function readUtf8(val: ProtoValue | string | undefined): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (val instanceof Uint8Array) return textDecoder.decode(val);
  return '';
}

export function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(value));
  while (v >= 0x80) {
    bytes.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
  return bytes;
}

export function encodeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint(fieldNumber * 8 + wireType);
}

export function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  return Uint8Array.from([...encodeTag(fieldNumber, 0), ...encodeVarint(value)]);
}

export function encodeBytesField(fieldNumber: number, payload: Uint8Array | string): Uint8Array {
  const raw = typeof payload === 'string' ? textEncoder.encode(payload) : payload;
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(raw.length);
  const out = new Uint8Array(tag.length + len.length + raw.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(raw, tag.length + len.length);
  return out;
}

export function concatProtoFields(fields: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of fields) total += f.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of fields) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
