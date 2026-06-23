"""
server.py
FastAPI backend for Text → Sign Symbol conversion.

Run: python -m app.api.server
Or:  uvicorn app.api.server:app --reload --port 8000
"""

import base64
import json
import os
import re
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .sign_lookup import sign_dict
from .text_parser import parse_text
from .landmark_processing import process_landmark_entry
from .profile_store import profile_store

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


@app.post("/api/camera/landmarks")
async def camera_landmarks(req: CameraLandmarkRequest):
    """Extract real MediaPipe holistic landmarks from a browser camera frame."""
    rgb = _decode_camera_image(req.image)
    return _extract_camera_landmarks(rgb)


@app.get("/api/camera/python-state")
async def camera_python_state():
    return _camera_stream_state


@app.get("/api/camera/python-stream")
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
async def get_landmarks(gloss: str):
    """
    Get landmark frames for a specific sign gloss.
    Streams from the large JSON file without loading entirely.
    """
    gloss_lower = gloss.lower().strip()
    if not re.fullmatch(r"[a-z0-9_' -]+", gloss_lower):
        raise HTTPException(status_code=400, detail="Invalid gloss")

    cache_path = sign_dict._landmarks_v2_dir / f"{gloss_lower}.json"
    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as source:
                return JSONResponse(content={
                    "gloss": gloss_lower,
                    "data": json.load(source),
                })
        except (OSError, json.JSONDecodeError):
            cache_path.unlink(missing_ok=True)

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

        if gloss_lower in sign_dict._landmarks_cache:
            data = process_landmark_entry(sign_dict._landmarks_cache[gloss_lower])
            sign_dict._landmarks_v2_dir.mkdir(parents=True, exist_ok=True)
            temporary_path = cache_path.with_suffix(".tmp")
            with temporary_path.open("w", encoding="utf-8") as destination:
                json.dump(data, destination, ensure_ascii=False, separators=(",", ":"))
            temporary_path.replace(cache_path)
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
