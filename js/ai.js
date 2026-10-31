// js/ai.js — عميل الذكاء الاصطناعي في المتصفح (لوحة الأدمن فقط) — خالٍ تماماً من المفاتيح.
// القاعدة الذهبية هنا: «مخرجات النموذج بيانات غير موثوقة». كل ما يرجع منه يُنظَّف ويُتحقَّق منه
// (أرقام، روابط، أقسام، إجراءات) قبل أن تراه admin.js، ولا يُكتب شيء في Firebase إلا بعد تأكيد المدير.
const StoreAI = (() => {
  const CHUNK_ROWS = 40;            // عدد صفوف الجدول في الطلب الواحد (يمنع قطع الرد في الملفات الكبيرة)
  const MAX_IMAGE_SIDE = 2000;      // أكبر ضلع للصورة قبل الإرسال (أصغر حجماً وأسرع دون خسارة قراءة النص)
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_ITEMS = 1000;           // سقف أمان لعدد المنتجات في عملية استيراد واحدة
  // مفاتيح config.js: aiEnabled (افتراضي true) و aiBilingualNames (افتراضي true). غير معرّفة (اختبارات) ← الافتراضي.
  const cfg = () => (typeof STORE_CONFIG !== "undefined" && STORE_CONFIG) ? STORE_CONFIG : {};
  const aiEnabled = () => cfg().aiEnabled !== false;
  const bilingualNames = () => cfg().aiBilingualNames !== false;
  function assertEnabled() {
    if (!aiEnabled()) throw new Error("أدوات الذكاء الاصطناعي معطّلة لهذا المتجر (aiEnabled في config.js).");
  }

  // مخططات JSON: تُرسل للخادم فيُلزم Gemini/Groq بالشكل (والتنظيف في العميل يبقى كحماية ثانية)
  const STR = { type: "string" }, NULLABLE_STR = { type: ["string", "null"] }, NULLABLE_NUM = { type: ["number", "null"] };
  const INVOICE_SCHEMA = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: STR, category: STR, price: { type: "number" }, qty: { type: "integer" },
            barcode: NULLABLE_STR, colors: { type: "array", items: STR }, sizes: { type: "array", items: STR },
            description: STR, image: NULLABLE_STR
          },
          required: ["name", "category", "price", "qty", "barcode", "colors", "sizes", "description", "image"]
        }
      }
    },
    required: ["items"]
  };
  const SHELF_SCHEMA = {
    type: "object",
    properties: { products: { type: "array", items: { type: "object", properties: { name: STR, category: STR, box_2d: { type: "array", items: { type: "number" } } }, required: ["name", "category", "box_2d"] } } },
    required: ["products"]
  };
  const PRICE_SCHEMA = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["discount_percent", "discount_fixed", "increase_percent", "increase_fixed", "reset_discount", "unclear"] },
      value: { type: "number" }, category: NULLABLE_STR, minPrice: NULLABLE_NUM, maxPrice: NULLABLE_NUM, summary: STR
    },
    required: ["action", "value", "category", "minPrice", "maxPrice", "summary"],
    additionalProperties: false
  };

  // الأقسام قد تأتي أسماء (نص) أو كائنات {name, path}؛ المسار «الأب › الفرعي» يميّز قسمين بنفس الاسم تحت أبوين مختلفين
  const catLabel = c => cleanText(typeof c === "string" ? c : (c && (c.path || c.name)), 120);
  const PRICE_ACTIONS = ["discount_percent", "discount_fixed", "increase_percent", "increase_fixed", "reset_discount"];

  /* ------------------------------ أدوات التنظيف ------------------------------ */
  const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
                      "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

  function toAsciiDigits(s) { return String(s).replace(/[٠-٩۰-۹]/g, d => AR_DIGITS[d]); }

  // يحوّل "25,000" / "٢٥٬٠٠٠" / "18.5 د.ع" إلى رقم. غير الصالح ← 0 (لا NaN أبداً).
  function toNumber(v) {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
    if (v === null || v === undefined) return 0;
    const s = toAsciiDigits(v).replace(/[,،٬\s]/g, "").replace(/٫/g, ".");
    const m = s.match(/\d+(?:\.\d+)?/);
    const n = m ? parseFloat(m[0]) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function cleanText(v, max) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 200);
  }

  function toList(v, maxItems, maxLen) {
    const arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split(/[,،|/]/) : []);
    const out = [], seen = new Set();
    for (const x of arr) {
      const t = cleanText(x, maxLen || 40);
      const k = t.toLowerCase();
      if (t && !seen.has(k)) { seen.add(k); out.push(t); }
      if (out.length >= (maxItems || 20)) break;
    }
    return out;
  }

  function safeUrl(v) {
    if (!v) return null;
    const m = String(v).match(/https?:\/\/[^\s"'<>\u0000-\u001F]+/i);
    return m && m[0].length <= 1000 ? m[0] : null;
  }

  function normKey(s) {
    return toAsciiDigits(cleanText(s, 300)).toLowerCase()
      .replace(/[\u064B-\u0652\u0640]/g, "")          // التشكيل والتطويل
      .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  /* ------------------------------ تنظيف المنتجات المستخرجة ------------------------------ */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = cleanText(raw.name, 200);
    if (!name || name.length < 2) return null;
    const qtyRaw = raw.qty === undefined || raw.qty === null || raw.qty === "" ? 1 : Math.floor(toNumber(raw.qty));
    const barcode = cleanText(raw.barcode, 64).replace(/[^\p{L}\p{N}\-_.]/gu, "");
    return {
      name,
      category: cleanText(raw.category, 80),
      price: toNumber(raw.price),
      qty: Number.isFinite(qtyRaw) && qtyRaw >= 0 ? Math.min(qtyRaw, 1000000) : 1,
      barcode: barcode || null,
      colors: toList(raw.colors, 20, 30),
      sizes: toList(raw.sizes, 20, 30),
      description: cleanText(raw.description, 2000),
      image: safeUrl(raw.image)
    };
  }

  // يوحّد السطور المكررة (نفس الباركود أو الاسم) بدل إنشاء منتجين: تُجمع الكميات وتُدمج الألوان والمقاسات.
  function normalizeItems(list) {
    const out = [], index = new Map();
    let dropped = 0, merged = 0;
    for (const raw of (Array.isArray(list) ? list : [])) {
      const it = normalizeItem(raw);
      if (!it) { dropped++; continue; }
      const key = it.barcode ? "b:" + it.barcode : "n:" + normKey(it.name);
      const prev = index.get(key) || (it.barcode ? index.get("n:" + normKey(it.name)) : null);
      if (prev) {
        merged++;
        prev.qty += it.qty;
        prev.colors = toList(prev.colors.concat(it.colors), 20, 30);
        prev.sizes = toList(prev.sizes.concat(it.sizes), 20, 30);
        if (!prev.price && it.price) prev.price = it.price;
        if (!prev.description && it.description) prev.description = it.description;
        if (!prev.image && it.image) prev.image = it.image;
        if (!prev.barcode && it.barcode) prev.barcode = it.barcode;
        continue;
      }
      if (out.length >= MAX_ITEMS) { dropped++; continue; }
      index.set(key, it);
      out.push(it);
    }
    return { items: out, dropped, merged };
  }

  /* ------------------------------ الاتصال بالخادم ------------------------------ */
  async function getIdToken() {
    const user = (typeof firebase !== "undefined" && typeof firebase.auth === "function") ? firebase.auth().currentUser : null;
    if (!user) throw new Error("سجّل الدخول كأدمن أولاً لاستخدام الذكاء الاصطناعي.");
    return await user.getIdToken();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function callServerApi(action, payload, attempt = 0) {
    const token = await getIdToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000);
    let res;
    try {
      res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ action, payload }),
        signal: ctrl.signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("انتهت مهلة الذكاء الاصطناعي. جرّب ملفاً أصغر أو أعد المحاولة.");
      throw new Error("تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الإنترنت.");
    } finally { clearTimeout(timer); }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      if ((res.status === 404 || res.status === 405) && !data) {
        throw new Error("خدمة /api/ai غير موجودة على هذه الاستضافة. الذكاء الاصطناعي يعمل فقط عند النشر على Cloudflare Pages مع مجلد functions.");
      }
      if ((res.status === 429 || res.status === 502 || res.status === 504) && attempt < 1) {
        await sleep(2000);
        return callServerApi(action, payload, attempt + 1);
      }
      throw new Error((data && data.error) || ("خطأ في معالجة الذكاء الاصطناعي (" + res.status + ")"));
    }
    return data;
  }

  /* ------------------------------ 1) توليد الوصف ------------------------------ */
  function cleanDescription(s) {
    let t = String(s || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^\s*(الوصف|وصف المنتج)\s*[:：]\s*/u, "")
      .replace(/[*#`_>]+/g, "")
      .replace(/^["«“'\s]+|["»”'\s]+$/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    if (t.length > 500) {                     // لا نقطع منتصف جملة
      const cut = t.slice(0, 500);
      const last = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("،"), cut.lastIndexOf("!"), cut.lastIndexOf("؟"));
      t = last > 150 ? cut.slice(0, last + 1) : cut;
    }
    return t;
  }

  async function generateDescription(productName, categoryName = "") {
    assertEnabled();
    const name = cleanText(productName, 200);
    if (!name) throw new Error("اكتب اسم المنتج أولاً");
    const sys = [
      "أنت كاتب إعلانات لمتجر إلكتروني عراقي. اكتب بالعربية الفصحى المبسطة جملتين فقط (سطران) دون مقدمة أو خاتمة ودون عنوان.",
      "قواعد الدقة الصارمة:",
      "- اعتمد فقط على اسم المنتج والقسم المعطيين. ممنوع اختراع مكونات أو مقاسات أو سعات أو نسب أو ألوان أو بلد صنع أو ضمان أو شهادات.",
      "- ممنوع الادعاءات الطبية أو العلاجية (يعالج، يشفي، يمنع…) وممنوع المبالغات غير القابلة للإثبات (الأفضل في العالم، 100% مضمون).",
      "- إن كان الاسم غامضاً فاكتب وصفاً عاماً عن نوع المنتج واستخدامه دون تفاصيل مخترعة.",
      "- لا إيموجي، ولا علامات تنسيق، ولا ذكر للسعر."
    ].join("\n");
    const cat = cleanText(categoryName, 80);
    const prompt = "اسم المنتج: " + name + (cat ? "\nالقسم: " + cat : "") + "\nاكتب الوصف مباشرة:";
    const data = await callServerApi("groq_chat", { prompt, systemInstruction: sys, asJson: false });
    const text = cleanDescription(data.result);
    if (!text) throw new Error("لم يُنتج النموذج وصفاً صالحاً. أعد المحاولة.");
    return text;
  }

  /* ------------------------------ 2) أوامر التسعير ------------------------------ */
  function resolveCategoryName(wanted, categories) {
    const w = normKey(wanted);
    if (!w) return null;
    const list = (categories || []).map(c => {
      const label = catLabel(c);
      const leaf = label.split("›").pop();
      return { label, key: normKey(label), leaf: normKey(leaf) };
    }).filter(c => c.key);
    const exact = list.filter(c => c.key === w || c.leaf === w);
    if (exact.length === 1) return exact[0].label;
    if (exact.length > 1) return undefined;                 // نفس الاسم تحت أكثر من أب ← التباس: يُطلب المسار الكامل
    const partial = list.filter(c => c.key.includes(w) || w.includes(c.leaf));
    if (partial.length === 1) return partial[0].label;      // التطابق الجزئي مقبول فقط إن كان وحيداً (لا تخمين)
    return undefined;                                       // غير موجود أو ملتبس
  }

  function describePlan(plan) {
    const scope = plan.category ? "على قسم «" + plan.category + "» (وأقسامه الفرعية)" : "على كل الأقسام";
    const range = (plan.minPrice != null || plan.maxPrice != null)
      ? " للمنتجات التي سعرها" + (plan.minPrice != null ? " ≥ " + plan.minPrice.toLocaleString("en-US") : "") + (plan.maxPrice != null ? (plan.minPrice != null ? " و" : "") + " ≤ " + plan.maxPrice.toLocaleString("en-US") : "")
      : "";
    const act = {
      discount_percent: "خصم " + plan.value + "%",
      discount_fixed: "خصم مبلغ ثابت " + plan.value.toLocaleString("en-US"),
      increase_percent: "رفع الأسعار بنسبة " + plan.value + "%",
      increase_fixed: "رفع الأسعار بمبلغ ثابت " + plan.value.toLocaleString("en-US"),
      reset_discount: "إلغاء الخصومات وإرجاع السعر الأصلي"
    }[plan.action];
    return act + " " + scope + range;
  }

  // يتحقق من خطة التسعير القادمة من النموذج. أي التباس ← خطأ صريح بدل تنفيذ تخميني على كل المتجر.
  function normalizePricePlan(plan, categories) {
    if (!plan || typeof plan !== "object") throw new Error("لم أفهم أمر التسعير. أعد صياغته بوضوح.");
    if (plan.action === "unclear") throw new Error(cleanText(plan.summary, 200) || "الأمر غير واضح أو يحوي أكثر من عملية. نفّذ عملية واحدة في كل أمر.");
    if (!PRICE_ACTIONS.includes(plan.action)) throw new Error("لم أفهم نوع العملية المطلوبة (خصم/زيادة/إلغاء خصم).");

    let value = 0;
    if (plan.action !== "reset_discount") {
      value = toNumber(plan.value);
      if (value <= 0) throw new Error("لم أجد قيمة واضحة في الأمر (نسبة أو مبلغ).");
      if (plan.action === "discount_percent" && value > 90) throw new Error("نسبة الخصم " + value + "% مرتفعة جداً لتُنفَّذ بأمر نصي. عدّلها يدوياً إن كانت مقصودة.");
      if (plan.action === "increase_percent" && value > 300) throw new Error("نسبة الزيادة " + value + "% مرتفعة جداً. تحقق من الأمر.");
    }

    let category = null;
    const wanted = cleanText(plan.category, 100);
    if (wanted && !/^(null|none|all|الكل|كل الأقسام)$/i.test(wanted)) {
      const resolved = resolveCategoryName(wanted, categories);
      if (!resolved) throw new Error("لم أجد قسماً مطابقاً لـ «" + wanted + "» في متجرك، أو أن الاسم ينطبق على أكثر من قسم. اكتب اسم القسم كما هو. لم يُنفَّذ شيء.");
      category = resolved;
    }

    const minRaw = plan.minPrice === null || plan.minPrice === undefined ? 0 : toNumber(plan.minPrice);
    const maxRaw = plan.maxPrice === null || plan.maxPrice === undefined ? 0 : toNumber(plan.maxPrice);
    const minPrice = minRaw > 0 ? minRaw : null;
    const maxPrice = maxRaw > 0 ? maxRaw : null;
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new Error("الحد الأدنى للسعر أكبر من الحد الأعلى. راجع الأمر.");

    const clean = { action: plan.action, value, category, minPrice, maxPrice };
    clean.summary = describePlan(clean);      // الملخص يُبنى من الخطة المتحقَّق منها، لا من كلام النموذج (قد يناقض الفعل الحقيقي)
    return clean;
  }

  async function parsePriceCommand(commandText, categories = []) {
    assertEnabled();
    const cmd = cleanText(commandText, 500);
    if (!cmd) throw new Error("اكتب أمر التسعير أولاً");
    const names = (categories || []).map(catLabel).filter(Boolean);
    const sys = [
      "أنت محلل أوامر تسعير لمتجر. حوّل أمر المدير إلى JSON واحد فقط (بلا أي نص خارجه):",
      '{"action":"discount_percent|discount_fixed|increase_percent|increase_fixed|reset_discount|unclear","value":number,"category":string|null,"minPrice":number|null,"maxPrice":number|null,"summary":string}',
      "قواعد الدقة:",
      "- حدّد عملية واحدة فقط. إن احتوى الأمر أكثر من عملية أو كان غامضاً أو ليس أمر تسعير فأرجع action=\"unclear\" وفي summary سبب ذلك بجملة عربية قصيرة.",
      "- خصم/تخفيض/تنزيل ← discount. زيادة/رفع/غلاء ← increase. إلغاء الخصم/إرجاع السعر الأصلي ← reset_discount (value=0).",
      "- \"%\" أو \"بالمئة\" أو \"نسبة\" ← الصيغة percent وإلا فالصيغة fixed. value رقم موجب بأرقام لاتينية (٥٠٠٠ ← 5000).",
      "- الكلمات: \"ألف\"=1000 (\"5 آلاف\"=5000) و\"مليون\"=1000000 و\"نص/نصف\"=50% و\"ربع\"=25%.",
      "- category: انسخ القسم حرفياً من القائمة أدناه (الأقسام الفرعية بصيغة «الأب › الفرعي»؛ إن ذكر المدير قسماً فرعياً بأي صيغة فاكتب مساره الكامل من القائمة) إن ذكر قسماً يطابقها. إن ذكر قسماً غير موجود في القائمة فاكتب ما قاله كما هو (لا تستبدله بقسم آخر). إن لم يذكر قسماً فـ null. ممنوع تخمين قسم لم يُذكر.",
      "- minPrice/maxPrice فقط إذا حدد المدير نطاق سعر (مثل \"للمنتجات فوق 10000\" ← minPrice=10000)، وإلا null.",
      "الأقسام المتاحة: " + (names.length ? names.join("، ") : "(لا أقسام)")
    ].join("\n");
    const data = await callServerApi("groq_chat", { prompt: cmd, systemInstruction: sys, asJson: true, schema: PRICE_SCHEMA });
    return normalizePricePlan(data.data, names);
  }

  /* ------------------------------ 3) تجهيز الملفات ------------------------------ */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("تعذّر قراءة الملف"));
      r.readAsDataURL(blob);
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  // يصغّر صور الهاتف الضخمة قبل الإرسال (أسرع وأرخص وأقل عرضة لتجاوز الحد) ويرجع {base64, mimeType}.
  async function prepareImage(file) {
    if (!file) throw new Error("لم يتم اختيار صورة");
    if (file.size > 30 * 1024 * 1024) throw new Error("الصورة كبيرة جداً (أكثر من 30MB).");
    try {
      const img = await loadImage(file);
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);     // PNG الشفاف لا يتحول لأسود
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.9));
      if (!blob) throw new Error("encode");
      return { base64: await blobToBase64(blob), mimeType: "image/jpeg" };
    } catch (e) {
      // صيغة لا يفك المتصفح ترميزها (مثل HEIC خارج سفاري): نرسل الأصل إن كان صغيراً وإلا نطلب تحويله.
      if (file.size > MAX_FILE_BYTES) throw new Error("تعذّر تصغير الصورة وحجمها كبير. صوّرها بصيغة JPEG أو حوّلها.");
      return { base64: await blobToBase64(file), mimeType: (file.type || "image/jpeg").replace("image/jpg", "image/jpeg") };
    }
  }

  async function preparePdf(file) {
    if (!file) throw new Error("لم يتم اختيار ملف");
    if (file.size > MAX_FILE_BYTES) throw new Error("ملف PDF أكبر من 12MB. قسّمه إلى أجزاء.");
    return { base64: await blobToBase64(file), mimeType: "application/pdf" };
  }

  // تقسيم CSV إلى سجلات منطقية (يحترم الحقول المقتبسة التي تحوي أسطراً جديدة)
  function splitCsvRows(text) {
    const rows = [];
    let cur = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQ && text[i + 1] === '"') { cur += '""'; i++; continue; }
        inQ = !inQ; cur += ch; continue;
      }
      if (!inQ && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        if (cur.trim()) rows.push(cur);
        cur = ""; continue;
      }
      cur += ch;
    }
    if (cur.trim()) rows.push(cur);
    return rows;
  }

  /* ------------------------------ 4) قراءة الفواتير والجداول والصور ------------------------------ */
  function buildInvoicePrompt(storeCategories, isChunk) {
    const cats = (storeCategories || []).map(catLabel).filter(Boolean);
    const categoriesContext = cats.length
      ? "أقسام المتجر الحالية (الفرعي بصيغة «الأب › الفرعي»): [" + cats.join("، ") + "]. اختر لكل منتج أنسب قسم من هذه القائمة وانسخه حرفياً كما هو (بمساره كاملاً إن كان فرعياً)."
      : "";
    const nameRule = bilingualNames()
      ? "1. name (إلزامي): الاسم الأساسي بصيغة \"الاسم بالعربي / Name in English\". إن كان المصدر بلغة واحدة فاكتب مقابله بالأخرى (تعريب أو ترجمة أو الاسم التجاري المعروف) فقط إذا كنت متأكداً؛ وإن لم تكن متأكداً فاكتب الاسم كما ورد بلغته فقط ولا تخترع اسماً تجارياً. جرّد الاسم من الأحجام والسعات والألوان والمقاسات (لها حقولها)."
      : "1. name (إلزامي): الاسم الأساسي **كما ورد في المصدر وبلغته نفسها دون ترجمة أو تعريب أو إضافة لغة ثانية**. جرّد الاسم من الأحجام والسعات والألوان والمقاسات (لها حقولها).";
    return [
      "أنت نظام استخراج بيانات منتجات من المستندات. حلّل البيانات المرفقة (صورة أو PDF أو جدول) واستخرج المنتجات.",
      isChunk ? "ملاحظة: هذه دفعة من جدول أكبر؛ السطر الأول عناوين الأعمدة وبقية الأسطر منتجات." : "",
      categoriesContext,
      "",
      "قواعد الدقة (الأهم): استخرج فقط ما هو مكتوب فعلاً في المصدر. ممنوع اختراع أو تخمين سعر أو كمية أو باركود أو رابط أو وصف. الحقل غير الموجود يأخذ قيمته الافتراضية المذكورة أدناه.",
      "تجاهل أسطر المجاميع والضريبة والشحن والخصم العام وأرقام الصفحات والعناوين وأي سطر ليس منتجاً.",
      "المنتج الواحد يُرجَع مرة واحدة؛ فإن تكرر في عدة أسطر تختلف باللون/المقاس فقط فأرجعه مرة واحدة مع ألوانه/مقاساته وجمع كمياته.",
      "حوّل الأرقام العربية الهندية (٠١٢٣…) إلى لاتينية.",
      "",
      "الحقول لكل منتج:",
      nameRule,
      "2. category: لا تعتمد على عمود تصنيف قديم في الملف؛ استنتج من طبيعة المنتج واختر من قائمة أقسام المتجر. إن لم يناسب أي قسم فاكتب اسماً عربياً موجزاً مناسباً (مثل: المكياج، العناية بالبشرة، العطور، إلكترونيات، ملابس).",
      "3. colors: ألوان الشراء الحقيقية فقط (ملابس، درجات أحمر الشفاه، طلاء الأظافر، الأجهزة…) بكلمة نقية (\"أزرق فاتح\"، \"بيج\"). كلمات مثل شفاف/مائي/جل/سائل/عديم اللون/clear/transparent وصف للقوام وليست ألواناً؛ منتجات العناية بالبشرة والعطور والزيوت وما شابهها تكون colors=[] ما لم يوجد لون شراء حقيقي صريح.",
      "4. sizes: المقاسات/السعات/الأوزان المتاحة كخيارات (\"50ml\"، \"S\"، \"256GB\") وإلا [].",
      "5. image: رابط مباشر لصورة المنتج (يبدأ بـ http:// أو https://) إن وُجد صراحة في المصدر وإلا null.",
      "6. price: سعر بيع الوحدة (وليس إجمالي السطر ولا سعر الجملة إن وُجد عمود لسعر البيع) رقماً فقط بلا فواصل أو عملة. إن لم يتضح السعر فـ 0.",
      "7. qty: الكمية صحيحاً؛ إن لم تُذكر فـ 1.",
      "8. barcode: الباركود/كود المادة إن وُجد وإلا null.",
      "9. description: الوصف المكتوب في المصدر نقلاً حرفياً دون تلخيص أو تأليف؛ وإن لم يوجد \"\".",
      "",
      "أرجع JSON فقط بلا أي نص آخر:",
      '{"items":[{"name":"","category":"","price":0,"qty":1,"barcode":null,"colors":[],"sizes":[],"description":"","image":null}]}',
      'وإن لم تجد منتجات فأرجع {"items":[]}.'
    ].filter(l => l !== undefined).join("\n");
  }

  function readItems(resp) {
    const d = resp && resp.data;
    if (Array.isArray(d)) return d;
    return d && Array.isArray(d.items) ? d.items : [];
  }

  // inputData: نص CSV (mimeType = text/csv|text/plain) أو base64 لصورة/PDF.
  // يرجع { items, warnings[] } — العناصر منظّفة ومدموجة المكرر. opts.onProgress(done, total)
  async function scanInvoice(inputData, mimeType = "image/jpeg", storeCategories = [], opts = {}) {
    assertEnabled();
    const warnings = [];
    const isText = mimeType === "text/plain" || mimeType === "text/csv";
    let raw = [];

    if (isText) {
      const rows = splitCsvRows(String(inputData || ""));
      if (rows.length < 2) return { items: [], warnings };
      const header = rows[0], body = rows.slice(1);
      const chunks = [];
      for (let i = 0; i < body.length; i += CHUNK_ROWS) chunks.push(body.slice(i, i + CHUNK_ROWS));
      const prompt = buildInvoicePrompt(storeCategories, true);
      let lastError = null, failed = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (opts.onProgress) opts.onProgress(i, chunks.length);
        try {
          const resp = await callServerApi("gemini_vision", { prompt, fileText: [header].concat(chunks[i]).join("\n"), schema: INVOICE_SCHEMA });
          raw = raw.concat(readItems(resp));
          if (resp.partial) warnings.push("الدفعة " + (i + 1) + " من " + chunks.length + " قُطع ردها وقد تنقص بعض منتجاتها. راجع الصفوف المقابلة.");
        } catch (e) {
          failed++; lastError = e;
          warnings.push("فشلت الدفعة " + (i + 1) + " من " + chunks.length + " (صفوف " + (i * CHUNK_ROWS + 1) + "–" + Math.min((i + 1) * CHUNK_ROWS, body.length) + "): " + e.message);
        }
      }
      if (opts.onProgress) opts.onProgress(chunks.length, chunks.length);
      if (failed === chunks.length && lastError) throw lastError;
    } else {
      const mime = String(mimeType || "").toLowerCase().replace("image/jpg", "image/jpeg");
      if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(mime)) throw new Error("نوع الملف غير مدعوم. استخدم صورة (JPEG/PNG/WEBP) أو PDF.");
      const resp = await callServerApi("gemini_vision", { prompt: buildInvoicePrompt(storeCategories, false), base64Data: inputData, mimeType: mime, schema: INVOICE_SCHEMA });
      raw = readItems(resp);
      if (resp.partial) warnings.push("قُطع رد الذكاء الاصطناعي لكثرة المنتجات وقد تنقص بعضها. أعد المسح على أجزاء أصغر.");
    }

    const norm = normalizeItems(raw);
    if (norm.merged) warnings.push("تم دمج " + norm.merged + " سطر مكرر (نفس المنتج) وجمع كمياتها.");
    if (norm.dropped) warnings.push("تم تجاهل " + norm.dropped + " عنصراً غير صالح (بلا اسم واضح).");
    return { items: norm.items, warnings };
  }

  /* ------------------------------ 5) مسح الرف (غير مستعملة حالياً في admin.js) ------------------------------ */
  async function scanShelf(base64Image, mimeType = "image/jpeg") {
    assertEnabled();
    const prompt = [
      "حلل صورة الرف واكتشف كل منتج/عبوة منفصلة ظاهرة فعلاً. لا تخترع منتجات غير مرئية.",
      "لكل منتج: name (الاسم كما يُقرأ من العبوة)، category (قسم تقريبي)، box_2d = [ymin, xmin, ymax, xmax] بأرقام صحيحة من 0 إلى 1000.",
      'أرجع JSON فقط: {"products":[{"name":"","category":"","box_2d":[0,0,0,0]}]}'
    ].join("\n");
    const resp = await callServerApi("gemini_vision", { prompt, base64Data: base64Image, mimeType, schema: SHELF_SCHEMA });
    const d = resp.data;
    const list = d && Array.isArray(d.products) ? d.products : (Array.isArray(d) ? d : []);
    const products = [];
    for (const p of list) {
      const name = cleanText(p && p.name, 200);
      const b = p && Array.isArray(p.box_2d) ? p.box_2d.map(Number) : null;
      if (!name || !b || b.length !== 4 || b.some(n => !Number.isFinite(n))) continue;
      const [y1, x1, y2, x2] = b.map(n => Math.max(0, Math.min(1000, Math.round(n))));
      if (y2 <= y1 || x2 <= x1) continue;
      products.push({ name, category: cleanText(p.category, 80), box_2d: [y1, x1, y2, x2] });
    }
    return { products, partial: !!resp.partial };
  }

  const api = {
    generateDescription, parsePriceCommand, scanShelf, scanInvoice,
    prepareImage, preparePdf,
    // للاختبارات وللاستعمال من admin.js
    normalizeItems, normalizePricePlan, toNumber, splitCsvRows, cleanDescription, normKey, buildInvoicePrompt
  };
  return api;
})();

if (typeof window !== "undefined") window.StoreAI = StoreAI;
if (typeof module !== "undefined" && module.exports) module.exports = StoreAI;
