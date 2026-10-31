/* اختبار تكاملي لإثراء المنتجات: node tests/enrich-tests.js
   يربط عميل المتصفح (js/ai.js) بخادم /api/ai الحقيقي (functions/api/ai.js) ويحاكي Gemini والمتاجر والصور بـ fetch وهمي.
   لا يتصل بالإنترنت. يتحقق من: التأسيس على مصادر، رفض التخمين، SSRF، استخراج الصورة، قاعدة الأقسام، شارات المراجعة. */
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { pathToFileURL } = require("url");
let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  ✓ " + name); }, (e) => { fail++; console.log("  ✗ " + name + "\n      " + (e && e.stack || e)); });

const outbound = [];            // كل طلب خارجي حاول الخادم إرساله
let geminiMode = "normal";
const GOOD_SOURCES = [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "bounty.example" } },
                      { web: { uri: "https://shop.example/logo-page", title: "shop.example" } }];

function html(body, status = 200, headers = {}) { return new Response(body, { status, headers: Object.assign({ "content-type": "text/html; charset=utf-8" }, headers) }); }
function img(total, type = "image/jpeg") { return new Response(new Uint8Array(16), { status: 206, headers: { "content-type": type, "content-range": "bytes 0-15/" + total } }); }

function geminiAnswer(prompt) {
  const grounded = (obj, chunks = GOOD_SOURCES) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] }, groundingMetadata: { groundingChunks: chunks } }] });
  const base = { found: true, confidence: "high", officialName: "", brand: "", productType: "", category: "", suggestedCategory: "", description: "", colors: [], sizes: [] };
  if (prompt.includes("شامبو باونتي")) return grounded(Object.assign(base, { officialName: "شامبو باونتي / Bounty Shampoo", brand: "Bounty", productType: "شامبو", category: "العناية بالشعر", description: "شامبو يغذّي الشعر ويمنحه لمعاناً.", colors: ["شفاف", "ذهبي"], sizes: ["400ml"] }));
  if (prompt.includes("منتج مجهول")) return grounded(Object.assign(base, { found: false, confidence: "low" }), []);
  if (prompt.includes("كريم مشكوك")) return grounded(Object.assign(base, { confidence: "low", description: "وصف غير موثوق", colors: ["أحمر"] }));
  if (prompt.includes("منتج مخترع")) return grounded(Object.assign(base, { description: "وصف من الذاكرة", colors: ["أزرق"] }), []);        // found=true لكن بلا مصادر بحث
  if (prompt.includes("أحمر شفاه ماركة")) return grounded(Object.assign(base, { officialName: "Brand Lipstick", category: "", suggestedCategory: "مكياج", description: "أحمر شفاه.", colors: ["أحمر"] }));
  return grounded(base, []);
}

