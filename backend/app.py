import io
import sys
import asyncio
import json
import numpy as np
import cv2
import tensorflow as tf
import tensorflow_hub as hub
from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="Pose Backend (MoveNet + FastAPI)")

# ---------------------------------------------------------
# Load MoveNet model (CPU)
# ---------------------------------------------------------
movenet = hub.load("https://tfhub.dev/google/movenet/singlepose/thunder/4")
input_size = 256


def run_movenet(img_rgb):
    """Run MoveNet pose detection on an RGB image."""
    img_resized = tf.image.resize_with_pad(tf.expand_dims(img_rgb, axis=0), input_size, input_size)
    input_tensor = tf.cast(img_resized, dtype=tf.int32)

    outputs = movenet.signatures["serving_default"](input_tensor)
    keypoints = outputs["output_0"].numpy()[0, 0, :, :]  # (17, 3)

    return keypoints


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
    h, w = img_bgr.shape[:2]
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

    kp = run_movenet(img_rgb)  # (17 keypoints, each [y, x, confidence])

    landmarks = []
    for idx, (y, x, c) in enumerate(kp):
        landmarks.append({
            "index": idx,
            "name": str(idx),
            "x": float(x * w),
            "y": float(y * h),
            "visibility": float(c)
        })

    return {"landmarks": landmarks, "has_pose": True}


# ---------------------------------------------------------
# HTTP Endpoint
# ---------------------------------------------------------

@app.post("/pose")
async def pose_from_upload(image: UploadFile = File(...)):
    if image.content_type.split("/")[0] != "image":
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    data = await image.read()
    img = _decode_image_bytes(data)

    result = _process_image_bgr(img)
    return JSONResponse(content=result)


# ---------------------------------------------------------
# WebSocket Pose
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
                await ws.send_json({
                    "error": "send_binary_frames",
                    "detail": "Send image bytes as binary frames"
                })
    finally:
        await ws.close()


# ---------------------------------------------------------
# Control WebSocket (unchanged)
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
            except:
                await ws.send_json({"error": "invalid_json"})
                continue

            if obj.get("type") == "next":
                import random
                pose = random.choice(POSES)

                dead = []
                for conn in list(CONTROL_WS_CONNECTIONS):
                    try:
                        await conn.send_json({"type": "pose", "pose": pose})
                    except:
                        dead.append(conn)

                for d in dead:
                    CONTROL_WS_CONNECTIONS.discard(d)

            else:
                await ws.send_json({"type": "error", "detail": "unknown_type"})
    finally:
        CONTROL_WS_CONNECTIONS.discard(ws)


# ---------------------------------------------------------
# For local dev
# ---------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000)
