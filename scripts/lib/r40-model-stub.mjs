// Replace the (blocked) Anthropic messages.create with a scripted model: fn(promptText, ctx) -> tool "answer" input.
export async function installScriptedModel() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  const state = { fn: null, calls: 0, lastPrompt: "" };
  proto.create = async function scripted(req) {
    state.calls++;
    const blocks = (req.messages?.[0]?.content ?? []);
    const text = (Array.isArray(blocks) ? blocks.map((b) => b.text ?? "").join("\n") : String(blocks));
    state.lastPrompt = text;
    if (!state.fn) { const e = new Error("no scripted model"); e.status = 400; e.isMock = true; throw e; }
    const input = state.fn(text, req);
    return { content: [{ type: "tool_use", name: "answer", input }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "tool_use" };
  };
  return state;
}
/** passages visible in the prompt: [{n, documentId, page, file, text}] */
export function parsePassages(prompt) {
  const out = []; const re = /\[(\d+)\] documentId: (\S+) \| page: (\d+) \| file: ([^\n(]+?)(?: \(\w+\))?\n([\s\S]*?)(?=\n\n\[\d+\] documentId:|\n\nALREADY-EXTRACTED|\n\nQUESTION:)/g;
  let m; while ((m = re.exec(prompt))) out.push({ n: +m[1], documentId: m[2], page: +m[3], file: m[4].trim(), text: m[5] });
  return out;
}
