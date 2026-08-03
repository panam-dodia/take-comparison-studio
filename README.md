# Take Comparison Studio

**Live app:** https://take-comparison-studio.onrender.com
*(Free-tier hosting — spins down after ~15 min idle; first request after that can take 30-60s to wake up.)*

Generate one reference image, fan out to 3 GMI Cloud video models conditioned
on that same image, compare the takes side-by-side, and pick a favorite.
Every asset and its provenance manifest is stored in Backblaze B2, linked via
`parent_run_id` back to the shared reference image.

See [DEVLOG.md](DEVLOG.md) for the full design rationale and the verified
Genblaze API shape used here.

## Using the app

Three ways to start:
1. **I already have an image** — upload a file or paste an image URL, skip straight to generating the 3 video takes.
2. **Generate the image first, then decide** — generates just the reference image so you can review it, and only pays for video generation once you approve it (or regenerate the image if it doesn't look right).
3. **Generate everything automatically** — one click, image and all 3 takes run together in the background.

All three show a live progress bar with real per-step status and elapsed time (generation time varies a lot between providers, from seconds to several minutes). Past runs are available under **History**, where you can revisit a comparison or pick a favorite take.

## Setup

```bash
pip install -r backend/requirements.txt
cp .env.example .env
```

Edit `.env`:
- Leave `GENBLAZE_MOCK=true` to run the full pipeline (generation + B2 upload
  + manifest + lineage) at zero API cost, using Genblaze's mock providers.
- Fill in `B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET` to exercise real B2 storage
  (free within the 10GB tier) even while mocking generation.
- Only set `GENBLAZE_MOCK=false` and `GMI_API_KEY` once you're ready to spend
  real budget on the final demo generations.

## Run

```bash
uvicorn backend.app:app --reload --port 8000
```

Open http://localhost:8000

## Providers & models

- Reference image: GMI Cloud `seedream-5.0-lite` ($0.035/image)
- Video takes: GMI Cloud `Kling-Image2Video-V2.1-Master` ($0.28/sec, 5 or 10s),
  `pixverse-v5.6-i2v` ($0.03/sec, 5/8/10s), `veo-3.1-fast-generate-001`
  ($0.15/sec, 4/6/8s)

Verified live against console.gmicloud.ai on 2026-07-27 — see DEVLOG.md for
the full findings. Model slugs are case-sensitive on GMI Cloud and the
catalog rotates (e.g. `Veo3` is stale, superseded by the `veo-3.1-*` family
under publisher "VertexAI") — re-verify before spending real budget again.

## B2 & Genblaze usage

- **Genblaze** orchestrates the fan-out: one `Pipeline` generates the
  reference image, then three more `Pipeline`s each call
  `.from_result(ref)` (lineage: sets `parent_run_id`) and
  `.step(..., external_inputs=[ref_asset])` (conditions the video on the same
  reference image).
- **Backblaze B2** is the `ObjectStorageSink` backend for every pipeline run —
  every generated asset and its SHA-256 provenance manifest lands in B2,
  organized by `KeyStrategy.HIERARCHICAL`.

## CLI tools

```bash
genblaze verify <file>.mp4
genblaze replay manifest.json
genblaze extract <file>.mp4
```

## License

MIT — see [LICENSE](LICENSE).
