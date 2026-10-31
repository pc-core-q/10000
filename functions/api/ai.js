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
// نموذج «الإثراء» (بحث Google + مخطط JSON). الجمع بينهما موثّق لنماذج Gemini 3. غيّره بـ GEMINI_ENRICH_MODEL إن لم يتوفر لحسابك.
const DEFAULT_ENRICH_MODEL = "gemini-3.5-flash";

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

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || LIMITS.timeoutMs);
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

/* ------------------------------ إثراء المنتج ببحث Google (Gemini + Grounding) ------------------------------ */
async function geminiSearch(payload, env) {
  const key = (env.GEMINI_API_KEY || "").trim();
  if (!key) return fail(500, "GEMINI_API_KEY غير مضبوط في متغيرات بيئة Cloudflare.", "no_gemini_key");
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt || prompt.length > LIMITS.prompt) return fail(400, "نص التعليمات مفقود أو طويل جداً.", "bad_prompt");

  const schema = validSchema(payload.schema);
  const model = (env.GEMINI_ENRICH_MODEL || DEFAULT_ENRICH_MODEL).trim();
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const call = (useSchema) => fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      // لا نضبط temperature: وثائق Gemini 3 توصي بالقيمة الافتراضية
      generationConfig: useSchema ? { responseMimeType: "application/json", responseJsonSchema: schema } : { maxOutputTokens: 8192 }
    })
  }, 50000);

  let res, data;
  try {
    res = await call(!!schema);
    data = await res.json().catch(() => null);
    const msg0 = (data && data.error && data.error.message) || "";
    if (schema && res.status === 400 && /schema|response|mime/i.test(msg0)) {   // الجمع غير مدعوم ← نعتمد على الموجّه ونحلل JSON بأنفسنا
      res = await call(false);
      data = await res.json().catch(() => null);
    }
  } catch (e) {
    return fail(504, "انتهت مهلة البحث. أعد المحاولة.", "gemini_timeout");
  }
  if (!res.ok || !data || data.error) {
    const msg = (data && data.error && data.error.message) || "";
    if (res.status === 429) return fail(429, "تجاوزت حد الطلبات لدى Gemini. انتظر دقيقة ثم أعد المحاولة.", "gemini_error");
    if (res.status === 400 && /tool|search|ground/i.test(msg)) return fail(422, "النموذج «" + model + "» لا يدعم البحث في Google لحسابك. عيّن GEMINI_ENRICH_MODEL بنموذج يدعمه.", "no_grounding");
    return fail(502, msg || "خطأ من Gemini (" + res.status + ")", "gemini_error");
  }
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .filter(p => p && typeof p.text === "string" && !p.thought).map(p => p.text).join("");
  if (!text.trim()) return fail(502, "لم يرجع Gemini أي نتيجة.", "empty");
  const parsed = extractJson(text);
  if (!parsed || parsed.partial) return fail(502, "رد البحث ليس JSON صالحاً.", "bad_json");

  // المصادر الفعلية التي استند إليها البحث (لا ما يكتبه النموذج): إن لم توجد فالرد غير مُؤسَّس ولا يُعتمد
  const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const seen = new Set(), sources = [];
  chunks.forEach(c => {
    const w = c && c.web;
    if (w && typeof w.uri === "string" && !seen.has(w.uri) && sources.length < 6) { seen.add(w.uri); sources.push({ uri: w.uri, title: String(w.title || "").slice(0, 120) }); }
  });
  return ok({ ok: true, data: parsed.value, sources, grounded: sources.length > 0, model });
}

/* ------------------------------ إيجاد صورة المنتج من صفحات المصادر ------------------------------ */
// الخادم يختار رابط الصورة فقط ويتحقق منه؛ رفعها إلى ImgBB يتم من المتصفح عبر uploadToImgBB (ImgBB يقبل رابطاً مباشراً)
const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i;
function publicUrl(u) {
  let url;
  try { url = new URL(u); } catch (e) { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  const h = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(h) || h.startsWith("[") || h.includes(":")) return null;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  } else if (!h.includes(".")) return null;
  return url;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "ar,en;q=0.8"
};

// يتبع التحويلات يدوياً ويفحص كل قفزة (منع SSRF: لا شبكات داخلية ولا منافذ غريبة)
async function fetchPublic(startUrl, headers, ms) {
  let cur = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    const u = publicUrl(cur);
    if (!u) throw new Error("blocked_url");
    const res = await fetchWithTimeout(u.href, { method: "GET", redirect: "manual", headers: Object.assign({}, BROWSER_HEADERS, headers || {}) }, ms || 8000);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {} cur = new URL(loc, u.href).href; continue; }
    return { res, finalUrl: u.href };
  }
  throw new Error("too_many_redirects");
}

