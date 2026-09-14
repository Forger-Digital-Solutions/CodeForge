#!/usr/bin/env python3
"""Optional developer-side 8-Bit trainer.

Input is JSONL containing only authorized structured evidence:
{"features":[13 floats],"qualifiedLabel":0|1,"roleLabels":{...}}

The output JSON uses the same compact weight shape as the TypeScript baseline. PyTorch is an
optional training dependency and is never imported by the desktop or server runtime.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


ROLE_KEYS = ["CODER", "REASONER", "PLANNER", "REVIEWER", "FAST_WORKER", "LONG_CONTEXT", "VISION", "TOOL_AGENT", "ANALYST"]


def read_samples(path: Path) -> list[dict]:
    samples = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        sample = json.loads(line)
        if len(sample.get("features", [])) != 13:
            raise ValueError("every sample must contain exactly 13 features")
        if not isinstance(sample.get("roleLabels"), dict):
            raise ValueError("every sample must contain structured roleLabels")
        samples.append(sample)
    if len(samples) < 3:
        raise ValueError("at least three authorized samples are required")
    return samples


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--seed", type=int, default=8000001)
    args = parser.parse_args()

    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise SystemExit("Optional GPU trainer requires PyTorch; install it in a developer environment only.") from exc

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but no CUDA device is available")
    device = "cuda" if args.device == "auto" and torch.cuda.is_available() else args.device

    samples = read_samples(args.input)
    features = torch.tensor([s["features"] for s in samples], dtype=torch.float32, device=device)
    qualified = torch.tensor([[float(s["qualifiedLabel"])] for s in samples], dtype=torch.float32, device=device)
    roles = torch.tensor([[float(s["roleLabels"].get(role, 0.0)) for role in ROLE_KEYS] for s in samples], dtype=torch.float32, device=device)

    hidden = nn.Linear(13, 16).to(device)
    qualification = nn.Linear(16, 1).to(device)
    role_head = nn.Linear(16, len(ROLE_KEYS)).to(device)
    optimizer = torch.optim.Adam([*hidden.parameters(), *qualification.parameters(), *role_head.parameters()], lr=args.learning_rate)
    bce = nn.BCEWithLogitsLoss()
    mse = nn.MSELoss()

    for _ in range(args.epochs):
        optimizer.zero_grad()
        hidden_values = torch.relu(hidden(features))
        loss = bce(qualification(hidden_values), qualified) + mse(torch.sigmoid(role_head(hidden_values)), roles)
        loss.backward()
        optimizer.step()

    with torch.no_grad():
        hidden_values = torch.relu(hidden(features))
        probabilities = torch.sigmoid(qualification(hidden_values)).squeeze(1)
        role_values = torch.sigmoid(role_head(hidden_values))
        qualification_accuracy = float(((probabilities >= 0.5) == (qualified.squeeze(1) >= 0.5)).float().mean())
        mean_loss = float((bce(qualification(hidden_values), qualified) + mse(role_values, roles)))

    artifact = {
        "weights": {
            "version": "8bit-specialist-v1-gpu",
            "inputDim": 13,
            "hiddenDim": 16,
            "w1": hidden.weight.detach().cpu().tolist(),
            "b1": hidden.bias.detach().cpu().tolist(),
            "wQual": qualification.weight.detach().cpu().tolist()[0],
            "bQual": float(qualification.bias.detach().cpu().item()),
            "wRoles": role_head.weight.detach().cpu().tolist(),
            "bRoles": role_head.bias.detach().cpu().tolist(),
        },
        "device": device,
        "datasetSize": len(samples),
        "epochs": args.epochs,
        "metrics": {"qualificationAccuracy": qualification_accuracy, "meanLoss": mean_loss},
        "policy": "inference remains subject to ForgeZero, qualification receipts, health and roster policy",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"device": device, "datasetSize": len(samples), "epochs": args.epochs, "output": str(args.output), "metrics": artifact["metrics"]}))


if __name__ == "__main__":
    main()
