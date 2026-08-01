# Project: AI Take Comparison Studio with Reference-Image Consistency

## What this app does
1. User enters a text prompt describing a subject/character.
2. App generates ONE reference image from that prompt (this becomes the "anchor" for consistency).
3. App fans out from that same reference image to 3 different video models (all within GMI Cloud, to control cost) — Kling, Seedance, and Veo3 — generating short video "takes."
4. All takes are displayed side-by-side in a simple UI; the user picks their favorite.
5. Every asset (reference image + all video takes) and its provenance manifest is stored in Backblaze B2, linked via `parent_run_id` so every take traces back to the same reference.
6. History/lineage view: user can see which take came from which model, with cost and generation time per take.

## Why this matters (for judging narrative)
- Solves a real, documented pain point: AI video generation is unpredictable, and creators currently generate multiple takes manually and compare by hand — this formalizes that workflow.
- Demonstrates Genblaze's actual differentiators (not just "call one API"): multi-model fan-out, provenance manifests, lineage tracking via `parent_run_id`, durable B2 storage.
- Production-minded: shows cost tracking per generation and full audit trail, not just a single demo output.

## Budget constraint — IMPORTANT
- Total budget for real API calls: **$5-10 USD**. Using GMI Cloud's signup credit plus a small top-up if needed.
- **Do NOT make real GMI Cloud API calls during development/debugging.** `GENBLAZE_MOCK=true` (the default, see `backend/config.py`) swaps in `MockProvider`/`MockVideoProvider` so the full pipeline — B2 upload, manifest creation, lineage linking, UI rendering — runs at zero API cost.
- Only switch to real API calls (`GENBLAZE_MOCK=false`) for the final generations needed for the demo, and keep video clips short (`duration=5` seconds) to minimize per-second video cost.

## Tech stack
- Backend: Python 3.11+, FastAPI (Genblaze is Python-only)
- Frontend: plain HTML/JS, served as static files by the same FastAPI app (avoids CORS entirely) — kept minimal, this is a hackathon, not production polish
- Storage: Backblaze B2 (S3-compatible), via `genblaze-s3`

## Install
```
pip install -r backend/requirements.txt
```

## Env vars needed (.env file — see .env.example)
```
GENBLAZE_MOCK=true          # false to hit real GMI Cloud + spend budget
B2_KEY_ID=...
B2_APP_KEY=...
B2_BUCKET=...
B2_REGION=us-west-004       # match your bucket's actual region
GMI_API_KEY=...             # only required when GENBLAZE_MOCK=false
```
Storage is optional in mock mode: if B2 credentials are absent, the pipeline runs without a `sink` (no upload), which is useful for pure offline iteration before a bucket is wired up.

