# R36 — Permissions & capacity honesty

## Capacity waits

`eightbit.status` events now produce `notice` feed rows:

- `FREE_CAPACITY_WAIT` → "Parked · Waiting for free capacity" + `reasonCodes` + `accessibleText`
- `ROUTE_ROTATION_STARTED` / `ROUTE_ROTATED` / `ROUTE_READY` → route-change notices
- `NO_ELIGIBLE_FREE_MODEL` → explicit no-capacity statement

These are honest notices — they never render as progress or success. The canonical header/status
path (`run-lifecycle.ts`, `WAITING_FOR_CAPACITY`) is unchanged and remains authoritative.

## Sidebar

Task rows surface the parked state: "Waiting for free capacity" with the waiting icon
(`screenshots/r36-capacity-parked.png`).

## Approvals

Approval/question surfaces were unchanged this slice — R35 contracts already render them.
