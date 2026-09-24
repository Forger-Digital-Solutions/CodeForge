# R32 Vision Feedback Classification

Question posed by the campaign: "Can visual observations feed back into intelligence
cleanly?" The honest answer splits into what exists on the wire, what reaches the model,
and what R32 actually ships as the feedback path.

## Wire schema: text-only

`packages/providers/src/chat-types.ts` — `ChatMessageSchema.content` is `z.string()`.
There is no image-part representation anywhere in the provider request schema. Screenshots
taken by `computer_screenshot` / browser capture tools return **persisted evidence
receipts + SHA-256 hashes**, never image bytes, and therefore never enter model context.
`packages/computer-use/src/runtime.ts` and `packages/browser/src/tools.ts` both implement
this deliberately.

## Capability detection: honest, per-model

`packages/providers/src/openrouter.ts` + `adaptive-topology.ts` detect `vision` from the
model's declared input modalities (`inputs.includes("image")`). This is catalog truth —
it records that a model *could* accept images — but the request path cannot supply them.
No code path claims otherwise.

## What R32 ships instead: structural UIA grounding

For the workload that matters here — operating a desktop UI — the implemented feedback
mechanism is the UI Automation tree (`computer_inspect_ui`, commit adc02f6): element names,
AutomationIds, control types, bounds, focus and enabled state, plus a `treeHash` used for
post-action verification. This is strictly more actionable than pixels for UI work: a
target resolves by name/id, an action verifies by re-enumeration, and failures name the
element rather than a coordinate.

## Verdict

- Raw pixel-to-model feedback: **NOT IMPLEMENTED** on this surface, correctly classified.
  Upstream blockers are structural, not incidental: the provider wire schema is text-only,
  free-tier vision models are rare and rate-limited, and image tokens would consume the
  same bounded inference budget the completion guarantee depends on.
- Visual observations → intelligence: **IMPLEMENTED via structural UIA grounding** — the
  actionable subset of "seeing the UI," proven live on Windows (see
  `20-computer-use/AUDIT.md`).

This is a classification, not a claim: nothing in the product surface reports pixel-level
vision reasoning as shipped.
