import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey } from "./_lib/claude.js";

// Sample records behind the public "Ask" demo on the marketing site.
// These are illustrative and mirror the DEMO array in index.html.
const RECORDS = [
  { id: "R1", type: "Warranty registration", title: "Carrier 59TP6 furnace — 3247 Elm St", text: "Carrier warranty registration. Model 59TP6A080V17--20, serial 4N2119-08772. Installed 2019-03-14 at 3247 Elm St (basement). Customer: T. Okafor. Parts coverage 10 years, through 2029-03-14. Labor coverage 5 years, through 2024-03-14. Registered by dealer 2019-03-19." },
  { id: "R2", type: "Work order", title: "#19-0412 — furnace install, 3247 Elm St", text: "Work order 19-0412, 2019-03-14. Address 3247 Elm St. Customer T. Okafor. Technician Marcus Reyes (#T-07). Job: remove old furnace, install Carrier 59TP6A080V17, serial 4N2119-08772 (page 2, serial field). Total $6,840. Signed J. Alvarez (office)." },
  { id: "R3", type: "Nameplate photo", title: "Nameplate — 3247 Elm St, Nov 2025", text: "Photo uploaded from truck 2025-11-02 by M. Reyes. Nameplate reads Carrier 59TP6A080V17--20, serial 4N2119-08772. Read confidence 99%." },
  { id: "R4", type: "Work order", title: "#25-1187 — no heat, Henderson, 8810 Ridgeview", text: "Work order 25-1187, 2025-11-02. Customer R. & D. Henderson, 8810 Ridgeview Dr. Technician Marcus Reyes (#T-07). Complaint: no heat. Found failed hot-surface igniter on Lennox EL296V furnace, serial 5817G04512. Replaced igniter, verified ignition and flame sense. Parts $118, labor $194, total $312." },
  { id: "R5", type: "Work order", title: "#25-1233 — blower cleaning, Henderson", text: "Work order 25-1233, 2025-11-19. Customer Henderson, 8810 Ridgeview Dr. Technician Marcus Reyes. Follow-up: blower wheel cleaning, filter replaced, static pressure checked. Total $189. No callback within 30 days." },
  { id: "R6", type: "Invoice", title: "Invoice 25-1187 — Henderson", text: "Invoice 25-1187 to R. Henderson for work order 25-1187. Hot-surface igniter $118, labor 1.5 h $194. Total $312. Paid by card 2025-11-10." },
  { id: "R7", type: "Spreadsheet", title: "Maintenance agreements 2026.xlsx", text: "Maintenance agreements 2026. Okafor, 3247 Elm St: active, renews 2026-12-01. Patel, 1120 Pine Ave: active, renews 2027-03-01. Henderson, 8810 Ridgeview Dr: none. Nguyen, 455 Birch Ct: none. Delgado, 77 Harbor Way: active." },
  { id: "R8", type: "Warranty registration", title: "Carrier 24ACC6 AC — 1120 Pine Ave", text: "Carrier warranty registration. Model 24ACC636A003, serial 2416E58811. Installed 2016-09-24 at 1120 Pine Ave. Customer R. Patel. Parts coverage 10 years, through 2026-09-24. Labor 1 year, expired 2017-09-24." },
  { id: "R9", type: "Warranty registration", title: "Carrier 58STA furnace — 455 Birch Ct", text: "Carrier warranty registration. Model 58STA090, serial 3016A22190. Installed 2016-10-30 at 455 Birch Ct. Customer L. Nguyen. Parts coverage 10 years, through 2026-10-30." },
  { id: "R10", type: "Work order", title: "#24-0655 — capacitor, 455 Birch Ct", text: "Work order 24-0655, 2024-02-11. 455 Birch Ct, customer L. Nguyen. Technician Dana Whitfield (#T-03). Replaced inducer motor run capacitor on Carrier 58STA090, serial 3016A22190. Total $228." },
  { id: "R11", type: "Startup sheet", title: "Startup — Carrier 59TP6, 3247 Elm St", text: "Startup sheet 2019-03-14, 3247 Elm St. Carrier 59TP6A080V17: 80,000 BTU input, 96% AFUE, two-stage. Total external static pressure 0.48 in. w.c. Temperature rise 52°F. Gas pressure 3.5 in. w.c. Technician M. Reyes." },
  { id: "R12", type: "Permit", title: "Mechanical permit M-2019-1183 — 3247 Elm St", text: "City mechanical permit M-2019-1183 for furnace replacement at 3247 Elm St. Issued 2019-03-12. Final inspection passed 2019-04-02." },
];

export function getRecords() {
  return RECORDS.map(({ id, type, title }) => ({ id, type, title }));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res).status(204).end();
  if (req.method === "GET") return res.status(200).json({ records: getRecords() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const question = String(req.body?.question || "").trim().slice(0, 300);
    if (!question) return res.status(400).json({ error: "Missing question" });

    const client = new Anthropic({ apiKey: getApiKey() });
    const today = "2026-09-12";
    const corpus = RECORDS.map((r) => `[${r.id}] ${r.type} — ${r.title}\n${r.text}`).join("\n\n");

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 700,
      system: `You answer questions for an HVAC contractor's office using ONLY the records provided. Today is ${today}.
Rules:
- Answer in one to three plain sentences, the way a careful coworker would. Use specific dates, names, serials and dollar amounts from the records.
- Every fact must come from a record. Cite record ids. Never invent equipment, dates, or people.
- If the records do not contain the answer, set answerable=false and say plainly what is not in the records; suggest the closest records.
- A bare address, serial number, or customer name is a valid question: return that entity's full story.
- Do not mention AI, models, or that you are an assistant. Do not apologize.`,
      tools: [
        {
          name: "answer",
          description: "Return the answer built from the records.",
          input_schema: {
            type: "object",
            properties: {
              answerable: { type: "boolean" },
              answer: { type: "string", description: "1–3 sentences. Plain English." },
              facts: {
                type: "array",
                description: "Up to 6 key/value facts that support the answer.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                    status: { type: "string", enum: ["ok", "warn", "bad", "none"], description: "ok=active/good, warn=expiring/attention, bad=expired/failed, none=neutral" },
                    statusLabel: { type: "string" },
                  },
                  required: ["label", "value", "status"],
                },
              },
              sources: {
                type: "array",
                description: "Records used, with where in the record the fact came from.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    where: { type: "string", description: "e.g. 'expiry dates', 'page 2, serial field', 'line items'" },
                  },
                  required: ["id", "where"],
                },
              },
              confidence: { type: "number", description: "0–1" },
            },
            required: ["answerable", "answer", "facts", "sources", "confidence"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "answer" },
      messages: [{ role: "user", content: `RECORDS:\n\n${corpus}\n\nQUESTION: ${question}` }],
    });

    const tool = response.content.find((c) => c.type === "tool_use");
    if (!tool) return res.status(502).json({ error: "No answer produced" });

    const byId = Object.fromEntries(RECORDS.map((r) => [r.id, r]));
    const out = tool.input;
    out.sources = (out.sources || [])
      .filter((s) => byId[s.id])
      .map((s) => ({ id: s.id, type: byId[s.id].type, title: byId[s.id].title, where: s.where }));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(out);
  } catch (err) {
    return handleError(res, err);
  }
}
