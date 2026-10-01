"""
server.py
FastAPI backend for Text → Sign Symbol conversion.

Run: python -m app.api.server
Or:  uvicorn app.api.server:app --reload --port 8000
"""

import asyncio
import base64
import io
import json
import os
import re
import threading
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .camera_recognition import is_available, recognize
from . import asr, local_nlp
from .sentence_builder import build_sentence, build_sentence_local, gemini_configured
from .sign_lookup import sign_dict
from .text_parser import gemini_enabled, parse_text, warmup as warmup_text_parser
from .landmark_index import load_or_build, read_entry
from .landmark_processing import process_landmark_entry
from .profile_store import profile_store
from .video_subtitles import SubtitleError, fetch_subtitles

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

# Landmark payloads are float-dense JSON and compress ~4x, which is the single
# biggest win on the wire for the avatar. 1 KB floor keeps small replies raw.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

# Serve static frontend files
FRONTEND_DIR = Path(__file__).resolve().parent.parent
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
app.mount("/styles", StaticFiles(directory=FRONTEND_DIR / "styles"), name="styles")
app.mount("/models", StaticFiles(directory=FRONTEND_DIR / "models"), name="models")


@app.on_event("startup")
async def startup():
    sign_dict.load()
    status = "configured" if gemini_enabled() else "not set (using rule-based fallback)"
    print(f"[Server] Gemini API: {status}")

    cached = len(list(sign_dict._landmarks_v2_dir.glob("*.json")))         if sign_dict._landmarks_v2_dir.exists() else 0
    print(f"[Server] Landmark cache: {cached} glosses")
    if cached < len(sign_dict.available_glosses):
        print("[Server] Some glosses are uncached — run "
              "`python -m scripts.build_landmark_cache` to avoid slow first hits")

    # Both are first-use costs that would otherwise land on a user request.
    await warmup_text_parser()

    # The offline models are standby only, so they load in the background:
    # startup and the normal path never wait on them.
    if os.getenv("LOCAL_AI_PRELOAD", "1") != "0":
        threading.Thread(target=_preload_local_ai, daemon=True).start()
    print("[Server] Ready at http://localhost:8000")


def _preload_local_ai():
    for name, module in (("PhoBERT", local_nlp), ("Whisper", asr)):
        if not module.is_installed():
            print(f"[Server] {name} not installed — offline fallback disabled")
            continue
        try:
            module.load()
        except Exception as error:  # noqa: BLE001 - standby must never crash
            print(f"[Server] {name} preload failed: {ascii(str(error))}")


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
    # Set by the offline parser when the gloss came from meaning similarity.
    match: str | None = None
    matched_vi: str | None = None
    score: float | None = None


class TextToSignResponse(BaseModel):
    input_text: str
    signs: list[SignToken]
    found_count: int
    total_count: int
    method: str  # "gemini" | "local" | "rule_based"
    fingerspell_fallback: list[SignToken] = []


class BatchTextToSignRequest(BaseModel):
    texts: list[str]
    use_llm: bool = True


class BatchTextToSignResponse(BaseModel):
    results: list[TextToSignResponse]


class VideoSubtitleRequest(BaseModel):
    url: str
    lang: str | None = None




class ProfileDetails(BaseModel):
    name: str | None = None
    role: str | None = None
    daily_goal: int | None = None


class ProfileSettings(BaseModel):
    autoplay: bool | None = None
    notifications: bool | None = None


class ProfileUpdateRequest(BaseModel):
    profile: ProfileDetails | None = None
    settings: ProfileSettings | None = None


class ActivityRequest(BaseModel):
    type: str
    label: str = ""
    value: int = 1
    metadata: dict = Field(default_factory=dict)


class CameraLandmarkRequest(BaseModel):
    image: str


class CameraRecognitionRequest(BaseModel):
    frames: list[str] = Field(min_length=12, max_length=48)
    top_k: int = Field(default=3, ge=1, le=5)


class SentenceBuildRequest(BaseModel):
    words: list[str] = Field(min_length=1, max_length=50)


_holistic_landmarker = None
_holistic_timestamp_ms = 0
_camera_stream_state = {
    "running": False,
    "has_hands": False,
    "result_ready": False,
    "seen_hands": False,
    "lost_frames": 0,
    "error": None,
}

