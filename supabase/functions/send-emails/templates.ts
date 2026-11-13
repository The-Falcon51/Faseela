// Faseela e-mail templates (bilingual AR/EN). Pure functions: no I/O, no secrets. Imported by index.ts.
const APP_URL = (Deno.env.get("APP_URL") ?? "https://gen-lang-client-0319369264.web.app").replace(/\/$/, "");

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function money(minor: unknown, currency: unknown): string {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return "";
  return `${(amount / 100).toFixed(2)} ${escapeHtml(currency || "USD")}`;
}

function when(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
}

function liters(ml: unknown): string {
  const n = Number(ml);
  return Number.isFinite(n) ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, "")} L` : "";
}

function kindAr(kind: unknown): string {
  return ({ delivery: "تسليم إلى العنوان", pickup: "استلام من المعصرة", donate: "تبرع" } as Record<string, string>)[String(kind)] ?? escapeHtml(kind);
}

function kindEn(kind: unknown): string {
  return ({ delivery: "home delivery", pickup: "pickup at the mill", donate: "donation" } as Record<string, string>)[String(kind)] ?? escapeHtml(kind);
}

function shortId(id: unknown): string {
  return escapeHtml(String(id ?? "").slice(0, 10)).toUpperCase();
}

export type Rendered = { subject: string; ar: string; en: string; cta?: { label_ar: string; label_en: string; href: string } };

export function render(template: string, p: Record<string, unknown>): Rendered {
  const tree = escapeHtml(p.treeId);
  const amount = money(p.amountMinor, p.currency);
  const note = p.note ? `<br><em>${escapeHtml(p.note)}</em>` : "";
  const dash = { label_ar: "فتح لوحة التحكم", label_en: "Open dashboard", href: `${APP_URL}/` };
  switch (template) {
    case "reservation_created":
      return {
        subject: "حجزك قيد الانتظار · Your reservation is waiting for payment",
        ar: `تم حجز ${escapeHtml(p.shareCount)} حصة في الشجرة ${tree}${p.includesLand ? " مع قطعة الأرض" : ""}. المبلغ: <strong>${amount}</strong>. يرجى رفع إشعار التحويل قبل <strong>${when(p.expiresAt)}</strong>، وإلا يُلغى الحجز تلقائياً. رقم الطلب: ${shortId(p.requestId)}.`,
        en: `You reserved ${escapeHtml(p.shareCount)} share(s) of tree ${tree}${p.includesLand ? " including the land parcel" : ""}. Amount: <strong>${amount}</strong>. Upload your transfer receipt before <strong>${when(p.expiresAt)}</strong>, otherwise the reservation is released automatically. Request ${shortId(p.requestId)}.`,
        cta: dash,
      };
    case "proof_received":
      return {
        subject: "استلمنا إشعار الدفع · We received your payment receipt",
        ar: `استلمنا إشعار الدفع لطلبك ${shortId(p.requestId)} (الشجرة ${tree}، ${amount}). سيراجعه فريق المالية خلال 72 ساعة؛ ستصلك رسالة بالنتيجة.`,
        en: `We received the payment receipt for request ${shortId(p.requestId)} (tree ${tree}, ${amount}). Finance reviews it within 72 hours; you will get the result by e-mail.`,
        cta: dash,
      };
    case "payment_approved":
      return {
        subject: "تم اعتماد حصتك · Your share is confirmed",
        ar: `تم اعتماد الدفع واعتمدت حصتك: ${escapeHtml(p.shareCount)} حصة في الشجرة ${tree} (${amount}). تظهر الآن في محفظتك.${note}`,
        en: `Your payment was approved and your share is confirmed: ${escapeHtml(p.shareCount)} share(s) of tree ${tree} (${amount}). It now appears in your portfolio.${note}`,
        cta: dash,
      };
    case "payment_rejected":
      return {
        subject: "لم نتمكن من اعتماد الدفع · We could not confirm your payment",
        ar: `لم نتمكن من اعتماد إشعار الدفع لطلبك ${shortId(p.requestId)} (الشجرة ${tree}، ${amount}). أُلغي الحجز.${note}<br>يمكنك إنشاء طلب جديد ورفع إشعار واضح.`,
        en: `We could not confirm the payment receipt for request ${shortId(p.requestId)} (tree ${tree}, ${amount}). The reservation was released.${note}<br>You can create a new request and upload a clear receipt.`,
        cta: dash,
      };
    case "reservation_expired":
      return {
        subject: "انتهت مهلة الحجز · Your reservation expired",
        ar: `انتهت مهلة الدفع لطلبك ${shortId(p.requestId)} (الشجرة ${tree}، ${amount}) وأُعيدت الحصص إلى السوق. يمكنك الحجز مجدداً في أي وقت.`,
        en: `The payment window for request ${shortId(p.requestId)} (tree ${tree}, ${amount}) has closed and the shares are back on the marketplace. You can reserve again at any time.`,
        cta: dash,
      };
    case "review_needed":
      return {
        subject: `مراجعة مطلوبة · Review needed: ${escapeHtml(p.queue)}`,
        ar: `يوجد عنصر جديد بانتظار المراجعة في قائمة <strong>${escapeHtml(p.queue)}</strong>${p.amountMinor ? ` (${amount})` : ""}${tree ? ` · الشجرة ${tree}` : ""}.`,
        en: `A new item is waiting in the <strong>${escapeHtml(p.queue)}</strong> queue${p.amountMinor ? ` (${amount})` : ""}${tree ? ` · tree ${tree}` : ""}.`,
        cta: { label_ar: "فتح مكتب الموافقات", label_en: "Open approvals desk", href: `${APP_URL}/` },
      };
    case "review_overdue":
      return {
        subject: "مراجعات متأخرة · Overdue payment reviews",
        ar: `${escapeHtml(p.count)} طلب(ات) دفع تجاوزت مهلة المراجعة (72 ساعة). يرجى المعالجة اليوم.`,
        en: `${escapeHtml(p.count)} payment request(s) exceeded the 72-hour review SLA. Please process them today.`,
        cta: dash,
      };
    case "role_approved":
      return {
        subject: "تم اعتماد طلب الدور · Your role application was approved",
        ar: `تم اعتماد طلبك للدور <strong>${escapeHtml(p.requestedRole)}</strong>. سجّل الدخول للوصول إلى بوابتك.${note}`,
        en: `Your application for the role <strong>${escapeHtml(p.requestedRole)}</strong> was approved. Sign in to access your portal.${note}`,
        cta: dash,
      };
    case "role_rejected":
      return {
        subject: "طلب الدور · Your role application",
        ar: `لم يُعتمد طلبك للدور <strong>${escapeHtml(p.requestedRole)}</strong> في الوقت الحالي.${note}`,
        en: `Your application for the role <strong>${escapeHtml(p.requestedRole)}</strong> was not approved at this time.${note}`,
      };
    case "farmer_update_published":
      return {
        subject: "نُشر تقريرك الميداني · Your field report was published",
        ar: `نُشر تقريرك (${escapeHtml(p.eventType)}) للشجرة ${tree} للمستثمرين.${note}`,
        en: `Your field report (${escapeHtml(p.eventType)}) for tree ${tree} is now visible to investors.${note}`,
      };
    case "farmer_update_rejected":
      return {
        subject: "تقريرك الميداني يحتاج إلى تعديل · Your field report needs changes",
        ar: `لم يُنشر تقريرك (${escapeHtml(p.eventType)}) للشجرة ${tree}.${note}`,
        en: `Your field report (${escapeHtml(p.eventType)}) for tree ${tree} was not published.${note}`,
      };
    case "batch_certified":
      return {
        subject: "اعتُمدت دفعة العصر · Pressing batch certified",
        ar: `اعتُمدت دفعة العصر للشجرة ${tree}. رقم الشهادة: <strong>${escapeHtml(p.certificateSerial)}</strong>.${note}`,
        en: `The pressing batch for tree ${tree} was certified. Certificate: <strong>${escapeHtml(p.certificateSerial)}</strong>.${note}`,
      };
    case "batch_rejected":
      return {
        subject: "دفعة العصر لم تُعتمد · Pressing batch not certified",
        ar: `لم تُعتمد دفعة العصر للشجرة ${tree}.${note}`,
        en: `The pressing batch for tree ${tree} was not certified.${note}`,
      };
    case "onboarding_one":
      return {
        subject: "كيف تعمل فسيلة · How Faseela works",
        ar: `أهلاً بك في فسيلة. كل شجرة زيتون مقسّمة إلى 4 حصص؛ تحجز حصتك، تحوّل المبلغ، ترفع إشعار التحويل، ويعتمده فريق المالية خلال 72 ساعة. بعدها تتابع شجرتك من الحقل إلى المعصرة مع تقارير مصوّرة وشهادات عصر معتمدة.`,
        en: `Welcome to Faseela. Every olive tree is split into 4 shares: reserve yours, transfer the amount, upload the receipt, and Finance confirms it within 72 hours. From then on you follow your tree from the grove to the mill with photo reports and certified pressing batches.`,
        cta: { label_ar: "تصفّح الأشجار", label_en: "Browse trees", href: `${APP_URL}/#marketplace` },
      };
    case "onboarding_three":
      return {
        subject: "ماذا يحدث بعد الحجز · What happens after you reserve",
        ar: `الحجز يحتفظ بالحصة لمدة 30 دقيقة حتى ترفع إشعار التحويل، ثم تبقى قيد المراجعة حتى يعتمدها فريق المالية. كل خطوة تصلك برسالة. لا رسوم خفية، والسعر الذي تراه في السوق هو السعر النهائي.`,
        en: `A reservation holds the share for 30 minutes until you upload the transfer receipt; it then stays under review until Finance confirms it. You get an e-mail at every step. No hidden fees — the marketplace price is the final price.`,
        cta: { label_ar: "تصفّح الأشجار", label_en: "Browse trees", href: `${APP_URL}/#marketplace` },
      };
    case "onboarding_seven":
      return {
        subject: "هل لديك سؤال؟ · Any questions before your first tree?",
        ar: `مرّ أسبوع على انضمامك ولم تحجز شجرتك الأولى بعد. إن كان لديك سؤال عن الدفع أو الأرض أو تقارير الحقل، أجب على هذه الرسالة وسنرد عليك شخصياً.`,
        en: `It has been a week since you joined and you have not reserved your first tree yet. If you have a question about payment, land parcels or field reports, reply to this e-mail and a person will answer.`,
        cta: dash,
      };
    case "oil_allocated":
      return {
        subject: "زيتك جاهز · Your olive oil has been allocated",
        ar: `اعتُمدت دفعة العصر للشجرة ${tree} (موسم ${escapeHtml(p.seasonYear)}، شهادة ${escapeHtml(p.certificateSerial)}). نصيبك: <strong>${liters(p.litersMl)}</strong>. يمكنك الآن طلب التسليم أو الاستلام من المعصرة أو التبرع من لوحة التحكم.`,
        en: `The pressing batch for tree ${tree} was certified (season ${escapeHtml(p.seasonYear)}, certificate ${escapeHtml(p.certificateSerial)}). Your share: <strong>${liters(p.litersMl)}</strong>. You can now request delivery, pickup at the mill or a donation from your dashboard.`,
        cta: dash,
      };
    case "oil_request_received":
      return {
        subject: "استلمنا طلب الزيت · We received your oil request",
        ar: `استلمنا طلبك ${shortId(p.requestId)}: ${kindAr(p.kind)} · ${liters(p.litersMl)}. سيراجعه فريق المالية وتصلك رسالة عند كل خطوة.`,
        en: `We received your request ${shortId(p.requestId)}: ${kindEn(p.kind)} · ${liters(p.litersMl)}. Finance will review it and you get an e-mail at every step.`,
        cta: dash,
      };
    case "oil_request_approved":
      return {
        subject: "تم اعتماد طلب الزيت · Your oil request was approved",
        ar: `اعتُمد طلبك ${shortId(p.requestId)} (${kindAr(p.kind)} · ${liters(p.litersMl)}) وهو الآن قيد التنفيذ.${note}`,
        en: `Your request ${shortId(p.requestId)} (${kindEn(p.kind)} · ${liters(p.litersMl)}) was approved and is being fulfilled.${note}`,
        cta: dash,
      };
    case "oil_request_fulfilled":
      return {
        subject: "تم تنفيذ طلب الزيت · Your oil request is complete",
        ar: `نُفّذ طلبك ${shortId(p.requestId)} (${kindAr(p.kind)} · ${liters(p.litersMl)}). بالصحة والعافية.${note}`,
        en: `Your request ${shortId(p.requestId)} (${kindEn(p.kind)} · ${liters(p.litersMl)}) has been fulfilled. Enjoy.${note}`,
        cta: dash,
      };
    case "oil_request_rejected":
      return {
        subject: "طلب الزيت · Your oil request",
        ar: `لم نتمكن من تنفيذ طلبك ${shortId(p.requestId)} (${liters(p.litersMl)}). أُعيد الزيت إلى رصيدك ويمكنك إرسال طلب جديد.${note}`,
        en: `We could not fulfil your request ${shortId(p.requestId)} (${liters(p.litersMl)}). The oil is back in your balance and you can send a new request.${note}`,
        cta: dash,
      };
    case "gift_created": {
      // The code is shown once here and in the dashboard response; the database stores only its hash.
      const code = escapeHtml(p.code);
      const to = p.recipientName ? ` لـ ${escapeHtml(p.recipientName)}` : "";
      const toEn = p.recipientName ? ` for ${escapeHtml(p.recipientName)}` : "";
      return {
        subject: "رمز الهدية الخاص بك · Your Faseela gift code",
        ar: `أنشأت هدية${to}: ${escapeHtml(p.shareCount)} حصة من الشجرة ${tree}. رمز الهدية: <strong style="font-size:20px;letter-spacing:2px;">${code}</strong><br>شاركه مع المُهدى إليه؛ يُستعمل مرة واحدة فقط وينتهي في ${when(p.expiresAt)}. احتفظ بالرمز سرًا — من يملكه يستطيع استلام الهدية.`,
        en: `You created a gift${toEn}: ${escapeHtml(p.shareCount)} share(s) of tree ${tree}. Gift code: <strong style="font-size:20px;letter-spacing:2px;">${code}</strong><br>Share it with the recipient; it can be redeemed once and expires on ${when(p.expiresAt)}. Keep the code private — whoever holds it can claim the gift.`,
        cta: { label_ar: "صفحة الهدية", label_en: "Gift page", href: `${APP_URL}/?gift=${encodeURIComponent(String(p.code ?? ""))}` },
      };
    }
    case "gift_redeemed":
      return {
        subject: "تم استلام هديتك · Your gift was redeemed",
        ar: `${p.recipientName ? escapeHtml(p.recipientName) : "المُهدى إليه"} استلم هديتك: ${escapeHtml(p.shareCount)} حصة من الشجرة ${tree}. انتقلت الحصة الآن إلى حسابه وسيتابع الشجرة من لوحته.`,
        en: `${p.recipientName ? escapeHtml(p.recipientName) : "The recipient"} redeemed your gift: ${escapeHtml(p.shareCount)} share(s) of tree ${tree}. The share now lives in their account and they follow the tree from their dashboard.`,
        cta: dash,
      };
    case "gift_received":
      return {
        subject: "وصلتك هدية زيتون · An olive tree gift is yours",
        ar: `أصبحت رعاية ${escapeHtml(p.shareCount)} حصة من الشجرة ${tree} باسمك.${p.message ? `<br><em>«${escapeHtml(p.message)}»</em>` : ""}<br>تابع الشجرة وتقارير الحقل ونصيبك من الزيت من لوحة التحكم.`,
        en: `Stewardship of ${escapeHtml(p.shareCount)} share(s) of tree ${tree} is now yours.${p.message ? `<br><em>“${escapeHtml(p.message)}”</em>` : ""}<br>Follow the tree, its field reports and your oil allocation from the dashboard.`,
        cta: dash,
      };
    case "referral_rewarded":
      return {
        subject: "رصيد زيت إضافي · Referral reward: extra olive oil",
        ar: p.role === "referrer"
          ? `شكرًا لتوصيتك! اكتمل أول شراء لصديقك، وأُضيف <strong>${liters(p.litersMl)}</strong> من الزيت إلى رصيدك. يُضاف تلقائيًا إلى طلب الزيت التالي.`
          : `أهلاً بك! لأنك انضممت عبر توصية، أُضيف <strong>${liters(p.litersMl)}</strong> من الزيت إلى رصيدك. يُضاف تلقائيًا إلى طلب الزيت التالي.`,
        en: p.role === "referrer"
          ? `Thank you for the recommendation! Your friend's first purchase is complete and <strong>${liters(p.litersMl)}</strong> of olive oil was added to your balance. It is merged into your next oil request automatically.`
          : `Welcome! Because you joined through a recommendation, <strong>${liters(p.litersMl)}</strong> of olive oil was added to your balance. It is merged into your next oil request automatically.`,
        cta: dash,
      };
    case "payment_change_pending":
      return {
        subject: "تغيير حسابات الدفع بانتظار الموافقة · Payment account change awaits approval",
        ar: `اقترح أحد المشرفين تغيير حسابات استلام الدفعات (${escapeHtml(p.channels)} قناة). لا يسري التغيير إلا بعد موافقة مشرف آخر من لوحة الإدارة. إن لم تكن على علم بهذا الطلب، ارفضه وراجع سجل التدقيق فوراً.`,
        en: `An admin proposed a change to the receiving accounts (${escapeHtml(p.channels)} channel(s)). It only takes effect after a different admin approves it in the admin panel. If you do not recognise this request, reject it and check the audit log immediately.`,
        cta: dash,
      };
    case "payment_accounts_changed":
      return {
        subject: "تنبيه أمني: تغيّرت حسابات استلام الدفعات · Security notice: receiving accounts changed",
        ar: `تم تغيير حسابات استلام الدفعات المعروضة للمستثمرين (${escapeHtml(p.channels)} قناة)${p.fourEyes ? " بموافقة مشرف ثانٍ" : " من قبل مشرف واحد"}. إن لم يكن هذا التغيير متوقعاً، افتح لوحة الإدارة فوراً، صحّح الحسابات وأوقف الحساب المعني.`,
        en: `The receiving accounts shown to investors were changed (${escapeHtml(p.channels)} channel(s))${p.fourEyes ? " with a second admin's approval" : " by a single admin"}. If this change is unexpected, open the admin panel now, correct the accounts and suspend the account involved.`,
        cta: dash,
      };
    case "ops_alert":
      return {
        subject: "تنبيه تشغيلي · Faseela ops alert",
        ar: `رسائل فاشلة خلال 24 ساعة: ${escapeHtml(p.failedEmails)} · أخطاء العميل خلال ساعة: ${escapeHtml(p.clientErrorsLastHour)}. افتح حالة النظام في لوحة الإدارة.`,
        en: `Failed e-mails in 24 h: ${escapeHtml(p.failedEmails)} · client errors in the last hour: ${escapeHtml(p.clientErrorsLastHour)}. Open the system status in the admin panel.`,
        cta: dash,
      };
    default:
      throw new Error(`unknown template ${template}`);
  }
}

