import {
  AutoProcessor,
  AutoModelForVision2Seq,
  TextStreamer,
  InterruptableStoppingCriteria,
  load_image,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1";

// SWARM Vision Sensor v0.8.0
// This worker follows Hugging Face's SmolVLM WebGPU example, adapted for SWARM's
// static PWA and one-image-at-a-time mobile memory budget.
env.allowLocalModels = false;

const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
const MAX_NEW_TOKENS = 360;
let processor = null;
let model = null;
let loadPromise = null;
const stoppingCriteria = new InterruptableStoppingCriteria();

function post(status, extra = {}) {
  self.postMessage({ status, ...extra });
}

async function getModel() {
  if (processor && model) return [processor, model];
  if (!loadPromise) {
    post("loading", { data: "Загружаю лёгкий Vision-модуль…" });
    loadPromise = Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID, {
        progress_callback: (x) => self.postMessage(x),
      }),
      AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        dtype: "fp32",
        device: "webgpu",
        progress_callback: (x) => self.postMessage(x),
      }),
    ]).then(([p, m]) => {
      processor = p;
      model = m;
      post("ready", { modelId: MODEL_ID });
      return [p, m];
    }).catch((error) => {
      loadPromise = null;
      post("error", { data: String(error?.message || error) });
      throw error;
    });
  }
  return loadPromise;
}

async function check() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter не найден");
    post("checked", { fp16: adapter.features.has("shader-f16") });
  } catch (error) {
    post("error", { data: String(error?.message || error) });
  }
}

async function generate({ requestId, prompt, image }) {
  try {
    stoppingCriteria.reset();
    const [p, m] = await getModel();
    const rawImage = await load_image(image);
    const messages = [{
      role: "user",
      content: [
        { type: "image", image },
        { type: "text", text: prompt },
      ],
    }];

    const text = p.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await p(text, [rawImage], { do_image_splitting: false });
    let output = "";
    const streamer = new TextStreamer(p.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        output += chunk;
        post("update", { requestId, output: chunk });
      },
    });

    post("start", { requestId });
    await m.generate({
      ...inputs,
      do_sample: false,
      repetition_penalty: 1.1,
      max_new_tokens: MAX_NEW_TOKENS,
      streamer,
      stopping_criteria: stoppingCriteria,
    });

    post("complete", { requestId, output: output.trim() });
  } catch (error) {
    post("error", { requestId, data: String(error?.message || error) });
  }
}

self.addEventListener("message", (event) => {
  const { type, data } = event.data || {};
  if (type === "check") check();
  if (type === "load") getModel();
  if (type === "generate") generate(data || {});
  if (type === "interrupt") stoppingCriteria.interrupt();
});
