// functions/api/ai.js — يعمل على خوادم Cloudflare Pages بدون كشف المفاتيح
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const { action, payload } = body;

    const geminiKey = env.GEMINI_API_KEY;
    const groqKey = env.GROQ_API_KEY;

    // 1) فحص الصور والمستندات والجداول (Gemini 3.5 Flash-Lite)
    if (action === "gemini_vision") {
      if (!geminiKey) {
        return new Response(
          JSON.stringify({ error: "Missing GEMINI_API_KEY in Cloudflare environment" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const parts = [{ text: payload.prompt }];

      if (payload.fileText) {
        // نصوص وجداول الإكسل المرسلة كنص مباشر فائق الدقة
        parts.push({ text: "\n\n--- بيانات الملف أو الجدول المرفق ---\n" + payload.fileText });
      } else if (payload.base64Data) {
        // ملفات PDF الإلكترونية والصور عبر المعالجة المتعددة الوسائط
        parts.push({
          inlineData: {
            mimeType: payload.mimeType || "image/jpeg",
            data: payload.base64Data
          }
        });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        })
      });

      const data = await res.json();
      if (data.error) {
        return new Response(
          JSON.stringify({ error: data.error.message || "Gemini API error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }

    // 2) التسعير وتوليد الأوصاف (Groq Qwen 3.8 27B)
    if (action === "groq_chat") {
      if (!groqKey) {
        return new Response(
          JSON.stringify({ error: "Missing GROQ_API_KEY in Cloudflare environment" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
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
          temperature: 0.2,
          max_tokens: 1500,
          response_format: payload.asJson ? { type: "json_object" } : undefined
        })
      });

      const data = await res.json();
      if (data.error) {
        return new Response(
          JSON.stringify({ error: data.error.message || "Groq API error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const content = data?.choices?.[0]?.message?.content?.trim() || "";
      return new Response(JSON.stringify({ result: content }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
