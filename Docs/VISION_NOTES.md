# Vision v0.8.0

SWARM One now uses a separate lightweight visual sensor for attached images.

## Current flow

1. The iPhone locally downsizes the attached image before analysis.
2. The core text model translates the user's Russian visual question into a compact English sensor instruction.
3. `HuggingFaceTB/SmolVLM-256M-Instruct` runs in a Web Worker through Transformers.js + WebGPU.
4. The Vision output is treated as **evidence**, not as the final answer.
5. The normal SWARM protocol receives the original user request plus the visual evidence and produces the Russian response.

This separation is deliberate: the current SmolVLM checkpoint is English-oriented, while the SWARM core remains responsible for Russian conversation, reasoning, critique and verification.

## Mobile safeguards

- Analyze at most 2 images in one request for now.
- `do_image_splitting` is disabled to reduce memory pressure.
- Vision output is explicitly labeled as sensor evidence.
- If Vision fails, SWARM must not invent a description of the image.

## What Vision can reasonably attempt

- general photo description;
- visible objects and composition;
- screenshots and UI structure;
- basic visible text/OCR-like reading when legible;
- product-card and visual-layout observations.

Fine typography, tiny text and subtle design judgments should still be treated cautiously and can be improved later with specialist visual tools.

## Source basis

Implementation is adapted from Hugging Face's official Transformers.js SmolVLM WebGPU example and uses `@huggingface/transformers` 3.7.1, matching that example's tested dependency.
