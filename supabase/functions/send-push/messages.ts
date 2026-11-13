// Push texts per template. Deliberately generic: no amounts, names, tree or request ids leave the database through
// a push service. The details are in the app (and in the e-mail the user receives in parallel).
export type PushText = { ar: string; en: string };

const TEXTS: Record<string, PushText> = {
  reservation_created: { ar: "تم حجز حصتك. يرجى رفع إشعار التحويل.", en: "Your shares are reserved. Please upload your transfer receipt." },
  reservation_expired: { ar: "انتهت مهلة الحجز وأُلغي تلقائياً.", en: "Your reservation expired and was released." },
  proof_received: { ar: "استلمنا إشعار الدفع وهو قيد المراجعة.", en: "We received your payment receipt. It is under review." },
  payment_approved: { ar: "تم اعتماد دفعتك.", en: "Your payment was approved." },
  payment_rejected: { ar: "تعذّر اعتماد دفعتك. التفاصيل في التطبيق.", en: "Your payment could not be approved. See the app for details." },
  oil_allocated: { ar: "تم تخصيص حصة زيت لك.", en: "Olive oil has been allocated to you." },
  oil_request_received: { ar: "استلمنا طلب الزيت.", en: "We received your oil request." },
  oil_request_approved: { ar: "تمت الموافقة على طلب الزيت.", en: "Your oil request was approved." },
  oil_request_rejected: { ar: "تعذّرت الموافقة على طلب الزيت.", en: "Your oil request could not be approved." },
  oil_request_fulfilled: { ar: "تم تنفيذ طلب الزيت.", en: "Your oil request was fulfilled." },
  gift_created: { ar: "رمز الهدية جاهز.", en: "Your gift code is ready." },
  gift_received: { ar: "وصلتك هدية على فسيلة.", en: "You received a gift on Faseela." },
  gift_redeemed: { ar: "تم استلام هديتك.", en: "Your gift was redeemed." },
  referral_rewarded: { ar: "حصلت على مكافأة إحالة.", en: "You earned a referral reward." },
  role_approved: { ar: "تم اعتماد دورك على المنصة.", en: "Your role on the platform was approved." },
  role_rejected: { ar: "تعذّر اعتماد طلب الدور.", en: "Your role request could not be approved." },
  farmer_update_published: { ar: "نُشر تحديثك الميداني.", en: "Your field update was published." },
  farmer_update_rejected: { ar: "تعذّر نشر تحديثك الميداني.", en: "Your field update could not be published." },
  batch_certified: { ar: "تم اعتماد دفعة العصر.", en: "The pressing batch was certified." },
  batch_rejected: { ar: "تعذّر اعتماد دفعة العصر.", en: "The pressing batch could not be certified." },
};

const FALLBACK: PushText = { ar: "لديك تحديث جديد على فسيلة.", en: "You have a new update on Faseela." };

export function pushText(template: string): PushText {
  return Object.prototype.hasOwnProperty.call(TEXTS, template) ? TEXTS[template] : FALLBACK;
}
