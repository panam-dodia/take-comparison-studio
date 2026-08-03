"""Fan-out generation: one reference image -> N linked video takes.

Every take is conditioned on the same reference image (via ``external_inputs``)
and linked back to it (via ``from_result`` -> ``parent_run_id``), so the
provenance manifest for each take traces to a common anchor.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx
from genblaze_core import Asset, Modality, Pipeline

from . import config
from .storage import build_sink, upload_user_reference

if config.MOCK_GENERATION:
    from genblaze_core import MockProvider, MockVideoProvider

    # MockProvider/MockVideoProvider default to a fake https://mock.test/...
    # URL, which a *real* B2 sink can't fetch (DNS fails). Point them at a
    # real local file instead so B2 upload + manifest creation can still be
    # exercised for free — see DEVLOG.md.
    _MOCK_ASSET_DIR = Path(tempfile.gettempdir()) / "genblaze-mock-assets"
    _MOCK_ASSET_DIR.mkdir(exist_ok=True)

    def _write_mock_asset(filename: str, data: bytes, media_type: str) -> Asset:
        path = _MOCK_ASSET_DIR / filename
        path.write_bytes(data)
        return Asset(url=path.resolve().as_uri(), media_type=media_type, sha256=hashlib.sha256(data).hexdigest())

    _MOCK_IMAGE_ASSET = _write_mock_asset("reference.png", bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478"
        "da6360000002000155ac1c580000000049454e44ae426082"
    ), "image/png")
    _MOCK_VIDEO_ASSET = _write_mock_asset("take.mp4", b"placeholder bytes standing in for a real generated video", "video/mp4")

    def _image_provider():
        return MockProvider(assets=[_MOCK_IMAGE_ASSET])

    def _video_provider():
        return MockVideoProvider(assets=[_MOCK_VIDEO_ASSET])
else:
    from genblaze_gmicloud import GMICloudImageProvider, GMICloudVideoProvider

    def _image_provider():
        return GMICloudImageProvider()

    def _video_provider():
        return GMICloudVideoProvider()


# Verified live against console.gmicloud.ai on 2026-07-27 — slugs, params,
# and prices all rotate, so re-check before spending real budget again.
# Each model has a different allowed duration set and a different parameter
# surface (e.g. Kling has no aspect_ratio param), hence per-model params.
REFERENCE_MODEL = "seedream-5.0-lite"  # $0.035/image
VIDEO_MODELS = [
    {
        "key": "kling", "label": "Kling 2.1 Master",
        "model": "Kling-Image2Video-V2.1-Master",  # $0.28/sec, duration in {5, 10}
        # No resolution/quality param exists for this model on GMI Cloud —
        # its parameter panel only has Text Prompt / Video Length /
        # Negative Prompt / CFG Scale, so there's nothing to lower here.
        "params": {"duration": 5},
    },
    {
        "key": "pixverse", "label": "Pixverse v5.6 I2V",
        "model": "pixverse-v5.6-i2v",  # $0.03/sec, duration in {5, 8, 10} —
        # swapped in after BOTH seedance-2-0-260128 (Backend error 400) and
        # wan2.7-r2v (generic "please try again later") failed on GMI
        # Cloud's own side (confirmed via their Playground UI, not our
        # code) — see DEVLOG.md.
        # GMI's real API wants "image_url" as an explicit string field (not
        # genblaze's generic "image" chain-input slot) and "duration" as a
        # STRING enum ("5"), not an int. genblaze's own Pixverse connector
        # forces duration back to an int via IntSchema + _coerce_whole_seconds
        # no matter what we pass — a genblaze SDK bug, confirmed by comparing
        # against GMI's own published API docs. So in REAL mode this model
        # bypasses genblaze's Pipeline entirely (see _run_pixverse_direct)
        # and calls GMI Cloud's REST API directly instead. Mock mode is
        # unaffected — it still goes through the normal genblaze mock path.
        "params": {"duration": 5, "aspect_ratio": "16:9", "quality": "540p"},
        "direct_gmi_call": True,
    },
    {
        "key": "veo", "label": "Veo 3.1 Fast",
        "model": "veo-3.1-fast-generate-001",  # $0.15/sec, duration in {4, 6, 8} — "Veo3" is stale
        # No 540p option on GMI Cloud for this model — 720p is its lowest.
        "params": {"duration": 4, "aspect_ratio": "16:9", "resolution": "720p"},
    },
]

PROJECT_ID = "take-comparison-studio"

# genblaze only populates step.cost_usd when a pricing strategy is
# registered with it, which we haven't done — so this fills the gap using
# the rates verified live against console.gmicloud.ai on 2026-07-27 (see
# DEVLOG.md). Re-check these before trusting cost figures on a later run.
PRICING = {
    "seedream-5.0-lite": {"kind": "flat", "rate": 0.035},
    "Kling-Image2Video-V2.1-Master": {"kind": "per_second", "rate": 0.28},
    "pixverse-v5.6-i2v": {"kind": "per_second", "rate": 0.03},
    "veo-3.1-fast-generate-001": {"kind": "per_second", "rate": 0.15},
}


def _estimate_cost(model: str, duration_sec: int | None) -> float | None:
    pricing = PRICING.get(model)
    if pricing is None:
        return None
    if pricing["kind"] == "flat":
        return pricing["rate"]
    if duration_sec is None:
        return None
    return round(pricing["rate"] * duration_sec, 3)


def _resolve_cost(genblaze_cost: float | None, model: str, duration_sec: int | None) -> float | None:
    if genblaze_cost is not None:
        return genblaze_cost
    if config.MOCK_GENERATION:
        return None  # no real cost in mock mode — don't show a fake dollar figure
    return _estimate_cost(model, duration_sec)


@dataclass
class TakeResult:
    key: str
    label: str
    model: str
    status: str
    url: str | None
    cost_usd: float | None
    duration_sec: float | None
    run_id: str
    manifest_uri: str | None
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ComparisonResult:
    parent_run_id: str
    reference_url: str | None
    reference_manifest_uri: str | None
    prompt: str
    motion_prompt: str
    reference_cost_usd: float | None = None
    takes: list[TakeResult] = field(default_factory=list)
    favorite_key: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferenceOnlyResult:
    """Just the image step — for a cheap real-API smoke test before the full
    (much more expensive) fan-out to all 3 video models."""
    run_id: str
    status: str
    url: str | None
    cost_usd: float | None
    manifest_uri: str | None
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _generate_reference(prompt: str, sink):
    ref_result = (
        Pipeline(f"reference-{uuid.uuid4().hex[:8]}", project_id=PROJECT_ID)
        .step(
            _image_provider(),
            model=REFERENCE_MODEL,
            prompt=prompt,
            modality=Modality.IMAGE,
        )
        .run(sink=sink, timeout=120)
    )
    return ref_result, ref_result.run.steps[0]


def generate_reference_only(prompt: str, progress: dict | None = None) -> ReferenceOnlyResult:
    if progress is not None:
        progress["reference"] = {"status": "processing", "started_at": time.time()}

    sink = build_sink()
    ref_result, ref_step = _generate_reference(prompt, sink)
    result = ReferenceOnlyResult(
        run_id=ref_result.run.run_id,
        status=str(ref_step.status),
        url=ref_step.assets[0].url if ref_step.assets else None,
        cost_usd=_resolve_cost(ref_step.cost_usd, REFERENCE_MODEL, None),
        manifest_uri=ref_result.manifest.manifest_uri,
        error=ref_step.error if str(ref_step.status) != "succeeded" else None,
    )

    if progress is not None:
        progress["reference"].update(status=result.status, completed_at=time.time())
    return result


GMI_BASE_URL = "https://console.gmicloud.ai"


def _pixverse_direct_generate(prompt: str, image_url: str, duration: int, aspect_ratio: str, quality: str) -> tuple[bytes, dict]:
    """Calls GMI Cloud's REST API directly for Pixverse, bypassing
    genblaze's Pipeline entirely — see the comment on the "pixverse" entry
    in VIDEO_MODELS for why. Returns (video_bytes, raw_status_response)."""
    if not config.GMI_API_KEY:
        raise RuntimeError("GMI_API_KEY is not configured")

    headers = {"Authorization": f"Bearer {config.GMI_API_KEY}", "Content-Type": "application/json"}
    body = {
        "model": "pixverse-v5.6-i2v",
        "payload": {
            "image_url": image_url,
            "prompt": prompt,
            "duration": str(duration),
            "aspect_ratio": aspect_ratio,
            "quality": quality,
        },
    }

    with httpx.Client(timeout=30) as client:
        submit_resp = client.post(f"{GMI_BASE_URL}/api/v1/ie/requestqueue/apikey/requests", json=body, headers=headers)
        submit_resp.raise_for_status()
        submit_data = submit_resp.json()
        request_id = submit_data.get("request_id") or submit_data.get("id")
        if not request_id:
            raise RuntimeError(f"GMI Cloud submit response had no request_id: {submit_data}")

        deadline = time.time() + 600
        status_data: dict = {}
        while time.time() < deadline:
            status_resp = client.get(f"{GMI_BASE_URL}/api/v1/ie/requestqueue/apikey/requests/{request_id}", headers=headers)
            status_resp.raise_for_status()
            status_data = status_resp.json()
            status = status_data.get("status")
            if status == "success":
                outcome = status_data.get("outcome") or {}
                # GMI's own docs claim outcome.video_url, but the real live
                # response instead nests it as outcome.media_urls[0].url —
                # confirmed against an actual successful response. Try both.
                media_urls = outcome.get("media_urls") or []
                video_url = outcome.get("video_url") or (media_urls[0].get("url") if media_urls else None)
                if not video_url:
                    raise RuntimeError(
                        f"success response had no recognizable video URL for request_id={request_id} — full response: {status_data}"
                    )
                video_resp = client.get(video_url)
                video_resp.raise_for_status()
                return video_resp.content, status_data
            if status in ("failed", "cancelled"):
                raise RuntimeError(f"GMI Cloud request {status}: {status_data}")
            time.sleep(4)

    raise TimeoutError(f"GMI Cloud request timed out after 600s; last status: {status_data}")


def _run_pixverse_direct(spec: dict, ref_asset, motion_prompt: str) -> TakeResult:
    """Real GMI Cloud call for Pixverse via direct HTTP (see
    _pixverse_direct_generate). Since this bypasses genblaze's Pipeline,
    there's no genblaze-native manifest for this step — a lightweight
    manifest is built and uploaded to B2 by hand instead, so provenance
    still lands durably even without genblaze's tooling wrapping this call.
    """
    duration = spec["params"]["duration"]
    started_at = time.time()
    run_id = f"pixverse-direct-{uuid.uuid4().hex[:8]}"

    try:
        video_bytes, raw_status = _pixverse_direct_generate(
            prompt=motion_prompt,
            image_url=ref_asset.url,
            duration=duration,
            aspect_ratio=spec["params"].get("aspect_ratio", "16:9"),
            quality=spec["params"].get("quality", "540p"),
        )
    except Exception as exc:
        return TakeResult(
            key=spec["key"], label=spec["label"], model=spec["model"],
            status="failed", url=None, cost_usd=None, duration_sec=None,
            run_id=run_id, manifest_uri=None, error=str(exc),
        )

    completed_at = time.time()
    video_url = raw_status.get("outcome", {}).get("video_url")
    manifest_uri = None
    try:
        video_url = upload_user_reference(video_bytes, f"{run_id}.mp4", "video/mp4")
        manifest = {
            "run_id": run_id,
            "model": spec["model"],
            "provider": "gmicloud-direct",
            "prompt": motion_prompt,
            "duration_requested": duration,
            "reference_image_url": ref_asset.url,
            "video_url": video_url,
            "gmi_raw_status": raw_status,
            "note": (
                "Generated via a direct GMI Cloud API call, bypassing genblaze's "
                "Pipeline — its Pixverse connector forces `duration` to an int, "
                "which GMI Cloud's real API rejects (it requires a string enum). "
                "See DEVLOG.md."
            ),
        }
        manifest_uri = upload_user_reference(
            json.dumps(manifest, indent=2).encode("utf-8"), f"{run_id}-manifest.json", "application/json",
        )
    except Exception:
        pass  # keep the raw GMI-hosted video URL as a fallback if the B2 upload has an issue

    return TakeResult(
        key=spec["key"],
        label=spec["label"],
        model=spec["model"],
        status="succeeded",
        url=video_url,
        cost_usd=_estimate_cost(spec["model"], duration),
        duration_sec=completed_at - started_at,
        run_id=run_id,
        manifest_uri=manifest_uri,
        error=None,
    )


def _run_take(spec: dict, ref_result, ref_asset, motion_prompt: str, sink, progress: dict | None = None) -> TakeResult:
    if progress is not None:
        progress["takes"][spec["key"]].update(status="processing", started_at=time.time())

    if spec.get("direct_gmi_call") and not config.MOCK_GENERATION:
        result = _run_pixverse_direct(spec, ref_asset, motion_prompt)
        if progress is not None:
            progress["takes"][spec["key"]].update(status=result.status, completed_at=time.time())
        return result

    run_name = f"take-{spec['key']}-{uuid.uuid4().hex[:8]}"
    try:
        take_result = (
            Pipeline(run_name, project_id=PROJECT_ID)
            .from_result(ref_result)
            .step(
                _video_provider(),
                model=spec["model"],
                prompt=motion_prompt,
                modality=Modality.VIDEO,
                external_inputs=[ref_asset],
                **spec["params"],
            )
            .run(sink=sink, timeout=600)
        )
    except Exception as exc:  # provider/network failure shouldn't kill the other takes
        result = TakeResult(
            key=spec["key"], label=spec["label"], model=spec["model"],
            status="failed", url=None, cost_usd=None, duration_sec=None,
            run_id="", manifest_uri=None, error=str(exc),
        )
        if progress is not None:
            progress["takes"][spec["key"]].update(status="failed", completed_at=time.time())
        return result

    step = take_result.run.steps[0]
    duration_sec = None
    if step.started_at and step.completed_at:
        duration_sec = (step.completed_at - step.started_at).total_seconds()

    result = TakeResult(
        key=spec["key"],
        label=spec["label"],
        model=spec["model"],
        status=str(step.status),
        url=step.assets[0].url if step.assets else None,
        cost_usd=_resolve_cost(step.cost_usd, spec["model"], spec["params"].get("duration")),
        duration_sec=duration_sec,
        run_id=take_result.run.run_id,
        manifest_uri=take_result.manifest.manifest_uri,
        error=step.error if step.status != "succeeded" else None,
    )
    if progress is not None:
        progress["takes"][spec["key"]].update(status=result.status, completed_at=time.time())
    return result


class _FakeRun:
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id


class _FakeReferenceResult:
    """Stands in for a real Pipeline result so retry_take() can call
    .from_result() for lineage without re-running (and re-paying for) the
    reference-image step."""
    def __init__(self, run_id: str) -> None:
        self.run = _FakeRun(run_id)


def _external_image_asset(reference_url: str) -> Asset:
    """Wrap a caller-supplied image URL (not from a fresh genblaze run) as
    an Asset for external_inputs. Forces an image/* media type regardless
    of what mimetypes guesses — it maps unfamiliar extensions to
    application/octet-stream, not None, which would make route_images()
    silently drop the asset (see DEVLOG.md)."""
    guessed = mimetypes.guess_type(reference_url)[0]
    media_type = guessed if guessed and guessed.startswith("image/") else "image/jpeg"
    return Asset(url=reference_url, media_type=media_type, sha256="0" * 64)


def retry_take(reference_url: str, reference_run_id: str, model_key: str, motion_prompt: str) -> TakeResult:
    """Re-run a single failed video model against an already-generated
    reference image, instead of re-paying for the image + every other
    model just to test a fix for one."""
    spec = next((s for s in VIDEO_MODELS if s["key"] == model_key), None)
    if spec is None:
        raise ValueError(f"Unknown model key: {model_key}")

    ref_asset = _external_image_asset(reference_url)
    ref_result = _FakeReferenceResult(reference_run_id)
    sink = build_sink()
    return _run_take(spec, ref_result, ref_asset, motion_prompt, sink)


def generate_takes_from_reference(
    reference_url: str,
    motion_prompt: str,
    reference_run_id: str | None = None,
    reference_cost_usd: float | None = None,
    progress: dict | None = None,
) -> ComparisonResult:
    """Fan out to all VIDEO_MODELS using a reference image the caller
    already has, so they don't have to pay for a fresh reference-image
    generation. Pass reference_run_id/reference_cost_usd when the image
    came from a real tracked generation (e.g. the "stage the image first"
    flow) so lineage and cost stay accurate — otherwise a synthetic run id
    is used, for a genuinely external image with no generation to trace."""
    sink = build_sink()
    if reference_run_id is None:
        reference_run_id = f"external-{uuid.uuid4().hex[:8]}"
    ref_asset = _external_image_asset(reference_url)
    ref_result = _FakeReferenceResult(reference_run_id)

    if progress is not None:
        now = time.time()
        progress["reference"] = {"status": "succeeded", "started_at": now, "completed_at": now}
        progress["takes"] = {
            spec["key"]: {"label": spec["label"], "status": "pending"}
            for spec in VIDEO_MODELS
        }

    result = ComparisonResult(
        parent_run_id=reference_run_id,
        reference_url=reference_url,
        reference_manifest_uri=None,
        prompt=motion_prompt,
        motion_prompt=motion_prompt,
        reference_cost_usd=reference_cost_usd if reference_cost_usd is not None else 0.0,
    )

    with ThreadPoolExecutor(max_workers=len(VIDEO_MODELS)) as pool:
        futures = [
            pool.submit(_run_take, spec, ref_result, ref_asset, motion_prompt, sink, progress)
            for spec in VIDEO_MODELS
        ]
        takes = [f.result() for f in as_completed(futures)]

    takes.sort(key=lambda t: [spec["key"] for spec in VIDEO_MODELS].index(t.key))
    result.takes = takes
    return result


def generate_comparison(prompt: str, motion_prompt: str | None = None, progress: dict | None = None) -> ComparisonResult:
    motion_prompt = motion_prompt or prompt
    sink = build_sink()

    if progress is not None:
        progress["reference"] = {"status": "processing", "started_at": time.time()}
        progress["takes"] = {
            spec["key"]: {"label": spec["label"], "status": "pending"}
            for spec in VIDEO_MODELS
        }

    ref_result, ref_step = _generate_reference(prompt, sink)

    if str(ref_step.status) != "succeeded" or not ref_step.assets:
        if progress is not None:
            progress["reference"].update(status="failed", completed_at=time.time())
        raise RuntimeError(f"Reference image generation failed: {ref_step.error}")
    ref_asset = ref_step.assets[0]

    if progress is not None:
        progress["reference"].update(status="succeeded", completed_at=time.time())

    result = ComparisonResult(
        parent_run_id=ref_result.run.run_id,
        reference_url=ref_asset.url,
        reference_manifest_uri=ref_result.manifest.manifest_uri,
        prompt=prompt,
        motion_prompt=motion_prompt,
        reference_cost_usd=_resolve_cost(ref_step.cost_usd, REFERENCE_MODEL, None),
    )

    with ThreadPoolExecutor(max_workers=len(VIDEO_MODELS)) as pool:
        futures = [
            pool.submit(_run_take, spec, ref_result, ref_asset, motion_prompt, sink, progress)
            for spec in VIDEO_MODELS
        ]
        takes = [f.result() for f in as_completed(futures)]

    takes.sort(key=lambda t: [spec["key"] for spec in VIDEO_MODELS].index(t.key))
    result.takes = takes
    return result
