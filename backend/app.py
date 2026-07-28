from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .pipeline import generate_comparison, generate_reference_only, retry_take

app = FastAPI(title="Take Comparison Studio")


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


def _load_runs() -> list[dict]:
    if not config.RUNS_INDEX_PATH.exists():
        return []
    return json.loads(config.RUNS_INDEX_PATH.read_text())


def _save_runs(runs: list[dict]) -> None:
    config.RUNS_INDEX_PATH.write_text(json.dumps(runs, indent=2))


@app.get("/api/config")
def get_config():
    return {"mock_generation": config.MOCK_GENERATION, "storage_enabled": config.STORAGE_ENABLED}


@app.post("/api/test-reference")
def test_reference(req: GenerateRequest):
    """Reference image only — cheap (~$0.035) real-API smoke test, no video
    fan-out, so a bad slug/key doesn't burn the full ~$2.39 run's budget."""
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is required")
    try:
        result = generate_reference_only(req.prompt)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
    return result.to_dict()


@app.post("/api/generate")
def generate(req: GenerateRequest):
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is required")
    try:
        result = generate_comparison(req.prompt, req.motion_prompt)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    runs = _load_runs()
    runs.insert(0, result.to_dict())
    _save_runs(runs)
    return result.to_dict()


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
