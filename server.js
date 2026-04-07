import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

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
      content: "Respondé SOLO en JSON válido. Sin texto extra."
    },
    ...messages
  ],
  max_tokens: 500
})

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    res.json({
      success: true,
      analysis: JSON.parse(content)
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});