// functions/api/ai.js — يعمل على خوادم Cloudflare بدون كشف المفاتيح
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const { action, payload } = body;

    const geminiKey = env.GEMINI_API_KEY;
    const groqKey = env.GROQ_API_KEY;

    // 1) فحص الفواتير والرفوف بالصور (Gemini 3.5 Flash-Lite)
    if (action === "gemini_vision") {
      if (!geminiKey) {
        return new Response(JSON.stringify({ error: "Missing GEMINI_API_KEY in Cloudflare environment" }), { status: 500 });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: payload.prompt },
              { inlineData: { mimeType: payload.mimeType || "image/jpeg", data: payload.base64Data } }
            ]
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      });

      const data = await res.json();
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error.message || "Gemini API error" }), { status: 500 });
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }

    // 2) التسعير وتوليد الأوصاف (Qwen 3.8 27B عبر Groq)
    if (action === "groq_chat") {
      if (!groqKey) {
        return new Response(JSON.stringify({ error: "Missing GROQ_API_KEY in Cloudflare environment" }), { status: 500 });
      }

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b",
          messages: [
            { role: "system", content: payload.systemInstruction || "أنت مساعد ذكي لإدارة المتاجر." },
            { role: "user", content: payload.prompt }
          ],
          temperature: 0.3,
          max_tokens: 1500,
          response_format: payload.asJson ? { type: "json_object" } : undefined
        })
      });

      const data = await res.json();
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error.message || "Groq API error" }), { status: 500 });
      }

      const content = data?.choices?.[0]?.message?.content?.trim() || "";
      return new Response(JSON.stringify({ result: content }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
