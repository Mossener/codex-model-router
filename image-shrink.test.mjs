// A screenshot the router cannot shrink has to survive untouched: an image this
// module corrupts would be worse than one it refuses to touch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, encodePng, downscale, shrinkPngDataUrl, isPngDataUrl } from './image-shrink.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// A screenshot-shaped image: a gradient with noise, which is what makes a PNG big
// in the first place and what a palette-only test would not exercise.
function noisyPng(width, height, { colorType = 2, filter = 0 } = {}) {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < width; x += 1) {
      const target = y * (stride + 1) + 1 + x * channels;
      raw[target] = (x * 7 + y * 3) & 0xff;
      raw[target + 1] = (x * 13 + y * 11) & 0xff;
      raw[target + 2] = (x * 29 + y * 17) & 0xff;
      if (channels === 4) raw[target + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a PNG round-trips through decode and encode unchanged', () => {
  const source = noisyPng(64, 48);
  const image = decodePng(source);
  assert.ok(image, 'the fixture decodes');
  assert.equal(image.width, 64);
  assert.equal(image.height, 48);
  assert.equal(image.opaque, true);
  const again = decodePng(encodePng(image));
  assert.ok(again, 'what the encoder wrote decodes');
  assert.equal(again.width, 64);
  assert.equal(again.height, 48);
  assert.deepEqual(again.data, image.data, 'every pixel survives the round trip');
});

test('the filters a screenshot arrives with are all undone', () => {
  // Each scanline filter gets its own fixture: a decoder that mishandles one of them
  // produces a plausible-looking but wrong image, which is the failure that matters.
  for (const filter of [0, 1, 2, 3, 4]) {
    const width = 32;
    const height = 8;
    const channels = 3;
    const stride = width * channels;
    const pixels = Buffer.alloc(stride * height);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 37) & 0xff;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
      raw[y * (stride + 1)] = filter;
      for (let x = 0; x < stride; x += 1) {
        const value = pixels[y * stride + x];
        const left = x >= channels ? pixels[y * stride + x - channels] : 0;
        const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
        const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
        }
        raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    const image = decodePng(png);
    assert.ok(image, `filter ${filter} decodes`);
    for (let index = 0; index < pixels.length; index += 3) {
      const source = (index / 3) * 4;
      assert.equal(image.data[source], pixels[index], `filter ${filter} red at ${index / 3}`);
      assert.equal(image.data[source + 1], pixels[index + 1], `filter ${filter} green at ${index / 3}`);
      assert.equal(image.data[source + 2], pixels[index + 2], `filter ${filter} blue at ${index / 3}`);
    }
  }
});

test('a palette screenshot is expanded through its colour table', () => {
  const width = 4;
  const height = 2;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) raw[y * (width + 1) + 1 + x] = x % 2;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  const palette = Buffer.from([255, 0, 0, 0, 0, 255]);
  const png = Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const image = decodePng(png);
  assert.ok(image, 'the palette fixture decodes');
  assert.deepEqual([...image.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...image.data.subarray(4, 8)], [0, 0, 255, 255]);
});

test('downscaling averages the block instead of picking a corner', () => {
  const image = { width: 4, height: 4, opaque: true, data: Buffer.alloc(4 * 4 * 4, 0) };
  // A checkerboard of black and white: averaging a 2x2 block gives mid grey, while
  // sampling one pixel of it would give either 0 or 200.
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const value = (x + y) % 2 === 0 ? 0 : 200;
      const target = (y * 4 + x) * 4;
      image.data[target] = value;
      image.data[target + 1] = value;
      image.data[target + 2] = value;
    }
  }
  const smaller = downscale(image, 2);
  assert.equal(smaller.width, 2);
  assert.equal(smaller.height, 2);
  assert.equal(smaller.data[0], 100, `the block is averaged: ${smaller.data[0]}`);
});

test('shrinking a screenshot produces a smaller but valid data URL', () => {
  const png = noisyPng(320, 240);
  const url = `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(isPngDataUrl(url), true);
  const smaller = shrinkPngDataUrl(url, 2);
  assert.ok(smaller, 'the screenshot shrinks');
  assert.ok(isPngDataUrl(smaller));
  assert.ok(smaller.length < url.length, 'the result is smaller');
  const decoded = decodePng(Buffer.from(smaller.split(',')[1], 'base64'));
  assert.equal(decoded.width, 160, 'half the width');
  assert.equal(decoded.height, 120, 'half the height');
});

test('an image the module cannot rewrite is left untouched', () => {
  assert.equal(shrinkPngDataUrl('data:image/jpeg;base64,AAAA', 2), null, 'not a PNG');
  assert.equal(shrinkPngDataUrl('data:image/png;base64,AAAA', 2), null, 'not a real PNG');
  assert.equal(shrinkPngDataUrl('', 2), null);
  assert.equal(shrinkPngDataUrl(undefined, 2), null);
  // A tiny icon would not get smaller, so it must not be rewritten at all.
  const tiny = `data:image/png;base64,${noisyPng(8, 8).toString('base64')}`;
  assert.equal(shrinkPngDataUrl(tiny, 2), null);
});

test('a 16-bit or interlaced PNG is refused rather than misread', () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 16;
  header[9] = 6;
  const sixteenBit = Buffer.concat([signature, chunk('IHDR', header), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(decodePng(sixteenBit), null);
  header[8] = 8;
  header[12] = 1;
  const interlaced = Buffer.concat([signature, chunk('IHDR', header), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(decodePng(interlaced), null);
});
