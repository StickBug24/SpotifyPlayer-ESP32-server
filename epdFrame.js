// Converts an image (Buffer) into a 400x300 1-bit frame for the e-paper display.
// Output: 15000 bytes, 1 = white, 0 = black, MSB first, row by row (50 bytes per row).
const sharp = require('sharp');

const W = 400, H = 300, CHUNK = 2500;           // 6 chunks of 2500 bytes = 15000

async function bufferToFrame(input) {
  const { data, info } = await sharp(input)
    .rotate()                                    // honour EXIF orientation
    .flatten({ background: '#ffffff' })          // transparency -> white
    .resize(W, H, { fit: 'contain', background: '#ffffff' })   // whole cover, white bars at the sides
    .toColourspace('b-w')
    .normalise()                                 // stretch contrast: helps a lot on 1-bit panels
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 1 || info.width !== W || info.height !== H) {
    throw new Error(`unexpected image layout ${info.width}x${info.height}x${info.channels}`);
  }

  // Floyd-Steinberg dithering
  const px = Float32Array.from(data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const old = px[i];
      const nw = old < 128 ? 0 : 255;
      const err = old - nw;
      px[i] = nw;
      if (x + 1 < W)               px[i + 1]     += err * 7 / 16;
      if (y + 1 < H) {
        if (x > 0)                 px[i + W - 1] += err * 3 / 16;
                                   px[i + W]     += err * 5 / 16;
        if (x + 1 < W)             px[i + W + 1] += err * 1 / 16;
      }
    }
  }

  // Pack to bits
  const out = Buffer.alloc(W * H / 8);           // all 0 = black
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (px[y * W + x] === 255) out[y * (W / 8) + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

function splitChunks(frame) {
  const chunks = [];
  for (let i = 0; i < frame.length; i += CHUNK) chunks.push(frame.subarray(i, i + CHUNK));
  return chunks;
}

module.exports = { bufferToFrame, splitChunks, W, H };
