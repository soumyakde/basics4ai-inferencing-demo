let extractedData = null; // { passage_text, passage_filename, answer_key_text, answer_key_filename }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Step 1 — extract text from both PDFs
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
    document.getElementById("extractedPassage").value = data.passage_text;
    document.getElementById("extractedAnswerKey").value = data.answer_key_text;
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
// Step 2 — dynamic question rows
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
// Step 3 — activate (stores questions, asks the 3 LLMs)
// ---------------------------------------------------------------------

document.getElementById("activateBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("activateStatus");
  const accessCode = document.getElementById("accessCode").value;

  if (!extractedData) {
    statusEl.textContent = "Read the PDFs first.";
    statusEl.className = "form-status error";
    return;
  }

  // Use the CURRENT textarea contents, not the original extraction — this is
  // what lets an instructor strip out leaked/garbled text (e.g. leftover
  // answer fragments from an incompletely-redacted source PDF) before it
  // ever reaches students. Whatever is in this box is exactly what gets sent.
  const passageText = document.getElementById("extractedPassage").value.trim();
  const answerKeyText = document.getElementById("extractedAnswerKey").value.trim();

  if (!passageText) {
    statusEl.textContent = "Passage text is empty — nothing for students to read.";
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
    passage_text: passageText,
    passage_filename: extractedData.passage_filename,
    answer_key_text: answerKeyText,
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
    statusEl.textContent = "Activated. Students can now use the site.";
    statusEl.className = "form-status ok";
    await loadCurrentSetup(accessCode);
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

// ---------------------------------------------------------------------
// Retry AI answers only
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
    await loadCurrentSetup(accessCode);
  } catch (err) {
    statusEl.textContent = "Network error: " + err;
    statusEl.className = "form-status error";
  }
});

// ---------------------------------------------------------------------
// Current setup summary (full state, including answer key — instructor only)
// ---------------------------------------------------------------------

async function loadCurrentSetup(accessCode) {
  const fd = new FormData();
  fd.append("access_code", accessCode);
  const res = await fetch("/api/instructor/state", { method: "POST", body: fd });
  if (!res.ok) return;
  const state = await res.json();

  const wrap = document.getElementById("currentSetup");
  const summary = document.getElementById("currentSummary");
  if (!state.has_passage) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";

  const questionsHtml = state.questions.map((q, i) => {
    const models = ["claude", "gpt", "gemini"];
    const statusBits = models.map((m) => {
      const r = (q.ai_responses || {})[m];
      const ok = r && !r.error;
      return `<span class="badge" style="${ok ? "" : "color:var(--accent);border-color:var(--accent);"}">${m}: ${ok ? "ok" : (r ? "error" : "pending")}</span>`;
    }).join(" ");
    return `<div class="card" style="margin-bottom:10px;">
      <strong>Q${i + 1}.</strong> ${escapeHtml(q.question)}<br>
      <span class="fine">Reference answer: ${escapeHtml(q.ref_answer || "(none entered)")}</span><br>
      ${statusBits}
    </div>`;
  }).join("");

  summary.innerHTML = `
    <p class="fine">Passage file: ${escapeHtml(state.passage_filename)} · Answer key file: ${escapeHtml(state.answer_key_filename)}</p>
    ${questionsHtml}
  `;
}

// On load, if an access code + activation already exists this browser session, nothing to prefill —
// the instructor re-enters their code each visit (kept simple; not treated as a persistent login).
