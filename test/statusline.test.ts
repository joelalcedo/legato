import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayName, formatStatus, type SessionStatus } from '../src/stats.js';
import { arithmetic, money, money1 } from '../src/words.js';

const base: SessionStatus = {
  sessionId: 's',
  at: '2026-10-22T00:00:00.000Z',
  mode: 'live',
  incoming: 'claude-opus-5-5',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  incomingEffort: 'xhigh',
  switched: true,
  reason: 'looks like an ordinary coding task',
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

  it('writes money the way people say it, and makes the switch sum add up on paper', () => {
    assert.equal(money1(0.019), '1.9¢');
    assert.equal(money1(0.12), '$0.12');
    const a = arithmetic({ perRequestSavingUsd: 0.019, rebuildUsd: 0.048, returnUsd: 0.037 }, 8);
    assert.deepEqual([a.saving, a.rebuild, a.back, a.net], [0.15, 0.05, 0.04, 0.06]);
    assert.equal(money(0.97), '$0.97');
    assert.equal(money(0.039), '4¢');
    assert.equal(money(0.001), 'under 1¢');
    assert.equal(money(-0.95), '-$0.95');
    assert.equal(money(12.5), '$12.50');
  });

  it('says what switched, the effort, and what the session has saved', () => {
    assert.equal(
      formatStatus(base),
      'Legato: switched from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of xhigh · saved $0.58 this session',
    );
  });

  it('explains a held switch in money and says the effort went down instead', () => {
    const held: SessionStatus = {
      ...base,
      model: 'claude-opus-5-5',
      switched: false,
      held: { model: 'claude-sonnet-5-5', why: 'cost', rebuildUsd: 0.97, lossUsd: 0.95 },
      turns: 7,
      costUsd: 2.0,
      baselineUsd: 2.31,
    };
    assert.equal(
      formatStatus(held),
      'Legato: staying on Opus 5.5 for this task, using medium effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.95 more than it saves) · saved $0.31 this session',
    );
    const weak: SessionStatus = { ...held, model: 'claude-sonnet-5-5', held: { model: 'claude-opus-5-5', why: 'weak-upgrade', rebuildUsd: 1.46 } };
    assert.match(formatStatus(weak), /\(not clearly hard enough to pay \$1\.46 for Opus 5\.5\)/);
  });

  it('says it kept the model, and the effort is the one you set, when nothing changed', () => {
    const same: SessionStatus = { ...base, model: 'claude-opus-5-5', effort: 'xhigh', switched: false, turns: 1 };
    assert.equal(formatStatus(same), 'Legato: kept Opus 5.5 for this task, using xhigh effort, as you set · saved $0.58 this session');
  });

  it('does not call the first pick a switch from the "Dynamic mode" alias, and marks shadow mode', () => {
    const aliased: SessionStatus = { ...base, alias: 'Dynamic mode', incoming: 'Dynamic mode', model: 'claude-haiku-5-5', effort: 'low', turns: 1 };
    assert.equal(formatStatus(aliased), 'Legato: chose Haiku 5.5 for this task, using low effort instead of xhigh · saved $0.58 this session');
    const later: SessionStatus = { ...aliased, from: 'claude-opus-5-5' };
    assert.equal(
      formatStatus(later),
      'Legato: switched from Opus 5.5 to Haiku 5.5 for this task, using low effort instead of xhigh · saved $0.58 this session',
    );
    const shadow: SessionStatus = { ...base, mode: 'shadow' };
    assert.equal(
      formatStatus(shadow),
      'Legato (shadow): would switch from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of xhigh · would have saved $0.58 this session',
    );
  });

  it('admits when the session has cost more so far', () => {
    const behind: SessionStatus = { ...base, costUsd: 4.8, baselineUsd: 4.5 };
    assert.equal(
      formatStatus(behind),
      'Legato: switched from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of xhigh · spent $0.30 more than Claude Code alone this session',
    );
  });

  it('says so when the last request failed or was forwarded as sent, instead of showing stale numbers', () => {
    const stale: SessionStatus = {
      ...base,
      incoming: 'dynamic',
      model: 'dynamic',
      through: false,
      lastStatus: 404,
      reason: 'not a Claude model Legato knows, sent as is',
    };
    assert.equal(
      formatStatus(stale),
      'Legato: the last request failed, the API does not know the model "dynamic"; if you just rebuilt legato, restart the proxy',
    );
    const passthrough: SessionStatus = { ...stale, lastStatus: 200 };
    assert.equal(formatStatus(passthrough), 'Legato: not routing "dynamic" (not a Claude model Legato knows, sent as is)');
    const overloaded: SessionStatus = { ...base, lastStatus: 529, through: true };
    assert.equal(formatStatus(overloaded), 'Legato: the last request failed, the API answered HTTP 529');
    // A request the user cancelled is not a failure.
    assert.match(formatStatus({ ...base, lastStatus: 499, through: true }), /^Legato: switched from Opus 5\.5/);
  });
});
