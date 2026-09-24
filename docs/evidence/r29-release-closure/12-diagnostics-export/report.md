# Packaged diagnostic export

The final production-channel package's **Settings → Data & Privacy → Support bundle** action completed and changed its button to `Exported — open folder`. A 20,528-byte JSON bundle appeared in the CodeForge profile's diagnostics folder. It contained app state keys and 52 recent log entries; the raw bundle was not copied into the repository. The frozen receipt records its SHA-256 and structural metadata.

Read-only inspection found zero raw OpenAI-style keys, GitHub tokens, AWS access keys, encrypted credential payloads, or bearer headers in this export. No planted synthetic secret was present in the live profile, so the R28 planted-secret sanitizer tests remain the stronger redaction challenge. The export has no save dialog; cancellation and injected failure/temp-file cleanup were not tested.