POSE_DRAW_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]
POSE_CONNECTIONS = [
    [0, 2], [0, 5], [2, 7], [5, 8], [11, 12],
    [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
]
POSE_DRAW_INDEX_MAP = {
    original_index: draw_index
    for draw_index, original_index in enumerate(POSE_DRAW_INDICES)
}
POSE_DRAW_CONNECTIONS = [
    [POSE_DRAW_INDEX_MAP[start], POSE_DRAW_INDEX_MAP[end]]
    for start, end in POSE_CONNECTIONS
    if start in POSE_DRAW_INDEX_MAP and end in POSE_DRAW_INDEX_MAP
]
HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20],
    [5, 9], [9, 13], [13, 17],
]


def _get_holistic_landmarker():
    global _holistic_landmarker
    if _holistic_landmarker is not None:
        return _holistic_landmarker

    model_path = Path(__file__).resolve().parents[2] / "train_sing_language" / "models" / "holistic_landmarker.task"
    try:
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            HolisticLandmarker,
            HolisticLandmarkerOptions,
        )
        from mediapipe.tasks.python.vision.core.vision_task_running_mode import (
            VisionTaskRunningMode,
        )
    except ImportError:
        try:
            import mediapipe as mp
        except ImportError as error:
            raise HTTPException(
                status_code=503,
                detail="MediaPipe chưa được cài cho backend. Cài requirements của train_sing_language trước.",
            ) from error

        _holistic_landmarker = (
            "solutions_split",
            {
                "pose": mp.solutions.pose.Pose(
                    static_image_mode=False,
                    model_complexity=1,
                    smooth_landmarks=True,
                    enable_segmentation=False,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5,
                ),
                "hands": mp.solutions.hands.Hands(
                    static_image_mode=False,
                    max_num_hands=2,
                    model_complexity=1,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5,
                ),
            },
        )
        return _holistic_landmarker

    if not model_path.exists():
        try:
            import mediapipe as mp
            _holistic_landmarker = (
                "solutions_split",
                {
                    "pose": mp.solutions.pose.Pose(
                        static_image_mode=False,
                        model_complexity=1,
                        smooth_landmarks=True,
                        enable_segmentation=False,
                        min_detection_confidence=0.5,
                        min_tracking_confidence=0.5,
                    ),
                    "hands": mp.solutions.hands.Hands(
                        static_image_mode=False,
                        max_num_hands=2,
                        model_complexity=1,
                        min_detection_confidence=0.5,
                        min_tracking_confidence=0.5,
                    ),
                },
            )
            return _holistic_landmarker
        except ImportError as error:
            raise HTTPException(
                status_code=503,
                detail=f"Không tìm thấy MediaPipe model: {model_path}",
            ) from error

    options = HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=VisionTaskRunningMode.VIDEO,
        min_pose_detection_confidence=0.5,
        min_pose_landmarks_confidence=0.5,
        min_hand_landmarks_confidence=0.5,
    )
    _holistic_landmarker = ("tasks", HolisticLandmarker.create_from_options(options))
    return _holistic_landmarker


def _decode_camera_image(data_url: str):
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        raise HTTPException(
            status_code=503,
            detail="OpenCV/Numpy chưa được cài cho backend.",
        ) from error

    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
    try:
        raw = base64.b64decode(encoded)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Ảnh camera không hợp lệ") from error

    image_array = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="Không đọc được ảnh camera")

    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _points(landmarks, indices=None):
    if not landmarks:
        return []
    if hasattr(landmarks, "landmark"):
        landmarks = landmarks.landmark
    selected = indices if indices is not None else range(len(landmarks))
    result = []
    for index in selected:
        if index >= len(landmarks):
            result.append(None)
            continue
        lm = landmarks[index]
        result.append({
            "x": float(lm.x),
            "y": float(lm.y),
            "visibility": float(getattr(lm, "visibility", 1.0)),
        })
    return result


def _extract_camera_landmarks(rgb):
    global _holistic_timestamp_ms
    detector_type, holistic = _get_holistic_landmarker()

    if detector_type == "tasks":
        try:
            import mediapipe as mp
        except ImportError as error:
            raise HTTPException(status_code=503, detail="MediaPipe chưa được cài") from error

        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        next_timestamp = int(time.monotonic() * 1000)
        _holistic_timestamp_ms = max(_holistic_timestamp_ms + 1, next_timestamp)
        result = holistic.detect_for_video(mp_image, _holistic_timestamp_ms)
        pose = _points(result.pose_landmarks, POSE_DRAW_INDICES)
        left_hand = _points(result.left_hand_landmarks)
        right_hand = _points(result.right_hand_landmarks)
    else:
        pose_result = holistic["pose"].process(rgb)
        hands_result = holistic["hands"].process(rgb)
        pose = _points(pose_result.pose_landmarks, POSE_DRAW_INDICES)
        left_hand = []
        right_hand = []
        hand_landmarks = hands_result.multi_hand_landmarks or []
        handedness = hands_result.multi_handedness or []
        for index, landmarks in enumerate(hand_landmarks):
            label = ""
            if index < len(handedness) and handedness[index].classification:
                label = handedness[index].classification[0].label.lower()
            points = _points(landmarks)
            if label == "left":
                left_hand = points
            elif label == "right":
                right_hand = points
            elif not left_hand:
                left_hand = points
            else:
                right_hand = points

    return {
        "has_hands": bool(left_hand or right_hand),
        "pose": pose,
        "left_hand": left_hand,
        "right_hand": right_hand,
        "connections": {
            "pose": POSE_DRAW_CONNECTIONS,
            "hand": HAND_CONNECTIONS,
        },
    }


