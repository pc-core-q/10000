// functions/api/ai.js — وسيط الذكاء الاصطناعي (Cloudflare Pages Functions)
// ------------------------------------------------------------------------------------
// • المفاتيح تبقى هنا فقط (متغيرات بيئة Cloudflare) ولا تصل للمتصفح أبداً.
// • الطلب مقصور على الأدمن: يجب إرسال Firebase ID Token في ترويسة Authorization،
//   ويُتحقق منه عبر Google ثم تُطابَق الإيميل مع ADMIN_EMAILS.  بدون ذلك أي زائر
//   كان يستطيع استهلاك رصيد Gemini/Groq (الثغرة التي أُغلقت هنا).
// • المتغيرات المطلوبة في Cloudflare ← Pages ← Settings ← Environment variables:
//     GEMINI_API_KEY   مفتاح Google AI Studio
//     GROQ_API_KEY     مفتاح Groq
//     FIREBASE_API_KEY نفس firebaseApiKey الموجود في js/config.js (للتحقق من الدخول فقط)
//     ADMIN_EMAILS     إيميلات الأدمن مفصولة بفاصلة (نفس adminEmails في config.js)
//   اختيارية: GEMINI_MODEL و GROQ_MODEL لتغيير النموذج دون تعديل الكود.

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";

const LIMITS = {
  prompt: 40000,          // أحرف
  systemInstruction: 8000,
  fileText: 150000,       // أحرف (دفعة CSV واحدة أصغر بكثير — العميل يقطّع الملفات الكبيرة)
  base64: 18000000,       // ≈ 13.5MB فعلياً؛ حد Gemini للطلب المضمَّن 20MB
  timeoutMs: 55000
};
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"
]);

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const fail = (status, error, code) => new Response(JSON.stringify({ error, code: code || "error" }), { status, headers: HEADERS });

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.timeoutMs);
  try { return await fetch(url, Object.assign({}, init, { signal: ctrl.signal })); }
  finally { clearTimeout(timer); }
}

/* ------------------------------ التحقق من الأدمن ------------------------------ */
async function requireAdmin(request, env) {
  const apiKey = (env.FIREBASE_API_KEY || "").trim();
  const admins = (env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!apiKey || !admins.length) {
    return { error: fail(500, "إعداد ناقص: أضف FIREBASE_API_KEY و ADMIN_EMAILS في متغيرات بيئة Cloudflare ثم أعد النشر.", "auth_not_configured") };
  }
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!m) return { error: fail(401, "يلزم تسجيل الدخول كأدمن لاستخدام الذكاء الاصطناعي.", "no_token") };

  let res;
  try {
    res = await fetchWithTimeout(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(apiKey),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: m[1] }) }
    );
  } catch (e) {
    return { error: fail(502, "تعذّر التحقق من الدخول (مهلة الاتصال بـ Google).", "auth_unreachable") };
  }
  if (!res.ok) return { error: fail(401, "انتهت جلسة الدخول. سجّل الدخول من جديد.", "bad_token") };
  const data = await res.json().catch(() => ({}));
  const user = data && data.users && data.users[0];
  const email = user && user.email ? String(user.email).toLowerCase() : "";
  if (!email || !admins.includes(email)) return { error: fail(403, "هذا الحساب غير مصرّح له باستخدام الذكاء الاصطناعي.", "not_admin") };
  return { email };
}

/* ------------------------------ أدوات JSON ------------------------------ */
function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")      // وسم مفتوح بلا إغلاق (قُطع الرد)
    .trim();
}
function stripFences(text) {
  return String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}
function tryParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

// إنقاذ JSON مقطوع (بلغ حد الإخراج): نقصّ عند آخر عنصر مكتمل داخل المصفوفة ونغلق الأقواس.
function salvageJson(text) {
  const stack = [];
  let inStr = false, esc = false, safe = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length >= 2) safe = { i, open: stack.slice() };   // ما زلنا داخل الجذر والمصفوفة
    }
  }
  if (!safe) return undefined;
  const closers = safe.open.reverse().map(c => (c === "{" ? "}" : "]")).join("");
  return tryParse(text.slice(0, safe.i + 1) + closers);
}