function router(url, init) {
  const u = String(url);
  if (u === "/api/ai") {
    const req = { headers: { get: (h) => (h === "Authorization" ? (router.token === null ? null : "Bearer " + (router.token || "good")) : null) }, json: async () => JSON.parse(init.body) };
    return router.server.onRequestPost({ request: req, env: router.env });
  }
  outbound.push(u);
  if (u.includes("identitytoolkit")) return new Response(JSON.stringify({ users: [{ email: "admin@shop.com" }] }), { status: 200 });
  if (u.includes("generativelanguage")) {
    const body = JSON.parse(init.body);
    router.lastGemini = body;
    if (geminiMode === "no_grounding") return new Response(JSON.stringify({ error: { message: "google_search tool is not supported for this model" } }), { status: 400 });
    if (geminiMode === "schema_reject" && body.generationConfig.responseJsonSchema) return new Response(JSON.stringify({ error: { message: "responseJsonSchema not allowed with tools" } }), { status: 400 });
    return new Response(JSON.stringify(geminiAnswer(body.contents[0].parts[0].text)), { status: 200 });
  }
  if (u.startsWith("https://vertexaisearch.cloud.google.com/")) return new Response(null, { status: 302, headers: { location: "https://shop.example/p/bounty" } });
  if (u === "https://shop.example/p/bounty") return html(`<html><head>
      <meta property="og:image" content="/img/og-bounty.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Bounty","image":["https://cdn.shop.example/products/bounty-400.jpg"]}]}</script></head></html>`);
  if (u === "https://shop.example/logo-page") return html(`<meta property="og:image" content="https://shop.example/assets/logo.png">`);
  if (u === "https://evil.example/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } });
  if (u === "https://cdn.shop.example/products/bounty-400.jpg") return img(54000);
  if (u === "https://shop.example/img/og-bounty.jpg") return img(2000);                // صغيرة جداً (أيقونة)
  if (u.includes("notimage")) return html("<p>no</p>", 200);
  return new Response("not found", { status: 404 });
}

(async () => {
  // تحميل الخادم الحقيقي كوحدة ESM
  const tmp = path.join(os.tmpdir(), "ai_server_test_" + process.pid + ".mjs");
  fs.copyFileSync(path.join(__dirname, "..", "functions", "api", "ai.js"), tmp);
  router.server = await import(pathToFileURL(tmp).href);
  router.env = { FIREBASE_API_KEY: "k", ADMIN_EMAILS: "admin@shop.com", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" };
  global.fetch = async (u, i) => router(u, i);
  global.firebase = { auth: () => ({ currentUser: { getIdToken: async () => "good" } }) };
  const AI = require(path.join(__dirname, "..", "js", "ai.js"));
  const cats = ["العناية بالشعر", "العناية بالبشرة"];
  const call = (action, payload, token) => { router.token = token; return fetch("/api/ai", { method: "POST", body: JSON.stringify({ action, payload }) }).then(async r => [r.status, await r.json()]); };

  console.log("الخادم: resolve_image (أمان + اختيار الصورة)");
  await t("يرفض بلا توكن", async () => { const [st] = await call("resolve_image", { urls: ["https://shop.example/p/bounty"] }, null); assert.strictEqual(st, 401); router.token = undefined; });
  await t("SSRF: عناوين داخلية/localhost/منافذ غريبة لا تُجلب أبداً", async () => {
    outbound.length = 0;
    const [st, body] = await call("resolve_image", { urls: ["http://169.254.169.254/latest/meta-data", "http://localhost:8080/", "https://10.0.0.5/x", "http://[::1]/", "https://shop.example:8443/x", "ftp://shop.example/a"] });
    assert.strictEqual(st, 404); assert.strictEqual(body.code, "no_image");
    assert.deepStrictEqual(outbound.filter(u => /169\.254|localhost|10\.0\.0\.5|::1|8443|^ftp/.test(u)), []);
  });
  await t("SSRF عبر تحويل: صفحة عامة تحوّل إلى 127.0.0.1 ← تُحجب القفزة", async () => {
    outbound.length = 0;
    const [st] = await call("resolve_image", { urls: ["https://evil.example/redirect"] });
    assert.strictEqual(st, 404);
    assert.ok(!outbound.some(u => u.includes("127.0.0.1")));
  });
  await t("يتبع تحويل Google ثم يختار صورة JSON-LD للمنتج ويتجاوز og:image الصغيرة", async () => {
    const [st, body] = await call("resolve_image", { urls: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"] });
    assert.strictEqual(st, 200);
    assert.strictEqual(body.imageUrl, "https://cdn.shop.example/products/bounty-400.jpg");
  });
  await t("صفحة شعار فقط ← لا صورة (لا نضع شعاراً مكان المنتج)", async () => {
    const [st] = await call("resolve_image", { urls: ["https://shop.example/logo-page"] });
    assert.strictEqual(st, 404);
  });

  console.log("\nالخادم: gemini_search");
  await t("يرجع المصادر الفعلية من groundingMetadata ويرسل أداة البحث + المخطط", async () => {
    const [st, body] = await call("gemini_search", { prompt: "شامبو باونتي 400مل", schema: { type: "object", properties: {} } });
    assert.strictEqual(st, 200); assert.strictEqual(body.grounded, true); assert.strictEqual(body.sources.length, 2);
    assert.deepStrictEqual(router.lastGemini.tools, [{ google_search: {} }]);
    assert.ok(router.lastGemini.generationConfig.responseJsonSchema);
    assert.strictEqual(router.lastGemini.generationConfig.temperature, undefined);
  });
  await t("رفض الجمع بين المخطط والأداة ← يعيد بدون مخطط ويحلل JSON", async () => {
    geminiMode = "schema_reject";
    const [st, body] = await call("gemini_search", { prompt: "شامبو باونتي 400مل", schema: { type: "object", properties: {} } });
    geminiMode = "normal";
    assert.strictEqual(st, 200); assert.strictEqual(body.data.found, true);
    assert.ok(!router.lastGemini.generationConfig.responseJsonSchema);
  });
  await t("نموذج بلا بحث ← خطأ no_grounding بنص واضح", async () => {
    geminiMode = "no_grounding";
    const [st, body] = await call("gemini_search", { prompt: "شامبو باونتي" });
    geminiMode = "normal";
    assert.strictEqual(st, 422); assert.strictEqual(body.code, "no_grounding"); assert.ok(body.error.includes("GEMINI_ENRICH_MODEL"));
  });

  console.log("\nالعميل + الخادم: enrichItems");
  const uploads = [];
  const opts = { uploadImage: async (u) => { uploads.push(u); return "https://ik.example/tr:w-900/abc.jpg"; } };
  const mk = (name) => ({ name, category: "", price: 5000, qty: 7, barcode: "123", colors: [], sizes: [], description: "", image: null });
  let result;
  await t("منتج معروف: يكمل الوصف والألوان والمقاسات والقسم والصورة ولا يمس الاسم والسعر والكمية", async () => {
    result = await AI.enrichItems([mk("شامبو باونتي 400مل")], cats, opts);
    const it = result.items[0];
    assert.strictEqual(it.name, "شامبو باونتي 400مل");
    assert.strictEqual(it.price, 5000); assert.strictEqual(it.qty, 7); assert.strictEqual(it.barcode, "123");
    assert.strictEqual(it.description, "شامبو يغذّي الشعر ويمنحه لمعاناً.");
    assert.deepStrictEqual(it.colors, ["ذهبي"]);                       // «شفاف» حُذف (وصف قوام لا لون)
    assert.deepStrictEqual(it.sizes, ["400ml"]);
    assert.strictEqual(it.category, "العناية بالشعر");
    assert.strictEqual(it.image, "https://ik.example/tr:w-900/abc.jpg");
    assert.deepStrictEqual(uploads, ["https://cdn.shop.example/products/bounty-400.jpg"]);
    assert.strictEqual(it.enriched.state, "high"); assert.strictEqual(it.enriched.webImage, true);
    assert.strictEqual(it.enriched.officialName, "شامبو باونتي / Bounty Shampoo");
    assert.strictEqual(it.enriched.addedVariants, true);
    assert.ok(it.enriched.sources.length >= 1);
  });
  await t("منتج غير موجود (found=false): يُترك فارغاً، بلا صورة، مع تحذير", async () => {
    uploads.length = 0;
    const r = await AI.enrichItems([mk("منتج مجهول 77")], cats, opts);
    const it = r.items[0];
    assert.strictEqual(it.description, ""); assert.deepStrictEqual(it.colors, []); assert.strictEqual(it.image, null);
    assert.strictEqual(it.enriched.state, "notfound"); assert.strictEqual(uploads.length, 0);
    assert.ok(r.warnings.some(w => w.includes("لم يُعثر عليه")));
  });
  await t("ثقة منخفضة: لا يملأ وصفاً ولا ألواناً (حفاظاً على الدقة)", async () => {
    const r = await AI.enrichItems([mk("كريم مشكوك")], cats, opts);
    const it = r.items[0];
    assert.strictEqual(it.description, ""); assert.deepStrictEqual(it.colors, []); assert.strictEqual(it.enriched.state, "low");
    assert.ok(r.warnings.some(w => w.includes("ثقة منخفضة")));
  });
  await t("هلوسة: found=true لكن بلا مصادر بحث فعلية ← يُرفض كأنه غير موجود", async () => {
    const r = await AI.enrichItems([mk("منتج مخترع")], cats, opts);
    const it = r.items[0];
    assert.strictEqual(it.description, ""); assert.deepStrictEqual(it.colors, []); assert.strictEqual(it.enriched.state, "notfound");
  });
  await t("لا قسم مطابق: يقترح قسماً بنوع المنتج (للإنشاء عند المراجعة)", async () => {
    const r = await AI.enrichItems([mk("أحمر شفاه ماركة")], cats, opts);
    assert.strictEqual(r.items[0].category, "مكياج");
  });
  await t("لا يستبدل ما كتبه التاجر: الوصف واللون الموجودان يبقيان", async () => {
    const it0 = Object.assign(mk("شامبو باونتي 400مل"), { description: "وصف التاجر", colors: ["أسود"], image: "https://x.example/a.jpg" });
    const r = await AI.enrichItems([it0], cats, opts);
    assert.strictEqual(r.items[0].description, "وصف التاجر"); assert.deepStrictEqual(r.items[0].colors, ["أسود"]);
    assert.strictEqual(r.items[0].image, "https://x.example/a.jpg");
  });
  await t("skip يتجاوز الكامل، والحد aiEnrichMax يقتصر على العدد مع تحذير", async () => {
    let calls = 0;
    const before = outbound.filter(u => u.includes("generativelanguage")).length;
    global.STORE_CONFIG = { aiEnrichMax: 2 };
    const items = ["شامبو باونتي 1", "شامبو باونتي 2", "شامبو باونتي 3", "شامبو باونتي 4"].map(mk);
    const r = await AI.enrichItems(items, cats, Object.assign({ skip: it => it.name.endsWith("4") }, opts));
    delete global.STORE_CONFIG;
    calls = outbound.filter(u => u.includes("generativelanguage")).length - before;
    assert.strictEqual(calls, 2);
    assert.ok(r.warnings.some(w => w.includes("أول 2")));
    assert.ok(!r.items[3].enriched);
  });
  await t("aiEnrich:false ← لا أي طلب", async () => {
    const before = outbound.length;
    global.STORE_CONFIG = { aiEnrich: false };
    const r = await AI.enrichItems([mk("شامبو باونتي")], cats, opts);
    delete global.STORE_CONFIG;
    assert.strictEqual(outbound.length, before); assert.ok(!r.items[0].enriched);
  });
  await t("نموذج بلا بحث: يتوقف بتحذير واحد (لا يكرر الطلبات الفاشلة) ويبقي المنتجات كما هي", async () => {
    geminiMode = "no_grounding";
    const before = outbound.filter(u => u.includes("generativelanguage")).length;
    const items = Array.from({ length: 12 }, (_, i) => mk("شامبو باونتي " + i));
    const r = await AI.enrichItems(items, cats, opts);
    geminiMode = "normal";
    const calls = outbound.filter(u => u.includes("generativelanguage")).length - before;
    assert.ok(calls <= 4, "calls=" + calls);
    assert.strictEqual(r.warnings.filter(w => w.startsWith("توقف الإثراء")).length >= 1, true);
    assert.ok(r.items.every(it => it.name.startsWith("شامبو باونتي") && !it.description));
  });
  await t("الموجّه: يطلب الترتيب (نوع ← ماركة ← اقتراح) ويحوي الأقسام بمساراتها وقاعدة عدم التخمين", () => {
    const p = AI.buildEnrichPrompt(mk("شامبو"), ["رجالي", "رجالي › أحذية"]);
    assert.ok(p.includes("رجالي › أحذية") && p.includes("قسم باسم ماركة المنتج") && p.includes("لا تخمّن"));
    global.STORE_CONFIG = { aiBilingualNames: false };
    const p2 = AI.buildEnrichPrompt(mk("شامبو"), []);
    delete global.STORE_CONFIG;
    assert.ok(p2.includes("دون ترجمة"));
  });

  console.log("\nلوحة الأدمن: شارات المراجعة");
  const app = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const adminSrc = fs.readFileSync(path.join(__dirname, "..", "js", "admin.js"), "utf8");
  const grab = (src, n) => { const m = src.match(new RegExp("function " + n + "\\b[\\s\\S]*?\\n}\\n")); assert.ok(m, n); return m[0]; };
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(["escapeHtml", "safeUrl"].map(n => grab(app, n)).join("\n") + ["cleanNameForMatch", "enrichBadgesHtml", "findExistingFor"].map(n => grab(adminSrc, n)).join("\n") + ";this.api={enrichBadgesHtml,findExistingFor}", ctx);
  await t("الشارات تهرّب النصوص (اسم رسمي/مصدر خبيث) وتعرض الثقة والتنبيهات", () => {
    const h = ctx.api.enrichBadgesHtml({ name: "شامبو", enriched: { state: "medium", officialName: '<img src=x onerror=alert(1)>', sources: [{ uri: "javascript:alert(1)", title: "<b>x</b>" }], webImage: true, addedVariants: true } });
    assert.ok(!h.includes("<img src=x") && !h.includes("<b>x</b>") && !/href="javascript:/i.test(h));
    assert.ok(h.includes("ثقة متوسطة") && h.includes("الصورة من الإنترنت") && h.includes("سيُوزَّع المخزون"));
    assert.strictEqual(ctx.api.enrichBadgesHtml({ name: "x" }), "");
  });
  await t("findExistingFor: بالباركود ثم بالاسم الموحَّد", () => {
    const ex = [{ id: "1", name: "كريم مرطبة", barcode: "" }, { id: "2", name: "حذاء", sku: "999" }];
    assert.strictEqual(ctx.api.findExistingFor({ name: "كريم مرطبه" }, ex).id, "1");
    assert.strictEqual(ctx.api.findExistingFor({ name: "شيء آخر", barcode: "999" }, ex).id, "2");
    assert.strictEqual(ctx.api.findExistingFor({ name: "لا شيء" }, ex), undefined);
  });

  fs.unlinkSync(tmp);
  console.log("\nالنتيجة: " + pass + " نجح، " + fail + " فشل");
  process.exit(fail ? 1 : 0);
})();
