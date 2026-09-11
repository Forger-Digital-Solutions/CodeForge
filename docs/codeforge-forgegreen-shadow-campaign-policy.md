# ForgeGreen shadow campaign policy

## Scope

This policy covers the recovered ForgeGreen FG-8 through FG-10R lineage and the shadow-mode observation pipeline that is only valid when bound to a certified implementation surface.

## Core invariants

- Candidate A remains `ACTIVE_SAFE` only for verified duplicate read-only tool reuse.
- Candidate B, C, and D remain `SHADOW` and cannot silently promote themselves.
- The canonical evidence for Candidates B/C/D is defined by the recovered source implementation and not by prose-only assumptions.
- Observations must include the certified source-state ID, observation schema version, and candidate policy/version.
- Source-state mismatch prevents cross-lineage aggregation.

## Qualified evidence requirements

### Candidate B

- page identity
- delivered-content fingerprint
- workspace revision
- turn ordering

### Candidate C

- optionality
- validity of current availability
- terminal lifecycle signals

### Candidate D

- evidence ID
- evidence hash
- input-state hash
- policy revision
- ForgeVerify validity decision

## Certification gate

FG-11 observations are valid only when the source-state identity matches the certified implementation surface and the candidate policy/version remains compatible.
