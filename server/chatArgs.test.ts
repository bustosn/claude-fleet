import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliExtraArgs } from './chat.js';

test('chats start with --chrome when claudeInChrome is on', () => {
  assert.deepEqual(cliExtraArgs({ claudeInChrome: true }, false), { chrome: null });
});

test('claudeInChrome off adds no flags', () => {
  assert.equal(cliExtraArgs({ claudeInChrome: false }, false), undefined);
});

test('QA reviewers never get Claude in Chrome', () => {
  assert.equal(cliExtraArgs({ claudeInChrome: true }, true), undefined);
});
