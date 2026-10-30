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

  // 4) المسح الذكي الشامل (PDF، إكسل، وصولات ورقية، سكرين شوتس)
  async function scanInvoice(inputData, mimeType = "image/jpeg", storeCategories = []) {
    const categoriesContext = storeCategories.length 
      ? `أقسام المتجر الحالية المتاحة هي: [${storeCategories.join("، ")}]. يجب عليك اختيار أفضل قسم مطابق من هذه القائمة لكل منتج بناءً على فهمك لطبيعته وسياقه.` 
      : "";

    const prompt = `أنت نظام استخراج وتفريغ بيانات تجارية فائق الدقة (Data Extraction AI Engine).
حلل البيانات المرفقة بدقة بالغة (سواء كانت صورة، لقطة شاشة، مستند PDF إلكتروني، أو جدول بيانات).
${categoriesContext}

التعليمات الصارمة الإلزامية لاستخراج كل منتج:
1. name (إلزامي):
   - يجب أن يكون اسم المنتج دائماً باللغتين العربية والإنجليزية معاً بصيغة: "الاسم بالعربي / Name in English" (مثال: "شارلوت تلبوري هوليوود فلوليس فلتر / Charlotte Tilbury Hollywood Flawless Filter").
   - حتى لو كان الاسم في الملف مكتوباً بالعربية فقط، استخرج أو اكتب الاسم التجاري الرسمي الإنجليزي للمنتج وأضفه بجانبه.
   - حتى لو كان الاسم في الملف بالإنجليزية فقط، اكتب الاسم المعرب والشائع له بالعربية بجانبه.
   - جرد الاسم الأساسي تماماً من أي أحجام أو سعات أو ألوان أو مقاسات (توضع في حقولها الخاصة).

2. category (إلزامي):
   - لا تعتمد نهائياً على أي عمود تصنيف أو قسم قديم مكتوب في الملف.
   - استنتج القسم بنفسك من سياق المنتج وطبيعته واستخدامه، واختر أفضل مطابقة من قائمة أقسام المتجر المتاحة أعلاه. إذا لم تجد قسماً مطابقاً تماماً، اكتب اسماً مناسباً وموجزاً باللغة العربية (مثل: المكياج، العناية بالبشرة، العطور، إلكترونيات، ملابس).

3. colors (دقة فائقة للألوان):
   - مصفوفة بأسماء الألوان الحقيقية المتاحة للمنتج كخيارات شراء (مثل: الملابس، درجات أحمر الشفاه، ألوان طلاء الأظافر، ألوان الأجهزة).
   - تنبيه استبعاد صارم: منتجات العناية بالبشرة، السيروم، المرطبات، الغسولات، الزيوت، والعطور؛ إذا ذُكر في وصفها أنها (شفافة، مائية، عديمة اللون، جيل، سائل، clear، transparent)، فهذا وصف للقوام الفيزيائي وليس لوناً! يُمنع منعاً باتاً كتابة "شفاف" أو "مائي" أو اعتبارها لوناً، ويجب أن يكون حقل colors مصفوفة فارغة [] تماماً.
   - عند وجود لون حقيقي، استخرج اسم اللون بكلمة نقية ومباشرة (مثل: "أزرق فاتح"، "وردي"، "بيج"، "أسود") دون إلحاق صفات مثل "مائي" أو "شفاف".

4. sizes:
   - مصفوفة بجميع المقاسات أو السعات أو الأحجام أو الأوزان (مثال: ["10ml", "30ml"] أو ["50g"] أو ["S", "M", "L"])، وإلا [].

5. image:
   - ابحث بدقة عن أي رابط مباشر لصورة المنتج (URL يبدأ بـ http:// أو https://) سواء كان في عمود مخصص، أو رابط تشعبي، أو في تفاصيل المنتج.
   - ضعه كاملاً وبدقة في حقل image. إذا لم يوجد أي رابط للمنتج ضع null.

6. price:
   - سعر البيع أو السعر المفرد كرقم فقط بدون فواصل أو رموز عملات (مثال: 25000 أو 18.5). إذا لم يوجد سعر ضع 0.

7. qty:
   - الكمية الإجمالية كرقم صحيح (إن لم تذكر ضع 1).

8. barcode:
   - كود المادة أو الباركود إن وجد، وإلا null.

9. description:
   - انقل الوصف والمواصفات والمميزات المكتوبة بالكامل نصياً دون أي تلخيص أو اختصار أو تأليف. إذا لم يوجد وصف فاجعله نصاً فارغاً "".

أرجع النتيجة حصراً بصيغة JSON بدون أي هوامش أو نصوص إضافية:
{
  "items": [
    {
      "name": "الاسم بالعربي / Name in English",
      "category": "اسم القسم",
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

    if (mimeType === "text/plain" || mimeType === "text/csv") {
      return await callServerApi("gemini_vision", { prompt, fileText: inputData });
    }

    return await callServerApi("gemini_vision", { prompt, base64Data: inputData, mimeType });
  }

  return {
    generateDescription,
    parsePriceCommand,
    scanShelf,
    scanInvoice
  };
})();

window.StoreAI = StoreAI;
