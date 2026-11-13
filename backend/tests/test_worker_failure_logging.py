import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.worker import MediaWorker


class TestWorkerFailureLogging(unittest.TestCase):
    def _worker(self) -> MediaWorker:
        worker = object.__new__(MediaWorker)
        worker.gateway = MagicMock()
        return worker

    def test_retryable_failure_is_logged_with_job_id_and_message(self):
        worker = self._worker()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worker._fail("job-1", "Shared Vision configuration is not configured", retryable=True)
        line = out.getvalue()
        self.assertIn("job-1", line)
        self.assertIn("will retry", line)
        self.assertIn("Shared Vision configuration is not configured", line)
        worker.gateway.rpc.assert_called_once()

    def test_permanent_failure_is_logged_and_message_is_truncated(self):
        worker = self._worker()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worker._fail("job-2", "x" * 1000, retryable=False)
        line = out.getvalue()
        self.assertIn("failed permanently", line)
        self.assertLess(len(line), 400)

    def test_log_is_written_even_when_persisting_the_failure_fails(self):
        worker = self._worker()
        worker.gateway.rpc.side_effect = RuntimeError("db down")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worker._fail("job-3", "boom", retryable=True)
        text = out.getvalue()
        self.assertIn("job-3", text)
        self.assertIn("boom", text)
        self.assertIn("failed to persist worker error", text)


if __name__ == "__main__":
    unittest.main()
