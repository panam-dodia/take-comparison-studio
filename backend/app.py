from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .pipeline import generate_comparison, generate_reference_only, generate_takes_from_reference, retry_take
from .storage import upload_user_reference

app = FastAPI(title="Take Comparison Studio")

# In-memory job registry for the generate flow, so the frontend can poll for
# live per-step progress instead of blocking on one multi-minute request.
# Fine for a single-process hackathon app; wouldn't survive a server restart
# or multiple worker processes.
JOBS: dict[str, dict] = {}


class GenerateRequest(BaseModel):
    prompt: str
    motion_prompt: str | None = None


class FavoriteRequest(BaseModel):
    take_key: str


class RetryTakeRequest(BaseModel):
    reference_url: str
    reference_run_id: str
    model_key: str
    motion_prompt: str


class TakesFromReferenceRequest(BaseModel):
    reference_url: str
    motion_prompt: str
    reference_run_id: str | None = None
    reference_cost_usd: float | None = None


def _load_runs() -> list[dict]:
    if not config.RUNS_INDEX_PATH.exists():
        return []
    return json.loads(config.RUNS_INDEX_PATH.read_text())


def _save_runs(runs: list[dict]) -> None:
    config.RUNS_INDEX_PATH.write_text(json.dumps(runs, indent=2))


@app.post("/api/upload-reference")
async def upload_reference(file: UploadFile = File(...)):
    """Uploads a user-supplied reference image to B2 and returns its public
    URL — zero GMI Cloud cost, just moves bytes to storage."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        url = upload_user_reference(data, file.filename or "reference.jpg", file.content_type or "image/jpeg")
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
    return {"url": url}


def _start_job(target, args) -> str:
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {"status": "running", "progress": {}, "result": None, "error": None}
    thread = threading.Thread(target=target, args=(job_id, *args), daemon=True)
    thread.start()
    return job_id


def _run_test_reference_job(job_id: str, prompt: str) -> None:
    job = JOBS[job_id]
    try:
        result = generate_reference_only(prompt, progress=job["progress"])
        job["status"] = "done"
        job["result"] = result.to_dict()
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)


@app.post("/api/test-reference")
def test_reference(req: GenerateRequest):
    """Reference image only — cheap (~$0.035) real-API smoke test, no video
    fan-out, so a bad slug/key doesn't burn the full ~$2.39 run's budget."""
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is required")
    return {"job_id": _start_job(_run_test_reference_job, (req.prompt,))}


def _run_generate_job(job_id: str, prompt: str, motion_prompt: str | None) -> None:
    job = JOBS[job_id]
    try:
        result = generate_comparison(prompt, motion_prompt, progress=job["progress"])
        runs = _load_runs()
        runs.insert(0, result.to_dict())
        _save_runs(runs)
        job["status"] = "done"
        job["result"] = result.to_dict()
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)


@app.post("/api/generate")
def generate(req: GenerateRequest):
    """Starts the fan-out in a background thread and returns immediately —
    poll GET /api/jobs/{job_id} for live progress, since a full run can take
    several minutes and per-step timing varies a lot between models."""
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is required")
    job_id = _start_job(_run_generate_job, (req.prompt, req.motion_prompt))
    return {"job_id": job_id}


def _run_takes_from_reference_job(
    job_id: str, reference_url: str, motion_prompt: str,
    reference_run_id: str | None, reference_cost_usd: float | None,
) -> None:
    job = JOBS[job_id]
    try:
        result = generate_takes_from_reference(
            reference_url, motion_prompt, reference_run_id, reference_cost_usd, progress=job["progress"],
        )
        runs = _load_runs()
        runs.insert(0, result.to_dict())
        _save_runs(runs)
        job["status"] = "done"
        job["result"] = result.to_dict()
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)


@app.post("/api/generate-takes-from-reference")
def generate_takes_from_reference_endpoint(req: TakesFromReferenceRequest):
    """Fan out to all 3 video models using a reference image the caller
    already has, skipping the reference-image generation cost entirely.
    If reference_run_id/reference_cost_usd are supplied (the image came
    from a real tracked generation, e.g. the "stage the image first" flow),
    lineage and cost stay accurate instead of using a synthetic run id."""
    if not req.reference_url.strip():
        raise HTTPException(400, "reference_url is required")
    job_id = _start_job(
        _run_takes_from_reference_job,
        (req.reference_url, req.motion_prompt, req.reference_run_id, req.reference_cost_usd),
    )
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@app.get("/api/runs")
def list_runs():
    return _load_runs()


@app.get("/api/runs/{parent_run_id}")
def get_run(parent_run_id: str):
    for run in _load_runs():
        if run["parent_run_id"] == parent_run_id:
            return run
    raise HTTPException(404, "run not found")


@app.post("/api/runs/{parent_run_id}/retry-take")
def retry_take_endpoint(parent_run_id: str, req: RetryTakeRequest):
    """Re-run one failed video model against the reference image that's
    already been paid for, instead of re-running the whole ~$2.39 batch."""
    try:
        result = retry_take(req.reference_url, req.reference_run_id, req.model_key, req.motion_prompt)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    runs = _load_runs()
    for run in runs:
        if run["parent_run_id"] == parent_run_id:
            for i, t in enumerate(run["takes"]):
                if t["key"] == req.model_key:
                    run["takes"][i] = result.to_dict()
                    break
            _save_runs(runs)
            return run
    raise HTTPException(404, "run not found")


@app.post("/api/runs/{parent_run_id}/favorite")
def set_favorite(parent_run_id: str, req: FavoriteRequest):
    runs = _load_runs()
    for run in runs:
        if run["parent_run_id"] == parent_run_id:
            run["favorite_key"] = req.take_key
            _save_runs(runs)
            return run
    raise HTTPException(404, "run not found")


# Mounted last so /api/* routes above always match first.
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
