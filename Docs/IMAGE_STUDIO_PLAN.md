# SWARM One — Image Studio plan

## Goal

Add a real image workflow to SWARM One, not a decorative placeholder:

- text → image;
- image + instruction → edited image;
- iterative edits in the same conversation;
- multiple variants;
- save/export to iPhone Files/Photos where the platform allows it;
- preserve the original image until the user explicitly replaces it.

## Architecture rule

Image generation is a **tool layer**, not an agent persona. The SWARM text core decides when to call it, while the generator/editor performs the pixel operation.

The base implementation must remain free to use. Any cloud generator is optional acceleration/quality boost, never a required dependency.

## Sequence

1. **Vision sensor** — understand attached photos/screenshots and produce factual visual evidence.
2. **Prompt director** — turn the user's natural-language intent and visual evidence into a compact generation/edit instruction.
3. **Generator/editor adapter** — pluggable engine with a stable interface.
4. **Visual verifier** — re-run Vision on the generated result and compare it with the user's request before presenting it as finished.
5. **History/versioning** — keep the source plus generated variants, so instructions like “leave everything else unchanged” can refer to a specific prior image.

## Engine policy

Do not hard-wire the UI to one model. Use an adapter interface so the engine can change without losing SWARM memory, chats, or workflow.

Candidate classes to evaluate:

- browser/WebGPU diffusion for the free PWA path;
- a future native iPhone engine for stronger local generation/editing;
- optional cloud adapters only when explicitly enabled by the user.

Avoid making research-only/non-commercial model weights a permanent core dependency if a more permissive alternative is available.

## Quality rules

- Never claim an image was visually verified unless Vision actually inspected the generated pixels.
- Editing must keep a reference to the original/source image.
- The user's instruction beats stylistic defaults.
- If an engine cannot preserve a requested detail, say so rather than silently replacing it.
- Generated files must be exportable independently of SWARM so they are not locked to the app.

## Current status

Vision integration begins in v0.8.0 using a lightweight SmolVLM sensor. Image generation/editing itself is not yet enabled.
