import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

function parseJsonSafely(content) {
  if (!content) return {};

  const attempts = [];
  const raw = String(content).trim();
  attempts.push(raw);

  const withoutFences = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  attempts.push(withoutFences);

  const objectMatch = withoutFences.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    attempts.push(objectMatch[0]);
    attempts.push(
      objectMatch[0]
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
    );
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return {};
}

app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages = [],
      model = "gpt-4o-mini",
      max_tokens = 500,
      temperature = 0.7,
      response_format
    } = req.body;

    // Conservar solo la imagen del ultimo mensaje; las anteriores se reemplazan.
    const cleanMessages = messages.map((msg, index) => {
      const isLastMessage = index === messages.length - 1;

      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((item) => {
            if (item.type === "image_url") {
              if (isLastMessage) {
                return item;
              }

              return {
                type: "text",
                text: "[imagen omitida del historial]"
              };
            }
            return item;
          })
        };
      }
      return msg;
    });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        response_format: response_format || { type: "json_object" },
        temperature,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "Respondé SOLO en JSON válido. Sin texto extra."
              }
            ]
          },
          ...cleanMessages
        ],
        max_tokens
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Error en OpenAI",
        raw: data
      });
    }

    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = parseJsonSafely(content);

    res.json({
      success: true,
      analysis: parsed,
      raw_content: content,
      usage: data.usage,
      model: data.model,
      id: data.id
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});
