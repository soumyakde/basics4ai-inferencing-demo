"""
Basics4AI — Inferencing Comparison Demo
========================================
A facilitator uploads a reading-passage worksheet PDF (passage + printed
questions) and a separate answer-key PDF (sample answers + "How do you know
this?" evidence). Because PDF layouts vary too much to parse reliably, the
facilitator reads both extracted texts on screen and manually enters a
dynamic list of {question, reference answer, reference evidence} — the same
manual-entry principle as the single-question version, just extended.

For each question, Claude, GPT, and Gemini each answer once (cached, not
re-run per child). Children enter their own answer + evidence per question
and compare all five side by side: their own, the three AIs', and the
answer key.

Non-research demo: nothing is persisted beyond the current session state
(one JSON file on disk for restart-resilience); no child responses or PII
are stored server-side.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Form, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pdf_extract import extract_pdf_text
from llm_clients import call_model, get_available_models

BASE_DIR = Path(__file__).resolve().parent
STATE_PATH = BASE_DIR / "data" / "session_state.json"
STATE_PATH.parent.mkdir(exist_ok=True)

app = FastAPI(title="Basics4AI Inferencing Demo")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# In-memory session state, mirrored to disk for restart-resilience.
_state = {
    "passage_text": "",
    "passage_filename": "",
    "answer_key_text": "",
    "answer_key_filename": "",
    "questions": [],   # [{id, question, ref_answer, ref_evidence, ai_responses}, ...]
    "generating": False,
}

SYSTEM_PROMPT = (
    "You are answering a reading-comprehension inferencing question written "
    "for a 10-14 year old audience. Read the passage carefully, then answer "
    "the question using ONLY information and reasonable inference from the "
    "passage. Output ONLY the two lines below — no preamble, no restating "
    "the question, no closing remarks, nothing before or after them:\n"
    "Answer: <your answer, in one short sentence>\n"
    "Evidence: <a direct quote or close paraphrase from the passage that "
    "supports your answer, in one short sentence>"
)


def _load_state():
    if STATE_PATH.exists():
        try:
            with open(STATE_PATH, encoding="utf-8") as f:
                saved = json.load(f)
            _state.update(saved)
            _state["generating"] = False  # never resume as "in progress"
        except Exception:
            pass


def _save_state():
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)


_load_state()


def _parse_answer_evidence(raw_text: Optional[str]) -> dict:
    """Best-effort split of the model's 'Answer: ... / Evidence: ...' reply."""
    if not raw_text:
        return {"answer": "", "evidence": ""}
    answer, evidence = "", ""
    lines = raw_text.strip().splitlines()
    current = None
    for line in lines:
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("answer:"):
            current = "answer"
            answer += stripped[len("answer:"):].strip() + " "
        elif low.startswith("evidence:"):
            current = "evidence"
            evidence += stripped[len("evidence:"):].strip() + " "
        elif current == "answer":
            answer += stripped + " "
        elif current == "evidence":
            evidence += stripped + " "
    if not answer and not evidence:
        answer = raw_text.strip()
    return {"answer": answer.strip(), "evidence": evidence.strip()}


async def _ask_all_models(passage: str, question: str) -> dict:
    prompt = f"Passage:\n{passage}\n\nQuestion: {question}"

    async def ask_one(model_key: str):
        result = await asyncio.to_thread(
            call_model,
            model=model_key,
            prompt=prompt,
            system=SYSTEM_PROMPT,
            temperature=0.0,
            max_tokens=600,
        )
        if result.get("error"):
            return {"answer": "", "evidence": "", "error": result["error"]}
        parsed = _parse_answer_evidence(result.get("text"))
        parsed["error"] = None
        return parsed

    claude, gpt, gemini = await asyncio.gather(
        ask_one("claude"), ask_one("gpt"), ask_one("gemini")
    )
    return {"claude": claude, "gpt": gpt, "gemini": gemini}


async def _generate_for_all_questions():
    """Ask the 3 LLMs, once per question, concurrently across questions too."""
    passage = _state["passage_text"]

    async def fill_one(q: dict):
        q["ai_responses"] = await _ask_all_models(passage, q["question"])

    await asyncio.gather(*[fill_one(q) for q in _state["questions"]])


