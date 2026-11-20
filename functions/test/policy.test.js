// Unit tests for the reservation quota (F-03) and separation-of-duties (F-04) policies.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  uploadGrantId,
  DELETION_CONFIRMATION,
  REVIEW_SLA_MS,
  assertAccountDeletable,
  isReviewOverdue,
  DEFAULT_RESERVATION_LIMITS,
  assertNotSelfReview,
  assertReservationQuota
} = require('../domain');

const req = (treeId, shareCount) => ({ treeId, shareCount });

test('quota: first request is allowed', () => {
  assert.doesNotThrow(() => assertReservationQuota([], req('tree_a', 4)));
});

test('quota: a second open request for the same tree is rejected', () => {
  assert.throws(() => assertReservationQuota([req('tree_a', 1)], req('tree_a', 1)),
    (error) => error.code === 'already-exists');
});

test('quota: open request count is capped', () => {
  const open = Array.from({ length: DEFAULT_RESERVATION_LIMITS.maxOpenRequests }, (_, i) => req(`tree_${i}`, 1));
  assert.throws(() => assertReservationQuota(open, req('tree_new', 1)),
    (error) => error.code === 'resource-exhausted');
});

test('quota: total open shares are capped', () => {
  assert.throws(() => assertReservationQuota([req('tree_a', 4), req('tree_b', 3)], req('tree_c', 2)),
    (error) => error.code === 'resource-exhausted');
  assert.doesNotThrow(() => assertReservationQuota([req('tree_a', 4), req('tree_b', 3)], req('tree_c', 1)));
});

test('quota: custom limits are honoured', () => {
  assert.throws(() => assertReservationQuota([], req('tree_a', 5), { maxOpenRequests: 3, maxOpenShares: 4 }),
    (error) => error.code === 'resource-exhausted');
});

test('quota: malformed input fails closed', () => {
  assert.throws(() => assertReservationQuota(null, req('tree_a', 1)), (error) => error.code === 'internal');
});

test('separation of duties: self-review is denied, foreign review allowed', () => {
  assert.throws(() => assertNotSelfReview('uid_1', 'uid_1'), (error) => error.code === 'permission-denied');
  assert.throws(() => assertNotSelfReview('uid_1', undefined), (error) => error.code === 'permission-denied');
  assert.doesNotThrow(() => assertNotSelfReview('uid_1', 'uid_2'));
});

test('account deletion requires the exact confirmation word', () => {
  assert.throws(() => assertAccountDeletable({ confirmation: 'delete', openRequests: 0, activeShares: 0 }),
    (error) => error.code === 'invalid-argument');
  assert.doesNotThrow(() => assertAccountDeletable({ confirmation: DELETION_CONFIRMATION, openRequests: 0, activeShares: 0 }));
});

test('account deletion is refused while contractual positions are open', () => {
  assert.throws(() => assertAccountDeletable({ confirmation: DELETION_CONFIRMATION, openRequests: 1, activeShares: 0 }),
    (error) => error.code === 'failed-precondition');
  assert.throws(() => assertAccountDeletable({ confirmation: DELETION_CONFIRMATION, openRequests: 0, activeShares: 2 }),
    (error) => error.code === 'failed-precondition');
});

test('review SLA: overdue only after 72 hours, missing timestamps are never overdue', () => {
  const now = Date.now();
  assert.equal(isReviewOverdue(now - REVIEW_SLA_MS - 1, now), true);
  assert.equal(isReviewOverdue(now - REVIEW_SLA_MS + 1000, now), false);
  assert.equal(isReviewOverdue(undefined, now), false);
});

test('upload grant ids are strict and cannot be path-injected', () => {
  assert.equal(uploadGrantId('abcUID123', 'payment', 'a'.repeat(64)), `abcUID123__payment__${'a'.repeat(64)}`);
  assert.throws(() => uploadGrantId('uid/../x', 'payment', 'r1'), (e) => e.code === 'invalid-argument');
  assert.throws(() => uploadGrantId('uid', 'admin', 'r1'), (e) => e.code === 'invalid-argument');
  assert.throws(() => uploadGrantId('uid', 'tree', 'tree/1'), (e) => e.code === 'invalid-argument');
});
