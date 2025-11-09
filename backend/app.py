"""FastAPI backend that accepts frames and returns MediaPipe pose landmarks.

Provides:
- WebSocket endpoint `/ws` that accepts binary JPEG frames and returns JSON landmarks
- HTTP POST `/pose` for single-image testing (multipart/form-data `image`)

Usage:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8000

Frontend (browser) can send frames as binary over the websocket; README contains an example.
"""
from typing import List, Dict, Any

import io
import sys
import asyncio
import numpy as np
import cv2
import mediapipe as mp
from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="Pose Backend (MediaPipe + OpenCV)")

mp_pose = mp.solutions.pose

# Create a Pose object; reuse for performance. Use the faster, smaller model by
# setting model_complexity=0 and disabling optional segmentation. This reduces
# CPU usage at the cost of a small accuracy tradeoff.
pose = mp_pose.Pose(
    static_image_mode=False,
    model_complexity=0,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)

# Server-side pose choices for control websocket
POSES = ["Arms Down", "Y-Pose", "T-Pose", "OMG"]

CONTROL_WS_CONNECTIONS = set()


def _decode_image_bytes(image_bytes: bytes) -> np.ndarray:
    """Decode image bytes (JPEG/PNG) into an OpenCV BGR image."""
    arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    return img


def _process_image_bgr(img_bgr: np.ndarray) -> Dict[str, Any]:
    """Run MediaPipe Pose on an OpenCV BGR image and return structured landmarks."""

    # Resize the image to a smaller resolution before running MediaPipe to
    # reduce CPU load and increase throughput. We keep aspect ratio and use a
    # reasonable max dimension (e.g., 320). MediaPipe returns normalized
    # landmark coordinates (0..1), so multiplying by the original width/height
    # still yields correct pixel coordinates.
    height, width = img_bgr.shape[:2]
    max_dim = 320
    scale = 1.0
    if max(width, height) > max_dim:
        scale = max_dim / float(max(width, height))

    if scale < 1.0:
        small_w = int(round(width * scale))
        small_h = int(round(height * scale))
        img_proc = cv2.resize(img_bgr, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
    else:
        img_proc = img_bgr

    # Convert BGR -> RGB for MediaPipe
    img_rgb = cv2.cvtColor(img_proc, cv2.COLOR_BGR2RGB)
    results = pose.process(img_rgb)

    if not results.pose_landmarks:
        return {"landmarks": [], "has_pose": False}

    landmarks = []
    # landmarks are normalized [0..1] based on image coordinates
    for idx, lm in enumerate(results.pose_landmarks.landmark):
        try:
            name = mp_pose.PoseLandmark(idx).name
        except Exception:
            name = str(idx)

        landmarks.append(
            {
                "index": idx,
                "name": name,
                "x": float(lm.x * width),
                "y": float(lm.y * height),
                "z": float(lm.z * width),
                "visibility": float(lm.visibility),
            }
        )

    return {"landmarks": landmarks, "has_pose": True}


@app.post("/pose")
async def pose_from_upload(image: UploadFile = File(...)):
    """Process a single uploaded image (multipart/form-data `image`) and return pose landmarks."""
    if image.content_type.split("/")[0] != "image":
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    data = await image.read()
    try:
        img = _decode_image_bytes(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not decode image: {e}")

    result = _process_image_bgr(img)
    return JSONResponse(content=result)


@app.websocket("/ws")
async def websocket_pose(ws: WebSocket):
    """WebSocket endpoint that accepts binary frames and responds with landmarks JSON.

    Client protocol (simple convention used here):
    - Client sends binary message containing a JPEG/PNG image (frame) as raw bytes.
    - Server responds with a JSON object {landmarks: [...], has_pose: bool}.

    This keeps latency low and format simple for a browser client.
    """
    await ws.accept()
    try:
        while True:
            msg = await ws.receive()
            # msg can be {'type': 'websocket.receive', 'bytes': b'...'} or {'type':'websocket.disconnect'}
            if msg.get("type") == "websocket.disconnect":
                break

            if bytes_data := msg.get("bytes"):
                try:
                    img = _decode_image_bytes(bytes_data)
                except Exception as e:
                    await ws.send_json({"error": "decode_failed", "detail": str(e)})
                    continue

                result = _process_image_bgr(img)
                await ws.send_json(result)
            else:
                # ignore text messages or respond with an error
                text = msg.get("text")
                if text:
                    await ws.send_json({"error": "send_binary_frames", "detail": "Send image bytes as binary frames"})

    except Exception as e:
        # In production, log the exception
        await ws.close()


# Simple stdin broadcaster for testing: read lines from the server's stdin and broadcast
# them to any connected test WebSocket clients. This allows you to type a test message
# into the backend process and have it appear in the frontend for connection testing.
TEST_WS_CONNECTIONS = set()


@app.websocket("/ws/test")
async def websocket_test(ws: WebSocket):
    """WebSocket that receives server-stdin broadcast messages.

    Connect from the browser to this endpoint to receive test messages typed into
    the server's console (stdin). Useful to verify the frontend/back-end connectivity.
    """
    await ws.accept()
    TEST_WS_CONNECTIONS.add(ws)
    try:
        # Keep the connection alive; listen for client messages to detect disconnects.
        while True:
            msg = await ws.receive_text()
            # Echo back a simple acknowledgement for any client message
            await ws.send_json({"type": "ack", "received": msg})
    except Exception:
        # client disconnected or error
        pass
    finally:
        try:
            TEST_WS_CONNECTIONS.remove(ws)
        except Exception:
            pass


@app.websocket("/ws/control")
async def websocket_control(ws: WebSocket):
    """Control websocket: clients can request the server to pick the next pose.

    Protocol:
    - Client sends JSON: {"type": "next"} when its round ends and it wants a server-chosen pose.
    - Server responds to that client with: {"type": "pose", "pose": "T-Pose"}
    - Other messages are ignored. This keeps the server as the authority for random selection
      while allowing each client to receive its own random pose.
    """
    await ws.accept()
    CONTROL_WS_CONNECTIONS.add(ws)
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            # support text frames containing JSON
            text = msg.get("text")
            if not text:
                # ignore binary messages
                continue
            try:
                import json

                obj = json.loads(text)
            except Exception:
                await ws.send_json({"error": "invalid_json"})
                continue

            if obj.get("type") == "next":
                # pick a random pose and broadcast it to all connected control clients
                import random

                pose = random.choice(POSES)
                dead = []
                for c in list(CONTROL_WS_CONNECTIONS):
                    try:
                        await c.send_json({"type": "pose", "pose": pose})
                    except Exception:
                        dead.append(c)
                for d in dead:
                    try:
                        CONTROL_WS_CONNECTIONS.remove(d)
                    except Exception:
                        pass
            else:
                # echo unknown message types for diagnostics
                await ws.send_json({"type": "error", "detail": "unknown_type"})
    except Exception:
        # connection dropped or error
        pass
    finally:
        try:
            CONTROL_WS_CONNECTIONS.remove(ws)
        except Exception:
            pass


async def _stdin_broadcaster_task():
    """Background task that reads lines from stdin and broadcasts to connected websockets."""
    loop = asyncio.get_event_loop()
    while True:
        # Blocking read executed in thread pool
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            # EOF or no input; sleep briefly to avoid busy loop
            await asyncio.sleep(0.1)
            continue
        text = line.rstrip("\n")
        if not text:
            continue
        dead = []
        for ws in list(TEST_WS_CONNECTIONS):
            try:
                await ws.send_json({"type": "stdin", "text": text})
            except Exception:
                dead.append(ws)
        for ws in dead:
            try:
                TEST_WS_CONNECTIONS.remove(ws)
            except Exception:
                pass


@app.on_event("startup")
async def _startup_stdin_broadcaster():
    # spawn background task to read stdin and broadcast messages
    asyncio.create_task(_stdin_broadcaster_task())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, log_level="info")
