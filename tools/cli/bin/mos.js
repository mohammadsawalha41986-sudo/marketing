#!/usr/bin/env node
import { run } from '../src/cli.js';

// `mos calendar | head` closes stdout early. Without this the process dies on an
// unhandled EPIPE instead of just stopping, which is what a pipe is supposed to do.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`mos: ${err.message}\n`);
  process.exitCode = 1;
}
