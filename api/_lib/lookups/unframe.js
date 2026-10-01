/**
 * R32b: conversational frame + filler-tail removal shared by the closed-shape parsers ("ok um, how many docs does X have thanks").
 * Pure; never invents words, only removes a leading frame and trailing please/thanks/when-you-get-a-sec filler.
 */
import { stripConversationalFrame } from "../router/frame.js";

const FILLER_TAIL = /\s+(?:for\s+me|please|pls|thanks|thx|real\s+quick|when\s+you\s+get\s+a\s+sec|asap|right\s+now|today|now)\s*[?.!]*$/i;

export function unframe(s) {
  let q = String(stripConversationalFrame(String(s ?? "")) ?? s ?? "").trim().replace(/[?!.]+$/, "");
  q = q.replace(FILLER_TAIL, "").replace(FILLER_TAIL, "");
  return q;
}
