// js/ai.js — عميل المتصفح الآمن (خالٍ تماماً من المفاتيح)
const StoreAI = (() => {
  async function callServerApi(action, payload) {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `خطأ في المعالجة السحابية (${res.status})`);
    }

    return await res.json();
  }

  // 1) توليد الوصف التسويقي
  async function generateDescription(productName, categoryName = "") {
    if (!productName?.trim()) throw new Error("اكتب اسم المنتج أولاً");
    const sys = "أنت كاتب إعلانات تجاري محترف. اكتب وصفاً تسويقياً جذاباً وموجزاً جداً باللغة العربية (سطران فقط) بدون أي مقدمات أو خاتمة وبلا إيموجي مفرط.";
    const p = `اسم المنتج: ${productName.trim()}${categoryName ? `\nالقسم: ${categoryName}` : ""}\nاكتب الوصف التسويقي مباشرة:`;
    const data = await callServerApi("groq_chat", { prompt: p, systemInstruction: sys, asJson: false });
    return data.result;
  }

  // 2) معالجة أوامر تعديل الأسعار بالأوامر الطبيعية
  async function parsePriceCommand(commandText, categories = []) {
    const sys = `أنت محرك تسعير ذكي. حلل الأمر الطبيعي للمدير واستخرج عملية التسعير بصيغة JSON حصراً:
{
  "action": "discount_percent" | "discount_fixed" | "increase_percent" | "increase_fixed" | "reset_discount",
  "value": number,
  "category": "اسم القسم إن حُدد أو null لكل الأقسام",
  "minPrice": number أو null,
  "maxPrice": number أو null,
  "summary": "ملخص واضح لما سيتم باللغة العربية"
}
الأقسام المتاحة: ${categories.join("، ")}`;

    const data = await callServerApi("groq_chat", { prompt: commandText, systemInstruction: sys, asJson: true });
    return JSON.parse(data.result);
  }

  // 3) مسح الرف واكتشاف المنتجات وقصها مكانياً
  async function scanShelf(base64Image, mimeType = "image/jpeg") {
    const prompt = `حلل صورة الرف هذه واكتشف كل منتج/عبوة منفصلة معروضة على الرف. لكل منتج، أرجع اسمه المقترح وقسمه التقريبي، وصندوق الإحداثيات الدقيق box_2d بصيغة [ymin, xmin, ymax, xmax] بأرقام نسبية من 0 إلى 1000.
أرجع النتيجة حصراً كمصفوفة JSON:
{
  "products": [
    { "name": "اسم المنتج المقترح", "category": "القسم", "box_2d": [ymin, xmin, ymax, xmax] }
  ]
}`;
    return await callServerApi("gemini_vision", { prompt, base64Data: base64Image, mimeType });
  }

  // 4) قراءة وتفريغ القوائم والفواتير وسكرين شوتس الشات
  async function scanInvoice(base64Image, mimeType = "image/jpeg") {
    const prompt = `أنت نظام استخراج وتفريغ بيانات تجارية فائق الدقة (Data Extraction OCR).
حلل الصورة المرفقة (وصل شراء، فاتورة، قائمة بضائع، أو لقطة شاشة Screenshot تحتوي منتجات مع تفاصيلها).
استخرج لكل منتج المعلومات التالية بدقة متناهية والتزام كامل:
- name: الاسم التجاري الأساسي النظيف للمنتج فقط (Base Clean Name)، مجرداً تماماً من أي سعة، حجم، وزن، مقاس، أو لون (أمثلة: "Samsung Galaxy S24 Ultra", "سيروم هيالورونيك لاروش", "هودي أوفر سايز").
- category: القسم أو التصنيف المقترح للمنتج بكلمة أو كلمتين (مثال: هواتف، إلكترونيات، عناية بالبشرة، ملابس، مواد غذائية).
- price: سعر البيع أو السعر المفرد كرقم فقط (إن لم يوجد سعر فضعه 0).
- qty: الكمية الإجمالية كرقم صحيح (إن لم تذكر ضع 1).
- barcode: الباركود أو كود المادة إن وجد وإلا null.
- colors: مصفوفة بأسماء الألوان المتاحة للمنتج إن ذكرت (مثال: ["أسود", "أبيض"])، وإن لم تذكر أي ألوان ضع [].
- sizes: مصفوفة بجميع المقاسات أو الأحجام أو السعات أو الأوزان المذكورة للمنتج (مثال: ["128GB", "256GB"] أو ["50ml", "100ml"] أو ["S", "M", "L"])، وإن لم تذكر ضع [].
- description: انقل الوصف المكتوب وتفاصيل ومواصفات المنتج بالكامل نصياً كما هي في الصورة دون أي تلخيص أو حذف أو تأليف من عندك، واذكر فيها الحجم والوزن إن كتب. إذا لم يكن هناك أي وصف أو تفاصيل مكتوبة فاجعله نصاً فارغاً "".
- image: رابط الصورة المباشر (URL يبدأ بـ http) إن وجد مكتوباً صراحة في الصورة، وإلا null.

أرجع النتيجة حصراً بصيغة JSON:
{
  "items": [
    {
      "name": "الاسم التجاري الأساسي النظيف",
      "category": "القسم المقترح",
      "price": 0,
      "qty": 1,
      "barcode": null,
      "colors": [],
      "sizes": [],
      "description": "",
      "image": null
    }
  ]
}`;
    return await callServerApi("gemini_vision", { prompt, base64Data: base64Image, mimeType });
  }

  return {
    generateDescription,
    parsePriceCommand,
    scanShelf,
    scanInvoice
  };
})();

window.StoreAI = StoreAI;
