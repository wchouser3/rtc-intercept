'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { WavWriter } = require('./wavWriter');
const { injectedMain } = require('./pageScript');

function buildRoomUrl({ baseUrl, room, password, proaudio }) {
  const url = new URL(baseUrl);
  url.searchParams.set('room', room);
  if (password) url.searchParams.set('password', password);
  url.searchParams.set('scene', ''); // composite/attach all guest streams
  url.searchParams.set('cleanoutput', '');
  if (proaudio) url.searchParams.set('proaudio', '');
  return url.toString().replace(/=$/, '').replace(/=&/g, '&');
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function run(args) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const sessionDir = path.join(args.outDir, `${args.room}_${timestampSlug()}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`RTC Intercept`);
  console.log(`  Room:   ${args.room}`);
  console.log(`  Output: ${sessionDir}`);
  console.log(`  Mode:   ${args.headless ? 'headless' : 'headful'}`);
  console.log('');

  const browser = await chromium.launch({
    headless: args.headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });
  const page = await context.newPage();

  const writers = new Map(); // streamKey -> WavWriter
  const labels = new Map();

  page.on('console', (msg) => {
    if (args.debug) console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.error('[browser error]', err));

  await context.exposeFunction('__intercept_log', (msg) => {
    console.log(`[vdo.ninja] ${msg}`);
  });

  const SAMPLE_RATE = 48000;

  await context.exposeFunction('__intercept_join', (streamKey, label, startOffsetSeconds, channelCount) => {
    if (writers.has(streamKey)) return;
    const safeLabel = (label || streamKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(sessionDir, `${safeLabel}.wav`);
    const channels = channelCount || 2;
    const writer = new WavWriter(filePath, { sampleRate: SAMPLE_RATE, channels });

    // Pad with silence so every guest's file lines up on the same timeline,
    // regardless of when they actually joined relative to the start of the
    // recording session. See pageScript.js for where startOffsetSeconds comes from.
    const silenceFrames = Math.max(0, Math.round((startOffsetSeconds || 0) * SAMPLE_RATE));
    if (silenceFrames > 0) {
      writer.writeSilence(silenceFrames);
      console.log(`  (padded with ${(silenceFrames / SAMPLE_RATE).toFixed(2)}s of silence to stay in sync)`);
    }

    writers.set(streamKey, writer);
    labels.set(streamKey, safeLabel);
    console.log(`+ Recording guest "${label}" -> ${filePath}`);
  });

  await context.exposeFunction('__intercept_audio', (streamKey, channelArrays) => {
    const writer = writers.get(streamKey);
    if (writer) writer.writeChannels(channelArrays);
  });

  await context.exposeFunction('__intercept_leave', (streamKey) => {
    const writer = writers.get(streamKey);
    if (writer) {
      writer.close();
      console.log(`- Finished recording "${labels.get(streamKey) || streamKey}"`);
      writers.delete(streamKey);
    }
  });

  await page.addInitScript(injectedMain, { chunkFrames: 4096, forceMono: args.forceMono });

  const roomUrl = buildRoomUrl(args);
  console.log(`Navigating to ${roomUrl}\n`);
  await page.goto(roomUrl, { waitUntil: 'domcontentloaded' });

  console.log('Joined room. Recording... press Ctrl+C to stop.\n');

  const shutdown = async () => {
    console.log('\nStopping — finalizing recordings...');
    for (const [streamKey, writer] of writers) {
      writer.close();
      console.log(`- Finished recording "${labels.get(streamKey) || streamKey}"`);
    }
    try { await browser.close(); } catch (e) { /* already closed */ }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Safety net: if the Chromium window gets closed manually (in --headful
  // mode) instead of stopping via Ctrl+C, still finalize whatever was
  // recorded rather than leaving WAV headers with a placeholder size.
  browser.on('disconnected', () => {
    console.log('\nBrowser closed unexpectedly — finalizing recordings...');
    for (const [streamKey, writer] of writers) {
      writer.close();
      console.log(`- Finished recording "${labels.get(streamKey) || streamKey}"`);
    }
    process.exit(0);
  });

  // Keep the process alive until the user interrupts it.
  await new Promise(() => {});
}

module.exports = { run, buildRoomUrl };