function extractJson(raw) {
  const text = stripFences(stripThinking(raw));
  let v = tryParse(text);
  if (v !== undefined) return { value: v, partial: false };
  const a = text.search(/[\[{]/);
  const b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) {
    v = tryParse(text.slice(a, b + 1));
    if (v !== undefined) return { value: v, partial: false };
  }
  v = salvageJson(a >= 0 ? text.slice(a) : text);
  if (v !== undefined) return { value: v, partial: true };
  return null;
}

// مخطط JSON (JSON Schema) اختياري يرسله العميل ليأتي الرد مطابقاً للشكل المطلوب من المصدر بدل الاعتماد على التنظيف بعد الوصول.
function validSchema(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try { return JSON.stringify(v).length <= 8000 ? v : null; } catch (e) { return null; }
}

/* ------------------------------ Gemini (الصور والملفات) ------------------------------ */
async function geminiVision(payload, env) {
  const key = (env.GEMINI_API_KEY || "").trim();
  if (!key) return fail(500, "GEMINI_API_KEY غير مضبوط في متغيرات بيئة Cloudflare.", "no_gemini_key");

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt || prompt.length > LIMITS.prompt) return fail(400, "نص التعليمات مفقود أو طويل جداً.", "bad_prompt");

  const parts = [{ text: prompt }];
  if (typeof payload.fileText === "string" && payload.fileText) {
    if (payload.fileText.length > LIMITS.fileText) return fail(413, "الجدول كبير جداً لدفعة واحدة. قسّمه إلى ملفات أصغر.", "too_big");
    parts.push({ text: "\n\n--- بيانات الملف (CSV؛ السطر الأول عناوين الأعمدة) ---\n" + payload.fileText });
  } else if (typeof payload.base64Data === "string" && payload.base64Data) {
    const mime = String(payload.mimeType || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return fail(400, "نوع الملف غير مدعوم (المسموح: JPEG/PNG/WEBP/HEIC وPDF).", "bad_mime");
    if (payload.base64Data.length > LIMITS.base64) return fail(413, "الملف كبير جداً (الحد الأقصى ≈13MB).", "too_big");
    parts.push({ inlineData: { mimeType: mime, data: payload.base64Data } });
  } else {
    return fail(400, "لم يُرسل أي ملف أو بيانات للتحليل.", "no_input");
  }

  const model = (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const schema = validSchema(payload.schema);
  const callGemini = (useSchema) => fetchWithTimeout(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },   // المفتاح في الترويسة لا في الرابط
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: Object.assign(
          { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 32768 },
          useSchema ? { responseJsonSchema: schema } : {}
        )
      })
    }
  );
  let res, data;
  try {
    res = await callGemini(!!schema);
    data = await res.json().catch(() => null);
    // نموذج/نسخة لا تقبل المخطط ← نعيد بدونه (يبقى التنظيف في العميل) بدل فشل العملية كلها
    if (schema && res.status === 400 && /schema|response/i.test((data && data.error && data.error.message) || "")) {
      res = await callGemini(false);
      data = await res.json().catch(() => null);
    }
  } catch (e) {
    return fail(504, "انتهت مهلة Gemini. جرّب ملفاً أصغر أو أعد المحاولة.", "gemini_timeout");
  }

  if (!res.ok || !data || data.error) {
    const status = res.status === 429 ? 429 : 502;
    const msg = res.status === 429 ? "تجاوزت حد الطلبات لدى Gemini. انتظر دقيقة ثم أعد المحاولة." : ((data && data.error && data.error.message) || "خطأ من Gemini (" + res.status + ")");
    return fail(status, msg, "gemini_error");
  }
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    return fail(422, "رفض Gemini تحليل هذا المحتوى (" + data.promptFeedback.blockReason + ").", "blocked");
  }
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .filter(p => p && typeof p.text === "string" && !p.thought)
    .map(p => p.text).join("");
  if (!text.trim()) return fail(502, "لم يرجع Gemini أي نتيجة. أعد المحاولة بصورة أوضح.", "empty");

  const parsed = extractJson(text);
  if (!parsed) return fail(502, "رد الذكاء الاصطناعي ليس JSON صالحاً. أعد المحاولة.", "bad_json");
  const truncated = !!(cand && cand.finishReason === "MAX_TOKENS");
  return ok({ ok: true, data: parsed.value, partial: parsed.partial || truncated });
}

