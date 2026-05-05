"""
server.py
FastAPI backend for Text → Sign Symbol conversion.

Run: python -m app.api.server
Or:  uvicorn app.api.server:app --reload --port 8000
"""

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .sign_lookup import sign_dict
from .text_parser import parse_text

# Load environment variables
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

app = FastAPI(title="Speech-to-Sign API", version="1.0.0")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static frontend files
FRONTEND_DIR = Path(__file__).resolve().parent.parent
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
app.mount("/styles", StaticFiles(directory=FRONTEND_DIR / "styles"), name="styles")
app.mount("/models", StaticFiles(directory=FRONTEND_DIR / "models"), name="models")


@app.on_event("startup")
def startup():
    sign_dict.load()
    has_key = bool(os.getenv("GEMINI_API_KEY") and
                   os.getenv("GEMINI_API_KEY") != "your_gemini_api_key_here")
    status = "configured" if has_key else "not set (using rule-based fallback)"
    print(f"[Server] Gemini API: {status}")
    print("[Server] Ready at http://localhost:8000")


@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


class TextToSignRequest(BaseModel):
    text: str
    use_llm: bool = True


class SignToken(BaseModel):
    vi: str
    gloss: str | None = None
    found: bool = False
    fingerspell: bool = False


class TextToSignResponse(BaseModel):
    input_text: str
    signs: list[SignToken]
    found_count: int
    total_count: int
    method: str  # "gemini" | "rule_based"
    fingerspell_fallback: list[SignToken] = []


@app.post("/api/text-to-signs", response_model=TextToSignResponse)
async def text_to_signs(req: TextToSignRequest):
    """Convert Vietnamese text to a sequence of sign symbols."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    text = req.text.strip()

    # Parse text into sign tokens
    signs = await parse_text(text)

    # For unfound words, provide fingerspell fallback
    fingerspell_fallback = []
    for sign in signs:
        if not sign.get("found") and sign.get("vi"):
            letters = sign_dict.get_alphabet_glosses(sign["vi"])
            fingerspell_fallback.extend(letters)

    found_count = sum(1 for s in signs if s.get("found"))

    # Detect which method was used
    has_gemini = bool(os.getenv("GEMINI_API_KEY") and
                      os.getenv("GEMINI_API_KEY") != "your_gemini_api_key_here")
    method = "gemini" if has_gemini and req.use_llm else "rule_based"

    return TextToSignResponse(
        input_text=text,
        signs=[SignToken(**s) for s in signs],
        found_count=found_count,
        total_count=len(signs),
        method=method,
        fingerspell_fallback=[SignToken(**f) for f in fingerspell_fallback],
    )


@app.get("/api/dictionary/stats")
async def dictionary_stats():
    """Get sign dictionary statistics."""
    return {
        "total_vietnamese_words": len(sign_dict.vi_to_gloss),
        "total_glosses": len(sign_dict.available_glosses),
        "sample_words": list(sign_dict.vi_to_gloss.keys())[:50],
    }


@app.get("/api/dictionary/search")
async def search_dictionary(q: str = ""):
    """Search the Vietnamese sign dictionary."""
    if not q:
        return {"results": []}

    q_lower = q.lower().strip()
    results = []

    for vi_word, gloss in sign_dict.vi_to_gloss.items():
        if q_lower in vi_word:
            results.append({"vi": vi_word, "gloss": gloss})
            if len(results) >= 20:
                break

    return {"query": q, "results": results}


@app.get("/api/landmarks/{gloss}")
async def get_landmarks(gloss: str):
    """
    Get landmark frames for a specific sign gloss.
    Streams from the large JSON file without loading entirely.
    """
    landmarks_path = sign_dict._landmarks_path

    if not landmarks_path.exists():
        raise HTTPException(status_code=404, detail="Landmarks file not found")

    try:
        # Use ijson-style streaming or load specific entry
        # For simplicity, we'll load and cache on first access
        if not hasattr(sign_dict, '_landmarks_cache'):
            print("[Server] Loading landmarks file (this may take a moment)...")
            with open(landmarks_path, "r", encoding="utf-8") as f:
                sign_dict._landmarks_cache = json.load(f)
            print(f"[Server] Landmarks loaded: {len(sign_dict._landmarks_cache)} entries")

        gloss_lower = gloss.lower()
        if gloss_lower in sign_dict._landmarks_cache:
            data = sign_dict._landmarks_cache[gloss_lower]
            return JSONResponse(content={
                "gloss": gloss_lower,
                "data": data,
            })
        else:
            raise HTTPException(status_code=404, detail=f"No landmarks for '{gloss}'")

    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Error reading landmarks file")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.api.server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
