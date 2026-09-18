# Ollama user-connected Free Cloud — security evidence

- API keys are accepted by the trusted Electron main process and stored through the existing
  Windows-first `safeStorage` credential mechanism.
- Ollama keys are stored under a user-scoped encrypted reference, not the renderer-facing provider
  id. Key replacement validates the new key before replacing the old one.
- The renderer receives connection state, feature metadata, model names, capacity state, and
  sanitized links only. It never receives a saved key, account email, account id, or decrypted
  credential.
- The provider adapter reads the key only in the trusted process. The renderer has no Node
  integration and keeps the typed key only until the one connect IPC call completes.
- Disconnect deletes the local credential reference and cached connection state. It does not
  delete or revoke the Ollama account; the UI links the user to Ollama's key settings for manual
  revocation because the documented API exposes key revocation in the provider console.
- Secret-scan and tenant-isolation tests must remain release gates. No key is written to evidence,
  chat history, telemetry, logs, localStorage, or IndexedDB.

The focused desktop tests cover user-scoped storage, source classification, sanitized connection
views, and disconnect cleanup. The ForgeZero tests cover independent pool identities and capacity
reservation separation.
