"""Extract plain text from an uploaded PDF's raw bytes.

pdfplumber first (better layout handling), falls back to pypdf if
pdfplumber isn't available or fails to open the file.
"""
from __future__ import annotations
import io


def extract_pdf_text(raw: bytes) -> str:
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
        text = "\n\n".join(p.strip() for p in pages if p.strip())
        if text:
            return text
    except Exception:
        pass

    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(raw))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n\n".join(p.strip() for p in pages if p.strip())
        return text
    except Exception as e:
        raise ValueError(f"Could not extract text from this PDF: {e}")