def _draw_camera_landmarks(frame, data):
    import cv2

    height, width = frame.shape[:2]

    def xy(point):
        return int(point["x"] * width), int(point["y"] * height)

    def draw_connections(points, connections, color, thickness=2):
        if not points:
            return
        for start, end in connections:
            if start >= len(points) or end >= len(points):
                continue
            a, b = points[start], points[end]
            if not a or not b:
                continue
            cv2.line(frame, xy(a), xy(b), color, thickness, cv2.LINE_AA)

    def draw_points(points, color, radius):
        for point in points or []:
            if not point:
                continue
            cv2.circle(frame, xy(point), radius, color, -1, cv2.LINE_AA)

    draw_connections(data["pose"], POSE_DRAW_CONNECTIONS, (80, 220, 255), 2)
    draw_connections(data["left_hand"], HAND_CONNECTIONS, (255, 230, 120), 2)
    draw_connections(data["right_hand"], HAND_CONNECTIONS, (120, 255, 210), 2)
    draw_points(data["pose"], (255, 245, 170), 4)
    draw_points(data["left_hand"], (255, 255, 255), 4)
    draw_points(data["right_hand"], (235, 255, 250), 4)

    label = "HANDS DETECTED" if data["has_hands"] else "NO HANDS"
    color = (80, 255, 120) if data["has_hands"] else (120, 120, 120)
    cv2.putText(frame, label, (16, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.75, color, 2, cv2.LINE_AA)
    return frame


async def _convert_text_to_signs(text: str, use_llm: bool) -> TextToSignResponse:
    """Shared body of the single and batch text-to-sign routes."""
    signs, method = await parse_text(text, use_llm=use_llm)

    # For unfound words, provide fingerspell fallback
    fingerspell_fallback = []
    for sign in signs:
        if not sign.get("found") and sign.get("vi"):
            letters = sign_dict.get_alphabet_glosses(sign["vi"])
            fingerspell_fallback.extend(letters)

    found_count = sum(1 for s in signs if s.get("found"))

    return TextToSignResponse(
        input_text=text,
        signs=[SignToken(**s) for s in signs],
        found_count=found_count,
        total_count=len(signs),
        method=method,
        fingerspell_fallback=[SignToken(**f) for f in fingerspell_fallback],
    )


@app.post("/api/text-to-signs", response_model=TextToSignResponse)
async def text_to_signs(req: TextToSignRequest):
    """Convert Vietnamese text to a sequence of sign symbols."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    return await _convert_text_to_signs(req.text.strip(), req.use_llm)


# One subtitle line per request would mean a round trip — and a Gemini call —
# for every caption in the video, which is both slow and the fastest way to
# burn the API quota. The whole transcript is converted in one request instead.
BATCH_TEXT_LIMIT = 400
_BATCH_CONCURRENCY = 6


@app.post("/api/text-to-signs/batch", response_model=BatchTextToSignResponse)
async def text_to_signs_batch(req: BatchTextToSignRequest):
    """Convert many lines of text to sign sequences in one request."""
    texts = [t.strip() for t in (req.texts or []) if t and t.strip()]
    if not texts:
        raise HTTPException(status_code=400, detail="texts is required")
    if len(texts) > BATCH_TEXT_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"Tối đa {BATCH_TEXT_LIMIT} câu mỗi lần",
        )

    # Bounded: the parser fans out to Gemini, and an unbounded gather over a
    # long transcript would trip its rate limit and push every line onto the
    # rule-based fallback.
    semaphore = asyncio.Semaphore(_BATCH_CONCURRENCY)

    async def convert(text: str) -> TextToSignResponse:
        async with semaphore:
            return await _convert_text_to_signs(text, req.use_llm)

    results = await asyncio.gather(*(convert(text) for text in texts))
    return BatchTextToSignResponse(results=list(results))


@app.post("/api/video/subtitles")
async def video_subtitles(req: VideoSubtitleRequest):
    """Fetch a video's caption track as timed cues, ready to sign along to."""
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    try:
        # yt-dlp is blocking and talks to the network, so it must not run on
        # the event loop or it stalls every other request for seconds.
        return await run_in_threadpool(fetch_subtitles, url, req.lang)
    except SubtitleError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


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


def profile_total_words():
    return len(sign_dict.available_glosses)


@app.get("/api/profile")
async def get_profile():
    return profile_store.get(profile_total_words())


@app.patch("/api/profile")
async def update_profile(req: ProfileUpdateRequest):
    profile = req.profile.model_dump(exclude_none=True) if req.profile else None
    settings = req.settings.model_dump(exclude_none=True) if req.settings else None
    if profile:
        if "name" in profile:
            profile["name"] = profile["name"].strip()[:80]
            if not profile["name"]:
                raise HTTPException(status_code=400, detail="Tên không được để trống")
        if "role" in profile:
            profile["role"] = profile["role"].strip()[:120]
        if "daily_goal" in profile:
            profile["daily_goal"] = min(max(profile["daily_goal"], 1), 200)
    return profile_store.update(profile, settings, profile_total_words())


@app.post("/api/profile/activities")
async def add_profile_activity(req: ActivityRequest):
    try:
        return profile_store.add_activity(
            req.type,
            req.label,
            req.value,
            req.metadata,
            profile_total_words(),
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.delete("/api/profile/activities")
async def reset_profile_activity():
    return profile_store.reset(profile_total_words())


@app.get("/api/camera/model-status")
async def camera_model_status():
    return {
        "available": is_available(),
        "model": "WLASL100-I3D-Transformer",
        "classes": 100,
        "gemini_configured": gemini_configured(),
    }


@app.post("/api/camera/recognize")
async def camera_recognize(req: CameraRecognitionRequest):
    """Classify a short sign sequence captured by the browser."""
    try:
        return await run_in_threadpool(recognize, req.frames, req.top_k)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/camera/build-sentence")
async def camera_build_sentence(req: SentenceBuildRequest):
    try:
        sentence = await build_sentence(req.words)
        return {
            "sentence": sentence,
            "source_words": req.words,
            "method": "gemini-3.6-flash",
        }
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - no key, offline, quota, timeout
        print(f"[SentenceBuilder] Gemini unavailable, using local builder: {ascii(str(error))}")
        try:
            sentence = build_sentence_local(req.words)
        except ValueError as local_error:
            raise HTTPException(status_code=400, detail=str(local_error)) from local_error
        return {
            "sentence": sentence,
            "source_words": req.words,
            "method": "local",
        }


@app.post("/api/speech/transcribe")
async def speech_transcribe(request: Request):
    """Offline speech-to-text for the microphone, used when the browser's own
    speech engine is unreachable. The body is the raw recorded audio."""
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Không có dữ liệu âm thanh.")
    if len(audio) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Đoạn ghi âm quá dài.")
    lang = request.query_params.get("lang", "vi").split("-")[0] or "vi"
    try:
        return await run_in_threadpool(asr.transcribe, io.BytesIO(audio), lang)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - undecodable audio
        print(f"[ASR] transcribe failed: {ascii(str(error))}")
        raise HTTPException(status_code=400, detail="Không đọc được đoạn ghi âm.") from error


@app.get("/api/local-ai/status")
async def local_ai_status():
    return {"asr": asr.status(), "nlp": local_nlp.status()}


async def camera_python_state():
    return _camera_stream_state


async def camera_python_stream(camera: int = 0):
    """Stream annotated camera frames processed entirely by Python/OpenCV."""

    def generate():
        try:
            import cv2
        except ImportError as error:
            _camera_stream_state.update({
                "running": False,
                "error": "OpenCV chưa được cài cho backend.",
            })
            raise error

        cap = cv2.VideoCapture(camera)
        if not cap.isOpened():
            _camera_stream_state.update({
                "running": False,
                "has_hands": False,
                "result_ready": False,
                "error": f"Không mở được camera {camera}",
            })
            return

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 960)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        _camera_stream_state.update({
            "running": True,
            "has_hands": False,
            "result_ready": False,
            "seen_hands": False,
            "lost_frames": 0,
            "error": None,
        })

        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    _camera_stream_state["error"] = "Không đọc được frame từ camera"
                    break

                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                data = _extract_camera_landmarks(rgb)
                _draw_camera_landmarks(frame, data)

                if data["has_hands"]:
                    _camera_stream_state.update({
                        "has_hands": True,
                        "result_ready": False,
                        "seen_hands": True,
                        "lost_frames": 0,
                    })
                else:
                    lost = int(_camera_stream_state.get("lost_frames", 0)) + 1
                    result_ready = (
                        bool(_camera_stream_state.get("seen_hands"))
                        and lost >= 5
                    )
                    _camera_stream_state.update({
                        "has_hands": False,
                        "result_ready": result_ready,
                        "lost_frames": lost,
                    })

                if _camera_stream_state.get("result_ready"):
                    cv2.putText(
                        frame,
                        "xin chao toi yeu ban",
                        (16, frame.shape[0] - 28),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.9,
                        (80, 255, 180),
                        2,
                        cv2.LINE_AA,
                    )

                ok, buffer = cv2.imencode(
                    ".jpg",
                    frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 82],
                )
                if not ok:
                    continue

                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + buffer.tobytes()
                    + b"\r\n"
                )
                time.sleep(0.03)
        finally:
            cap.release()
            _camera_stream_state.update({
                "running": False,
                "has_hands": False,
            })

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/api/landmarks/{gloss}")
async def get_landmarks(gloss: str, request: Request):
    """
    Return the landmark frames for one sign gloss.

    Cached files are served as raw bytes with no parse/re-serialise step: the
    payload is float-dense JSON the server has nothing useful to say about, and
    round-tripping it through Python cost more than reading it from disk.
    """
    gloss_lower = gloss.lower().strip()
    if not re.fullmatch(r"[a-z0-9_' -]+", gloss_lower):
        raise HTTPException(status_code=400, detail="Invalid gloss")

    cache_path = sign_dict._landmarks_v2_dir / f"{gloss_lower}.json"
    if cache_path.exists():
        try:
            return _cached_landmark_response(gloss_lower, cache_path, request)
        except OSError:
            cache_path.unlink(missing_ok=True)

    # Cache miss. Read just this entry out of the big file using the byte-offset
    # index — a seek plus a few hundred KB, instead of a 446 MB json.load that
    # would block the event loop for 5-15 s and hold ~1.5 GB of RAM.
    data = await run_in_threadpool(_build_landmark_cache_entry, gloss_lower, cache_path)
    if data is None:
        raise HTTPException(status_code=404, detail=f"No landmarks for '{gloss}'")

    try:
        return _cached_landmark_response(gloss_lower, cache_path, request)
    except OSError:
        return JSONResponse(content={"gloss": gloss_lower, "data": data})


