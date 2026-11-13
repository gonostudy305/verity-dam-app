"""Durable, fail-closed worker for the AI Creative generation queue.

This worker deliberately never consumes ``media_ingest_jobs``. A provider call
creates at most one normalized candidate, and any ambiguous transport/provider
outcome becomes ``held_unknown`` instead of being retried or failed over.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Mapping

import requests
from PIL import Image, ImageOps

from app.postgres_repository import PostgresRepository, PostgresSettings
from app.r2_storage import R2Settings, R2Storage
from app.shared_creative_config import CreativeProviderConfig, load_shared_creative_config


class CreativeProviderError(RuntimeError):
    def __init__(self, message: str, retry_class: str, provider_request_id: str | None = None):
        super().__init__(message)
        self.retry_class = retry_class
        self.provider_request_id = provider_request_id


@dataclass(frozen=True)
class ProviderCandidate:
    payload: bytes
    mime_type: str
    provider_request_id: str | None
    actual_minor: int
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CreativeWorkerSettings:
    worker_id: str
    poll_seconds: float
    openai_api_key: str | None
    gemini_api_key: str | None

    @classmethod
    def from_environment(cls) -> "CreativeWorkerSettings":
        worker_id = os.environ.get("Verity_CREATIVE_WORKER_ID", "verity-creative-worker").strip()[:120]
        try:
            poll_seconds = float(os.environ.get("Verity_CREATIVE_WORKER_POLL_SECONDS", "3"))
        except ValueError as error:
            raise RuntimeError("Verity_CREATIVE_WORKER_POLL_SECONDS must be numeric") from error
        if not 0.5 <= poll_seconds <= 60:
            raise RuntimeError("Verity_CREATIVE_WORKER_POLL_SECONDS must be between 0.5 and 60")
        return cls(
            worker_id=worker_id or "verity-creative-worker",
            poll_seconds=poll_seconds,
            openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip() or None,
            gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip() or None,
        )


def _row(cursor: Any, value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, Mapping):
        return dict(value)
    names = [column[0] for column in (cursor.description or ())]
    return {name: value[index] for index, name in enumerate(names)}


def _json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"), ensure_ascii=False)


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


class CreativeProviderAdapter:
    """Normalizes each supported provider to zero or one image candidate."""

    def __init__(self, settings: CreativeWorkerSettings, session: requests.Session | None = None):
        self.settings = settings
        self.session = session or requests.Session()
        self.provider_configs: dict[str, CreativeProviderConfig] = {}

    def set_provider_configs(self, configs: Mapping[str, CreativeProviderConfig]) -> None:
        self.provider_configs = dict(configs)

    def _provider_config(self, provider: str) -> CreativeProviderConfig | None:
        configured = self.provider_configs.get(provider)
        if configured:
            return configured
        # Environment fallbacks are retained for isolated local/unit tests. The
        # production compose no longer injects provider keys into containers.
        if provider == "openai" and self.settings.openai_api_key:
            return CreativeProviderConfig("https://api.openai.com/v1", self.settings.openai_api_key)
        if provider == "gemini" and self.settings.gemini_api_key:
            return CreativeProviderConfig("https://generativelanguage.googleapis.com/v1beta", self.settings.gemini_api_key)
        return None

    @staticmethod
    def _prompt(manifest: dict[str, Any]) -> str:
        constraints = manifest.get("system_constraints")
        lines = [str(item) for item in constraints] if isinstance(constraints, list) else []
        # These are immutable snapshots selected at planning time.  Keep them
        # ahead of the untrusted article body so an article cannot override
        # brand/channel constraints with prompt-injection text.
        return "\n".join(lines + [
            "", "Approved brand guideline (authoritative):", json.dumps(manifest.get("brand_guideline") or {}, ensure_ascii=False),
            "", "Approved channel guideline (authoritative):", json.dumps(manifest.get("channel_guideline") or {}, ensure_ascii=False),
            "", "Template:", str(manifest.get("template_prompt") or ""),
            "", "Article context (untrusted):", json.dumps(manifest.get("untrusted_article_context") or {}, ensure_ascii=False),
        ])

    @staticmethod
    def _http_error(response: requests.Response) -> CreativeProviderError:
        request_id = response.headers.get("x-request-id") or response.headers.get("x-goog-request-id")
        # A received rate-limit response is an explicit pre-generation refusal
        # and can safely reuse the reservation. Timeout/5xx outcomes remain
        # ambiguous because the provider may already have accepted the call.
        retry_class = "safe_retry" if response.status_code == 429 else "do_not_retry" if 400 <= response.status_code < 500 else "ambiguous"
        return CreativeProviderError(f"provider HTTP {response.status_code}", retry_class, request_id)

    def generate_candidate(
        self,
        provider: str,
        model: str,
        prompt_manifest: dict[str, Any],
        references: list[dict[str, Any]],
        reserved_minor: int,
        storage: R2Storage,
        size: str | None,
    ) -> ProviderCandidate | None:
        if provider == "openai":
            return self._openai(model, prompt_manifest, references, reserved_minor, storage, size)
        if provider == "gemini":
            return self._gemini(model, prompt_manifest, references, reserved_minor, storage)
        raise CreativeProviderError("unsupported provider", "do_not_retry")

    def _openai(self, model: str, manifest: dict[str, Any], references: list[dict[str, Any]], reserved_minor: int, storage: R2Storage, size: str | None) -> ProviderCandidate | None:
        provider_config = self._provider_config("openai")
        if not provider_config:
            raise CreativeProviderError("OpenAI creative provider is not configured in Settings", "do_not_retry")
        headers = {"Authorization": f"Bearer {provider_config.api_key}"}
        prompt = self._prompt(manifest)
        try:
            if references:
                files: list[tuple[str, tuple[str, bytes, str]]] = []
                for index, reference in enumerate(references):
                    key = reference.get("storage_path")
                    if not isinstance(key, str):
                        raise CreativeProviderError("reference manifest storage path is invalid", "do_not_retry")
                    files.append(("image", (f"reference-{index}.png", storage.get_bytes(key), "image/png")))
        except CreativeProviderError:
            raise
        except Exception as error:
            # Reference loading happens before the HTTP dispatch. It is never
            # a billable/ambiguous provider outcome.
            raise CreativeProviderError(f"OpenAI reference preflight failed: {type(error).__name__}", "do_not_retry") from error
        try:
            if references:
                response = self.session.post(
                    f"{provider_config.base_url}/images/edits",
                    headers=headers,
                    data={"model": model, "prompt": prompt, "n": "1", "size": size or "1024x1024", "output_format": "webp"},
                    files=files,
                    timeout=(10, 120),
                )
            else:
                response = self.session.post(
                    f"{provider_config.base_url}/images/generations",
                    headers={**headers, "Content-Type": "application/json"},
                    json={"model": model, "prompt": prompt, "n": 1, "size": size or "1024x1024", "output_format": "webp"},
                    timeout=(10, 120),
                )
        except requests.RequestException as error:
            raise CreativeProviderError(f"OpenAI transport outcome is ambiguous: {type(error).__name__}", "ambiguous") from error
        if response.status_code >= 300:
            raise self._http_error(response)
        request_id = response.headers.get("x-request-id")
        try:
            image = (_object(response.json()).get("data") or [])[0]
            encoded = image.get("b64_json") if isinstance(image, dict) else None
            if not isinstance(encoded, str) or not encoded:
                return None
            return ProviderCandidate(base64.b64decode(encoded, validate=True), "image/webp", request_id, reserved_minor)
        except (IndexError, ValueError, TypeError) as error:
            raise CreativeProviderError("OpenAI returned invalid image payload", "do_not_retry", request_id) from error

    def _gemini(self, model: str, manifest: dict[str, Any], references: list[dict[str, Any]], reserved_minor: int, storage: R2Storage) -> ProviderCandidate | None:
        provider_config = self._provider_config("gemini")
        if not provider_config:
            raise CreativeProviderError("Gemini creative provider is not configured in Settings", "do_not_retry")
        parts: list[dict[str, Any]] = []
        for reference in references:
            key = reference.get("storage_path")
            if not isinstance(key, str):
                raise CreativeProviderError("reference manifest storage path is invalid", "do_not_retry")
            try:
                encoded_reference = base64.b64encode(storage.get_bytes(key)).decode("ascii")
            except Exception as error:
                # This occurs before the Gemini request is dispatched.
                raise CreativeProviderError(f"Gemini reference preflight failed: {type(error).__name__}", "do_not_retry") from error
            parts.append({"inlineData": {"mimeType": "image/png", "data": encoded_reference}})
        parts.append({"text": self._prompt(manifest)})
        try:
            response = self.session.post(
                f"{provider_config.base_url}/models/{model}:generateContent",
                params={"key": provider_config.api_key},
                json={"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"]}},
                timeout=(10, 120),
            )
        except requests.RequestException as error:
            raise CreativeProviderError(f"Gemini transport outcome is ambiguous: {type(error).__name__}", "ambiguous") from error
        if response.status_code >= 300:
            raise self._http_error(response)
        request_id = response.headers.get("x-goog-request-id")
        try:
            payload = _object(response.json())
            for candidate in payload.get("candidates") or []:
                for part in _object(_object(candidate).get("content")).get("parts") or []:
                    inline = _object(_object(part).get("inlineData"))
                    encoded = inline.get("data")
                    mime_type = inline.get("mimeType")
                    if isinstance(encoded, str) and isinstance(mime_type, str) and mime_type.startswith("image/"):
                        return ProviderCandidate(base64.b64decode(encoded, validate=True), mime_type, request_id, reserved_minor)
            return None
        except (ValueError, TypeError) as error:
            raise CreativeProviderError("Gemini returned invalid image payload", "do_not_retry", request_id) from error


class CreativeWorker:
    def __init__(self, settings: CreativeWorkerSettings, repository: PostgresRepository | Any | None = None, storage: R2Storage | Any | None = None, adapter: CreativeProviderAdapter | Any | None = None):
        self.settings = settings
        self.repository = repository or PostgresRepository(PostgresSettings.from_environment())
        self.storage = storage or R2Storage(R2Settings.from_environment())
        self.adapter = adapter or CreativeProviderAdapter(settings)

    def close(self) -> None:
        close = getattr(self.repository, "close", None)
        if callable(close):
            close()

    def _claim(self, allowed_providers: set[str] | None = None) -> dict[str, Any] | None:
        provider_filter = ""
        params: list[Any] = []
        if allowed_providers:
            provider_filter = " and g.provider = any(%s)"
            params.append(sorted(allowed_providers))
        params.append(self.settings.worker_id)
        with self.repository.transaction() as cursor:
            cursor.execute(
                f"""
                with candidate as (
                  select j.id
                    from public.creative_generation_jobs j
                    join public.ai_image_generations g on g.id = j.generation_id
                   where j.run_after <= now()
                     and j.attempts < j.max_attempts
                     and j.status in ('queued', 'processing')
                     and (j.status = 'queued' or j.locked_at < now() - interval '5 minutes')
                     {provider_filter}
                   order by j.created_at
                   for update skip locked
                   limit 1
                )
                update public.creative_generation_jobs j
                   set status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = %s,
                       error_message = null, updated_at = now()
                  from candidate c
                 where j.id = c.id
                returning j.id as job_id, j.generation_id, j.payload as job_payload, j.attempts, j.max_attempts
                """,
                tuple(params),
            )
            job = _row(cursor, cursor.fetchone())
            if not job:
                return None
            cursor.execute(
                """
                select g.provider, g.model, g.prompt_manifest, g.reference_manifest, q.budget_period_id
                  from public.ai_image_generations g
                  join public.creative_slots s on s.id = g.slot_id
                  join public.creative_requests q on q.id = s.request_id
                 where g.id = %s for update
                """,
                (job["generation_id"],),
            )
            generation = _row(cursor, cursor.fetchone())
            if not generation:
                raise RuntimeError("creative generation disappeared")
            cursor.execute(
                "update public.ai_image_generations set provider_call_state = 'executing', started_at = coalesce(started_at, now()), updated_at = now() where id = %s",
                (job["generation_id"],),
            )
            return {**job, **generation}

    def _reserve(self, job: dict[str, Any]) -> None:
        budget_period_id = job.get("budget_period_id")
        if not budget_period_id:
            return
        payload = _object(job.get("job_payload"))
        reserved = payload.get("reserved_minor")
        if not isinstance(reserved, int) or reserved < 0:
            raise CreativeProviderError("generation job lacks valid reserved_minor", "do_not_retry")
        with self.repository.transaction() as cursor:
            cursor.execute("select id, status from public.creative_budget_reservations where generation_id = %s for update", (job["generation_id"],))
            existing = _row(cursor, cursor.fetchone())
            if existing and existing["status"] in {"reserved", "held_unknown", "settled", "resolved_spent"}:
                if existing["status"] == "held_unknown":
                    raise CreativeProviderError("budget is held_unknown and requires admin resolution", "do_not_retry")
                return
            if existing:
                raise CreativeProviderError("released generation must use a new attempt", "do_not_retry")
            cursor.execute("select public.reserve_creative_budget(%s, %s, %s)", (budget_period_id, job["generation_id"], reserved))

    def _finish(self, job: dict[str, Any], candidate: ProviderCandidate | None) -> None:
        payload = _object(job.get("job_payload"))
        reserved = int(payload.get("reserved_minor") or 0)
        with self.repository.transaction() as cursor:
            output_id: str | None = None
            if candidate is not None:
                sha256 = hashlib.sha256(candidate.payload).hexdigest()
                extension = {"image/png": "png", "image/jpeg": "jpg"}.get(candidate.mime_type, "webp")
                key = f"creative/temp/{job['generation_id']}/{sha256}.{extension}"
                self.storage.put_bytes(key, candidate.payload, candidate.mime_type)
                cursor.execute(
                    """insert into public.ai_image_generation_outputs(generation_id, candidate_index, temp_storage_key, temp_sha256, provenance)
                       values (%s, 0, %s, %s, %s::jsonb)
                       on conflict (generation_id, candidate_index) do update set temp_storage_key = excluded.temp_storage_key, temp_sha256 = excluded.temp_sha256, provenance = excluded.provenance, updated_at = now()
                       returning id""",
                    (job["generation_id"], key, sha256, _json({"mime_type": candidate.mime_type, "provider_request_id": candidate.provider_request_id, "provider": job["provider"], "model": job["model"], "final_sha256": sha256, **candidate.provenance})),
                )
                output = _row(cursor, cursor.fetchone())
                output_id = str(output["id"])
            cursor.execute(
                "update public.ai_image_generations set provider_call_state = 'succeeded', provider_request_id = %s, completed_at = now(), updated_at = now() where id = %s",
                (candidate.provider_request_id if candidate else None, job["generation_id"]),
            )
            cursor.execute(
                "update public.creative_generation_jobs set status = 'succeeded', result = %s::jsonb, locked_at = null, locked_by = null, completed_at = now(), updated_at = now() where id = %s",
                (_json({"output_id": output_id, "candidate_count": 1 if candidate else 0}), job["job_id"]),
            )
            if job.get("budget_period_id"):
                cursor.execute(
                    "update public.creative_budget_reservations set status = 'settled', actual_minor = %s, updated_at = now() where generation_id = %s and status = 'reserved'",
                    (candidate.actual_minor if candidate else reserved, job["generation_id"]),
                )
            cursor.execute("select public.recompute_creative_slots(array[(select slot_id from public.ai_image_generations where id = %s)])", (job["generation_id"],))

    def _fail(self, job: dict[str, Any], error: CreativeProviderError) -> None:
        retry_class = error.retry_class
        terminal = retry_class != "safe_retry" or int(job["attempts"]) >= int(job["max_attempts"])
        with self.repository.transaction() as cursor:
            if retry_class == "ambiguous":
                cursor.execute("update public.creative_budget_reservations set status = 'held_unknown', resolution_reason = %s, updated_at = now() where generation_id = %s and status = 'reserved'", (str(error)[:1000], job["generation_id"]))
                generation_state, job_state = "uncertain", "blocked"
            else:
                # A queued safe retry reuses its reservation so workers never
                # race beyond the cap. Once it exhausts max_attempts, the
                # provider outcome is known-no-charge and the terminal
                # reservation must be released before a manual new attempt.
                if job.get("budget_period_id") and (retry_class != "safe_retry" or terminal):
                    cursor.execute("update public.creative_budget_reservations set status = 'released', resolution_reason = %s, updated_at = now() where generation_id = %s and status = 'reserved'", (str(error)[:1000], job["generation_id"]))
                generation_state, job_state = (
                    ("failed", "failed") if terminal else ("queued", "queued")
                )
            cursor.execute(
                "update public.ai_image_generations set provider_call_state = %s, retry_class = %s, provider_request_id = coalesce(%s, provider_request_id), error_detail = %s, completed_at = case when %s then now() else null end, updated_at = now() where id = %s",
                (generation_state, retry_class, error.provider_request_id, str(error)[:2000], terminal or retry_class == "ambiguous", job["generation_id"]),
            )
            cursor.execute(
                "update public.creative_generation_jobs set status = %s, error_message = %s, locked_at = null, locked_by = null, run_after = case when %s = 'queued' then now() + least(900, 15 * attempts * attempts) * interval '1 second' else run_after end, completed_at = case when %s in ('failed', 'blocked') then now() else null end, updated_at = now() where id = %s",
                (job_state, str(error)[:2000], job_state, job_state, job["job_id"]),
            )
            # DB-owned derivation updates the slot and request exactly once.
            # This also turns terminal provider failures into visible failed
            # work rather than leaving Studio stuck on "generating".
            cursor.execute("select public.recompute_creative_slots(array[(select slot_id from public.ai_image_generations where id = %s)])", (job["generation_id"],))

    def _compose_preserve_pixels(self, background: ProviderCandidate, references: list[dict[str, Any]], compositor: Any) -> ProviderCandidate:
        """Deterministic final render. No model invocation occurs after this."""
        layout = _object(compositor)
        product_box = _object(layout.get("product_box"))
        try:
            width, height = int(layout["width"]), int(layout["height"])
            left, top = int(product_box["left"]), int(product_box["top"])
            box_width, box_height = int(product_box["width"]), int(product_box["height"])
        except (KeyError, TypeError, ValueError) as error:
            raise CreativeProviderError("preserve_pixels compositor layout is invalid", "do_not_retry") from error
        if not (320 <= width <= 4096 and 320 <= height <= 4096 and left >= 0 and top >= 0 and box_width > 0 and box_height > 0 and left + box_width <= width and top + box_height <= height):
            raise CreativeProviderError("preserve_pixels compositor layout is out of bounds", "do_not_retry")
        cutout = next((item for item in references if item.get("role") == "cutout"), None)
        if not isinstance(cutout, dict) or not isinstance(cutout.get("storage_path"), str):
            raise CreativeProviderError("preserve_pixels requires a verified cutout", "do_not_retry")
        try:
            background_image = Image.open(io.BytesIO(background.payload)).convert("RGBA")
            cutout_bytes = self.storage.get_bytes(cutout["storage_path"])
            cutout_image = Image.open(io.BytesIO(cutout_bytes)).convert("RGBA")
            canvas = ImageOps.fit(background_image, (width, height), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
            contained = ImageOps.contain(cutout_image, (box_width, box_height), method=Image.Resampling.LANCZOS)
            composite_left = left + (box_width - contained.width) // 2
            composite_top = top + (box_height - contained.height) // 2
            canvas.alpha_composite(contained, (composite_left, composite_top))
            encoded = io.BytesIO()
            canvas.convert("RGB").save(encoded, format="WEBP", quality=82, method=6)
        except Exception as error:  # PIL/R2 error; provider has already spent, so hold budget.
            raise CreativeProviderError(f"preserve_pixels compositor failed: {type(error).__name__}", "ambiguous") from error
        final_bytes = encoded.getvalue()
        return ProviderCandidate(
            final_bytes,
            "image/webp",
            background.provider_request_id,
            background.actual_minor,
            {
                "compositor_version": "pillow-preserve-pixels-v1",
                "pillow_version": getattr(Image, "__version__", "unknown"),
                "product_cutout_sha256": cutout.get("sha256"),
                "layer_manifest_hash": hashlib.sha256(json.dumps({"canvas": [width, height], "product_box": product_box}, sort_keys=True).encode("utf-8")).hexdigest(),
                "model_calls_after_composite": 0,
            },
        )

    def sweep_expired_candidates(self) -> int:
        """Expire candidates atomically, then delete only their exact R2 keys."""
        with self.repository.transaction() as cursor:
            # Promotion is resumable by calling promote again while the
            # candidate is valid. Once its TTL has elapsed, an incomplete
            # copy/verify saga may no longer shield it from expiry forever.
            # Marking the saga failed lets expire_creative_candidates perform
            # the canonical state transition and enables exact-key cleanup.
            cursor.execute(
                """
                update public.creative_storage_sagas s
                   set state = 'failed',
                       last_error = coalesce(s.last_error, 'promotion saga exceeded candidate TTL before DB finalize'),
                       updated_at = now()
                  from public.ai_image_generation_outputs o
                 where o.id = s.output_id
                   and o.creative_state = 'candidate'
                   and o.expires_at <= now()
                   and s.state in ('pending_copy', 'copied', 'verified')
                """
            )
            cursor.execute("select output_id, temp_storage_key from public.expire_creative_candidates()")
            expired = [_row(cursor, row) for row in cursor.fetchall()]
            cursor.execute(
                """
                select s.id as saga_id, s.canonical_storage_key
                  from public.creative_storage_sagas s
                  join public.ai_image_generation_outputs o on o.id = s.output_id
                 where o.creative_state = 'expired'
                   and s.state = 'failed'
                   and s.updated_at < now() - interval '1 hour'
                   and not exists (
                     select 1 from public.creative_storage_cleanup_events e
                      where e.saga_id = s.id and e.object_key = s.canonical_storage_key
                   )
                 for update skip locked
                """
            )
            orphaned = [_row(cursor, row) for row in cursor.fetchall()]
        removed = 0
        for item in expired:
            if not item:
                continue
            try:
                self.storage.delete_object(str(item["temp_storage_key"]))
                removed += 1
            except Exception:
                # The DB state is already terminal. A later object-lifecycle
                # retry can safely re-attempt this exact key.
                pass
        for item in orphaned:
            if not item:
                continue
            try:
                self.storage.delete_object(str(item["canonical_storage_key"]))
                with self.repository.transaction() as cursor:
                    cursor.execute(
                        "insert into public.creative_storage_cleanup_events(saga_id, object_key, cleanup_kind) values (%s,%s,'orphan_canonical') on conflict do nothing",
                        (item["saga_id"], item["canonical_storage_key"]),
                    )
                removed += 1
            except Exception:
                pass
        return removed

    def run_once(self) -> bool:
        try:
            provider_configs = load_shared_creative_config(self.repository)
        except Exception:
            # A malformed or unavailable Settings record must not consume a
            # queued job. An operator can repair the configuration in Settings.
            provider_configs = {}
        if not provider_configs and not (self.settings.openai_api_key or self.settings.gemini_api_key):
            return False
        set_configs = getattr(self.adapter, "set_provider_configs", None)
        if callable(set_configs):
            set_configs(provider_configs)
        allowed_providers = set(provider_configs)
        if self.settings.openai_api_key:
            allowed_providers.add("openai")
        if self.settings.gemini_api_key:
            allowed_providers.add("gemini")
        job = self._claim(allowed_providers)
        if not job:
            return False
        try:
            try:
                self._reserve(job)
            except CreativeProviderError:
                raise
            except Exception as error:
                # Budget reservation happens strictly before a provider
                # request. A hard cap/database rejection is known-no-charge.
                raise CreativeProviderError(f"creative pre-dispatch reservation failed: {type(error).__name__}", "do_not_retry") from error
            payload = _object(job.get("job_payload"))
            references = _object(job.get("reference_manifest")).get("roles")
            references = references if isinstance(references, list) else []
            prompt_manifest = _object(job.get("prompt_manifest"))
            fidelity_mode = str(prompt_manifest.get("fidelity_mode") or "reference_generate")
            candidate = self.adapter.generate_candidate(
                str(job["provider"]), str(job["model"]), prompt_manifest,
                references if fidelity_mode == "reference_generate" else [], int(payload.get("reserved_minor") or 0), self.storage,
                payload.get("size") if isinstance(payload.get("size"), str) else None,
            )
            if candidate is not None and fidelity_mode == "preserve_pixels":
                candidate = self._compose_preserve_pixels(candidate, references, payload.get("compositor"))
            self._finish(job, candidate)
        except CreativeProviderError as error:
            self._fail(job, error)
        except Exception as error:  # Provider may have received a request; do not retry automatically.
            self._fail(job, CreativeProviderError(f"ambiguous creative worker failure: {type(error).__name__}", "ambiguous"))
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Verity Creative generation worker")
    parser.add_argument("--once", action="store_true", help="Process one creative job and exit")
    args = parser.parse_args()
    worker = CreativeWorker(CreativeWorkerSettings.from_environment())
    try:
        if args.once:
            worker.run_once()
            worker.sweep_expired_candidates()
            return
        while True:
            if not worker.run_once():
                worker.sweep_expired_candidates()
                time.sleep(worker.settings.poll_seconds)
    finally:
        worker.close()


if __name__ == "__main__":
    main()
