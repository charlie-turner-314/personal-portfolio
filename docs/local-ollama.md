# Local Ollama categorisation

Settings → AI supports OpenAI and Ollama independently. Select Ollama, refresh the installed model list, choose a model, and test/save. Saving tests the model without transaction data. Automatic categorisation applies to future imports; the existing-transactions action only fills eligible empty categories. Disconnect disables future requests for that user. A saved OpenAI key is retained encrypted when switching providers, but is never used as an Ollama fallback.

The deployment administrator configures `OLLAMA_BASE_URL` and `OLLAMA_API_KEY` in the existing Compose environment. The URL points to the private gateway (for example `http://192.168.1.103:11435`); it is not a browser-controlled URL. Recreate backend/worker services through the normal release procedure after changing environment values. Never put the gateway token in a public frontend variable.

## Mac gateway

Keep native Ollama listening on localhost port 11434 so it can use the Mac GPU. `scripts/ollama-lan-proxy.py` provides a separate LAN listener on 11435. It requires both an allowed source IP and a bearer token; only model listing and chat completion routes are exposed. It rejects cloud/remote models, model-management requests and oversized bodies, disables thinking, permits one inference request at a time, and does not log prompts or credentials.

The gateway takes one private JSON configuration file:

- `listen_host`: IPv4 interface address or `0.0.0.0`.
- `listen_port`: 11435.
- `allowed_clients`: explicit Pi LAN IP, optionally localhost for diagnostics.
- `token`: at least 32 random characters; generate with Python `secrets.token_urlsafe(48)` and transfer privately to the Pi environment.

Store the configuration with mode 600 in a mode-700 directory. Run the gateway with a persistent user LaunchAgent whose arguments are the absolute Python path, script path and configuration path. Keep secrets out of the plist and command line. The installed Syllogic gateway uses `~/Library/Application Support/Syllogic/Ollama/` and `~/Library/LaunchAgents/com.syllogic.ollama-gateway.plist`.

Reserve the Mac and Pi addresses in the router's DHCP settings. Do not forward port 11435 from the internet. This gateway uses HTTP over the trusted LAN; for untrusted networks use a private encrypted tunnel or TLS. Keep the Mac powered and awake; closing a laptop lid or leaving the LAN may still make it unavailable. The user LaunchAgent runs in the signed-in user session and restarts on failure.

## Runtime behaviour

Ollama uses 10-row batches, explicit thinking disablement and a 120-second request timeout. Model startup may take longer than a warm request. Local inference is recorded with zero provider API cost. A busy/offline Mac or failed request stops a manual run with a visible error; completed batches remain saved. Retry processes only remaining eligible transactions. There is no automatic cloud fallback. A run is limited to ten minutes; very large imports may require a retry after the time-limit message.

The current practical starting model is `qwen3:8b`. Validate categorisation accuracy against representative data before assuming model confidence is calibrated. The model list intentionally excludes remote/cloud models; the gateway checks again on every inference request.

Validation must include unauthenticated rejection, Pi-to-Mac discovery/inference, real-model synthetic browser categorisation across multiple batches, offline retry, user isolation, existing-category preservation and an isolated database upgrade rehearsal.
