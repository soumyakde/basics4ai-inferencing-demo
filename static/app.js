const MODEL_LABELS = { claude: "Claude", gpt: "ChatGPT", gemini: "Gemini" };

let currentState = null;
let extractedData = null; // { passage_text, passage_filename, answer_key_text, answer_key_filename }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Load + render current session state (children-facing view)
// ---------------------------------------------------------------------

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

  renderQuestionBlocks(state);
}

function renderQuestionBlocks(state) {
  const container = document.getElementById("questionBlocks");
  container.innerHTML = "";
  const tpl = document.getElementById("questionBlockTemplate");

  (state.questions || []).forEach((q, idx) => {
    const node = tpl.content.cloneNode(true);
    const block = node.querySelector(".question-block");
    block.dataset.qid = q.id;

    node.querySelector(".q-index").textContent = String(idx + 1);
    node.querySelector(".q-text").textContent = q.question;

    renderAiPanels(node, q, state.generating);

    const form = node.querySelector(".child-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const answer = form.querySelector(".child-answer").value.trim();
      const evidence = form.querySelector(".child-evidence").value.trim();
      buildCompareTable(block, q, answer, evidence);
      block.querySelector(".compare-area").scrollIntoView({ behavior: "smooth" });
    });

    container.appendChild(node);
  });
}

function renderAiPanels(node, q, generating) {
  const wrap = node.querySelector(".ai-panels");
  wrap.innerHTML = "";
  const models = ["claude", "gpt", "gemini"];
  const responses = q.ai_responses || {};

  models.forEach((key) => {
    const panel = document.createElement("div");
    const resp = responses[key];

    if (generating || !resp || Object.keys(responses).length === 0) {
      panel.className = "ai-panel pending";
      panel.innerHTML = `<h4>${MODEL_LABELS[key]}</h4><p class="fine">${generating ? "Thinking…" : "Not yet generated."}</p>`;
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

function buildCompareTable(block, q, childAnswer, childEvidence) {
  const body = block.querySelector(".compare-body");
  body.innerHTML = "";

  const responses = q.ai_responses || {};
  const rows = [
    { label: "You", answer: childAnswer, evidence: childEvidence, error: null },
  ];
  ["claude", "gpt", "gemini"].forEach((key) => {
    const resp = responses[key] || {};
    rows.push({
      label: MODEL_LABELS[key],
      answer: resp.error ? "" : resp.answer,
      evidence: resp.error ? "" : resp.evidence,
      error: resp.error,
    });
  });
  rows.push({ label: "Answer key", answer: q.ref_answer, evidence: q.ref_evidence, error: null });

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.error) {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td colspan="2" class="err-text">${escapeHtml(row.error)}</td>`;
    } else {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td>${escapeHtml(row.answer)}</td><td>${escapeHtml(row.evidence)}</td>`;
    }
    body.appendChild(tr);
  });

  block.querySelector(".compare-area").style.display = "block";
}

// ---------------------------------------------------------------------
// Facilitator: Step 1 — extract text from both PDFs
// ---------------------------------------------------------------------

document.getElementById("extractBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("extractStatus");
  const accessCode = document.getElementById("accessCode").value;
  const passageFile = document.getElementById("passagePdf").files[0];
  const answerKeyFile = document.getElementById("answerKeyPdf").files[0];

  if (!accessCode || !passageFile || !answerKeyFile) {
    statusEl.textContent = "Fill in the access code and both PDFs first.";
    statusEl.className = "form-status error";
    return;
  }

  statusEl.textContent = "Reading PDFs…";
  statusEl.className = "form-status";

  const fd = new FormData();
  fd.append("access_code", accessCode);
  fd.append("passage_pdf", passageFile);
  fd.append("answer_key_pdf", answerKeyFile);

  try {
    const res = await fetch("/api/facilitator/extract", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.detail || "Something went wrong.";
      statusEl.className = "form-status error";
      return;
    }
    extractedData = data;
    document.getElementById("extractedPassage").textContent = data.passage_text;
    document.getElementById("extractedAnswerKey").textContent = data.answer_key_text;
    document.getElementById("reviewStep").style.display = "block";
    document.getElementById("questionRows").innerHTML = "";
    addQuestionRow();
    statusEl.textContent = "PDFs read. Add your questions below.";
    statusEl.className = "form-status ok";
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

// ---------------------------------------------------------------------
// Facilitator: Step 2 — dynamic question rows
// ---------------------------------------------------------------------

function addQuestionRow() {
  const tpl = document.getElementById("questionRowTemplate");
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".question-row");
  row.querySelector(".remove-row-btn").addEventListener("click", () => row.remove());
  document.getElementById("questionRows").appendChild(node);
}

document.getElementById("addQuestionBtn").addEventListener("click", addQuestionRow);

// ---------------------------------------------------------------------
// Facilitator: Step 3 — activate (stores questions, asks the 3 LLMs)
// ---------------------------------------------------------------------

document.getElementById("activateBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("activateStatus");
  const accessCode = document.getElementById("accessCode").value;

  if (!extractedData) {
    statusEl.textContent = "Read the PDFs first.";
    statusEl.className = "form-status error";
    return;
  }

  const rows = Array.from(document.querySelectorAll("#questionRows .question-row"));
  const questions = rows.map((row) => ({
    question: row.querySelector(".q-question").value.trim(),
    ref_answer: row.querySelector(".q-ref-answer").value.trim(),
    ref_evidence: row.querySelector(".q-ref-evidence").value.trim(),
  })).filter((q) => q.question);

  if (questions.length === 0) {
    statusEl.textContent = "Add at least one question with text.";
    statusEl.className = "form-status error";
    return;
  }

  statusEl.textContent = `Activating — asking Claude, GPT, and Gemini for ${questions.length} question(s), this can take a bit…`;
  statusEl.className = "form-status";

  const body = {
    access_code: accessCode,
    passage_text: extractedData.passage_text,
    passage_filename: extractedData.passage_filename,
    answer_key_text: extractedData.answer_key_text,
    answer_key_filename: extractedData.answer_key_filename,
    questions: questions,
  };

  try {
    const res = await fetch("/api/facilitator/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.detail || "Something went wrong.";
      statusEl.className = "form-status error";
      return;
    }
    statusEl.textContent = "Activated.";
    statusEl.className = "form-status ok";
    document.getElementById("facilitatorPanel").removeAttribute("open");
    await loadState();
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

// ---------------------------------------------------------------------
// Facilitator: retry AI answers only
// ---------------------------------------------------------------------

document.getElementById("regenerateBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("activateStatus");
  const accessCode = document.getElementById("accessCode").value;

  statusEl.textContent = "Retrying AI answers for all current questions…";
  statusEl.className = "form-status";

  const fd = new FormData();
  fd.append("access_code", accessCode);

  try {
    const res = await fetch("/api/facilitator/regenerate", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.detail || "Something went wrong.";
      statusEl.className = "form-status error";
      return;
    }
    statusEl.textContent = "Retried.";
    statusEl.className = "form-status ok";
    await loadState();
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

loadState();
