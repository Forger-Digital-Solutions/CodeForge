import asyncio
import json
import os
import secrets
import signal
import subprocess
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse


MODEL_ID = os.environ.get("CODEFORGE_MODEL_ID", "codeforge/qwen-coder-free")
MODEL_REVISION = os.environ.get("CODEFORGE_MODEL_REVISION", "")
MODEL_SOURCE = os.environ.get("CODEFORGE_MODEL_SOURCE", "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8")
WORKER_ID = os.environ.get("CODEFORGE_WORKER_ID", "")
WORKER_TOKEN = os.environ.get("CODEFORGE_WORKER_TOKEN", "")
WORKER_ADMIN_TOKEN = os.environ.get("CODEFORGE_WORKER_ADMIN_TOKEN", "")
VLLM_URL = f"http://127.0.0.1:{os.environ.get('VLLM_API_PORT', '8001')}"
MAX_SEQUENCES = int(os.environ.get("CODEFORGE_MAX_CONCURRENT_SEQUENCES", "8"))
MAX_BATCH_TOKENS = int(os.environ.get("CODEFORGE_MAX_BATCH_TOKENS", "4096"))
active_requests = 0
draining = False
started_at = time.time()
process: subprocess.Popen[bytes] | None = None
client = httpx.AsyncClient(timeout=None)


def vllm_args() -> list[str]:
    return [
        "vllm", "serve", MODEL_SOURCE,
        "--revision", MODEL_REVISION,
        "--served-model-name", MODEL_ID,
        "--host", "127.0.0.1",
        "--port", os.environ.get("VLLM_API_PORT", "8001"),
        "--dtype", os.environ.get("CODEFORGE_DTYPE", "auto"),
        "--max-model-len", os.environ.get("CODEFORGE_MAX_MODEL_LEN", "32768"),
        "--max-num-seqs", str(MAX_SEQUENCES),
        "--max-num-batched-tokens", str(MAX_BATCH_TOKENS),
        "--tensor-parallel-size", os.environ.get("CODEFORGE_TENSOR_PARALLEL_SIZE", "1"),
        "--enable-auto-tool-choice",
        "--tool-call-parser", "qwen3_xml",
        "--enable-prefix-caching",
    ]


@asynccontextmanager
async def lifespan(_: FastAPI):
    global process
    if not WORKER_ID or not WORKER_TOKEN or not WORKER_ADMIN_TOKEN or not MODEL_REVISION:
        raise RuntimeError("CODEFORGE_WORKER_ID, worker and admin tokens, and pinned CODEFORGE_MODEL_REVISION are required")
    process = subprocess.Popen(vllm_args(), start_new_session=True)
    try:
        yield
    finally:
        await client.aclose()
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()


app = FastAPI(lifespan=lifespan)


def require_worker_token(authorization: str | None) -> None:
    expected = f"Bearer {WORKER_TOKEN}".encode()
    provided = (authorization or "").encode()
    if not WORKER_TOKEN or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid worker credential")


def require_admin_token(authorization: str | None) -> None:
    expected = f"Bearer {WORKER_ADMIN_TOKEN}".encode()
    provided = (authorization or "").encode()
    if not WORKER_ADMIN_TOKEN or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid worker admin credential")


async def readiness() -> bool:
    if process is None or process.poll() is not None:
        return False
    try:
        response = await client.get(f"{VLLM_URL}/health", timeout=2)
        if response.status_code != 200:
            return False
        models = await client.get(f"{VLLM_URL}/v1/models", timeout=2)
        return models.status_code == 200 and any(item.get("id") == MODEL_ID for item in models.json().get("data", []))
    except (httpx.HTTPError, ValueError):
        return False


@app.get("/health")
async def health():
    return {"status": "alive", "workerId": WORKER_ID, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION}


@app.get("/ready")
async def ready():
    if draining or not await readiness():
        return JSONResponse(status_code=503, content={"status": "not_ready", "draining": draining})
    return {"status": "ready", "workerId": WORKER_ID, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION}


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)):
    require_worker_token(authorization)
    if not await readiness():
        raise HTTPException(status_code=503, detail="Model worker is not ready")
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "codeforge", "revision": MODEL_REVISION}]}


