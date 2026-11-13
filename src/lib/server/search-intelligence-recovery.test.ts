import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverZeroResult, RecoveryStage } from './search-intelligence-recovery';

test('recoverZeroResult stops at the first stage that meets minSufficient', async () => {
  const calls: RecoveryStage[] = [];
  const result = await recoverZeroResult<string>({
    [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL]: () => {
      calls.push(RecoveryStage.ORIGINAL_ACCENTED_LEXICAL);
      return [];
    },
    [RecoveryStage.ACCENT_FOLDED_LEXICAL]: () => {
      calls.push(RecoveryStage.ACCENT_FOLDED_LEXICAL);
      return ['hit-1'];
    },
    [RecoveryStage.BOUNDED_FUZZY_CORRECTION]: () => {
      calls.push(RecoveryStage.BOUNDED_FUZZY_CORRECTION);
      return ['should-never-run'];
    },
  });

  assert.equal(result.recoveryStageUsed, RecoveryStage.ACCENT_FOLDED_LEXICAL);
  assert.deepEqual(result.candidates, ['hit-1']);
  assert.deepEqual(calls, [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL, RecoveryStage.ACCENT_FOLDED_LEXICAL]);
});

test('recoverZeroResult returns EXHAUSTED with no candidates when every supplied stage is empty', async () => {
  const result = await recoverZeroResult<string>({
    [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL]: () => [],
    [RecoveryStage.REVIEWED_SYNONYMS]: () => [],
  });
  assert.equal(result.recoveryStageUsed, RecoveryStage.EXHAUSTED);
  assert.deepEqual(result.candidates, []);
});

test('recoverZeroResult never rewrites the query -- it only sequences stage functions', async () => {
  // The stage functions themselves receive no query argument at all;
  // this test documents/locks that contract.
  const result = await recoverZeroResult<number>({
    [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL]: () => [1, 2, 3],
  });
  assert.equal(result.recoveryStageUsed, RecoveryStage.ORIGINAL_ACCENTED_LEXICAL);
  assert.deepEqual(result.candidates, [1, 2, 3]);
});

test('recoverZeroResult skips stages that were not supplied', async () => {
  const result = await recoverZeroResult<string>({
    [RecoveryStage.BOUNDED_FUZZY_CORRECTION]: () => ['fuzzy-hit'],
  });
  assert.equal(result.recoveryStageUsed, RecoveryStage.BOUNDED_FUZZY_CORRECTION);
  assert.deepEqual(result.attemptedStages, [RecoveryStage.BOUNDED_FUZZY_CORRECTION]);
});

test('recoverZeroResult propagates a thrown error from a stage without catching it', async () => {
  await assert.rejects(
    () =>
      recoverZeroResult<string>({
        [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL]: () => {
          throw new Error('candidate pool too large');
        },
      }),
    /candidate pool too large/,
  );
});
