const toastContainer = document.getElementById("toast-container");

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// --- Chooser / flow navigation ---

const chooser = document.getElementById("chooser");
const flowPanels = {
  existing: document.getElementById("flow-existing"),
  staged: document.getElementById("flow-staged"),
  auto: document.getElementById("flow-auto"),
};

function showChooser() {
  chooser.classList.remove("hidden");
  Object.values(flowPanels).forEach((p) => p.classList.add("hidden"));
}

function showFlow(name) {
  chooser.classList.add("hidden");
  Object.entries(flowPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== name);
  });
}

document.querySelectorAll(".option-card").forEach((card) => {
  card.addEventListener("click", () => showFlow(card.dataset.flow));
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", showChooser);
});

// --- History panel (toggled independently of the chooser/flow) ---

const historyToggle = document.getElementById("history-toggle");
const historyPanel = document.getElementById("history-panel");

historyToggle.addEventListener("click", async () => {
  const willShow = historyPanel.classList.contains("hidden");
  historyPanel.classList.toggle("hidden", !willShow);
  if (willShow) await loadHistory();
});

// --- Result rendering (shared by all generate flows) ---

const resultPanel = document.getElementById("result-panel");
const referenceImage = document.getElementById("reference-image");
const referenceMeta = document.getElementById("reference-meta");
const takesGrid = document.getElementById("takes-grid");
const historyList = document.getElementById("history-list");