@app.get("/metrics")
async def metrics(authorization: str | None = Header(default=None)):
    require_worker_token(authorization)
    try:
        upstream = await client.get(f"{VLLM_URL}/metrics", timeout=3)
        upstream.raise_for_status()
        text = upstream.text
    except httpx.HTTPError:
        text = ""
    gpu = await gpu_state()
    cache_hits = metric_value(text, "vllm:prefix_cache_hits")
    cache_queries = metric_value(text, "vllm:prefix_cache_queries")
    cache_hit_rate = cache_hits / cache_queries if cache_hits is not None and cache_queries and cache_queries > 0 else None
    identity = {
        "workerId": WORKER_ID,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "accelerator": gpu["accelerator"] or os.environ.get("CODEFORGE_ACCELERATOR", "unreported"),
        "vramMb": gpu["vramTotalMb"] or int(os.environ.get("CODEFORGE_VRAM_MB", "0")),
        "vramUsedMb": gpu["vramUsedMb"],
        "gpuUtilizationPct": gpu["gpuUtilizationPct"],
        "activeRequests": active_requests,
        "queueDepth": metric_value(text, "vllm:num_requests_waiting"),
        "maxConcurrentSequences": MAX_SEQUENCES,
        "maxBatchTokens": MAX_BATCH_TOKENS,
        "promptTokensPerSecond": metric_value(text, "vllm:avg_prompt_throughput_toks_per_s"),
        "generationTokensPerSecond": metric_value(text, "vllm:avg_generation_throughput_toks_per_s"),
        "gpuCacheUsagePct": (metric_value(text, "vllm:gpu_cache_usage_perc") or 0) * 100 if text else None,
        "prefixCacheHitRate": cache_hit_rate,
        "draining": draining,
        "uptimeSeconds": int(time.time() - started_at),
    }
    return JSONResponse(identity, headers={"X-VLLM-Metrics-Available": str(bool(text)).lower()})


def metric_value(text: str, name: str) -> float | None:
    for line in text.splitlines():
        if line.startswith(name + "{") or line.startswith(name + " "):
            try:
                return float(line.rsplit(" ", 1)[1])
            except ValueError:
                return None
    return None


async def gpu_state() -> dict[str, str | float | None]:
    try:
        process = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=2)
        if process.returncode != 0:
            raise RuntimeError("nvidia-smi unavailable")
        rows = []
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            fields = [field.strip() for field in line.split(",")]
            if len(fields) != 4:
                continue
            try:
                rows.append((fields[0], float(fields[1]), float(fields[2]), float(fields[3])))
            except ValueError:
                continue
        if not rows:
            return {"accelerator": None, "vramUsedMb": None, "vramTotalMb": None, "gpuUtilizationPct": None}
        return {
            "accelerator": ", ".join(row[0] for row in rows),
            "vramUsedMb": sum(row[2] for row in rows),
            "vramTotalMb": sum(row[3] for row in rows),
            "gpuUtilizationPct": sum(row[1] for row in rows) / len(rows),
        }
    except (OSError, asyncio.TimeoutError, RuntimeError):
        return {"accelerator": None, "vramUsedMb": None, "vramTotalMb": None, "gpuUtilizationPct": None}


@app.post("/admin/drain")
async def drain(authorization: str | None = Header(default=None)):
    global draining
    require_admin_token(authorization)
    draining = True
    return {"state": "DRAINING", "activeRequests": active_requests}


@app.post("/admin/ready")
async def resume(authorization: str | None = Header(default=None)):
    global draining
    require_admin_token(authorization)
    if not await readiness():
        raise HTTPException(status_code=503, detail="Model worker is not ready")
    draining = False
    return {"state": "READY"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str | None = Header(default=None)):
    global active_requests
    require_worker_token(authorization)
    if draining or not await readiness():
        raise HTTPException(status_code=503, detail="CODEFORGE_CAPACITY_SATURATED")
    body = await request.body()
    if len(body) > 1_048_576:
        raise HTTPException(status_code=413, detail="Request exceeds 1 MiB worker limit")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=400, detail="Invalid JSON") from error
    if payload.get("model") != MODEL_ID:
        raise HTTPException(status_code=400, detail="Unapproved logical model")
    max_tokens = payload.get("max_tokens", 2000)
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1 or max_tokens > 4096:
        raise HTTPException(status_code=400, detail="Qwen worker output limit is 4,096 tokens")
    if payload.get("n", 1) != 1:
        raise HTTPException(status_code=400, detail="Qwen worker serves one choice per request")
    active_requests += 1
    try:
        upstream = await client.send(client.build_request("POST", f"{VLLM_URL}/v1/chat/completions", content=body, headers={"content-type": "application/json"}), stream=True)
    except httpx.HTTPError as error:
        active_requests -= 1
        raise HTTPException(status_code=503, detail="CODEFORGE_CAPACITY_SATURATED") from error
    if upstream.status_code >= 400:
        content = await upstream.aread()
        await upstream.aclose()
        active_requests -= 1
        return Response(content=content, status_code=upstream.status_code, media_type="application/json")
    if payload.get("stream") is True:
        async def stream() -> AsyncIterator[bytes]:
            global active_requests
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                active_requests -= 1

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
    try:
        content = await upstream.aread()
        return Response(content=content, status_code=upstream.status_code, media_type="application/json")
    finally:
        await upstream.aclose()
        active_requests -= 1


@app.get("/metrics/vllm")
async def raw_metrics(authorization: str | None = Header(default=None)):
    require_worker_token(authorization)
    try:
        response = await client.get(f"{VLLM_URL}/metrics", timeout=3)
        return Response(content=response.text, status_code=response.status_code, media_type="text/plain; version=0.0.4")
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="vLLM metrics unavailable") from error