async function readTextCapped(res, maxBytes) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader(), dec = new TextDecoder("utf-8", { fatal: false });
  let out = "", total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length; out += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch (e) {}
  return out;
}

const BAD_IMG = /(logo|favicon|sprite|placeholder|blank|spacer|default[-_]?(image|share)|avatar|icon[-_.])/i;
function collectLdImages(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectLdImages(n, out)); return; }
  if (typeof node !== "object") return;
  const t = [].concat(node["@type"] || []).map(String);
  if (t.some(x => /product/i.test(x)) && node.image) {
    [].concat(node.image).forEach(im => { if (typeof im === "string") out.push(im); else if (im && typeof im.url === "string") out.push(im.url); });
  }
  if (node["@graph"]) collectLdImages(node["@graph"], out);
  if (node.mainEntity) collectLdImages(node.mainEntity, out);
}
function extractImageCandidates(html, baseUrl) {
  const raw = [];
  (html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []).forEach(block => {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try { collectLdImages(JSON.parse(body), raw); } catch (e) {}
  });
  (html.match(/<meta\s[^>]*>/gi) || []).forEach(tag => {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && content && /^(og:image(:secure_url)?|twitter:image(:src)?)$/i.test(key)) raw.push(content.replace(/&amp;/g, "&"));
  });
  const link = (html.match(/<link[^>]+rel=["']image_src["'][^>]*>/i) || [])[0];
  if (link) { const h = (link.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1]; if (h) raw.push(h); }
  const out = [], seen = new Set();
  raw.forEach(c => {
    let abs; try { abs = new URL(c, baseUrl).href; } catch (e) { return; }
    if (!publicUrl(abs) || BAD_IMG.test(abs) || seen.has(abs)) return;
    seen.add(abs); out.push(abs);
  });
  return out.slice(0, 6);
}

// يتأكد أن الرابط صورة حقيقية (jpeg/png/webp) بحجم معقول دون تنزيلها كاملة
async function verifyImage(url) {
  try {
    const { res } = await fetchPublic(url, { Range: "bytes=0-1023", Accept: "image/*" }, 8000);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const range = (res.headers.get("content-range") || "").match(/\/(\d+)$/);
    const total = range ? +range[1] : +(res.headers.get("content-length") || 0);
    try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {}
    if (!(res.status === 200 || res.status === 206)) return false;
    if (!/^image\/(jpeg|jpg|png|webp)/.test(ct)) return false;
    if (total && (total < 6000 || total > 15 * 1024 * 1024)) return false;      // أيقونات/شعارات صغيرة أو ملفات ضخمة
    return true;
  } catch (e) { return false; }
}

async function resolveImage(payload) {
  const urls = Array.isArray(payload.urls) ? payload.urls.filter(u => typeof u === "string").slice(0, 3) : [];
  if (!urls.length) return fail(400, "لا توجد روابط مصادر.", "no_urls");
  let verifications = 0;
  for (const pageUrl of urls) {
    let fetched;
    try { fetched = await fetchPublic(pageUrl, { Accept: "text/html,application/xhtml+xml,image/*" }, 9000); } catch (e) { continue; }
    const { res, finalUrl } = fetched;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {} continue; }
    if (ct.startsWith("image/")) {                       // الرابط نفسه صورة
      try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {}
      if (++verifications <= 8 && await verifyImage(finalUrl)) return ok({ ok: true, imageUrl: finalUrl, from: finalUrl });
      continue;
    }
    if (!/html/.test(ct)) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {} continue; }
    const html = await readTextCapped(res, 400000);
    for (const cand of extractImageCandidates(html, finalUrl)) {
      if (++verifications > 8) break;
      if (await verifyImage(cand)) return ok({ ok: true, imageUrl: cand, from: finalUrl });
    }
  }
  return fail(404, "لم أجد صورة صالحة في المصادر.", "no_image");
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
    if (action === "gemini_search") return await geminiSearch(payload, env);
    if (action === "resolve_image") return await resolveImage(payload);
    return fail(400, "إجراء غير معروف.", "bad_action");
  } catch (err) {
    return fail(500, "خطأ غير متوقع في الخادم.", "internal");
  }
}

export async function onRequest() {
  return fail(405, "الطريقة غير مسموحة. استخدم POST.", "method");
}
