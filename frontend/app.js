const form = document.getElementById("generate-form");
const generateBtn = document.getElementById("generate-btn");
const statusLine = document.getElementById("status-line");
const resultPanel = document.getElementById("result-panel");
const referenceImage = document.getElementById("reference-image");
const referenceMeta = document.getElementById("reference-meta");
const takesGrid = document.getElementById("takes-grid");
const historyList = document.getElementById("history-list");
const modeBadge = document.getElementById("mode-badge");

async function loadConfig() {
  const res = await fetch("/api/config");
  const cfg = await res.json();
  modeBadge.textContent = cfg.mock_generation
    ? "mock generation — $0 cost"
    : "LIVE generation — spends budget";
  modeBadge.style.color = cfg.mock_generation ? "#3ecf8e" : "#ff6b6b";
  if (!cfg.storage_enabled) {
    modeBadge.textContent += " · storage disabled (no B2 creds)";
  }
}

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
      statusLine.textContent = `Retrying ${take.label} against the existing reference image…`;
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
        statusLine.textContent = "Retry done.";
      } catch (err) {
        statusLine.textContent = `Error: ${err.message}`;
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry this model only";
      }
    });
  }

  return card;
}

function renderResult(run) {
  resultPanel.classList.remove("hidden");
  referenceImage.src = run.reference_url || "";
  const refCost = run.reference_cost_usd != null ? ` · cost: $${run.reference_cost_usd.toFixed(3)}` : "";
  referenceMeta.textContent = `run: ${run.parent_run_id} · prompt: "${run.prompt}"${refCost}`;

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
      <img src="${run.reference_url || ""}" />
      <span class="h-prompt">${run.prompt}</span>
      ${run.favorite_key ? `<span class="h-fav">★ ${run.favorite_key}</span>` : ""}
    `;
    item.addEventListener("click", () => renderResult(run));
    historyList.appendChild(item);
  }
}

// --- Generic progress bar + job polling, shared by all 3 generate flows ---

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

// opts: { panelEl, fillEl, stepsEl, statusEl, onDone(result), onError(message) }
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
      opts.statusEl.textContent = `Error: ${job.error}`;
      opts.onError && opts.onError(job.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// --- Flow 1: reference image only (cheap smoke test) ---

const testReferenceBtn = document.getElementById("test-reference-btn");
const referenceTestPanel = document.getElementById("reference-test-panel");
const referenceTestImage = document.getElementById("reference-test-image");
const referenceTestMeta = document.getElementById("reference-test-meta");
const referenceTestProgress = document.getElementById("reference-test-progress");
const referenceTestProgressFill = document.getElementById("reference-test-progress-fill");
const referenceTestProgressSteps = document.getElementById("reference-test-progress-steps");

testReferenceBtn.addEventListener("click", async () => {
  const prompt = document.getElementById("prompt").value.trim();
  if (!prompt) {
    statusLine.textContent = "Enter a subject prompt first.";
    return;
  }

  testReferenceBtn.disabled = true;
  statusLine.textContent = "Calling the real GMI Cloud image API (~$0.035)…";
  referenceTestPanel.classList.remove("hidden");
  referenceTestImage.removeAttribute("src");
  referenceTestMeta.textContent = "";
  referenceTestProgress.classList.remove("hidden");
  referenceTestProgressFill.style.width = "0%";
  referenceTestProgressSteps.innerHTML = "";

  try {
    const res = await fetch("/api/test-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "test failed");
    }
    const { job_id } = await res.json();
    await pollJob(job_id, {
      panelEl: referenceTestProgress,
      fillEl: referenceTestProgressFill,
      stepsEl: referenceTestProgressSteps,
      statusEl: statusLine,
      onDone: (data) => {
        if (data.status === "succeeded" && data.url) {
          referenceTestImage.src = data.url;
        }
        referenceTestMeta.innerHTML = `
          status: ${data.status}<br/>
          run: ${data.run_id}<br/>
          ${data.cost_usd != null ? `cost: $${data.cost_usd.toFixed(3)}<br/>` : ""}
          ${data.manifest_uri ? `manifest: <a href="${data.manifest_uri}" target="_blank">${data.manifest_uri}</a><br/>` : ""}
          ${data.error ? `<span style="color:#ff6b6b">${data.error}</span>` : ""}
        `;
        statusLine.textContent = "Reference-only test done.";
      },
    });
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
    referenceTestProgress.classList.add("hidden");
  } finally {
    testReferenceBtn.disabled = false;
  }
});

// --- Flow 2: full generate (reference + 3 takes) ---

const progressPanel = document.getElementById("progress-panel");
const progressBarFill = document.getElementById("progress-bar-fill");
const progressSteps = document.getElementById("progress-steps");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = document.getElementById("prompt").value.trim();
  const motionPrompt = document.getElementById("motion-prompt").value.trim();
  if (!prompt) return;

  generateBtn.disabled = true;
  statusLine.textContent = "Starting generation — timing varies a lot per model (seconds to several minutes).";
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
      statusEl: statusLine,
      onDone: async (result) => {
        renderResult(result);
        await loadHistory();
        statusLine.textContent = "Done.";
      },
    });
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
    progressPanel.classList.add("hidden");
  } finally {
    generateBtn.disabled = false;
  }
});

// --- Flow 3: fan out to 3 takes using an existing reference image ---

const fromReferenceForm = document.getElementById("from-reference-form");
const fromReferenceBtn = document.getElementById("from-reference-btn");
const fromReferenceStatus = document.getElementById("from-reference-status");
const fromReferenceProgress = document.getElementById("from-reference-progress");
const fromReferenceProgressFill = document.getElementById("from-reference-progress-fill");
const fromReferenceProgressSteps = document.getElementById("from-reference-progress-steps");

fromReferenceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("existing-reference-file");
  const pastedUrl = document.getElementById("existing-reference-url").value.trim();
  const motionPrompt = document.getElementById("existing-motion-prompt").value.trim();
  const file = fileInput.files[0];

  if (!file && !pastedUrl) {
    fromReferenceStatus.textContent = "Upload an image or paste a URL first.";
    return;
  }
  if (!motionPrompt) return;

  fromReferenceBtn.disabled = true;
  fromReferenceProgress.classList.remove("hidden");
  fromReferenceProgressFill.style.width = "0%";
  fromReferenceProgressSteps.innerHTML = "";

  try {
    let referenceUrl = pastedUrl;
    if (file) {
      fromReferenceStatus.textContent = "Uploading image…";
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/upload-reference", { method: "POST", body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.detail || "upload failed");
      referenceUrl = uploadData.url;
    }

    fromReferenceStatus.textContent = "Starting generation — timing varies a lot per model (seconds to several minutes).";
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
      panelEl: fromReferenceProgress,
      fillEl: fromReferenceProgressFill,
      stepsEl: fromReferenceProgressSteps,
      statusEl: fromReferenceStatus,
      onDone: async (result) => {
        renderResult(result);
        await loadHistory();
        fromReferenceStatus.textContent = "Done.";
      },
    });
  } catch (err) {
    fromReferenceStatus.textContent = `Error: ${err.message}`;
    fromReferenceProgress.classList.add("hidden");
  } finally {
    fromReferenceBtn.disabled = false;
  }
});

loadConfig();
loadHistory();