def _landmark_headers(stat_result) -> dict[str, str]:
    etag = f'"{stat_result.st_mtime_ns:x}-{stat_result.st_size:x}"'
    return {
        "ETag": etag,
        # Revalidate rather than trust an age: rebuilding the cache has to take
        # effect immediately. The ETag makes that a 304 with an empty body, and
        # the avatar keeps its own in-memory copy for replays inside a session.
        "Cache-Control": "no-cache",
    }


def _cached_landmark_response(gloss: str, cache_path: Path, request: Request):
    """Serve a cached file, wrapping the raw bytes in the API envelope."""
    stat_result = cache_path.stat()
    headers = _landmark_headers(stat_result)

    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)

    body = cache_path.read_bytes()
    envelope = b'{"gloss":' + json.dumps(gloss).encode("utf-8") + b',"data":'
    return Response(
        content=envelope + body + b"}",
        media_type="application/json",
        headers=headers,
    )


def _build_landmark_cache_entry(gloss: str, cache_path: Path):
    """Extract one gloss from the source file and write its cache file.

    Runs in a worker thread — everything here is blocking disk and CPU work.
    """
    landmarks_path = sign_dict._landmarks_path
    if not landmarks_path.exists():
        raise HTTPException(status_code=404, detail="Landmarks file not found")

    try:
        offsets = load_or_build(landmarks_path, sign_dict._landmarks_offsets_path)
        span = offsets.get(gloss)
        if span is None:
            return None
        entry = read_entry(landmarks_path, span)[gloss]
        data = process_landmark_entry(entry)
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(
            status_code=500,
            detail="Error reading landmarks file",
        ) from error

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_suffix(".tmp")
    with temporary_path.open("w", encoding="utf-8") as destination:
        json.dump(data, destination, ensure_ascii=False, separators=(",", ":"))
    temporary_path.replace(cache_path)
    return data


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.api.server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
