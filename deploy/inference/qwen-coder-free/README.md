# Qwen Coder Free worker

This is a deployable vLLM worker image for the pinned candidate in `manifest.json`. It is a
server-side cloud worker; it is not a local inference path in the desktop. The wrapper protects
inference, model identity, metrics, and drain controls with a worker-scoped bearer token. Health
and readiness are intended for private-network orchestration only.

Build from this directory, then run on a CUDA 13 compatible host with the pinned revision and a
fresh per-worker token:

```powershell
docker build -t codeforge/qwen-coder-free:dcaee4d4dfc5 .
docker run --gpus all --rm -p 127.0.0.1:8000:8000 `
  -e CODEFORGE_WORKER_ID=qwen-worker-01 `
  -e CODEFORGE_WORKER_TOKEN=<secret-from-server-side-secret-store> `
  -e CODEFORGE_WORKER_ADMIN_TOKEN=<separate-admin-secret> `
  -e CODEFORGE_ACCELERATOR=<gpu-type> `
  -e CODEFORGE_VRAM_MB=<allocated-vram-mb> `
  codeforge/qwen-coder-free:dcaee4d4dfc5
```

Place the worker behind private-network TLS before connecting it to the public Cloud API. Configure
the matching per-worker `workerId`, base URL, and inference token in the server-side
`CODEFORGE_QWEN_WORKERS_JSON` value. Do not put either worker token in Electron, CLI, or user config.
The inference token authorizes model discovery, metrics, and inference; the distinct admin token
authorizes only `POST /admin/drain` and `POST /admin/ready`.

The Cloud API also requires a current `CODEFORGE_QWEN_QUALIFICATION_JSON` receipt matching the
model revision and worker runtime profile. It must record Apache-2.0 commercial-use compliance,
explicit multi-user authorization, and passing 8-Bit `CODER` and `TOOL_AGENT` qualification. Missing,
stale, expired, or mismatched evidence leaves the worker out of the Free pool while other Free
providers remain available.

Required capacity is not asserted by this image. The VRAM figures in the manifest are planning
estimates and the model is not qualified. Do not configure an authorized receipt based only on this
image building or starting. Record real model identity, health, serving limits, license evidence,
tool use, multi-user authorization, and real inference first. The control plane must stop new
assignments after drain and terminate only after active requests end.

vLLM is configured for dynamic continuous batching and prefix/KV caching. The configured sequence
and batch-token limits are conservative starting values, not measured capacity. Prefix caching is
enabled as a runtime setting, but no cache-hit or latency benefit is claimed. This repository's
Quadro T2000 has 4 GiB of VRAM, below this model's 48 GiB planning minimum; no throughput, cache-hit,
or real-inference claim is made from this host.

The pinned vLLM 0.30 runtime uses the documented `qwen3_xml` parser for Qwen3-Coder. Qwen's pinned
model card lists a native 262,144-token context and recommends up to 65,536 output tokens; CodeForge
stages a smaller 32,768-token context with a 24,576-token input target and 4,096-token output cap.
These CodeForge limits are unqualified operating targets, not measured worker capacity.
