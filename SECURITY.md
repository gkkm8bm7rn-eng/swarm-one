# Security notes

- No API keys are required by the static PWA.
- Personal state is not committed to the repository.
- User-provided text files are read in-browser and passed only to the local model in the current run.
- Unsupported binary files are not parsed in v0.7.1.
- Model/runtime files are fetched from WebLLM's documented CDN/model sources during first preparation and then rely on browser/WebLLM caching.
- Browser storage is not a guaranteed permanent backup. Export a Recovery Capsule and keep it in a user-controlled location.
- Do not treat the local verifier as external fact-checking: it has no web access in this build.
