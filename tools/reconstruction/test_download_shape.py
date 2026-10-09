import tempfile
import time
import unittest
from pathlib import Path

from download_shape import (
    DEFAULT_TOTAL_SECONDS,
    MAX_ALLOWED_TOTAL_SECONDS,
    MODEL_SHA256,
    MODEL_SIZE,
    MODEL_REVISION,
    parse_content_range,
    parse_max_seconds,
    throughput_mib_per_second,
    validate_hf_identity_headers,
    validate_range_response,
    validate_redirect_location,
    write_range_body,
)


class FakeResponse:
    def __init__(self, status_code, headers, chunks):
        self.status_code = status_code
        self.headers = headers
        self._chunks = chunks

    def iter_content(self, chunk_size):
        yield from self._chunks


class DownloadShapeTests(unittest.TestCase):
    def test_throughput_counts_bytes_downloaded_in_this_run_only(self):
        self.assertEqual(throughput_mib_per_second(10 * 1024 * 1024, 5), 2)

    def test_download_timeout_defaults_to_eight_hours_and_is_bounded(self):
        self.assertEqual(DEFAULT_TOTAL_SECONDS, 8 * 60 * 60)
        self.assertEqual(parse_max_seconds(None), DEFAULT_TOTAL_SECONDS)
        self.assertEqual(parse_max_seconds(5 * 60), 5 * 60)
        self.assertEqual(parse_max_seconds(MAX_ALLOWED_TOTAL_SECONDS), MAX_ALLOWED_TOTAL_SECONDS)
        for value in (True, 0, -1, 299, MAX_ALLOWED_TOTAL_SECONDS + 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_max_seconds(value)

    def test_parses_exact_byte_range_and_total(self):
        self.assertEqual(parse_content_range("bytes 256000000-257048575/4928151562"), (256000000, 257048575, MODEL_SIZE))

    def test_rejects_unsatisfied_or_malformed_content_range(self):
        for value in ("bytes */4928151562", "bytes 10-9/20", "bytes 0-4/*", "items 0-4/20"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_content_range(value)

    def test_rejects_non_partial_or_mismatched_range_responses(self):
        with self.assertRaises(ValueError):
            validate_range_response(200, {"Content-Range": "bytes 0-3/8", "Content-Length": "4"}, 0, 3, 8)
        with self.assertRaises(ValueError):
            validate_range_response(206, {"Content-Range": "bytes 0-2/8", "Content-Length": "3"}, 0, 3, 8)
        with self.assertRaises(ValueError):
            validate_range_response(206, {"Content-Range": "bytes 0-3/9", "Content-Length": "4"}, 0, 3, 8)

    def test_accepts_only_https_hugging_face_redirect_hosts(self):
        validate_redirect_location("https://us.aws.cdn.hf.co/object?sig=opaque")
        validate_redirect_location("https://huggingface.co/file")
        for value in ("http://us.aws.cdn.hf.co/file", "https://hf.co.attacker.example/file", "https://user@huggingface.co/file"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_redirect_location(value)

    def test_checks_fixed_repo_revision_etag_and_size(self):
        validate_hf_identity_headers(
            {
                "X-Repo-Commit": MODEL_REVISION,
                "X-Linked-Etag": f'"{MODEL_SHA256}"',
                "X-Linked-Size": str(MODEL_SIZE),
            }
        )
        for field, value in (("X-Repo-Commit", "0" * 40), ("X-Linked-Etag", '"' + "0" * 64 + '"'), ("X-Linked-Size", "1")):
            headers = {
                "X-Repo-Commit": MODEL_REVISION,
                "X-Linked-Etag": MODEL_SHA256,
                "X-Linked-Size": str(MODEL_SIZE),
            }
            headers[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_hf_identity_headers(headers)

    def test_short_range_body_rolls_back_to_prior_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            part_path = Path(directory) / "model.part"
            part_path.write_bytes(b"prefix")
            response = FakeResponse(
                206,
                {"Content-Range": "bytes 6-9/10", "Content-Length": "4"},
                [b"xy"],
            )
            with self.assertRaises(ValueError):
                write_range_body(response, part_path, 6, 9, 10)
            self.assertEqual(part_path.read_bytes(), b"prefix")

    def test_total_timeout_rolls_back_the_current_range(self):
        with tempfile.TemporaryDirectory() as directory:
            part_path = Path(directory) / "model.part"
            part_path.write_bytes(b"prefix")
            response = FakeResponse(
                206,
                {"Content-Range": "bytes 6-9/10", "Content-Length": "4"},
                [b"xy", b"zw"],
            )
            with self.assertRaises(TimeoutError):
                write_range_body(response, part_path, 6, 9, 10, deadline=time.monotonic() - 1)
            self.assertEqual(part_path.read_bytes(), b"prefix")

    def test_writes_only_a_complete_verified_range(self):
        with tempfile.TemporaryDirectory() as directory:
            part_path = Path(directory) / "model.part"
            part_path.write_bytes(b"prefix")
            response = FakeResponse(
                206,
                {"Content-Range": "bytes 6-9/10", "Content-Length": "4"},
                [b"xy", b"zw"],
            )
            self.assertEqual(write_range_body(response, part_path, 6, 9, 10), 4)
            self.assertEqual(part_path.read_bytes(), b"prefixxyzw")


if __name__ == "__main__":
    unittest.main()
