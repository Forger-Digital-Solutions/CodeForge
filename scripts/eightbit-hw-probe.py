#!/usr/bin/env python
"""8-Bit training hardware probe (R3.5 section 9).

Detects GPU, VRAM, driver, CUDA runtime compatibility, runs a tiny CUDA allocation test,
and derives a safe peak-memory target for local GPU-only training. Fails closed: if CUDA
is not usable the probe exits non-zero and training must not start (GPU TRAINING ONLY,
NO CPU TRAINING FALLBACK, NO SILENT CPU OFFLOAD).
"""
import json
import subprocess
import sys

import torch


def main() -> int:
    report: dict = {"purpose": "8-Bit GPU-only training hardware probe", "gpuTrainingOnly": True}

    if not torch.cuda.is_available():
        report["cudaAvailable"] = False
        report["verdict"] = "CUDA_UNAVAILABLE_TRAINING_FORBIDDEN"
        print(json.dumps(report, indent=1))
        return 2

    props = torch.cuda.get_device_properties(0)
    total_vram = props.total_memory
    report["cudaAvailable"] = True
    report["device"] = {
        "name": props.name,
        "computeCapability": f"{props.major}.{props.minor}",
        "totalVRAMBytes": total_vram,
        "totalVRAMMB": round(total_vram / (1024 * 1024)),
        "multiprocessors": props.multi_processor_count,
    }
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version,temperature.gpu,power.draw,memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if smi.returncode == 0:
            fields = [f.strip() for f in smi.stdout.strip().split(",")]
            report["driver"] = {
                "version": fields[0] if len(fields) > 0 else None,
                "temperatureC": float(fields[1]) if len(fields) > 1 else None,
                "powerDrawW": float(fields[2]) if len(fields) > 2 else None,
                "inUseMB": float(fields[3]) if len(fields) > 3 else None,
            }
    except (OSError, subprocess.SubprocessError):
        report["driver"] = {"query": "unavailable"}

    torch_version = torch.__version__
    report["runtime"] = {
        "torch": torch_version,
        "cudaRuntime": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else None,
    }

    free_bytes, _ = torch.cuda.mem_get_info(0)
    report["freeVRAMMB"] = round(free_bytes / (1024 * 1024))

    # Tiny allocation test: prove the runtime can actually allocate and compute on-device.
    try:
        x = torch.randn(256, 256, device="cuda", dtype=torch.float32)
        y = (x @ x).sum()
        torch.cuda.synchronize()
        report["allocationTest"] = {"ok": True, "sampleSum": float(y)}
    except Exception as exc:  # noqa: BLE001 - any allocation failure is a hard stop
        report["allocationTest"] = {"ok": False, "error": repr(exc)}
        report["verdict"] = "ALLOCATION_FAILED_TRAINING_FORBIDDEN"
        print(json.dumps(report, indent=1))
        return 3

    # Safe peak-memory target: 70% of free VRAM, leaving headroom for the desktop stack
    # (this machine also runs the operator's Electron tooling while training runs).
    safe_target = int(free_bytes * 0.70)
    report["safePeakMemoryTargetBytes"] = safe_target
    report["safePeakMemoryTargetMB"] = round(safe_target / (1024 * 1024))
    report["mixedPrecision"] = "float16" if props.major >= 7 else "none"
    report["verdict"] = "GPU_READY" if props.major >= 7 else "GPU_COMPUTE_TOO_OLD"
    print(json.dumps(report, indent=1))
    return 0 if report["verdict"] == "GPU_READY" else 4


if __name__ == "__main__":
    sys.exit(main())
