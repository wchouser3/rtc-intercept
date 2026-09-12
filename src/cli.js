'use strict';

const path = require('path');

const USAGE = `
RTC Intercept — record isolated per-guest audio from a VDO.Ninja room

Usage:
  intercept <room> [-p|--password <password>] [options]

Examples:
  intercept mypodcast
  intercept mypodcast --password s3cr3t
  intercept mypodcast -p s3cr3t --out ./recordings --headful

Options:
  -p, --password <pass>   Room password, if the room is protected.
  -o, --out <dir>         Output directory for recordings (default: ./recordings).
  --headful               Show the browser window instead of running headless.
                           Useful the first time you point this at a real room,
                           so you can see what's actually being joined/labeled.
  --base-url <url>        Alternate VDO.Ninja deployment (default: https://vdo.ninja).
  --no-proaudio           Don't request &proaudio (raw, unprocessed audio) from senders.
  --stereo                Keep each guest's native channel count (default: everyone
                           is downmixed to mono for a simpler multi-track workflow).
  -h, --help              Show this help text.
`;

function parseArgs(argv) {
  const args = { room: null, password: null, outDir: path.resolve(process.cwd(), 'recordings'),
    headless: true, baseUrl: 'https://vdo.ninja', proaudio: true, forceMono: true };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-p':
      case '--password':
        args.password = argv[++i];
        break;
      case '-o':
      case '--out':
        args.outDir = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--headful':
        args.headless = false;
        break;
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--no-proaudio':
        args.proaudio = false;
        break;
      case '--stereo':
        args.forceMono = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (!args.room && !a.startsWith('-')) {
          args.room = a;
        } else {
          throw new Error(`Unrecognized argument: ${a}`);
        }
    }
  }

  return args;
}

module.exports = { parseArgs, USAGE };
