import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayName, formatStatus, type SessionStatus } from '../src/stats.js';

const base: SessionStatus = {
  sessionId: 's',
  at: '2026-10-22T00:00:00.000Z',
  mode: 'live',
  incoming: 'claude-opus-5-5',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  incomingEffort: 'xhigh',
  switched: true,
  reason: 'classified sonnet/medium',
  turns: 3,
  requests: 30,
  costUsd: 3.9235796,
  baselineUsd: 4.5047062,
};

describe('status line', () => {
  it('names models the way Claude Code does', () => {
    assert.equal(displayName('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(displayName('claude-haiku-5-5'), 'Haiku 5.5');
    assert.equal(displayName('dynamic'), 'dynamic');
  });

  it('says in words what runs, instead of what, and what was saved', () => {
    assert.equal(formatStatus(base), '⇄ running on Sonnet 5.5 at medium effort instead of Opus 5.5 · saved $0.58 over 3 turns');
  });

  it('explains a held switch with the rebuild cost and the effort it adjusted instead', () => {
    const held: SessionStatus = {
      ...base,
      model: 'claude-opus-5-5',
      switched: false,
      reason: 'hold claude-opus-5-5: downshift nets $-0.950 (rebuild $0.970, saves $0.0390/request) - adjusting effort instead',
      turns: 7,
      costUsd: 2.0,
      baselineUsd: 2.31,
    };
    assert.equal(
      formatStatus(held),
      '⇄ running on Opus 5.5 at medium effort (asked xhigh) · switch held: rebuild $0.97 · saved $0.31 over 7 turns',
    );
  });

  it('says "as asked" when nothing was changed', () => {
    const same: SessionStatus = { ...base, model: 'claude-opus-5-5', effort: 'xhigh', switched: false, reason: 'classified opus/high', turns: 1 };
    assert.equal(formatStatus(same), '⇄ running on Opus 5.5 at xhigh effort, as asked · saved $0.58 over 1 turn');
  });

  it('drops the comparison when Claude Code was launched with an alias, and marks shadow mode', () => {
    const aliased: SessionStatus = { ...base, alias: 'dynamic', model: 'claude-haiku-5-5', effort: 'low', turns: 1 };
    assert.equal(formatStatus(aliased), '⇄ dynamic: running on Haiku 5.5 at low effort · saved $0.58 over 1 turn');
    const shadow: SessionStatus = { ...base, mode: 'shadow' };
    assert.equal(formatStatus(shadow), '⇄ shadow: would run on Sonnet 5.5 at medium effort instead of Opus 5.5 · would save $0.58 over 3 turns');
  });

  it('says so when the last request failed or was forwarded as sent, instead of showing stale numbers', () => {
    const stale: SessionStatus = { ...base, incoming: 'dynamic', model: 'dynamic', through: false, lastStatus: 404, reason: 'unrecognized model family' };
    assert.equal(
      formatStatus(stale),
      '⇄ switchyard: last request failed, the API does not know the model "dynamic" · unrecognized model family; if you just rebuilt switchyard, restart the proxy',
    );
    const passthrough: SessionStatus = { ...stale, lastStatus: 200 };
    assert.equal(formatStatus(passthrough), '⇄ switchyard: forwarding "dynamic" as sent (unrecognized model family)');
    const overloaded: SessionStatus = { ...base, lastStatus: 529, through: true };
    assert.equal(formatStatus(overloaded), '⇄ switchyard: last request failed, HTTP 529 from the API');
    // A request the user cancelled is not a failure.
    assert.match(formatStatus({ ...base, lastStatus: 499, through: true }), /^⇄ running on Sonnet 5\.5/);
  });
});
