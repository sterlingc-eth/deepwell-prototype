import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";

// Explicit, for the reason spelled out in ask.js: a route with no maxDuration
// gets the platform's bare default, and a model call that outlives it is hard-
// killed with no catch and no message. A body limit belongs here too — every
// other route in this codebase declares one, and these two were the exceptions.
export const config = { api: { bodyParser: { sizeLimit: "512kb" } }, maxDuration: 60 };

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
    const { query, equipment } = req.body;

    if (!query || !equipment) {
      return res.status(400).json({ error: "Missing query or equipment" });
    }

    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });

    // Get today's date for relative date queries
    const today = new Date().toISOString().split("T")[0];

    const equipmentJson = JSON.stringify(equipment, null, 2);

    const response = await client.messages.create({
      model: "claude-haiku-4-5", // Haiku for speed and cost
      max_tokens: 512,
      tools: [
        {
          name: "search_equipment",
          description: "Find equipment matching the user's natural language query",
          input_schema: {
            type: "object",
            properties: {
              matches: {
                type: "array",
                description: "Array of matching equipment",
                items: {
                  type: "object",
                  properties: {
                    equipmentId: {
                      type: "string",
                      description: "The equipment ID",
                    },
                    reason: {
                      type: "string",
                      description: "Why this equipment matches the query",
                    },
                    confidence: {
                      type: "number",
                      description: "Confidence score 0-1",
                    },
                  },
                  required: ["equipmentId", "reason", "confidence"],
                },
              },
            },
            required: ["matches"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Today's date: ${today}

Equipment database:
${equipmentJson}

User query: "${query}"

Find all equipment that matches this query and return results ranked by relevance.
Only return equipment IDs that actually exist in the database.

For date queries like "expiring soon", use today's date (${today}) to calculate.
Be smart about natural language - "warranty expiring this year" should find anything expiring before Dec 31 of the current year.`,
        },
      ],
    });

    // Find the tool use block
    const toolUse = response.content.find((block) => block.type === "tool_use");

    if (!toolUse) {
      return res.status(200).json({
        success: true,
        data: {
          query,
          matches: [],
          message: "No matches found",
        },
      });
    }

    const { matches } = toolUse.input;

    // Validate all equipment IDs exist in the provided data
    const validMatches = matches.filter((match) =>
      equipment.some((e) => e.id === match.equipmentId)
    );

    return handleCors(res, req).status(200).json({
      success: true,
      data: {
        query,
        matches: validMatches,
        totalMatches: validMatches.length,
      },
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
