/* اختبار متصفح حقيقي (اختياري): node tests/browser-enrich.js
   يحمّل js/ai.js و js/admin.js الحقيقيين في Chrome بدون واجهة، مع Store وfetch وهميين، ثم يمرّر منتجات عبر
   الإثراء ← بطاقات المراجعة ← الحفظ ويفحص DOM وما يُكتب في المتجر. يحتاج puppeteer-core ومتصفح Chrome:
     PUPPETEER_CORE=/path/to/puppeteer-core  CHROME_PATH=/path/to/chrome  (يتخطى الاختبار إن لم يوجدا) */
const fs = require("fs"), path = require("path"), assert = require("assert");
const guess = (c) => c.find(p => p && fs.existsSync(p));
const PUP = process.env.PUPPETEER_CORE || guess(["/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core"]);
const CHROME = process.env.CHROME_PATH || guess(["/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]);
if (!PUP || !CHROME) { console.log("تخطّي: puppeteer-core/Chrome غير متوفرين (اختبار اختياري)."); process.exit(0); }
const puppeteer = require(PUP);
const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e && e.message || e)); } };

const STUBS = `
  window.STORE_CONFIG = { imgbbApiKey: "k", imageKitEndpoint: "https://ik.example", aiEnabled: true, aiEnrich: true, aiEnrichMax: 40, aiBilingualNames: true };
  window.firebase = { auth: () => ({ currentUser: { getIdToken: async () => "tok" } }) };
  window.toasts = [];
  window.showToast = (m, k) => window.toasts.push([k, m]);
  window.iconSvg = () => "<i></i>";
  window.Store = {
    _cats: [{ id: "c1", name: "العناية بالشعر", parentId: "" }, { id: "c2", name: "العناية بالبشرة", parentId: "" }],
    _products: [], _added: [], _n: 0,
    getCategories() { return this._cats; }, getAdminProducts() { return this._products; }, getProducts() { return this._products; },
    canWriteNode: () => true, canWriteProducts: () => true, ensureAllProductsFresh: async () => {},
    addProduct(p) { p.id = "new" + (++this._n); this._added.push(JSON.parse(JSON.stringify(p))); this._products.push(p); return p; },
    addCategory(c) { c.id = "cat" + (++this._n); this._cats.push(c); return c; },
    saveProducts: async () => true, isProductAvailable: () => true, getTotalStock: () => 0, getCategoryName: () => "", saveCalls: 0
  };
  window.bumpMetaVersion = () => {};
  window.fetchLog = [];
  const SOURCES = [{ uri: "https://vertexaisearch.cloud.google.com/x", title: "bounty.example" }];
  window.fetch = async (url, init) => {
    const u = String(url); const json = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
    if (u.startsWith("https://api.imgbb.com/")) { window.fetchLog.push("imgbb:" + (init.body.get("image"))); return json({ success: true, data: { url: "https://i.ibb.co/abc/p.jpg" } }); }
    if (u === "/api/ai") {
      const b = JSON.parse(init.body); window.fetchLog.push(b.action);
      if (b.action === "gemini_search") {
        const p = b.payload.prompt;
        const base = { found: true, confidence: "high", officialName: "", brand: "", productType: "", category: "", suggestedCategory: "", description: "", colors: [], sizes: [] };
        if (p.includes("شامبو باونتي")) return json({ ok: true, grounded: true, sources: SOURCES, data: Object.assign(base, { officialName: "شامبو باونتي / Bounty Shampoo", category: "العناية بالشعر", description: "شامبو يغذّي الشعر.", colors: ["ذهبي"], sizes: ["400ml"] }) });
        return json({ ok: true, grounded: false, sources: [], data: Object.assign(base, { found: false }) });
      }
      if (b.action === "resolve_image") return json({ ok: true, imageUrl: "https://cdn.shop.example/p.jpg" });
    }
    return json({ error: "unexpected " + u }, 500);
  };
  window.confirm = () => true;
`;
const DOM = `
  <div id="shelfScanModal" style="display:none"><h3 id="batchModalTitle"></h3><span id="shelfScanStatus"></span>
    <input type="checkbox" id="batchSelectAll"><span id="batchSelectedCounter"></span><div id="shelfDetectedList"></div>
    <button id="closeShelfScanModal"></button><button id="btnCancelShelfScan"></button><button id="btnSaveShelfProducts">حفظ</button></div>
  <button id="btnCompleteMissing">إكمال</button>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setContent("<!doctype html><html dir='rtl'><body>" + DOM + "</body></html>");
  await page.evaluate(STUBS);
  await page.addScriptTag({ path: path.join(root, "js", "app.js") }).catch(() => {});   // escapeHtml/safeUrl الحقيقيان إن حُمّل بلا أخطاء
  await page.evaluate(() => { if (typeof escapeHtml !== "function") { window.escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); window.safeUrl = u => /^https?:/i.test(u) ? u : "#"; } });
  await page.addScriptTag({ path: path.join(root, "js", "ai.js") });
  await page.addScriptTag({ path: path.join(root, "js", "admin.js") });
  await page.evaluate(() => { wireSmartMediaScanner(); wireCompleteMissing(); });

  console.log("استيراد ← إثراء ← مراجعة (DOM حقيقي)");
  await page.evaluate(() => enrichAndOpen([
    { name: "شامبو باونتي 400مل", category: "", price: 5000, qty: 10, barcode: "111", colors: [], sizes: [], description: "", image: null },
    { name: "منتج مجهول 77", category: "", price: 2000, qty: 3, barcode: null, colors: [], sizes: [], description: "", image: null }
  ], "اختبار الاستيراد", ["تحذير تجريبي"]));
  const cards = () => page.$$eval(".shelf-item-card", els => els.map(c => ({
    name: c.querySelector(".shelf-item-name").value, cat: c.querySelector(".shelf-item-category").value,
    price: c.querySelector(".shelf-item-price").value, stock: c.querySelector(".shelf-item-stock").value,
    colors: c.querySelector(".shelf-item-colors").value, sizes: c.querySelector(".shelf-item-sizes").value,
    desc: c.querySelector(".shelf-item-desc").value, img: (c.querySelector(".shelf-item-img") || {}).src || "",
    crop: c.querySelector(".shelf-item-check").getAttribute("data-crop"), badge: (c.querySelector(".shelf-enrich-box") || {}).innerText || ""
  })));
  let cs;
  await t("تُفتح النافذة ببطاقتين وتظهر التحذيرات في الرأس", async () => {
    cs = await cards();
    assert.strictEqual(cs.length, 2);
    const status = await page.$eval("#shelfScanStatus", e => e.textContent);
    assert.ok(status.includes("تحذير تجريبي"), status);
    assert.strictEqual(await page.$eval("#shelfScanModal", e => e.style.display), "flex");
  });
  await t("المنتج المعروف: وصف وألوان ومقاسات وقسم وصورة (ImgBB←ImageKit) وشارة ثقة عالية", async () => {
    const c = cs[0];
    assert.strictEqual(c.name, "شامبو باونتي 400مل");
    assert.strictEqual(c.cat, "c1"); assert.strictEqual(c.price, "5000"); assert.strictEqual(c.stock, "10");
    assert.strictEqual(c.colors, "ذهبي"); assert.strictEqual(c.sizes, "400ml"); assert.strictEqual(c.desc, "شامبو يغذّي الشعر.");
    assert.strictEqual(c.crop, "https://ik.example/tr:w-900,q-85,f-webp/abc/p.jpg");
    assert.ok(c.img.includes("ik.example"));
    assert.ok(c.badge.includes("ثقة عالية") && c.badge.includes("الاسم الرسمي المقترح") && c.badge.includes("سيُوزَّع المخزون"), c.badge);
    const log = await page.evaluate(() => window.fetchLog);
    assert.ok(log.includes("imgbb:https://cdn.shop.example/p.jpg"), "ImgBB استلم الرابط: " + JSON.stringify(log));
  });
  await t("المنتج المجهول: بلا بيانات مخترعة، وشارة «لم يُعثر»", async () => {
    const c = cs[1];
    assert.strictEqual(c.desc, ""); assert.strictEqual(c.colors, ""); assert.strictEqual(c.sizes, ""); assert.strictEqual(c.crop, "");
    assert.ok(c.badge.includes("لم يُعثر"), c.badge);
  });
  await t("زر «استخدمه» يضع الاسم الرسمي في الحقل", async () => {
    await page.click(".btn-use-official");
    assert.strictEqual((await cards())[0].name, "شامبو باونتي / Bounty Shampoo");
  });

  console.log("\nالحفظ");
  await t("الحفظ يكتب المنتجين صحيحين: الاسم الرسمي، الصورة، المصفوفة، المخزون بمجموع 10، بلا صورة للمجهول", async () => {
    await page.click("#btnSaveShelfProducts");
    await page.waitForFunction(() => window.Store._added.length === 2, { timeout: 8000 });
    const added = await page.evaluate(() => window.Store._added);
    const a = added.find(p => p.barcode === "111"), b = added.find(p => p.price === 2000);
    assert.strictEqual(a.name, "شامبو باونتي / Bounty Shampoo");
    assert.strictEqual(a.categoryId, "c1"); assert.strictEqual(a.image, "https://ik.example/tr:w-900,q-85,f-webp/abc/p.jpg");
    assert.deepStrictEqual(a.sizes, ["400ml"]); assert.strictEqual(a.colors[0].name, "ذهبي");
    assert.deepStrictEqual(a.inventory, { "ذهبي||400ml": 10 }); assert.strictEqual(a.stock, 10);
    assert.strictEqual(a.description, "شامبو يغذّي الشعر.");
    assert.strictEqual(b.image, ""); assert.strictEqual(b.stock, 3); assert.strictEqual(b.categoryId, "");
    assert.ok(!(await page.evaluate(() => window.toasts)).some(x => x[0] === "error"), JSON.stringify(await page.evaluate(() => window.toasts)));
  });

  console.log("\nإكمال البيانات الناقصة للمنتجات الموجودة");
  await t("يجمع الناقص فقط (بلا وصف/صورة)، الكمية الواردة 0، والمنتج الكامل لا يُمسّ", async () => {
    await page.evaluate(() => {
      window.fetchLog.length = 0;
      document.getElementById("shelfDetectedList").innerHTML = "";
      window.Store._products = [
        { id: "p1", name: "شامبو باونتي 250مل", categoryId: "c1", price: 3000, stock: 5, description: "", image: "", barcode: "" },
        { id: "p2", name: "منتج كامل", categoryId: "c2", price: 100, stock: 1, description: "وصف", image: "https://x.example/a.jpg" }
      ];
      document.getElementById("btnCompleteMissing").click();
    });
    await page.waitForFunction(() => document.querySelectorAll(".shelf-item-card").length === 1, { timeout: 8000 });
    const c = (await cards())[0];
    assert.strictEqual(c.name, "شامبو باونتي 250مل"); assert.strictEqual(c.stock, "0"); assert.strictEqual(c.cat, "c1");
    assert.strictEqual(c.desc, "شامبو يغذّي الشعر.");
    const existing = await page.$eval(".shelf-item-card", e => e.getAttribute("data-existing-id"));
    assert.strictEqual(existing, "p1");
    const searches = (await page.evaluate(() => window.fetchLog)).filter(x => x === "gemini_search").length;
    assert.strictEqual(searches, 1);
  });
  await t("لا أخطاء JavaScript غير ملتقطة في الصفحة", () => assert.deepStrictEqual(errors, []));

  await browser.close();
  console.log("\nالنتيجة: " + pass + " نجح، " + fail + " فشل");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
