from pathlib import Path


def replace_function(source: str, start_marker: str, end_marker: str, replacement: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[:start] + replacement + source[end:]


p = Path("app.js")
s = p.read_text(encoding="utf-8")

s = s.replace('const APP_VERSION = "0.8.0";', 'const APP_VERSION = "0.8.1";')

new_build_vision = r'''async function buildVisionEvidence(task, imageItems) {
  if (!imageItems.length) return "";
  try {
    await ensureVision();
  } catch (err) {
    throw new Error(`VISION_LOAD_FAILED: ${err?.message || err}`);
  }
  const outputs = [];
  const selected = imageItems.slice(0, 2);
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    setRun(`Vision: анализ изображения ${i + 1}/${selected.length}`, 58 + i * 12, 1, 3);
    const prompt = `Act as a factual visual sensor. The user asks in Russian: ${escapeForPrompt(task, 900)}\nAnswer in Russian if possible; otherwise use simple English. Describe only visible evidence relevant to the question. Include objects, composition, colors, layout, and legible text when possible. If something is uncertain, say so. Do not invent context outside the image.`;
    let evidence;
    try {
      evidence = await askVision(prompt, item.blob);
    } catch (err) {
      throw new Error(`VISION_INFERENCE_FAILED: ${err?.message || err}`);
    }
    outputs.push(`[VISION ${i + 1}: ${item.name}]\n${evidence || "Vision не вернул надёжного описания."}`);
  }
  if (imageItems.length > 2) outputs.push(`[VISION LIMIT]\nПроанализированы первые 2 изображения из ${imageItems.length}, чтобы не перегружать память iPhone.`);
  return `ВИЗУАЛЬНЫЕ ДАННЫЕ ОТ ОТДЕЛЬНОГО VISION-СЕНСОРА:\n${outputs.join("\n\n")}`;
}

'''
s = replace_function(s, 'async function buildVisionEvidence(task, imageItems) {', 'function attachmentSummary() {', new_build_vision)

old_result = '    const result = modelReady ? await runSwarm(task, attachments) : demoResponse(task);'
new_result = r'''    let result;
    if (hasImages && !modelReady) {
      result = {
        mode: "s0",
        final: `Vision-предпросмотр (основная текстовая модель пока не загружена):\n\n${visionEvidence}`,
        candidates: [],
        verification: "Vision sensor only; text swarm not started",
        risks: ["Основная текстовая модель SWARM не запускалась; это прямой вывод Vision-сенсора."],
        visionOnly: true,
      };
    } else {
      result = modelReady ? await runSwarm(task, attachments) : demoResponse(task);
    }'''
if old_result not in s:
    raise RuntimeError("submitPrompt result marker not found")
s = s.replace(old_result, new_result)

s = s.replace('const visionFailure = /VISION|SmolVLM|transformers/i.test(String(err?.message || err));', 'const visionFailure = /VISION|SmolVLM|transformers|load failed/i.test(String(err?.message || err));')
s = s.replace('Vision не смог завершить анализ на этом устройстве: ${err?.message || err}. Изображение не было подменено догадкой.', 'Vision не смог завершить анализ: ${err?.message || err}. Изображение не было подменено догадкой. Ошибка сохранена для диагностики.')

p.write_text(s, encoding="utf-8")

idx = Path("index.html")
t = idx.read_text(encoding="utf-8")
t = t.replace("SWARM One · v0.8.0", "SWARM One · v0.8.1")
t = t.replace("./app.js?v=0.8.0", "./app.js?v=0.8.1")
idx.write_text(t, encoding="utf-8")

sw = Path("service-worker.js")
q = sw.read_text(encoding="utf-8")
q = q.replace('const VERSION = "swarm-one-v0.8.0";', 'const VERSION = "swarm-one-v0.8.1";')
q = q.replace('"./app.js?v=0.8.0"', '"./app.js?v=0.8.1"')
q = q.replace('"./vision-worker.js?v=0.8.0"', '"./vision-worker.js?v=0.8.1"')
sw.write_text(q, encoding="utf-8")

print("Vision v0.8.1 patch complete")
