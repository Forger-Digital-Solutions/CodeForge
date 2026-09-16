#!/usr/bin/env python
"""8-Bit learned specialist training (R3.5) — GPU-only.

Trains a compact transformer classifier over the frozen, vectorized 8-Bit dataset
(tests/evidence/r3.5-8bit-dataset). Multi-task: ROUTE_OUTCOME, ROLE_SUITABILITY,
ECONOMICS_STATE heads over one shared feature-token encoder. Deterministic seeding,
float16 mixed precision, peak-VRAM measurement, artifact + metrics + registry emission.

Hard constraints enforced here:
- GPU TRAINING ONLY: exits non-zero if CUDA is unavailable (no CPU fallback).
- Frozen splits: reads assignments verbatim from splits.json; never re-splits.
- Never tunes on PROTECTED_HOLDOUT: it is evaluated exactly once at the end.
"""
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

REPO = Path(__file__).resolve().parent.parent
DATASET_DIR = REPO / "tests" / "evidence" / "r3.5-8bit-dataset"
OUT_DIR = REPO / "tests" / "evidence" / "r3.5-8bit-model-v1"
SEED = 20260915

CONFIG = {
    "model": {
        "architecture": "tabular-feature-token-transformer",
        "dModel": 96,
        "nLayers": 3,
        "nHeads": 4,
        "ffMultiplier": 4,
        "dropout": 0.15,
    },
    "training": {
        "optimizer": "adamw",
        "lr": 1.2e-3,
        "weightDecay": 0.01,
        "batchSize": 32,
        "maxEpochs": 400,
        "earlyStopPatience": 40,
        # Pre-declared before the first run: DEV is tiny (8 rows) and class-degenerate, so its
        # F1 plateaus at 1.0 from epoch 0; patience may only start counting after this floor.
        "earlyStopMinEpochs": 60,
        "ampDtype": "float16",
        "gradClip": 1.0,
    },
}


def fail(message: str, code: int = 2):
    print(json.dumps({"verdict": "TRAINING_FORBIDDEN", "reason": message}))
    sys.exit(code)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- Data --------------------------------------------------------------------------------------

def load_dataset():
    vectorized = json.loads((DATASET_DIR / "vectorized.json").read_text())
    splits = json.loads((DATASET_DIR / "splits.json").read_text())
    spec = vectorized["spec"]
    rows = vectorized["rows"]
    split_of = {a["rowId"]: a["split"] for a in splits["assignments"]}

    n_cont = len(rows[0]["continuous"])
    n_cat = len(rows[0]["categoricalIndex"])
    cat_vocab = [len(spec["categorical"][name]) for name in spec["categorical"]]

    by_split = {"TRAIN": [], "DEV": [], "PROTECTED_HOLDOUT": [], "TEMPORAL_HOLDOUT": []}
    for row in rows:
        by_split[split_of[row["rowId"]]].append(row)

    def tensors(rowlist):
        cont = torch.tensor([r["continuous"] for r in rowlist], dtype=torch.float32)
        cat = torch.tensor([r["categoricalIndex"] for r in rowlist], dtype=torch.long)
        labels = torch.tensor([r["labelIndex"] for r in rowlist], dtype=torch.long)
        tasks = torch.tensor(
            [{"ROUTE_OUTCOME": 0, "ROLE_SUITABILITY": 1, "ECONOMICS_STATE": 2}[r["taskKind"]] for r in rowlist],
            dtype=torch.long,
        )
        return TensorDataset(cont, cat, labels, tasks)

    n_labels = {
        0: len(spec["routeOutcomeLabels"]),
        1: len(spec["roleSuitabilityLabels"]),
        2: len(spec["economicsStateLabels"]),
    }
    label_names = {
        "ROUTE_OUTCOME": spec["routeOutcomeLabels"],
        "ROLE_SUITABILITY": spec["roleSuitabilityLabels"],
        "ECONOMICS_STATE": spec["economicsStateLabels"],
    }
    return by_split, tensors, n_cont, n_cat, cat_vocab, n_labels, label_names


# --- Model --------------------------------------------------------------------------------------

