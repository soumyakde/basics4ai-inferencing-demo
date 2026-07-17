"""
Basics4AI — Inferencing Comparison Demo
========================================
A single-passage, single-question inferencing exercise. A facilitator
uploads a short reading passage (PDF) and an inferencing question; Claude,
GPT, and Gemini each answer it once (cached, not re-run per child). Children
then enter their own answer + evidence and compare all four side by side.

Non-research demo: nothing is persisted beyond the current session state
(one JSON file on disk for restart-resilience); no child responses or PII
are stored server-side.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Form, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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
    "question": "",
    "ai_responses": {},   # {"claude": {...}, "gpt": {...}, "gemini": {...}}
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
        # Model didn't follow the format — show the raw text as the answer.
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
        "question": _state["question"],
        "ai_responses": _state["ai_responses"],
        "generating": _state["generating"],
        "available_models": get_available_models(),
    })


@app.post("/api/facilitator/session")
async def set_session(
    access_code: str = Form(...),
    question: str = Form(...),
    pdf: UploadFile = File(...),
):
    _check_code(access_code)

    if not question.strip():
        raise HTTPException(400, "Please enter an inferencing question.")

    raw = await pdf.read()
    try:
        passage_text = extract_pdf_text(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))

    if not passage_text.strip():
        raise HTTPException(400, "No readable text found in that PDF.")

    _state["passage_text"] = passage_text
    _state["passage_filename"] = pdf.filename or "passage.pdf"
    _state["question"] = question.strip()
    _state["ai_responses"] = {}
    _state["generating"] = True
    _save_state()

    ai_responses = await _ask_all_models(passage_text, question.strip())

    _state["ai_responses"] = ai_responses
    _state["generating"] = False
    _save_state()

    return JSONResponse({"ok": True, "ai_responses": ai_responses})


@app.post("/api/facilitator/regenerate")
async def regenerate(access_code: str = Form(...)):
    """Re-ask the 3 LLMs for the current passage/question (e.g. after a transient failure)."""
    _check_code(access_code)
    if not _state["passage_text"] or not _state["question"]:
        raise HTTPException(400, "No active passage/question to regenerate.")

    _state["generating"] = True
    _save_state()
    ai_responses = await _ask_all_models(_state["passage_text"], _state["question"])
    _state["ai_responses"] = ai_responses
    _state["generating"] = False
    _save_state()
    return JSONResponse({"ok": True, "ai_responses": ai_responses})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8800)))
