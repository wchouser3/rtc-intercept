#!/usr/bin/env node
'use strict';

const { parseArgs, USAGE } = require('../src/cli');
const { run } = require('../src/recorder');

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (args.help || !args.room) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  args.debug = !args.headless; // surface page console logs whenever running headful

  try {
    await run(args);
  } catch (err) {
    console.error('Fatal error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
