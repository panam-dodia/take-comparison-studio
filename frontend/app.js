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
  referenceMeta.textContent = `run: ${run.parent_run_id} · prompt: "${run.prompt}"`;

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

const testReferenceBtn = document.getElementById("test-reference-btn");
const referenceTestPanel = document.getElementById("reference-test-panel");
const referenceTestImage = document.getElementById("reference-test-image");
const referenceTestMeta = document.getElementById("reference-test-meta");

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

  try {
    const res = await fetch("/api/test-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "test failed");

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
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
  } finally {
    testReferenceBtn.disabled = false;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = document.getElementById("prompt").value.trim();
  const motionPrompt = document.getElementById("motion-prompt").value.trim();
  if (!prompt) return;

  generateBtn.disabled = true;
  statusLine.textContent = "Generating reference image, then fanning out to 3 video models… this can take a while in live mode.";

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
    const run = await res.json();
    renderResult(run);
    await loadHistory();
    statusLine.textContent = "Done.";
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
  } finally {
    generateBtn.disabled = false;
  }
});

loadConfig();
loadHistory();
