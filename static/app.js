const MODEL_LABELS = { claude: "Claude", gpt: "ChatGPT", gemini: "Gemini" };

let currentState = null;

async function loadState() {
  const res = await fetch("/api/state");
  const state = await res.json();
  currentState = state;
  render(state);
}

function render(state) {
  const emptyState = document.getElementById("emptyState");
  const sessionArea = document.getElementById("sessionArea");

  if (!state.has_passage) {
    emptyState.style.display = "block";
    sessionArea.style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  sessionArea.style.display = "block";

  document.getElementById("passageFilename").textContent = state.passage_filename ? `(${state.passage_filename})` : "";
  document.getElementById("passageText").textContent = state.passage_text;
  document.getElementById("questionText").textContent = state.question;

  renderAiPanels(state);
  document.getElementById("compareArea").style.display = "none";
}

function renderAiPanels(state) {
  const wrap = document.getElementById("aiPanels");
  wrap.innerHTML = "";

  const models = ["claude", "gpt", "gemini"];
  models.forEach((key) => {
    const panel = document.createElement("div");
    const resp = (state.ai_responses || {})[key];

    if (state.generating || !resp) {
      panel.className = "ai-panel pending";
      panel.innerHTML = `<h4>${MODEL_LABELS[key]}</h4><p class="fine">${state.generating ? "Thinking…" : "Not yet generated."}</p>`;
    } else if (resp.error) {
      panel.className = "ai-panel errored";
      panel.innerHTML = `<h4>${MODEL_LABELS[key]}</h4><p class="err-text">${escapeHtml(resp.error)}</p>`;
    } else {
      panel.className = "ai-panel";
      panel.innerHTML = `
        <h4>${MODEL_LABELS[key]}</h4>
        <div class="a-label">Answer</div>
        <div class="a-text">${escapeHtml(resp.answer || "(no answer)")}</div>
        <div class="a-label">Evidence</div>
        <div class="a-text">${escapeHtml(resp.evidence || "(no evidence given)")}</div>
      `;
    }
    wrap.appendChild(panel);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function buildCompareTable(childAnswer, childEvidence) {
  const body = document.getElementById("compareBody");
  body.innerHTML = "";

  const rows = [
    { label: "You", answer: childAnswer, evidence: childEvidence, error: null },
  ];
  ["claude", "gpt", "gemini"].forEach((key) => {
    const resp = (currentState.ai_responses || {})[key] || {};
    rows.push({
      label: MODEL_LABELS[key],
      answer: resp.error ? "" : resp.answer,
      evidence: resp.error ? "" : resp.evidence,
      error: resp.error,
    });
  });

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.error) {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td colspan="2" class="err-text">${escapeHtml(row.error)}</td>`;
    } else {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td>${escapeHtml(row.answer)}</td><td>${escapeHtml(row.evidence)}</td>`;
    }
    body.appendChild(tr);
  });

  document.getElementById("compareArea").style.display = "block";
}

// ---- Facilitator form ----
document.getElementById("facilitatorForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("facilitatorStatus");
  statusEl.textContent = "Activating — asking Claude, GPT, and Gemini, this can take a few seconds…";
  statusEl.className = "form-status";

  const fd = new FormData();
  fd.append("access_code", document.getElementById("accessCode").value);
  fd.append("question", document.getElementById("questionInput").value);
  fd.append("pdf", document.getElementById("pdfFile").files[0]);

  try {
    const res = await fetch("/api/facilitator/session", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.detail || "Something went wrong.";
      statusEl.className = "form-status error";
      return;
    }
    statusEl.textContent = "Passage activated.";
    statusEl.className = "form-status ok";
    document.getElementById("facilitatorPanel").removeAttribute("open");
    await loadState();
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

// ---- Child form ----
document.getElementById("childForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const answer = document.getElementById("childAnswer").value.trim();
  const evidence = document.getElementById("childEvidence").value.trim();
  buildCompareTable(answer, evidence);
  document.getElementById("compareArea").scrollIntoView({ behavior: "smooth" });
});

loadState();
