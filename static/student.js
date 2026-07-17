const MODEL_LABELS = { claude: "Claude", gpt: "ChatGPT", gemini: "Gemini" };

let currentState = null;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Load + render current session state
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

    addEvidenceRow(node.querySelector(".evidence-list"));
    node.querySelector(".add-evidence-btn").addEventListener("click", (e) => {
      addEvidenceRow(block.querySelector(".evidence-list"));
    });

    container.appendChild(node);
  });
}

function addEvidenceRow(listEl) {
  const tpl = document.getElementById("evidenceRowTemplate");
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".evidence-row");
  row.querySelector(".remove-evidence-row-btn").addEventListener("click", () => {
    // Always keep at least one row.
    if (listEl.querySelectorAll(".evidence-row").length > 1) row.remove();
  });
  listEl.appendChild(node);
}

// ---------------------------------------------------------------------
// Compare my answers to the AIs — one button, all questions at once
// ---------------------------------------------------------------------

document.getElementById("compareAllBtn").addEventListener("click", () => {
  const blocks = Array.from(document.querySelectorAll(".question-block"));
  const hint = document.getElementById("compareHint");

  // Clear any previous "please answer this" flags.
  blocks.forEach((b) => b.classList.remove("unanswered-flag"));

  let firstIncomplete = null;
  const collected = blocks.map((block) => {
    const answer = block.querySelector(".child-answer").value.trim();
    const evidenceItems = Array.from(block.querySelectorAll(".evidence-item"))
      .map((t) => t.value.trim())
      .filter((v) => v);
    const complete = answer && evidenceItems.length > 0;
    if (!complete && !firstIncomplete) firstIncomplete = block;
    return { block, answer, evidenceItems, complete };
  });

  if (firstIncomplete) {
    firstIncomplete.classList.add("unanswered-flag");
    hint.textContent = "Please answer every question (with at least one piece of evidence) before comparing.";
    hint.classList.add("error");
    firstIncomplete.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  hint.classList.remove("error");
  hint.textContent = "Comparison revealed below for every question.";

  collected.forEach(({ block, answer, evidenceItems }) => {
    const qid = block.dataset.qid;
    const q = (currentState.questions || []).find((x) => x.id === qid);
    if (!q) return;

    block.classList.add("answered");
    const reveal = block.querySelector(".ai-reveal");
    reveal.style.display = "block";

    renderAiPanels(block, q);
    buildCompareTable(block, answer, evidenceItems.join(" / "));
  });

  document.querySelector(".question-block .ai-reveal").scrollIntoView({ behavior: "smooth" });
});

function renderAiPanels(block, q) {
  const wrap = block.querySelector(".ai-panels");
  wrap.innerHTML = "";
  const models = ["claude", "gpt", "gemini"];
  const responses = q.ai_responses || {};

  models.forEach((key) => {
    const panel = document.createElement("div");
    const resp = responses[key];

    if (!resp) {
      panel.className = "ai-panel pending";
      panel.innerHTML = `<h4>${MODEL_LABELS[key]}</h4><p class="fine">Not yet generated.</p>`;
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

function buildCompareTable(block, childAnswer, childEvidenceJoined) {
  const body = block.querySelector(".compare-body");
  body.innerHTML = "";

  const qid = block.dataset.qid;
  const q = (currentState.questions || []).find((x) => x.id === qid);
  const responses = (q && q.ai_responses) || {};

  const rows = [
    { label: "You", answer: childAnswer, evidence: childEvidenceJoined, error: null },
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

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.error) {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td colspan="2" class="err-text">${escapeHtml(row.error)}</td>`;
    } else {
      tr.innerHTML = `<td class="source-cell">${row.label}</td><td>${escapeHtml(row.answer)}</td><td>${escapeHtml(row.evidence)}</td>`;
    }
    body.appendChild(tr);
  });
}

loadState();
