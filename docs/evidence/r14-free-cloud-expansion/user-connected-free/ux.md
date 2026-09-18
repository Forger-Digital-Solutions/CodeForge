# Ollama user-connected Free Cloud — UX

Settings → Provider Connections contains a first-class **Add More Free Capacity** card:

1. **Create Free Ollama Account** opens Ollama's official signup page.
2. **Create Ollama API Key** opens Ollama's official key settings.
3. The connection dialog asks the user to create a key named `CodeForge`, paste it once, and
   return to CodeForge.
4. CodeForge validates the key with a small authenticated model-list request, discovers the live
   catalog, and stores the key securely.

The connected card labels the resource **Free · your account**, shows the one-request concurrency
limit and starter-model count, links to usage, supports key replacement, and supports disconnect.
Usage and reset are shown as “Not observable” until an official account-scoped usage source is
available; the UI never invents a percentage or says “Unlimited”.

The feature is rollout-flagged while provider terms and the free-only hard-stop remain pending.
