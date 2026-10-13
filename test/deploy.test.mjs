import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/db.mjs';

test('deploy avbryter före databasbytet om --behall misslyckas', () => {
  const text = readFileSync(join(ROOT, 'deploy', 'deploy.sh'), 'utf8');
  const kommando = text.match(/      node --disable-warning=ExperimentalWarning[\s\S]*?--behall[^\n]*/)?.[0];
  assert.ok(kommando);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  for (const kod of [1, 0]) {
    const r = spawnSync(bash, ['-c', 'set -e\nnode() { return ' + kod + '; }\nif true; then\n'
      + kommando + '\nfi\necho databasbytt'], { encoding: 'utf8' });
    assert.equal(r.status, kod, r.stderr);
    assert.equal(r.stdout.includes('databasbytt'), kod === 0);
  }
});