## Verified Genblaze API shape (confirmed against github.com/backblaze-labs/genblaze source, not guessed)
```python
from genblaze_core import Modality, Pipeline, KeyStrategy, ObjectStorageSink
from genblaze_gmicloud import GMICloudImageProvider, GMICloudVideoProvider
from genblaze_s3 import S3StorageBackend

storage = ObjectStorageSink(
    S3StorageBackend.for_backblaze("my-bucket", region="us-west-004"),
    key_strategy=KeyStrategy.HIERARCHICAL,
)

# Step 1: generate one reference image
ref = Pipeline("reference-image").step(
    GMICloudImageProvider(), model="seedream-5.0-lite",
    prompt="<user prompt>", modality=Modality.IMAGE,
).run(sink=storage, timeout=120)

ref_asset = ref.run.steps[0].assets[0]

# Step 2: fan out to multiple video models, each conditioned on the SAME
# reference image via external_inputs, and linked to it via from_result()
# (which sets parent_run_id on the manifest for lineage — it does NOT
# propagate assets; that's what external_inputs is for).
take = Pipeline("take-kling").from_result(ref).step(
    GMICloudVideoProvider(), model="Kling-Image2Video-V2.1-Master",
    prompt="<motion prompt>", modality=Modality.VIDEO,
    external_inputs=[ref_asset], duration=5,
).run(sink=storage, timeout=600)
```
Note the exact per-model slug casing matters (GMI Cloud's queue is case-sensitive): Kling V2.1 models are PascalCase (`Kling-Image2Video-V2.1-Master`), Seedance/Seedream are lowercase. Double-check current slugs against console.gmicloud.ai before spending real money — the catalog rotates (see "Verified live" below for what changed).

## Verified live against console.gmicloud.ai (2026-07-27)
Re-check before the next real run — this catalog rotates.

| Model | Slug | Image-to-Video? | Price | Allowed duration |
|---|---|---|---|---|
| Reference image | `seedream-5.0-lite` | n/a (image) | $0.035/image | n/a |
| Kling 2.1 Master | `Kling-Image2Video-V2.1-Master` | yes | $0.28/sec | 5 or 10 sec only |
| Pixverse v5.6 I2V | `pixverse-v5.6-i2v` | yes | $0.03/sec | 5, 8, or 10 sec |
| Veo 3.1 Fast | `veo-3.1-fast-generate-001` | yes | $0.15/sec | 4, 6, or 8 sec only |

Findings that changed the code:
- **`Veo3` was stale.** Google's Veo is now listed under publisher "VertexAI" as `veo-3.1-*-001`/`-preview` variants. `veo-3.1-lite-generate-001` is text-to-video only (no image input) — avoid it. `veo-3.1-fast-generate-001` supports image-to-video and is the cheapest viable option.
- **`seedance-2-0-260128` is broken on GMI Cloud's own backend right now** — reproducible `Backend error (400)` both through our pipeline and through GMI's own Playground UI with the same image/prompt/params, so it's not a request-formatting issue on our side. Swapped in `wan2.7-r2v` as a replacement.
- **`wan2.7-r2v` also failed** — generic `Generation failed / Please try again later`, again reproduced in GMI's own Playground (with and without "Enable Prompt Extension"), so also not fixable on our side. Swapped in `pixverse-v5.6-i2v` instead, which succeeded in the Playground.
- Genblaze's connector maps images to different request slots per model family: Kling/Veo/Pixverse/Wan all use a single `"image"` slot (`route_images(slots=("image",))`), while Seedance splits into `"first_frame"`/`"last_frame"` slots — the multi-slot family was the one that broke, though that's likely coincidental given Wan (single-slot) also failed.
- Each model has a **different allowed duration set** — there's no single `duration=5` that works for all three. `backend/pipeline.py`'s `VIDEO_MODELS` now carries per-model `params`.
- Kling's parameter panel has no `aspect_ratio` field (only Text Prompt / Video Length / Negative Prompt / CFG Scale) — don't pass one, the image-to-video output inherits the input image's aspect ratio anyway.
- `seedream-5.0-lite`'s size parameter is called `Size`, not `aspect_ratio`, with preset values (2K, 3K, specific WxH) — not verified in full, so the reference-image step now omits any size override and takes the model default.

Cost for one full comparison run (reference + all 3 takes at minimum viable duration): $0.035 + $1.40 (Kling 5s) + $0.15 (Pixverse 5s) + $0.60 (Veo 4s) ≈ **$2.19**.

## Storage layout
`KeyStrategy.HIERARCHICAL` — groups assets by `{prefix}/{run_id}/`, manifest.json alongside each asset.

## CLI tools to demo (production-readiness flex for judges)
```
genblaze verify <file>.mp4       # verify manifest integrity
genblaze replay manifest.json    # preview a replay
genblaze extract <file>.mp4      # pull manifest back out of a media file
genblaze index manifest.json -o ./   # index into Parquet — nice follow-up for the history view
```

## Build order
1. Scaffold project structure (backend + minimal frontend) — done
2. Confirm B2 storage connection + manifest creation works, in mock generation mode
3. Fan-out pipeline logic (reference image → 3 linked video takes) — done, mock-mode by default
4. Side-by-side comparison UI + "pick favorite" + lineage/history view
5. Only once everything above works end-to-end on mock data: set `GENBLAZE_MOCK=false`, add a real `GMI_API_KEY`, and run the actual paid generations needed for the demo
6. Record the ~3 min demo video

## Still to confirm before step 5 (real spend)
- ~~Exact GMI Cloud video model IDs currently live in the console~~ — confirmed, see "Verified live" above.
- ~~Whether Seedance-2.0 and Veo3 support image-conditioned generation~~ — confirmed yes for both (using `veo-3.1-fast-generate-001`, not the stale `Veo3`).
- ~~Current per-second video pricing~~ — confirmed, ≈$2.39/run.
- Still open: `.env` has no real `GMI_API_KEY` / B2 credentials yet, and no real (non-mock) call has been made. First real run should be one small test before the full demo batch.
