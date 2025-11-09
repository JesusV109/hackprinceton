"""
FastAPI backend using mediapipe-rs (CPU-only, DigitalOcean compatible).
Accepts:
- WebSocket /ws → binary JPEG frames → returns pose landmarks
- HTTP POST /pose → single-image testing
"""

import io
import sys
import asyncio
import json
import numpy as np
import cv2

from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

# mediapipe-rs pose detector
from mediapipe_rs import pose as mp_pose

app = FastAPI(title="Pose Backend (MediaPipe-RS + OpenCV)")

# Initialize pose detector (fast, CPU-only)
pose_detector = mp_pose.PoseDetector()


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------

def _decode_image_bytes(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    return img


def _process_image_bgr(img_bgr: np.ndarray):
    """
    Process BGR image and return landmarks structure similar to mediapipe.
    """
    height, width = img_bgr.shape[:2]

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

    # Run pose detection
    result = pose_detector.detect(img_rgb)

    if not result or not result.landmarks:
        return {"landmarks": [], "has_pose": False}

    # Normalize results to match your old format
    output = []
    for idx, lm in enumerate(result.landmarks):
        output.append({
            "index": idx,
            "name": str(idx),
            "x": float(lm.x * width),
            "y": float(lm.y * height),
            "z": float(lm.z * width),
            "visibility": float(lm.visibility),
        })

    return {"landmarks": output, "has_pose": True}


# ---------------------------------------------------------
# HTTP Endpoint
# ---------------------------------------------------------

@app.post("/pose")
async def pose_from_upload(image: UploadFile = File(...)):
    if image.content_type.split("/")[0] != "image":
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    data = await image.read()

    try:
        img = _decode_image_bytes(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not decode image: {e}")

    result = _process_image_bgr(img)
    return JSONResponse(content=result)


# ---------------------------------------------------------
# WebSocket: Pose Detection
# ---------------------------------------------------------

@app.websocket("/ws")
async def websocket_pose(ws: WebSocket):
    await ws.accept()

    try:
        while True:
            msg = await ws.receive()

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
                text = msg.get("text")
                if text:
                    await ws.send_json({
                        "error": "send_binary_frames",
                        "detail": "Send image bytes as binary frames"
                    })

    finally:
        await ws.close()


# ---------------------------------------------------------
# Control WS (unchanged)
# ---------------------------------------------------------

POSES = ["Arms Down", "Y-Pose", "T-Pose", "OMG"]
CONTROL_WS_CONNECTIONS = set()

@app.websocket("/ws/control")
async def websocket_control(ws: WebSocket):
    await ws.accept()
    CONTROL_WS_CONNECTIONS.add(ws)

    try:
        while True:
            msg = await ws.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            text = msg.get("text")
            if not text:
                continue

            try:
                obj = json.loads(text)
            except Exception:
                await ws.send_json({"error": "invalid_json"})
                continue

            if obj.get("type") == "next":
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
                    except:
                        pass
            else:
                await ws.send_json({"type": "error", "detail": "unknown_type"})
    finally:
        try:
            CONTROL_WS_CONNECTIONS.remove(ws)
        except:
            pass


# ---------------------------------------------------------
# Stdin Debug WS (optional)
# ---------------------------------------------------------

TEST_WS_CONNECTIONS = set()

@app.websocket("/ws/test")
async def websocket_test(ws: WebSocket):
    await ws.accept()
    TEST_WS_CONNECTIONS.add(ws)

    try:
        while True:
            msg = await ws.receive_text()
            await ws.send_json({"type": "ack", "received": msg})
    except:
        pass
    finally:
        try:
            TEST_WS_CONNECTIONS.remove(ws)
        except:
            pass


async def _stdin_broadcaster_task():
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
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
            except:
                pass


@app.on_event("startup")
async def _startup_task():
    asyncio.create_task(_stdin_broadcaster_task())


# ---------------------------------------------------------
# Local dev entrypoint
# ---------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, log_level="info")
