/** Test images: a valid PNG of any size (zlib only), and JPEG-magic bytes of an exact length (staging checks magic only). */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A decodable RGB PNG; `noise` fills it with pseudo-random pixels so it barely compresses. */
export function png(width: number, height: number, noise = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let x = 0x12345678;
  for (let row = 0; row < height; row++) {
    const at = row * (width * 3 + 1);
    raw[at] = 0;
    for (let i = 1; i <= width * 3; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      raw[at + i] = noise ? x & 0xff : (row * 7 + i) & 0xff;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

/** `n` bytes that start with JPEG magic. */
export function jpegBytes(n: number, fill = 0x5a): Buffer {
  const body = Buffer.alloc(n, fill);
  body.set([0xff, 0xd8, 0xff, 0xe0]);
  return body;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