function renderTake(take, run) {
  const card = document.createElement("div");
  card.className = "take-card" + (take.favorite ? " favorite" : "");

  const media = take.status === "succeeded" && take.url
    ? `<video src="${take.url}" controls muted></video>`
    : `<div class="placeholder">${take.status === "failed" ? "generation failed" : take.status}</div>`;

  card.innerHTML = `
    <span class="status-pill ${take.status}">${take.status}</span>
    ${media}
    <h3>${take.label}</h3>
    <div class="take-meta">
      model: ${take.model}<br/>
      ${take.cost_usd != null ? `cost: $${take.cost_usd.toFixed(3)}<br/>` : ""}
      ${take.duration_sec != null ? `gen time: ${take.duration_sec.toFixed(1)}s<br/>` : ""}
      run: ${take.run_id || "n/a"}
      ${take.manifest_uri ? `<br/><a href="${take.manifest_uri}" target="_blank" rel="noopener">view manifest</a>` : ""}
      ${take.error ? `<br/><span style="color:#ff6b6b">${take.error}</span>` : ""}
    </div>
    ${take.status === "failed" ? '<button class="retry-btn">Retry this model only</button>' : ""}
    <button class="pick-btn" ${take.status !== "succeeded" ? "disabled" : ""}>
      ${take.favorite ? "Favorite ✓" : "Pick this take"}
    </button>
  `;

  card.querySelector(".pick-btn").addEventListener("click", async () => {
    await fetch(`/api/runs/${run.parent_run_id}/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ take_key: take.key }),
    });
    await loadHistory();
    renderResult(await (await fetch(`/api/runs/${run.parent_run_id}`)).json());
  });

  const retryBtn = card.querySelector(".retry-btn");
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      showToast(`Retrying ${take.label} against the existing reference image…`);
      try {
        const res = await fetch(`/api/runs/${run.parent_run_id}/retry-take`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference_url: run.reference_url,
            reference_run_id: run.parent_run_id,
            model_key: take.key,
            motion_prompt: run.motion_prompt,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "retry failed");
        renderResult(data);
        await loadHistory();
        showToast("Retry done.", "success");
      } catch (err) {
        showToast(`Error: ${err.message}`, "error");
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry this model only";
      }
    });
  }

  return card;
}

function renderResult(run) {
  resultPanel.classList.remove("hidden");
  referenceImage.style.visibility = "";
  referenceImage.onerror = () => { referenceImage.style.visibility = "hidden"; };
  referenceImage.src = run.reference_url || "";
  const refCost = run.reference_cost_usd != null ? ` · cost: $${run.reference_cost_usd.toFixed(3)}` : "";
  const refManifest = run.reference_manifest_uri
    ? ` · <a href="${run.reference_manifest_uri}" target="_blank" rel="noopener">view manifest</a>`
    : "";
  referenceMeta.innerHTML = `run: ${run.parent_run_id} · prompt: "${run.prompt}"${refCost}${refManifest}`;

  takesGrid.innerHTML = "";
  for (const take of run.takes) {
    const withFavorite = { ...take, favorite: run.favorite_key === take.key };
    takesGrid.appendChild(renderTake(withFavorite, run));
  }
}

async function loadHistory() {
  const res = await fetch("/api/runs");
  const runs = await res.json();
  historyList.innerHTML = "";
  if (runs.length === 0) {
    historyList.innerHTML = '<p class="empty">No runs yet.</p>';
    return;
  }
  for (const run of runs) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <img src="${run.reference_url || ""}" onerror="this.style.visibility='hidden'" />
      <span class="h-prompt">${run.prompt}</span>
      ${run.favorite_key ? `<span class="h-fav">★ ${run.favorite_key}</span>` : ""}
    `;
    item.addEventListener("click", () => {
      renderResult(run);
      showToast("Loaded from history.");
    });
    historyList.appendChild(item);
  }
}

// --- Generic progress bar + job polling ---

function elapsedSeconds(step) {
  if (!step.started_at) return null;
  const end = step.completed_at || Date.now() / 1000;
  return Math.max(0, end - step.started_at);
}

function renderProgress(progress, fillEl, stepsEl) {
  const steps = [];
  if (progress.reference) steps.push({ label: "Reference image", ...progress.reference });
  for (const take of Object.values(progress.takes || {})) {
    steps.push({ label: take.label, status: take.status, started_at: take.started_at, completed_at: take.completed_at });
  }

  const total = steps.length;
  const done = steps.filter((s) => s.status === "succeeded" || s.status === "failed").length;
  fillEl.style.width = total ? `${(done / total) * 100}%` : "0%";

  stepsEl.innerHTML = steps
    .map((s) => {
      const secs = elapsedSeconds(s);
      const timeStr = secs != null ? ` (${secs.toFixed(0)}s)` : "";
      const statusLabel = { pending: "waiting…", processing: "in progress…", succeeded: "done ✓", failed: "failed ✗" }[s.status] || s.status;
      return `<div class="progress-step ${s.status}"><span>${s.label}</span><span class="step-status">${statusLabel}${timeStr}</span></div>`;
    })
    .join("");
}

// opts: { panelEl, fillEl, stepsEl, onDone(result), onError(message) }
async function pollJob(jobId, opts) {
  while (true) {
    const res = await fetch(`/api/jobs/${jobId}`);
    const job = await res.json();
    renderProgress(job.progress || {}, opts.fillEl, opts.stepsEl);

    if (job.status === "done") {
      opts.panelEl.classList.add("hidden");
      opts.onDone(job.result);
      return;
    }
    if (job.status === "error") {
      opts.panelEl.classList.add("hidden");
      showToast(`Error: ${job.error}`, "error");
      opts.onError && opts.onError(job.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// --- Flow: I already have an image ---

const fromReferenceForm = document.getElementById("from-reference-form");
const fromReferenceBtn = document.getElementById("from-reference-btn");
const progressPanel = document.getElementById("progress-panel");
const progressBarFill = document.getElementById("progress-bar-fill");
const progressSteps = document.getElementById("progress-steps");

fromReferenceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("existing-reference-file");
  const pastedUrl = document.getElementById("existing-reference-url").value.trim();
  const motionPrompt = document.getElementById("existing-motion-prompt").value.trim();
  const file = fileInput.files[0];

  if (!file && !pastedUrl) {
    showToast("Upload an image or paste a URL first.", "error");
    return;
  }
  if (!motionPrompt) return;

  fromReferenceBtn.disabled = true;
  progressPanel.classList.remove("hidden");
  progressBarFill.style.width = "0%";
  progressSteps.innerHTML = "";

  try {
    let referenceUrl = pastedUrl;
    if (file) {
      showToast("Uploading image…");
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/upload-reference", { method: "POST", body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.detail || "upload failed");
      referenceUrl = uploadData.url;
    }

    showToast("Starting generation — timing varies a lot per model (seconds to several minutes).");
    const res = await fetch("/api/generate-takes-from-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference_url: referenceUrl, motion_prompt: motionPrompt }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "generation failed");
    }
    const { job_id } = await res.json();
    await pollJob(job_id, {
      panelEl: progressPanel,
      fillEl: progressBarFill,
      stepsEl: progressSteps,
      onDone: async (result) => {
        renderResult(result);
        await loadHistory();
        showToast("Done.", "success");
      },
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    progressPanel.classList.add("hidden");
  } finally {
    fromReferenceBtn.disabled = false;
  }
});

// --- Flow: generate the reference image first, then decide ---

const stagedForm = document.getElementById("staged-reference-form");
const stagedBtn = document.getElementById("staged-reference-btn");
const stagedProgress = document.getElementById("staged-progress");
const stagedProgressFill = document.getElementById("staged-progress-fill");
const stagedProgressSteps = document.getElementById("staged-progress-steps");
const stagedReview = document.getElementById("staged-review");
const stagedReviewImage = document.getElementById("staged-review-image");
const stagedReviewMeta = document.getElementById("staged-review-meta");
const stagedRegenerateBtn = document.getElementById("staged-regenerate-btn");
const stagedContinueBtn = document.getElementById("staged-continue-btn");

let stagedReference = null; // { run_id, url, cost_usd } once a reference image succeeds

async function runStagedReferenceGeneration() {
  const prompt = document.getElementById("staged-prompt").value.trim();
  if (!prompt) {
    showToast("Enter a subject prompt first.", "error");
    return;
  }

  stagedBtn.disabled = true;
  stagedRegenerateBtn.disabled = true;
  stagedReview.classList.add("hidden");
  stagedProgress.classList.remove("hidden");
  stagedProgressFill.style.width = "0%";
  stagedProgressSteps.innerHTML = "";
  showToast("Generating reference image (~$0.035)…");

  try {
    const res = await fetch("/api/test-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "generation failed");
    }
    const { job_id } = await res.json();
    await pollJob(job_id, {
      panelEl: stagedProgress,
      fillEl: stagedProgressFill,
      stepsEl: stagedProgressSteps,
      onDone: (data) => {
        if (data.status !== "succeeded" || !data.url) {
          showToast(`Reference image failed: ${data.error || "unknown error"}`, "error");
          return;
        }
        stagedReference = { run_id: data.run_id, url: data.url, cost_usd: data.cost_usd };
        stagedReviewImage.src = data.url;
        stagedReviewMeta.textContent = `run: ${data.run_id}${data.cost_usd != null ? ` · cost: $${data.cost_usd.toFixed(3)}` : ""}`;
        stagedReview.classList.remove("hidden");
        showToast("Reference image ready — review it below.", "success");
      },
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    stagedProgress.classList.add("hidden");
  } finally {
    stagedBtn.disabled = false;
    stagedRegenerateBtn.disabled = false;
  }
}

stagedForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runStagedReferenceGeneration();
});

stagedRegenerateBtn.addEventListener("click", runStagedReferenceGeneration);

stagedContinueBtn.addEventListener("click", async () => {
  if (!stagedReference) return;
  const motionPrompt = document.getElementById("staged-motion-prompt").value.trim()
    || document.getElementById("staged-prompt").value.trim();

  stagedContinueBtn.disabled = true;
  progressPanel.classList.remove("hidden");
  progressBarFill.style.width = "0%";
  progressSteps.innerHTML = "";
  showToast("Starting video generation — timing varies a lot per model (seconds to several minutes).");

  try {
    const res = await fetch("/api/generate-takes-from-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference_url: stagedReference.url,
        motion_prompt: motionPrompt,
        reference_run_id: stagedReference.run_id,
        reference_cost_usd: stagedReference.cost_usd,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "generation failed");
    }
    const { job_id } = await res.json();
    await pollJob(job_id, {
      panelEl: progressPanel,
      fillEl: progressBarFill,
      stepsEl: progressSteps,
      onDone: async (result) => {
        renderResult(result);
        await loadHistory();
        showToast("Done.", "success");
      },
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    progressPanel.classList.add("hidden");
  } finally {
    stagedContinueBtn.disabled = false;
  }
});

// --- Flow: generate everything automatically ---

const form = document.getElementById("generate-form");
const generateBtn = document.getElementById("generate-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = document.getElementById("prompt").value.trim();
  const motionPrompt = document.getElementById("motion-prompt").value.trim();
  if (!prompt) return;

  generateBtn.disabled = true;
  showToast("Starting generation — timing varies a lot per model (seconds to several minutes).");
  progressPanel.classList.remove("hidden");
  progressBarFill.style.width = "0%";
  progressSteps.innerHTML = "";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, motion_prompt: motionPrompt || null }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "generation failed");
    }
    const { job_id } = await res.json();
    await pollJob(job_id, {
      panelEl: progressPanel,
      fillEl: progressBarFill,
      stepsEl: progressSteps,
      onDone: async (result) => {
        renderResult(result);
        await loadHistory();
        showToast("Done.", "success");
      },
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    progressPanel.classList.add("hidden");
  } finally {
    generateBtn.disabled = false;
  }
});

