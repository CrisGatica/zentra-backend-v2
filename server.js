import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    // ✅ LIMPIAR HISTORIAL (CLAVE)
    const cleanMessages = messages.map((msg) => {
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((item) => {
            // ❌ eliminar imágenes viejas
            if (item.type === "image_url") {
              return {
                type: "text",
                text: "[imagen omitida]"
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
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
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
        max_tokens: 500
      })
    });

    const data = await response.json();

    const content = data.choices?.[0]?.message?.content ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    res.json({
      success: true,
      analysis: parsed
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});