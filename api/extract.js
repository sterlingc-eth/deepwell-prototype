import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  // CORS handling
  if (req.method === "OPTIONS") {
    return handleCors(res, req).status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  void auth;


  try {
    const { imageData, documentType } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: "Missing imageData" });
    }

    const client = new Anthropic({ apiKey: getApiKey() });

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [
        {
          name: "extract_equipment_data",
          description:
            "Extract structured equipment data from HVAC documents, warranty cards, or service reports",
          input_schema: {
            type: "object",
            properties: {
              equipmentId: {
                type: "string",
                description: "Equipment ID or serial number from the document",
              },
              serialNumber: {
                type: "string",
                description: "Equipment serial number",
              },
              model: {
                type: "string",
                description: "Equipment model name/number",
              },
              manufacturer: {
                type: "string",
                description: "Equipment manufacturer (Carrier, Trane, Lennox, etc.)",
              },
              installationDate: {
                type: "string",
                description: "Installation date in YYYY-MM-DD format",
              },
              warrantyExpires: {
                type: "string",
                description: "Warranty expiration date in YYYY-MM-DD format",
              },
              serviceDate: {
                type: "string",
                description: "Service date in YYYY-MM-DD format (if service report)",
              },
              serviceType: {
                type: "string",
                description:
                  "Type of service (Preventive Maintenance, Repair, Emergency, Installation, etc.)",
              },
              technician: {
                type: "string",
                description: "Name of technician who performed service",
              },
              workPerformed: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of work items performed (filter replacement, repair, inspection, etc.)",
              },
              cost: {
                type: "number",
                description: "Service cost in dollars",
              },
              laborHours: {
                type: "number",
                description: "Labor hours spent on service",
              },
              status: {
                type: "string",
                description: "Status (Completed, Pending, In Progress)",
              },
              notes: {
                type: "string",
                description: "Additional notes or observations",
              },
              uncertainFields: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of fields where Claude was uncertain or where data was unclear",
              },
            },
            required: [
              "equipmentId",
              "model",
              "warrantyExpires",
              "uncertainFields",
            ],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageData,
              },
            },
            {
              type: "text",
              text: `Extract structured data from this ${documentType || "HVAC document"}.

              Use the extract_equipment_data tool with whatever fields you can confidently identify.
              For uncertainFields, list any fields where the document was unclear, illegible, or missing.

              This is a real HVAC system document - extract exactly what you see, don't invent data.`,
            },
          ],
        },
      ],
    });

    // Find the tool use block
    const toolUse = response.content.find((block) => block.type === "tool_use");

    if (!toolUse) {
      return res.status(500).json({
        error: "Failed to extract data",
        details: "No structured data returned from Claude",
      });
    }

    // Add confidence score based on uncertainFields length
    const extracted = toolUse.input;
    const uncertainCount = (extracted.uncertainFields || []).length;
    const confidence = Math.max(0, 1 - uncertainCount * 0.15); // Each uncertain field = -15% confidence

    return handleCors(res, req).status(200).json({
      success: true,
      data: {
        ...extracted,
        confidence: Math.round(confidence * 100) / 100,
      },
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
