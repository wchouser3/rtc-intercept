'use strict';

/**
 * This function is serialized by Playwright (via page.addInitScript) and run
 * INSIDE the Chromium page that has navigated to vdo.ninja. It cannot close
 * over anything from the Node side — only what's passed in `opts` and the
 * page-exposed bindings (window.__intercept_*) set up by recorder.js.
 *
 * Strategy:
 *  1. Watch the DOM for <video>/<audio> elements VDO.Ninja creates for each
 *     incoming guest stream.
 *  2. Once an element's srcObject is a live MediaStream with an audio track,
 *     tap it with the Web Audio API (createMediaStreamSource -> AudioWorklet)
 *     and stream raw float PCM back out to Node in modest-sized chunks.
 *  3. Best-effort guess a human-readable label for the guest by looking at
 *     nearby DOM text; falls back to a sequential guest id.
 *
 * NOTE: VDO.Ninja's internal DOM structure isn't a stable public API, so the
 * element-scanning and label-guessing here are intentionally generic/defensive
 * rather than tied to specific class names. If guests aren't being detected
 * or labels look wrong, run with --headful and check console output (also
 * forwarded to Node's terminal) to see what's actually in the DOM.
 */
function injectedMain(opts) {
  const CHUNK_FRAMES = opts.chunkFrames || 4096;
  const seenStreams = new WeakSet();
  const seenElements = new WeakSet();
  let guestCounter = 0;

  function log(msg) {
    try { window.__intercept_log(String(msg)); } catch (e) { /* noop */ }
  }

  function guessLabel(el) {
    // Walk a few ancestors up looking for a text node that looks like a name/label.
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      const candidates = node.querySelectorAll
        ? node.querySelectorAll('[class*="label"], [class*="name"], [id*="label"]')
        : [];
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (text && text.length < 60) return text;
      }
    }
    return null;
  }

  async function ensureAudioContext() {
    if (window.__intercept_ctx) return window.__intercept_ctx;

    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

    const workletCode = `
      class ChunkForwarder extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffers = null;
          this.filled = 0;
          this.chunkFrames = ${CHUNK_FRAMES};
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;
          if (!this.buffers) {
            this.buffers = input.map(() => new Float32Array(this.chunkFrames));
          }
          const frames = input[0].length;
          for (let f = 0; f < frames; f++) {
            for (let c = 0; c < input.length; c++) {
              this.buffers[c][this.filled] = input[c][f];
            }
            this.filled++;
            if (this.filled >= this.chunkFrames) {
              const out = this.buffers.map((b) => b.slice(0, this.filled));
              this.port.postMessage({ channels: out });
              this.filled = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('chunk-forwarder', ChunkForwarder);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);

    window.__intercept_ctx = ctx;
    return ctx;
  }

  async function attach(el) {
    if (seenElements.has(el)) return;
    const stream = el.srcObject;
    if (!(stream instanceof MediaStream)) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;
    if (seenStreams.has(stream)) return;

    seenElements.add(el);
    seenStreams.add(stream);

    guestCounter += 1;
    const label = guessLabel(el) || `guest-${guestCounter}`;
    const streamKey = `s${guestCounter}-${label}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const nativeChannelCount = audioTracks[0].getSettings().channelCount || 2;
    const channelCount = opts.forceMono ? 1 : nativeChannelCount;

    const ctx = await ensureAudioContext();
    const startOffsetSeconds = ctx.currentTime;

    log(`Detected guest audio stream: ${streamKey} (joins at +${startOffsetSeconds.toFixed(2)}s, ${channelCount}ch)`);
    window.__intercept_join(streamKey, label, startOffsetSeconds, channelCount);

    const audioOnlyStream = new MediaStream(audioTracks);
    const source = ctx.createMediaStreamSource(audioOnlyStream);
    const node = new AudioWorkletNode(ctx, 'chunk-forwarder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount,
      channelCountMode: 'explicit',
      // 'speakers' interpretation is what makes the browser properly
      // downmix stereo -> mono (averaging L+R) rather than just dropping
      // a channel, when channelCount is forced down to 1 below.
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = (ev) => {
      const channels = ev.data.channels.map((f32) => Array.from(f32));
      window.__intercept_audio(streamKey, channels, ctx.sampleRate);
    };
    source.connect(node);

    const track = audioTracks[0];
    const finish = () => {
      log(`Guest stream ended: ${streamKey}`);
      window.__intercept_leave(streamKey);
    };
    track.addEventListener('ended', finish, { once: true });
  }

  function scan(root) {
    const media = root.querySelectorAll ? root.querySelectorAll('video, audio') : [];
    media.forEach((el) => {
      if (el.srcObject) attach(el);
      else el.addEventListener('loadedmetadata', () => attach(el), { once: true });
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
          if (node.srcObject) attach(node);
          else node.addEventListener('loadedmetadata', () => attach(node), { once: true });
        }
        scan(node);
      });
    }
  });

  async function start() {
    // Create the shared AudioContext now, before any guest has joined, so its
    // clock (ctx.currentTime, starting at 0) represents the start of the
    // recording session as a whole — the reference every guest's join offset
    // gets measured against.
    await ensureAudioContext();
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
    // Periodic fallback scan in case srcObject is attached without a DOM mutation
    // or a loadedmetadata event we missed.
    setInterval(() => scan(document.body), 2000);
    log('Page watcher installed; waiting for guest streams...');
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
}

module.exports = { injectedMain };