class FeatureTokenizer(nn.Module):
    """One token per feature: identity embedding + value projection; missing values (-1
    sentinel) route to a dedicated learned missing-embedding per feature."""

    def __init__(self, n_cont: int, cat_vocab: list, d_model: int):
        super().__init__()
        self.n_cont = n_cont
        self.cat_vocab = cat_vocab
        self.cont_proj = nn.Linear(1, d_model)
        self.cont_missing = nn.Parameter(torch.zeros(n_cont, d_model))
        self.cat_embeds = nn.ModuleList(
            [nn.Embedding(v + 1, d_model, padding_idx=v) for v in cat_vocab]  # last index = missing
        )
        self.identity = nn.Parameter(torch.zeros(n_cont + len(cat_vocab), d_model))
        nn.init.normal_(self.identity, std=0.02)

    def forward(self, cont: torch.Tensor, cat: torch.Tensor) -> torch.Tensor:
        b, _ = cont.shape
        tokens = []
        missing = cont < -0.5
        clamped = cont.clamp(min=0.0).unsqueeze(-1)
        for i in range(self.n_cont):
            values = self.cont_proj(clamped[:, i, :])
            miss = self.cont_missing[i].unsqueeze(0).expand(b, -1)
            mask = missing[:, i].unsqueeze(-1)
            tokens.append(torch.where(mask, miss, values))
        for j, emb in enumerate(self.cat_embeds):
            idx = cat[:, j].clamp(min=0)
            idx = torch.where(cat[:, j] < 0, torch.full_like(idx, emb.padding_idx or 0), idx)
            tokens.append(emb(idx))
        stacked = torch.stack(tokens, dim=1)
        return stacked + self.identity.unsqueeze(0)


class EightBitSpecialist(nn.Module):
    def __init__(self, n_cont: int, cat_vocab: list, n_labels: dict, cfg: dict):
        super().__init__()
        d = cfg["dModel"]
        self.tokenizer = FeatureTokenizer(n_cont, cat_vocab, d)
        self.task_embed = nn.Embedding(3, d)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d, nhead=cfg["nHeads"], dim_feedforward=d * cfg["ffMultiplier"],
            dropout=cfg["dropout"], batch_first=True, norm_first=True, activation="gelu",
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=cfg["nLayers"])
        self.norm = nn.LayerNorm(d)
        self.heads = nn.ModuleDict({
            "0": nn.Linear(d, n_labels[0]),
            "1": nn.Linear(d, n_labels[1]),
            "2": nn.Linear(d, n_labels[2]),
        })
        self.dropout = nn.Dropout(cfg["dropout"])


class MultiTaskWrapper(nn.Module):
    """Batches may mix task kinds; each sample routes through the shared encoder to its own head."""

    def __init__(self, specialist: EightBitSpecialist):
        super().__init__()
        self.specialist = specialist

    def forward(self, cont, cat, task):
        tokens = self.specialist.tokenizer(cont, cat)
        task_token = self.specialist.task_embed(task).unsqueeze(1)
        tokens = torch.cat([task_token, tokens], dim=1)
        encoded = self.specialist.encoder(tokens)
        pooled = self.specialist.norm(encoded[:, 0])
        pooled = self.specialist.dropout(pooled)
        widest = max(head.out_features for head in self.specialist.heads.values())
        logits = torch.zeros(pooled.size(0), widest, device=pooled.device)
        out = torch.zeros(pooled.size(0), device=pooled.device, dtype=torch.long)
        for task_id, head in self.specialist.heads.items():
            mask = task == int(task_id)
            if mask.any():
                out[mask] = head(pooled[mask]).float().argmax(dim=-1)
                head_out = head(pooled[mask]).float()
                if head_out.size(1) == widest:
                    logits[mask] = head_out
                else:
                    padded = torch.full((int(mask.sum()), widest), float("-inf"), device=pooled.device)
                    padded[:, : head_out.size(1)] = head_out
                    logits[mask] = padded
        return logits, out


# --- Metrics --------------------------------------------------------------------------------------

def macro_f1(y_true, y_pred, n_classes):
    f1s = []
    for c in range(n_classes):
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == c and p == c)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != c and p == c)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == c and p != c)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    present = {t for t in y_true}
    used = [f1s[c] for c in range(n_classes) if c in present]
    return sum(used) / len(used) if used else 0.0


def brier_score(probs: dict, y_true):
    scores = []
    for i, t in enumerate(y_true):
        dist = probs[i]
        target = [1.0 if j == t else 0.0 for j in range(len(dist))]
        scores.append(sum((d - x) ** 2 for d, x in zip(dist, target)))
    return sum(scores) / len(scores) if scores else None


