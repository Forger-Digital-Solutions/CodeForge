# R84 ForgeAAA regression

Unreal **4.27.2** ran against an exclusively created R84 pilot copied from the verified R83 pilot. Original pilot Content hashes match before/after in [preservation.json](native/preservation.json). No authored Dead Trails West maps or assets were overwritten. Existing binary/native plugin and module assets were reused; Blender assets were not regenerated.

[Migration fault campaign](native/migration-fault-campaign-1791748709103.json): missing mesh and stale source conflict blocked before mutation; fault after three mutations rolled back; interruption exited 86 and recovered by rollback; caller booleans/copied rollback evidence were rejected; commit and idempotent repeat succeeded; a separate engine process verified exact saved transforms and **23 actor identities**.

[First persistence attempt](native/persistence-upgrade-1791748900412.json) and [staged-waypoint recheck](native/persistence-upgrade-1791749355350.json): pre-upgrade and post-upgrade pass, door/window SaveGame restored in a fresh process, interior interaction/closed collision/reopening and room traversal pass. The final exit fails (action 22 initially; actions 24/25 after staged waypoints). Both raw driver receipts remain. No assertion, collision or completion policy was weakened. This is **PARTIAL**, not full native regression success.

The initial missing .scratch parent startup failure remains in native-campaign.log. The owning wrapper creates that parent before exclusive pilot creation. It no longer regenerates the checked-in campaign scripts. Durable Director behavior was covered by the ForgeAAA core tests; the full live Director campaign and fresh visual review were not repeated.
