#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REQUIRED_MARKERS = [
  'cast-button-state',
  'sender-expanded-opened',
  'sender-mini-visible',
  'receiver-state',
  'receiver-idle-timeout',
  'receiver-paused-timeout',
  'stale-transport-recovered',
];

const REDACTION_CHECKS = [
  {
    name: 'unredacted query token',
    pattern: /[?&]token=(?!\[redacted\])[^&\s]+/i,
  },
  {
    name: 'unredacted bearer token',
    pattern: /Bearer\s+(?!\[redacted\])\S+/i,
  },
  {
    name: 'unredacted JWT',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
];

function printHelp() {
  console.log(`Usage: npm run verify:cast -- [--log logs/cast-receiver.log]

Audits the Cast diagnostics log after running the manual Cast checklist.
Fails when required checklist markers are missing or sensitive auth tokens
appear unredacted in the log.`);
}

function parseArgs(argv) {
  const args = {
    logPath: path.join('logs', 'cast-receiver.log'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--log') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--log requires a file path');
      }
      args.logPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readLog(logPath) {
  const absolutePath = path.resolve(process.cwd(), logPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Cast log not found: ${absolutePath}`);
  }
  return {
    absolutePath,
    content: fs.readFileSync(absolutePath, 'utf8'),
  };
}

function findMarkers(content) {
  return REQUIRED_MARKERS.map((marker) => ({
    marker,
    found: content.includes(marker),
  }));
}

function findRedactionLeaks(content) {
  const lines = content.split(/\r?\n/);
  return REDACTION_CHECKS.flatMap((check) => (
    lines
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => check.pattern.test(line))
      .slice(0, 5)
      .map(({ line, index }) => ({
        check: check.name,
        lineNumber: index,
        line: line.slice(0, 260),
      }))
  ));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { absolutePath, content } = readLog(args.logPath);
  const markerResults = findMarkers(content);
  const missingMarkers = markerResults.filter((result) => !result.found);
  const redactionLeaks = findRedactionLeaks(content);

  console.log('Cast design verification report');
  console.log(`Log: ${absolutePath}`);
  console.log('');
  console.log('Required markers:');
  markerResults.forEach(({ marker, found }) => {
    console.log(`  ${found ? 'OK  ' : 'MISS'} ${marker}`);
  });
  console.log('');
  console.log(`Redaction: ${redactionLeaks.length === 0 ? 'OK' : 'FAILED'}`);

  if (redactionLeaks.length > 0) {
    console.log('');
    console.log('Potential sensitive log lines:');
    redactionLeaks.forEach((leak) => {
      console.log(`  ${leak.check} at line ${leak.lineNumber}: ${leak.line}`);
    });
  }

  if (missingMarkers.length > 0 || redactionLeaks.length > 0) {
    console.log('');
    console.log('Result: FAILED');
    if (missingMarkers.length > 0) {
      console.log('Run the manual Cast checklist cases that exercise the missing markers, then rerun this verifier.');
    }
    process.exit(1);
  }

  console.log('');
  console.log('Result: PASSED');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
