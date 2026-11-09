// Screenshots are the bulk of a computer-use replay, and they are replayed on
// every turn. Dropping the old ones is one answer; losing the pixels entirely is a
// worse answer than keeping them at a lower resolution, because the model can still
// see what the screen looked like. This module re-encodes a screenshot smaller —
// a box filter over the pixels, then a fresh PNG — with no native dependency.
//
// Only the pixel formats a browser screenshot actually uses are decoded (8-bit,
// non-interlaced, gray/RGB/palette/gray+alpha/RGBA). Anything else is left exactly
// as it arrived: an image this module does not understand must never be corrupted.
import { deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) return null;
    chunks.push({ type, data: buffer.subarray(start, end) });
    offset = end + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}

// Undo the per-scanline filters in place of the raw stream. `bpp` is the distance to
// the pixel on the left, which is one byte for palette and gray+alpha is two.
function unfilter(raw, pixels, stride, bpp, height) {
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const line = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const left = x >= bpp ? pixels[line + x - bpp] : 0;
      const up = y > 0 ? pixels[line - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[line - stride + x - bpp] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paethPredictor(left, up, upLeft); break;
        default: return false;
      }
      pixels[line + x] = restored & 0xff;
    }
  }
  return true;
}

// Everything is expanded to RGBA so the downscale has one representation to work
// with; the encoder then writes RGB back when nothing is translucent.
export function decodePng(buffer) {
  const chunks = readChunks(buffer);
  if (!chunks) return null;
  const header = chunks.find(entry => entry.type === 'IHDR');
  if (!header || header.data.length < 13) return null;
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8];
  const colorType = header.data[9];
  const compression = header.data[10];
  const filterMethod = header.data[11];
  const interlace = header.data[12];
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) return null;
  const channels = channelCount[colorType];
  if (!channels || !width || !height) return null;
  const palette = chunks.find(entry => entry.type === 'PLTE');
  if (colorType === 3 && !palette) return null;
  const transparency = chunks.find(entry => entry.type === 'tRNS');
  const compressed = Buffer.concat(chunks.filter(entry => entry.type === 'IDAT').map(entry => entry.data));
  let raw;
  try { raw = inflateSync(compressed); } catch { return null; }
  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  if (!unfilter(raw, pixels, stride, bpp, height)) return null;
  const rgba = Buffer.alloc(width * height * 4);
  let opaque = true;
  for (let index = 0, source = 0; index < rgba.length; index += 4, source += bpp) {
    let red;
    let green;
    let blue;
    let alpha = 255;
    if (colorType === 0) { red = green = blue = pixels[source]; }
    else if (colorType === 2) { red = pixels[source]; green = pixels[source + 1]; blue = pixels[source + 2]; }
    else if (colorType === 3) {
      const entry = pixels[source] * 3;
      if (entry + 2 >= palette.data.length) return null;
      red = palette.data[entry]; green = palette.data[entry + 1]; blue = palette.data[entry + 2];
      if (transparency && pixels[source] < transparency.data.length) alpha = transparency.data[pixels[source]];
    } else if (colorType === 4) { red = green = blue = pixels[source]; alpha = pixels[source + 1]; }
    else { red = pixels[source]; green = pixels[source + 1]; blue = pixels[source + 2]; alpha = pixels[source + 3]; }
    rgba[index] = red; rgba[index + 1] = green; rgba[index + 2] = blue; rgba[index + 3] = alpha;
    if (alpha !== 255) opaque = false;
  }
  return { width, height, data: rgba, opaque };
}

export function encodePng({ width, height, data, opaque = false }) {
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    let target = y * (stride + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      raw[target] = data[source];
      raw[target + 1] = data[source + 1];
      raw[target + 2] = data[source + 2];
      if (!opaque) raw[target + 3] = data[source + 3];
      target += channels;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Box filter: every output pixel is the mean of the block it covers. Averaging keeps
// text legible at half size far better than picking one pixel out of the block.
export function downscale(image, factor) {
  const step = Math.max(2, Math.floor(factor));
  const width = Math.max(1, Math.floor(image.width / step));
  const height = Math.max(1, Math.floor(image.height / step));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;
      const top = y * step;
      const left = x * step;
      for (let sourceY = top; sourceY < Math.min(top + step, image.height); sourceY += 1) {
        for (let sourceX = left; sourceX < Math.min(left + step, image.width); sourceX += 1) {
          const source = (sourceY * image.width + sourceX) * 4;
          red += image.data[source];
          green += image.data[source + 1];
          blue += image.data[source + 2];
          alpha += image.data[source + 3];
          count += 1;
        }
      }
      const target = (y * width + x) * 4;
      data[target] = Math.round(red / count);
      data[target + 1] = Math.round(green / count);
      data[target + 2] = Math.round(blue / count);
      data[target + 3] = Math.round(alpha / count);
    }
  }
  return { width, height, data, opaque: image.opaque };
}

const dataUrlPattern = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i;

export function isPngDataUrl(value) {
  return typeof value === 'string' && dataUrlPattern.test(value.trim());
}

// Returns a smaller data URL, or null when this image is not one this module can
// rewrite, or when rewriting it would not actually save bytes.
export function shrinkPngDataUrl(value, factor = 2) {
  if (!isPngDataUrl(value)) return null;
  const match = dataUrlPattern.exec(value.trim());
  let decoded;
  try { decoded = Buffer.from(match[1].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (decoded.length < 1024) return null;
  const image = decodePng(decoded);
  if (!image) return null;
  if (image.width < 64 || image.height < 64) return null;
  const smaller = downscale(image, factor);
  const encoded = encodePng(smaller);
  if (encoded.length >= decoded.length) return null;
  return `data:image/png;base64,${encoded.toString('base64')}`;
}