/* ------------------------------ Groq (النصوص) ------------------------------ */
async function groqChat(payload, env) {
  const key = (env.GROQ_API_KEY || "").trim();
  if (!key) return fail(500, "GROQ_API_KEY غير مضبوط في متغيرات بيئة Cloudflare.", "no_groq_key");

  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt || prompt.length > LIMITS.prompt) return fail(400, "النص مفقود أو طويل جداً.", "bad_prompt");
  const system = typeof payload.systemInstruction === "string" && payload.systemInstruction.length <= LIMITS.systemInstruction
    ? payload.systemInstruction : "أنت مساعد دقيق لإدارة المتاجر. لا تخترع معلومات.";
  const asJson = payload.asJson === true;

  const model = (env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();
  const body = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    temperature: asJson ? 0 : 0.5,
    max_tokens: 2048,
    // Qwen 3.8 يعمل افتراضياً بوضع «التفكير» وتفكيره يستهلك max_tokens فيُقطع الرد أو يخرج فارغاً/ملوثاً بـ <think>.
    // مهامنا قصيرة ومحدّدة فنستعمل الوضع المباشر.
    reasoning_effort: "none"
  };
  const schema = asJson ? validSchema(payload.schema) : null;
  if (asJson) {
    body.response_format = schema
      ? { type: "json_schema", json_schema: { name: "result", schema } }
      : { type: "json_object" };
  }

  const call = () => fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(body)
  });

  let res;
  try {
    res = await call();
    for (let i = 0; i < 2 && res.status === 400; i++) {   // رفض بارامتر غير مدعوم ← أعد بدونه (بحد أقصى مرتان)
      const peek = await res.clone().json().catch(() => null);
      const msg = (peek && peek.error && peek.error.message) || "";
      if (/reasoning/i.test(msg) && body.reasoning_effort) delete body.reasoning_effort;
      else if (/schema|response_format/i.test(msg) && body.response_format && body.response_format.type === "json_schema") body.response_format = { type: "json_object" };
      else break;
      res = await call();
    }
  } catch (e) {
    return fail(504, "انتهت مهلة Groq. أعد المحاولة.", "groq_timeout");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    const status = res.status === 429 ? 429 : 502;
    const msg = res.status === 429 ? "تجاوزت حد الطلبات لدى Groq. انتظر قليلاً ثم أعد المحاولة." : ((data && data.error && data.error.message) || "خطأ من Groq (" + res.status + ")");
    return fail(status, msg, "groq_error");
  }

  const choice = data.choices && data.choices[0];
  const text = stripThinking(choice && choice.message && choice.message.content);
  if (!text) return fail(502, "لم يرجع النموذج أي نص. أعد المحاولة.", "empty");
  if (choice.finish_reason === "length") return fail(502, "قُطع رد النموذج لطوله. اختصر الأمر وأعد المحاولة.", "truncated");

  if (asJson) {
    const parsed = extractJson(text);
    if (!parsed || parsed.partial) return fail(502, "رد النموذج ليس JSON صالحاً. أعد صياغة الأمر.", "bad_json");
    return ok({ ok: true, result: text, data: parsed.value });
  }
  return ok({ ok: true, result: text });
}

/* ------------------------------ نقطة الدخول ------------------------------ */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;

    let body;
    try { body = await request.json(); } catch (e) { return fail(400, "جسم الطلب ليس JSON.", "bad_body"); }
    const action = body && body.action;
    const payload = body && body.payload && typeof body.payload === "object" ? body.payload : {};

    if (action === "gemini_vision") return await geminiVision(payload, env);
    if (action === "groq_chat") return await groqChat(payload, env);
    return fail(400, "إجراء غير معروف.", "bad_action");
  } catch (err) {
    return fail(500, "خطأ غير متوقع في الخادم.", "internal");
  }
}

export async function onRequest() {
  return fail(405, "الطريقة غير مسموحة. استخدم POST.", "method");
}