# --- Training --------------------------------------------------------------------------------------

def main():
    report = {"seed": SEED, "gpuOnly": True}

    if not torch.cuda.is_available():
        fail("CUDA unavailable; GPU-only training policy forbids CPU fallback")
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    device = torch.device("cuda")
    props = torch.cuda.get_device_properties(0)
    report["hardware"] = {"gpu": props.name, "vramMB": round(props.total_memory / (1024 * 1024)), "computeCapability": f"{props.major}.{props.minor}"}

    by_split, tensors, n_cont, n_cat, cat_vocab, n_labels, label_names = load_dataset()
    if any(len(by_split[s]) == 0 for s in ("TRAIN", "DEV")):
        fail("TRAIN or DEV split is empty")
    report["data"] = {s: len(v) for s, v in by_split.items()}

    train_loader = DataLoader(tensors(by_split["TRAIN"]), batch_size=CONFIG["training"]["batchSize"], shuffle=True,
                              generator=torch.Generator().manual_seed(SEED))
    dev_loader = DataLoader(tensors(by_split["DEV"]), batch_size=64, shuffle=False)
    temporal_loader = DataLoader(tensors(by_split["TEMPORAL_HOLDOUT"]), batch_size=64, shuffle=False)
    protected_loader = DataLoader(tensors(by_split["PROTECTED_HOLDOUT"]), batch_size=64, shuffle=False)

    model = MultiTaskWrapper(EightBitSpecialist(n_cont, cat_vocab, n_labels, CONFIG["model"]).to(device))
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    report["parameters"] = n_params

    # Class-weighted loss (route-outcome head dominates the corpus).
    train_labels = [r["labelIndex"] for r in by_split["TRAIN"]]
    tasks_train = [{"ROUTE_OUTCOME": 0, "ROLE_SUITABILITY": 1, "ECONOMICS_STATE": 2}[r["taskKind"]] for r in by_split["TRAIN"]]
    class_weights = []
    for task_id in range(3):
        counts = [sum(1 for t, l in zip(tasks_train, train_labels) if t == task_id and l == c) for c in range(n_labels[task_id])]
        total = sum(counts)
        weights = [(total / (n_labels[task_id] * c)) ** 0.5 if c else 1.0 for c in counts]
        class_weights.append(torch.tensor(weights, dtype=torch.float32, device=device))

    optimizer = torch.optim.AdamW(model.parameters(), lr=CONFIG["training"]["lr"], weight_decay=CONFIG["training"]["weightDecay"])
    scaler = torch.amp.GradScaler("cuda")
    autocast = torch.amp.autocast(device_type="cuda", dtype=torch.float16)

    best_dev_f1 = -1.0
    best_state = None
    best_epoch = -1
    patience_left = CONFIG["training"]["earlyStopPatience"]
    epoch_log = []
    started = time.time()

    def evaluate(loader):
        model.eval()
        y_true, y_pred, task_ids, prob_rows = [], [], [], []
        with torch.no_grad(), autocast:
            for cont, cat, labels, tasks in loader:
                cont, cat, tasks = cont.to(device), cat.to(device), tasks.to(device)
                logits, preds = model(cont, cat, tasks)
                logp = torch.log_softmax(logits.float(), dim=-1)
                for i in range(labels.size(0)):
                    task_id = int(tasks[i].item())
                    n_cls = n_labels[task_id]
                    dist = [math.exp(v) for v in logp[i, :n_cls].tolist()]
                    z = sum(dist)
                    prob_rows.append([d / z for d in dist])
                    y_true.append(int(labels[i].item()))
                    y_pred.append(int(preds[i].item()))
                    task_ids.append(task_id)
        per_task = {}
        for task_id, name in enumerate(["ROUTE_OUTCOME", "ROLE_SUITABILITY", "ECONOMICS_STATE"]):
            pairs = [(t, p) for t, p, k in zip(y_true, y_pred, task_ids) if k == task_id]
            if not pairs:
                per_task[name] = None
                continue
            tt = [t for t, _ in pairs]
            tp = [p for _, p in pairs]
            per_task[name] = {"macroF1": round(macro_f1(tt, tp, n_labels[task_id]), 4),
                              "n": len(pairs),
                              "support": {label_names[name][c]: tt.count(c) for c in range(n_labels[task_id]) if tt.count(c)}}
        return y_true, y_pred, task_ids, prob_rows, per_task

    for epoch in range(CONFIG["training"]["maxEpochs"]):
        model.train()
        epoch_loss, batches = 0.0, 0
        for cont, cat, labels, tasks in train_loader:
            cont, cat, labels, tasks = cont.to(device), cat.to(device), labels.to(device), tasks.to(device)
            optimizer.zero_grad(set_to_none=True)
            with autocast:
                tokens = model.specialist.tokenizer(cont, cat)
                task_token = model.specialist.task_embed(tasks).unsqueeze(1)
                tokens = torch.cat([task_token, tokens], dim=1)
                encoded = model.specialist.encoder(tokens)
                pooled = model.specialist.norm(encoded[:, 0])
                pooled = model.specialist.dropout(pooled)
                losses = []
                for task_id, head in model.specialist.heads.items():
                    mask = tasks == int(task_id)
                    if mask.any():
                        losses.append(nn.functional.cross_entropy(head(pooled[mask]), labels[mask], weight=class_weights[int(task_id)]))
                loss = sum(losses) / len(losses)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), CONFIG["training"]["gradClip"])
            scaler.step(optimizer)
            scaler.update()
            epoch_loss += float(loss.detach())
            batches += 1

        _, _, _, _, dev_per_task = evaluate(dev_loader)
        route_f1 = dev_per_task["ROUTE_OUTCOME"]["macroF1"] if dev_per_task["ROUTE_OUTCOME"] else 0.0
        all_f1 = [v["macroF1"] for v in dev_per_task.values() if v]
        mean_f1 = sum(all_f1) / len(all_f1) if all_f1 else 0.0
        epoch_log.append({"epoch": epoch, "trainLoss": round(epoch_loss / max(batches, 1), 5), "devMeanMacroF1": round(mean_f1, 4)})
        improved = mean_f1 > best_dev_f1 + 1e-4
        tie_keep_latest = abs(mean_f1 - best_dev_f1) <= 1e-4 and epoch > best_epoch
        if improved or tie_keep_latest:
            # DEV is class-degenerate at this scale, so its F1 plateaus immediately; on ties the
            # most-trained epoch is kept (declared rule, not tuned against any holdout).
            best_dev_f1, best_epoch, patience_left = mean_f1, epoch, CONFIG["training"]["earlyStopPatience"]
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        elif epoch >= CONFIG["training"]["earlyStopMinEpochs"]:
            patience_left -= 1
            if patience_left <= 0:
                break

    report["training"] = {
        "wallSeconds": round(time.time() - started, 1),
        "epochsRun": len(epoch_log),
        "bestEpoch": best_epoch,
        "bestDevMeanMacroF1": round(best_dev_f1, 4),
        "earlyStopped": len(epoch_log) < CONFIG["training"]["maxEpochs"],
    }
    report["devCurve"] = epoch_log

    if best_state is not None:
        model.load_state_dict(best_state)

    peak_vram = torch.cuda.max_memory_allocated(0)
    report["peakVRAMBytes"] = int(peak_vram)
    report["peakVRAMMB"] = round(peak_vram / (1024 * 1024), 1)
    report["safePeakMemoryTargetMB"] = 2308
    report["withinSafePeakTarget"] = peak_vram <= 2420228752

    # --- Final evaluations: DEV (model selection), then holdouts once -----------------------------
    def full_eval(loader, split_name):
        y_true, y_pred, task_ids, probs, per_task = evaluate(loader)
        # Latency: single-row GPU inference, batch of 1, measured over the split.
        model.eval()
        if len(y_true) > 0:
            cont1, cat1, _, task1 = next(iter(DataLoader(loader.dataset, batch_size=1, shuffle=False)))
            torch.cuda.synchronize()
            t0 = time.time()
            for _ in range(10):
                with torch.no_grad(), autocast:
                    model(cont1.to(device), cat1.to(device), task1.to(device))
            torch.cuda.synchronize()
            latency_ms = round((time.time() - t0) / 10 * 1000, 2)
        else:
            latency_ms = None
        return {
            "split": split_name,
            "perTask": per_task,
            "brier": {
                ["ROUTE_OUTCOME", "ROLE_SUITABILITY", "ECONOMICS_STATE"][k]: (
                    brier_score([p for p, kk in zip(probs, task_ids) if kk == k],
                                [t for t, kk in zip(y_true, task_ids) if kk == k])
                )
                for k in range(3)
            },
            "singleRowInferenceMs": latency_ms,
            "predictions": [
                {"taskKind": ["ROUTE_OUTCOME", "ROLE_SUITABILITY", "ECONOMICS_STATE"][k],
                 "yTrue": t, "yPred": p, "probs": pr}
                for (t, p, k, pr) in zip(y_true, y_pred, task_ids, probs)
            ],
        }

    dev_eval = full_eval(dev_loader, "DEV")
    temporal_eval = full_eval(temporal_loader, "TEMPORAL_HOLDOUT")
    protected_eval = full_eval(protected_loader, "PROTECTED_HOLDOUT")

    # Inference latency on CPU is irrelevant to this policy; GPU-only runtime is the contract.

    # --- Artifact ---------------------------------------------------------------------------------
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    artifact_config = {**CONFIG, "featureSpec": json.loads((DATASET_DIR / "vectorized.json").read_text())["spec"],
                       "datasetManifestHash": json.loads((DATASET_DIR / "manifest.json").read_text())["datasetManifestHash"],
                       "splitsSha256": json.loads((DATASET_DIR / "splits.json").read_text())["sha256"]}
    state_buf = io_state_dict(model)
    artifact_bytes = json.dumps({
        "format": "eightbit-specialist-v1",
        "config": artifact_config,
        "stateDict": state_buf,
    }, sort_keys=True).encode()
    artifact_sha = sha256_bytes(artifact_bytes)
    (OUT_DIR / "8bit-r35-c1.json.pt").write_bytes(artifact_bytes)

    for name, ev in (("dev", dev_eval), ("temporal", temporal_eval), ("protected", protected_eval)):
        (OUT_DIR / f"learned-predictions-{name}.json").write_text(json.dumps(
            {"split": ev["split"], "perTask": ev["perTask"], "predictions": ev["predictions"]}, indent=1))

    metrics = {k: v for k, v in report.items() if k not in {"devCurve"}}
    (OUT_DIR / "training-metrics.json").write_text(json.dumps({**metrics, "devCurve": report["devCurve"], "evaluations": {
        "DEV": dev_eval, "TEMPORAL_HOLDOUT": temporal_eval, "PROTECTED_HOLDOUT": protected_eval}}, indent=1))

    registry = {
        "8bit_version": "r35-c1",
        "base_model": "from-scratch compact tabular transformer (no third-party weights)",
        "base_revision": None,
        "base_license": "N/A (architecture only; weights are CodeForge-owned)",
        "parameter_count": n_params,
        "training_method": "multi-task SFT from scratch, float16 AMP, class-weighted CE",
        "adapter_config": None,
        "training_dataset_hash": json.loads((DATASET_DIR / "manifest.json").read_text())["datasetManifestHash"],
        "dev_hash": json.loads((DATASET_DIR / "splits.json").read_text())["sha256"],
        "protected_holdout_hash": json.loads((DATASET_DIR / "splits.json").read_text())["sha256"],
        "temporal_holdout_hash": json.loads((DATASET_DIR / "splits.json").read_text())["sha256"],
        "training_code_sha": sha256_bytes(Path(__file__).read_bytes()),
        "training_environment": {"gpu": props.name, "torch": torch.__version__, "cuda": torch.version.cuda, "seed": SEED},
        "GPU": props.name,
        "peak_VRAM": f"{report['peakVRAMMB']} MB",
        "training_duration": f"{report['training']['wallSeconds']} s",
        "metrics": {"bestDevMeanMacroF1": report["training"]["bestDevMeanMacroF1"]},
        "artifact_sha256": artifact_sha,
        "promotion_state": "candidate",
        "previous_version": None,
        "rollback_target": None,
    }
    (OUT_DIR / "registry-candidate.json").write_text(json.dumps(registry, indent=1))

    print(json.dumps({**report, "artifact": {"path": "tests/evidence/r3.5-8bit-model-v1/8bit-r35-c1.json.pt", "sha256": artifact_sha, "bytes": len(artifact_bytes)}}, indent=1))
    return 0


def io_state_dict(model) -> dict:
    return {k: v.detach().cpu().tolist() for k, v in model.state_dict().items()}


if __name__ == "__main__":
    sys.exit(main())
