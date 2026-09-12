'use strict';

const fs = require('fs');

/**
 * Writes interleaved 32-bit float PCM samples to a .wav file as they arrive,
 * then patches the header sizes on close(). 32-bit float is used (rather than
 * 16/24-bit int) so we never requantize the audio below whatever quality
 * WebRTC/Opus already decoded it to on the way in — this is the "best
 * possible quality" we can realistically capture at this point in the chain.
 */
class WavWriter {
  constructor(filePath, { sampleRate = 48000, channels = 2 } = {}) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bytesPerSample = 4; // float32
    this.dataBytesWritten = 0;
    this._closed = false;

    this.fd = fs.openSync(filePath, 'w');
    // Write a placeholder header now; sizes get patched in on close().
    fs.writeSync(this.fd, this._buildHeader(0));
  }

  _buildHeader(dataLength) {
    const blockAlign = this.channels * this.bytesPerSample;
    const byteRate = this.sampleRate * blockAlign;
    const buf = Buffer.alloc(44);

    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLength, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(3, 20); // 3 = IEEE float
    buf.writeUInt16LE(this.channels, 22);
    buf.writeUInt32LE(this.sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(this.bytesPerSample * 8, 34); // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataLength, 40);

    return buf;
  }

  /**
   * @param {number[][]} channelArrays - one array of float samples per channel,
   *   all the same length (a single audio "chunk" from the page).
   */
  writeChannels(channelArrays) {
    if (this._closed) return;
    const numChannels = channelArrays.length;
    const frameCount = channelArrays[0] ? channelArrays[0].length : 0;
    if (frameCount === 0) return;

    const buf = Buffer.alloc(frameCount * numChannels * this.bytesPerSample);
    let offset = 0;
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < numChannels; c++) {
        buf.writeFloatLE(channelArrays[c][i] || 0, offset);
        offset += 4;
      }
    }

    fs.writeSync(this.fd, buf);
    this.dataBytesWritten += buf.length;
  }

  /**
   * Writes `frameCount` frames of digital silence directly to disk, without
   * ever materializing a giant JS array — needed because a guest joining,
   * say, 45 minutes into a show means padding tens of millions of frames.
   */
  writeSilence(frameCount) {
    if (this._closed || frameCount <= 0) return;
    const bytesPerFrame = this.channels * this.bytesPerSample;
    const CHUNK_FRAMES = 65536;
    let remaining = Math.floor(frameCount);
    const chunkBuf = Buffer.alloc(Math.min(CHUNK_FRAMES, remaining) * bytesPerFrame); // zero-filled
    while (remaining > 0) {
      const framesThisChunk = Math.min(CHUNK_FRAMES, remaining);
      const bytes = framesThisChunk * bytesPerFrame;
      fs.writeSync(this.fd, chunkBuf, 0, bytes);
      this.dataBytesWritten += bytes;
      remaining -= framesThisChunk;
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const header = this._buildHeader(this.dataBytesWritten);
    fs.writeSync(this.fd, header, 0, header.length, 0); // patch header at offset 0
    fs.closeSync(this.fd);
  }
}

module.exports = { WavWriter };
