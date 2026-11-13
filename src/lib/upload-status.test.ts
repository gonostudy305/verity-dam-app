import assert from 'node:assert/strict';
import test from 'node:test';

import { describeJobIssue, statusToItemPatch, type UploadProcessingStatus } from './upload-status';

const base: UploadProcessingStatus = {
  media_asset_id: '00000000-0000-4000-8000-000000000001',
  ingest_status: 'queued',
  ingest_error: null,
};

test('missing Vision configuration is explained with attempts while the job is queued', () => {
  const issue = describeJobIssue({
    job_status: 'queued',
    job_attempts: 4,
    job_max_attempts: 8,
    job_error: 'Shared Vision configuration is not configured',
  });
  assert.ok(issue);
  assert.match(issue, /AI Vision chưa được cấu hình/);
  assert.match(issue, /4\/8/);
});

test('no issue is reported without a job error, or once the job is terminal', () => {
  assert.equal(describeJobIssue({ job_status: 'queued', job_error: null }), undefined);
  assert.equal(describeJobIssue({ job_status: 'queued', job_error: '   ' }), undefined);
  assert.equal(describeJobIssue({ job_status: 'failed', job_error: 'boom' }), undefined);
  assert.equal(describeJobIssue({ job_status: 'succeeded', job_error: 'old error' }), undefined);
});

test('unknown job errors are shown (truncated) rather than hidden', () => {
  const issue = describeJobIssue({ job_status: 'queued', job_error: 'x'.repeat(400) });
  assert.ok(issue);
  assert.ok(issue.length < 260);
  assert.match(issue, /\.\.\./);
});

test('statusToItemPatch carries the job issue only for in-flight assets', () => {
  const waiting = statusToItemPatch({ ...base, job_status: 'queued', job_attempts: 1, job_max_attempts: 8, job_error: 'Shared Vision configuration is not configured' });
  assert.equal(waiting.processing_state, 'queued');
  assert.ok(waiting.job_issue);
  assert.equal(waiting.error, undefined);

  const failed = statusToItemPatch({ ...base, ingest_status: 'failed', ingest_error: 'Shared Vision configuration is not configured', job_status: 'failed', job_error: 'Shared Vision configuration is not configured' });
  assert.equal(failed.error, 'Shared Vision configuration is not configured');
  assert.equal(failed.job_issue, undefined);

  const ready = statusToItemPatch({ ...base, ingest_status: 'ready', job_status: 'succeeded', job_error: 'stale' });
  assert.equal(ready.job_issue, undefined);
});
