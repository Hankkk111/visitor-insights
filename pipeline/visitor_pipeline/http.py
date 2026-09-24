"""Shared HTTP helper: timeouts, retries with exponential backoff, and clear errors."""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

log = logging.getLogger(__name__)

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class SourceUnavailable(RuntimeError):
    """Raised when an upstream API can't be reached after all retries."""


def get_json(
    url: str,
    params: dict[str, Any] | None = None,
    *,
    session: requests.Session | None = None,
    timeout: float = 15.0,
    max_attempts: int = 4,
    backoff_seconds: float = 0.5,
) -> Any:
    sess = session or requests.Session()
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = sess.get(url, params=params, timeout=timeout)
            if resp.status_code in RETRYABLE_STATUS:
                raise requests.HTTPError(f"retryable status {resp.status_code}", response=resp)
            resp.raise_for_status()
            return resp.json()
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and status not in RETRYABLE_STATUS:
                raise SourceUnavailable(f"{url} returned {status}") from exc
            last_error = exc
            if attempt < max_attempts:
                delay = backoff_seconds * 2 ** (attempt - 1)
                log.warning("GET %s failed (%s); retry %d in %.1fs", url, exc, attempt, delay)
                time.sleep(delay)
    raise SourceUnavailable(f"{url} unavailable after {max_attempts} attempts") from last_error
