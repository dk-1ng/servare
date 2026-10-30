// Turns the private data stream (stream_type 0x06) of an MPEG-TS file into a timed ID3
// metadata stream: the PMT entry gets stream_type 0x15 (metadata in PES packets) and a
// metadata_descriptor whose format identifier is 'ID3 '. Written from ISO/IEC 13818-1
// (section 2.4.4.8 for the PMT, 2.6.58-2.6.60 for the metadata descriptors, Annex A for the
// CRC). Synthetic test fixtures only. Usage: node ts-metadata.mjs <in.ts> <out.ts>
import { readFileSync, writeFileSync } from 'node:fs';

const PACKET = 188;
const PRIVATE_DATA = 0x06;
const METADATA_IN_PES = 0x15;
const ID3 = [0x49, 0x44, 0x33, 0x20]; // 'ID3 '

// metadata_descriptor (tag 0x26): application format and format both "identified by the next
// 32 bits" (0xFFFF / 0xFF), service id 0, no decoder config, no DSM-CC, reserved bits set.
const METADATA_DESCRIPTOR = [0x26, 13, 0xff, 0xff, ...ID3, 0xff, ...ID3, 0x00, 0x0f];

/** CRC-32 of MPEG-2 sections: polynomial 0x04C11DB7, initial value all ones, no reflection. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

/** Offset of the payload in a transport packet, or -1 when it carries none. */
function payloadOffset(ts, at) {
  const control = (ts[at + 3] >> 4) & 0x3;
  if (control === 0x1) return at + 4;
  if (control === 0x3) return at + 5 + ts[at + 4];
  return -1;
}

/** The section that starts in a packet with payload_unit_start_indicator set. */
function sectionStart(ts, at) {
  const payload = payloadOffset(ts, at);
  if (payload < 0) return -1;
  return payload + 1 + ts[payload]; // skip pointer_field and the bytes it points over
}

function pidOf(ts, at) {
  return ((ts[at + 1] & 0x1f) << 8) | ts[at + 2];
}

function startsUnit(ts, at) {
  return (ts[at + 1] & 0x40) !== 0;
}

function checkCrc(section, what) {
  const body = section.subarray(0, section.length - 4);
  const stored = new DataView(section.buffer, section.byteOffset).getUint32(section.length - 4);
  if (crc32(body) !== stored) throw new Error(`${what}: CRC mismatch`);
}

function sectionAt(ts, start) {
  const length = ((ts[start + 1] & 0x0f) << 8) | ts[start + 2];
  return ts.subarray(start, start + 3 + length);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node ts-metadata.mjs <in.ts> <out.ts>');
  process.exit(2);
}
const ts = new Uint8Array(readFileSync(input));
if (ts.length % PACKET !== 0) throw new Error('not a whole number of transport packets');

// The PAT (PID 0) names the PMT of the one program.
let pmtPid = -1;
for (let at = 0; at < ts.length && pmtPid < 0; at += PACKET) {
  if (ts[at] !== 0x47) throw new Error(`lost sync at ${at}`);
  if (pidOf(ts, at) !== 0 || !startsUnit(ts, at)) continue;
  const pat = sectionAt(ts, sectionStart(ts, at));
  checkCrc(pat, 'PAT');
  for (let entry = 8; entry < pat.length - 4; entry += 4) {
    const program = (pat[entry] << 8) | pat[entry + 1];
    if (program !== 0) pmtPid = ((pat[entry + 2] & 0x1f) << 8) | pat[entry + 3];
  }
}
if (pmtPid < 0) throw new Error('no PMT found');

let rewritten = 0;
for (let at = 0; at < ts.length; at += PACKET) {
  if (pidOf(ts, at) !== pmtPid || !startsUnit(ts, at)) continue;
  const start = sectionStart(ts, at);
  const pmt = sectionAt(ts, start);
  if (pmt[0] !== 0x02) throw new Error('PMT PID carries another table');
  if (start + pmt.length > at + PACKET) throw new Error('PMT spans packets');
  checkCrc(pmt, 'PMT');

  const programInfoLength = ((pmt[10] & 0x0f) << 8) | pmt[11];
  const out = [...pmt.subarray(0, 12 + programInfoLength)];
  let changed = false;
  for (let entry = 12 + programInfoLength; entry < pmt.length - 4;) {
    const infoLength = ((pmt[entry + 3] & 0x0f) << 8) | pmt[entry + 4];
    const info = [...pmt.subarray(entry + 5, entry + 5 + infoLength)];
    let type = pmt[entry];
    if (type === PRIVATE_DATA) {
      type = METADATA_IN_PES;
      info.push(...METADATA_DESCRIPTOR);
      changed = true;
    }
    out.push(
      type,
      pmt[entry + 1],
      pmt[entry + 2],
      (pmt[entry + 3] & 0xf0) | (info.length >> 8),
      info.length & 0xff,
      ...info,
    );
    entry += 5 + infoLength;
  }
  if (!changed) throw new Error('the PMT has no private data stream to retag');

  // section_length counts everything after itself, CRC included.
  const sectionLength = out.length - 3 + 4;
  out[1] = (out[1] & 0xf0) | (sectionLength >> 8);
  out[2] = sectionLength & 0xff;
  const crc = crc32(out);
  out.push(crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  if (start + out.length > at + PACKET) throw new Error('the new PMT does not fit its packet');
  ts.set(out, start);
  ts.fill(0xff, start + out.length, at + PACKET); // stuffing after the section
  rewritten++;
}
if (rewritten === 0) throw new Error('no PMT section rewritten');
writeFileSync(output, ts);