def _check_code(access_code: str):
    expected = os.environ.get("FACILITATOR_ACCESS_CODE")
    if not expected:
        raise HTTPException(
            500,
            "Server is missing FACILITATOR_ACCESS_CODE — ask the site admin to set it.",
        )
    if access_code != expected:
        raise HTTPException(401, "Incorrect access code.")


@app.get("/")
def serve_index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/state")
def get_state():
    return JSONResponse({
        "has_passage": bool(_state["passage_text"]),
        "passage_text": _state["passage_text"],
        "passage_filename": _state["passage_filename"],
        "questions": _state["questions"],
        "generating": _state["generating"],
        "available_models": get_available_models(),
    })


@app.post("/api/facilitator/extract")
async def extract_pdfs(
    access_code: str = Form(...),
    passage_pdf: UploadFile = File(...),
    answer_key_pdf: UploadFile = File(...),
):
    """
    Preview-only step: extracts text from both uploaded PDFs and returns it
    for the facilitator to read on screen while they type in the question
    list. Does NOT change the live session yet.
    """
    _check_code(access_code)

    passage_raw = await passage_pdf.read()
    key_raw = await answer_key_pdf.read()

    try:
        passage_text = extract_pdf_text(passage_raw)
    except ValueError as e:
        raise HTTPException(400, f"Passage PDF: {e}")
    try:
        answer_key_text = extract_pdf_text(key_raw)
    except ValueError as e:
        raise HTTPException(400, f"Answer key PDF: {e}")

    if not passage_text.strip():
        raise HTTPException(400, "No readable text found in the passage PDF.")
    if not answer_key_text.strip():
        raise HTTPException(400, "No readable text found in the answer key PDF.")

    return JSONResponse({
        "passage_text": passage_text,
        "passage_filename": passage_pdf.filename or "passage.pdf",
        "answer_key_text": answer_key_text,
        "answer_key_filename": answer_key_pdf.filename or "answer_key.pdf",
    })


class QuestionIn(BaseModel):
    question: str
    ref_answer: str = ""
    ref_evidence: str = ""


class ActivateBody(BaseModel):
    access_code: str
    passage_text: str
    passage_filename: str = ""
    answer_key_text: str = ""
    answer_key_filename: str = ""
    questions: List[QuestionIn]


@app.post("/api/facilitator/activate")
async def activate(body: ActivateBody):
    """
    Final step: stores the passage, answer key, and the facilitator-entered
    question list, then asks the 3 LLMs once per question (the only
    cost-incurring step) and caches the results for every child.
    """
    _check_code(body.access_code)

    if not body.passage_text.strip():
        raise HTTPException(400, "Missing passage text.")
    if not body.questions:
        raise HTTPException(400, "Add at least one question before activating.")
    for q in body.questions:
        if not q.question.strip():
            raise HTTPException(400, "Every question needs text — remove any empty rows.")

    _state["passage_text"] = body.passage_text
    _state["passage_filename"] = body.passage_filename
    _state["answer_key_text"] = body.answer_key_text
    _state["answer_key_filename"] = body.answer_key_filename
    _state["questions"] = [
        {
            "id": uuid.uuid4().hex[:8],
            "question": q.question.strip(),
            "ref_answer": q.ref_answer.strip(),
            "ref_evidence": q.ref_evidence.strip(),
            "ai_responses": {},
        }
        for q in body.questions
    ]
    _state["generating"] = True
    _save_state()

    await _generate_for_all_questions()

    _state["generating"] = False
    _save_state()

    return JSONResponse({"ok": True, "questions": _state["questions"]})


@app.post("/api/facilitator/regenerate")
async def regenerate(access_code: str = Form(...)):
    """Re-ask the 3 LLMs for every current question (e.g. after a transient failure)."""
    _check_code(access_code)
    if not _state["passage_text"] or not _state["questions"]:
        raise HTTPException(400, "No active passage/questions to regenerate.")

    _state["generating"] = True
    _save_state()
    await _generate_for_all_questions()
    _state["generating"] = False
    _save_state()
    return JSONResponse({"ok": True, "questions": _state["questions"]})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8800)))
