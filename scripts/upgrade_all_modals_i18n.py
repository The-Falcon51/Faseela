import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Certificate Modal: replace static dummy with dynamic container
old_cert_dummy = '''<div class="border-2 border-dashed border-olive-300 p-6 sm:p-8 rounded-2xl bg-gradient-to-b from-stone-50 via-white to-stone-50 text-center space-y-5">
        <div class="flex items-center justify-center gap-2">
          <i data-lucide="sprout" class="w-8 h-8 text-olive-700"></i>
          <span class="text-3xl font-black text-olive-950">فَسِيلَة • FASEELA</span>
        </div>
        <div class="uppercase tracking-widest text-xs font-bold text-amber-700">
          شهادة ملكية ورعاية زيتون رقمية موثقة
        </div>
        <h2 class="text-2xl sm:text-3xl font-black text-stone-900">شهادة إسهام في شجرة زيتون مباركة</h2>
        <p class="text-xs text-stone-600 leading-relaxed max-w-lg mx-auto">
          تشهد إدارة منصة "فسيلة" بأن المستثمر الكريم <strong>كريم العبدالله</strong> يمتلك حصة استثمارية قدرها <strong>50%</strong> في الشجرة المعمرة المسماة:
        </p>

        <div class="bg-olive-50 border border-olive-200 rounded-xl p-4 max-w-md mx-auto text-xs space-y-1">
          <div class="font-black text-base text-olive-950">الشجرة المعمرة - حارسة الجبل</div>
          <div class="text-stone-600 font-semibold">محافظة طرطوس • منطقة الدريكيش (كروم الكردي)</div>
          <div class="font-mono text-stone-500 font-bold">GPS: 34.8971° N, 36.1438° E</div>
          <div class="text-amber-800 font-bold">المعصرة المعتمدة: معصرة الدريكيش الإيطالية الحديثة</div>
        </div>

        <div class="grid grid-cols-3 gap-4 pt-4 border-t border-stone-200 text-xs">
          <div>
            <span class="text-stone-400 block text-[10px]">الرقم التسلسلي</span>
            <span class="font-mono font-bold text-stone-800">FAS-2026-TR01-50PCT</span>
          </div>
          <div>
            <span class="text-stone-400 block text-[10px]">الختم الرقمي</span>
            <span class="font-bold text-emerald-700 flex items-center justify-center gap-1"><i data-lucide="shield-check" class="w-3.5 h-3.5"></i> موثق ومشفر</span>
          </div>
          <div>
            <span class="text-stone-400 block text-[10px]">تاريخ الإصدار</span>
            <span class="font-bold text-stone-800">15 آذار 2026</span>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-3 mt-6">
        <button onclick="window.print()" class="bg-olive-800 hover:bg-olive-900 text-white px-5 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 shadow-md">
          <i data-lucide="printer" class="w-4 h-4"></i>
          <span>طباعة الشهادة الرسمية</span>
        </button>
      </div>'''

new_cert_dummy = '''<div id="certificate-render-area">
        <!-- Rendered dynamically by openCertificateModal() -->
      </div>'''

if old_cert_dummy in content:
    content = content.replace(old_cert_dummy, new_cert_dummy)
    print("Certificate modal fixed with dynamic render area.")

# 2. Lab Quality Modal
content = content.replace(
    '<span>شهادة الجودة والتحليل المخبري</span>',
    '<span data-i18n="lab_modal_title">شهادة الجودة والتحليل المخبري</span>'
)
content = content.replace(
    '<span class="text-stone-500">درجة الحموضة (Free Acidity):</span>',
    '<span class="text-stone-500" data-i18n="lab_modal_acidity_lbl">درجة الحموضة (Free Acidity):</span>'
)
content = content.replace(
    '<span class="text-stone-500">رقم البيروكسيد (Peroxide Value):</span>',
    '<span class="text-stone-500" data-i18n="lab_modal_peroxide_lbl">رقم البيروكسيد (Peroxide Value):</span>'
)
content = content.replace(
    '<span class="text-stone-500">درجة حرارة العصر:</span>',
    '<span class="text-stone-500" data-i18n="lab_modal_temp_lbl">درجة حرارة العصر:</span>'
)
content = content.replace(
    '<span class="text-stone-500">نسبة الاستخراج (السيولة):</span>',
    '<span class="text-stone-500" data-i18n="lab_modal_yield_lbl">نسبة الاستخراج (السيولة):</span>'
)
content = content.replace(
    '<button onclick="closeModal(\'modal-lab-cert\')" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-xl font-bold text-xs">\n          إغلاق المعاينة\n        </button>',
    '<button onclick="closeModal(\'modal-lab-cert\')" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-xl font-bold text-xs" data-i18n="btn_close">\n          إغلاق المعاينة\n        </button>'
)

# 3. Mill Register Batch Modal
content = content.replace(
    '<span>تسجيل دفعة عصر وإصدار شهادة</span>',
    '<span data-i18n="mill_modal_title">تسجيل دفعة عصر وإصدار شهادة</span>'
)
content = content.replace(
    '<label class="block font-bold text-stone-700 mb-1">المزرعة والشجرة المستهدفة:</label>',
    '<label class="block font-bold text-stone-700 mb-1" data-i18n="mill_modal_tree_lbl">المزرعة والشجرة المستهدفة:</label>'
)
content = content.replace(
    '<label class="block font-bold text-stone-700 mb-1">وزن الزيتون (كغ):</label>',
    '<label class="block font-bold text-stone-700 mb-1" data-i18n="mill_modal_weight_lbl">وزن الزيتون (كغ):</label>'
)
content = content.replace(
    '<label class="block font-bold text-stone-700 mb-1">ناتج الزيت باللتر:</label>',
    '<label class="block font-bold text-stone-700 mb-1" data-i18n="mill_modal_oil_lbl">ناتج الزيت باللتر:</label>'
)
content = content.replace(
    '<label class="block font-bold text-stone-700 mb-1">نسبة الحموضة %:</label>',
    '<label class="block font-bold text-stone-700 mb-1" data-i18n="mill_modal_acidity_lbl">نسبة الحموضة %:</label>'
)
content = content.replace(
    '<label class="block font-bold text-stone-700 mb-1">حرارة العصر (مئوية):</label>',
    '<label class="block font-bold text-stone-700 mb-1" data-i18n="mill_modal_temp_lbl">حرارة العصر (مئوية):</label>'
)
content = content.replace(
    'اعتماد الدفعة وإصدار الشهادة للمستثمرين',
    'اعتماد الدفعة وإصدار الشهادة للمستثمرين' # leave as is or tag
)

# 4. Invest Modal
content = content.replace(
    '<span>شراء حصة في شجرة زيتون</span>',
    '<span data-i18n="invest_modal_title">شراء حصة في شجرة زيتون</span>'
)
content = content.replace(
    '<span class="text-xs font-bold text-stone-500 block">الشجرة المختارة:</span>',
    '<span class="text-xs font-bold text-stone-500 block" data-i18n="invest_modal_tree_lbl">الشجرة المختارة:</span>'
)
content = content.replace(
    '<label class="block text-xs font-bold text-stone-700 mb-2">اختر نسبة الحصة المطلوبة:</label>',
    '<label class="block text-xs font-bold text-stone-700 mb-2" data-i18n="invest_modal_share_lbl">اختر نسبة الحصة المطلوبة:</label>'
)
content = content.replace(
    '<span>المبلغ الإجمالي للاستثمار:</span>',
    '<span data-i18n="invest_modal_total_lbl">المبلغ الإجمالي للاستثمار:</span>'
)
content = content.replace(
    '<span>حصتك المتوقعة من زيت الزيتون البكر:</span>',
    '<span data-i18n="invest_modal_oil_lbl">حصتك المتوقعة من زيت الزيتون البكر:</span>'
)
content = content.replace(
    '<span>شهادة ملكية رقمية بالـ GPS:</span>',
    '<span data-i18n="invest_modal_cert_lbl">شهادة ملكية رقمية بالـ GPS:</span>'
)
content = content.replace(
    '<span class="text-emerald-700 font-bold">مشمولة فوراً</span>',
    '<span class="text-emerald-700 font-bold" data-i18n="invest_modal_cert_val">مشمولة فوراً</span>'
)
content = content.replace(
    '<label class="block text-xs font-bold text-stone-700 mb-2">طريقة الدفع والتسوية:</label>',
    '<label class="block text-xs font-bold text-stone-700 mb-2" data-i18n="invest_modal_pay_method_lbl">طريقة الدفع والتسوية:</label>'
)
content = content.replace(
    '<span class="font-bold block text-stone-900">بطاقة مصرفية دولية (Visa / MasterCard)</span>',
    '<span class="font-bold block text-stone-900" data-i18n="pay_method_card_title">بطاقة مصرفية دولية (Visa / MasterCard)</span>'
)
content = content.replace(
    '<span class="font-bold block text-stone-900">تحويل محلي داخل سوريا (سيريتل كاش / بيمو / الهرم)</span>',
    '<span class="font-bold block text-stone-900" data-i18n="pay_method_local_title">تحويل محلي داخل سوريا (سيريتل كاش / بيمو / الهرم)</span>'
)
content = content.replace(
    '<i data-lucide="check-circle" class="w-5 h-5"></i>\n          <span>تأكيد الاستثمار وشراء الحصة الآن</span>',
    '<i data-lucide="check-circle" class="w-5 h-5"></i>\n          <span data-i18n="invest_modal_confirm_btn">تأكيد الاستثمار وشراء الحصة الآن</span>'
)

# 5. Farmer Payout Modal
content = content.replace(
    '<h3 class="text-lg font-black text-olive-950">طلب سحب مستحقات الرعاية</h3>',
    '<h3 class="text-lg font-black text-olive-950" data-i18n="farmer_payout_modal_title">طلب سحب مستحقات الرعاية</h3>'
)
content = content.replace(
    '<span class="text-[11px] font-bold text-emerald-800 block">المبلغ المتاح للصرف الفوري الآن:</span>',
    '<span class="text-[11px] font-bold text-emerald-800 block" data-i18n="farmer_payout_avail_lbl">المبلغ المتاح للصرف الفوري الآن:</span>'
)
content = content.replace(
    '<label class="block font-bold text-stone-800 mb-1">طريقة الاستلام المفضلة:</label>',
    '<label class="block font-bold text-stone-800 mb-1" data-i18n="farmer_payout_method_lbl">طريقة الاستلام المفضلة:</label>'
)
content = content.replace(
    '<label class="block font-bold text-stone-800 mb-1">رقم هاتف المزارع (سيريتل):</label>',
    '<label class="block font-bold text-stone-800 mb-1" data-i18n="farmer_payout_phone_lbl">رقم هاتف المزارع (سيريتل):</label>'
)
content = content.replace(
    '<button onclick="submitFarmerPayout()" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-2xl font-bold text-xs shadow-md transition-all">\n        تأكيد طلب الصرف وتحويل الرصيد\n      </button>',
    '<button onclick="submitFarmerPayout()" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-2xl font-bold text-xs shadow-md transition-all" data-i18n="farmer_payout_confirm_btn">\n        تأكيد طلب الصرف وتحويل الرصيد\n      </button>'
)

# 6. Emergency Voice Modal
content = content.replace(
    '<h3 class="text-lg font-black text-red-950">نداء طوارئ زراعي صوتي</h3>',
    '<h3 class="text-lg font-black text-red-950" data-i18n="emergency_modal_title">نداء طوارئ زراعي صوتي</h3>'
)
content = content.replace(
    '<i data-lucide="send" class="w-4 h-4"></i>\n        <span>بث نداء الطوارئ للمهندس الزراعي فوراً</span>',
    '<i data-lucide="send" class="w-4 h-4"></i>\n        <span data-i18n="emergency_modal_send_btn">بث نداء الطوارئ للمهندس الزراعي فوراً</span>'
)

# 7. Add i18n keys for newly tagged modal items
modal_keys_ar = '''
        lab_modal_title: "شهادة الجودة والتحليل المخبري",
        lab_modal_acidity_lbl: "درجة الحموضة (Free Acidity):",
        lab_modal_peroxide_lbl: "رقم البيروكسيد (Peroxide Value):",
        lab_modal_temp_lbl: "درجة حرارة العصر:",
        lab_modal_yield_lbl: "نسبة الاستخراج (السيولة):",
        mill_modal_title: "تسجيل دفعة عصر وإصدار شهادة",
        mill_modal_tree_lbl: "المزرعة والشجرة المستهدفة:",
        mill_modal_weight_lbl: "وزن الزيتون (كغ):",
        mill_modal_oil_lbl: "ناتج الزيت باللتر:",
        mill_modal_acidity_lbl: "نسبة الحموضة %:",
        mill_modal_temp_lbl: "حرارة العصر (مئوية):",
        invest_modal_title: "شراء حصة في شجرة زيتون",
        invest_modal_tree_lbl: "الشجرة المختارة:",
        invest_modal_share_lbl: "اختر نسبة الحصة المطلوبة:",
        invest_modal_total_lbl: "المبلغ الإجمالي للاستثمار:",
        invest_modal_oil_lbl: "حصتك المتوقعة من زيت الزيتون البكر:",
        invest_modal_cert_lbl: "شهادة ملكية رقمية بالـ GPS:",
        invest_modal_cert_val: "مشمولة فوراً",
        invest_modal_pay_method_lbl: "طريقة الدفع والتسوية:",
        pay_method_card_title: "بطاقة مصرفية دولية (Visa / MasterCard)",
        pay_method_local_title: "تحويل محلي داخل سوريا (سيريتل كاش / بيمو / الهرم)",
        invest_modal_confirm_btn: "تأكيد الاستثمار وشراء الحصة الآن",
        farmer_payout_modal_title: "طلب سحب مستحقات الرعاية",
        farmer_payout_avail_lbl: "المبلغ المتاح للصرف الفوري الآن:",
        farmer_payout_method_lbl: "طريقة الاستلام المفضلة:",
        farmer_payout_phone_lbl: "رقم هاتف المزارع (سيريتل):",
        farmer_payout_confirm_btn: "تأكيد طلب الصرف وتحويل الرصيد",
        emergency_modal_title: "نداء طوارئ زراعي صوتي",
        emergency_modal_send_btn: "بث نداء الطوارئ للمهندس الزراعي فوراً",
        farmer_guide_title: "إرشادات موسم قطاف وعصر أيلول / تشرين الأول",
        farmer_guide_sub: "توجيهات المهندسين الزراعيين لضمان أعلى نسبة زيت وأدنى حموضة",
        farmer_guide_listen_btn: "استمع للتسجيل التوجيهي",
'''

modal_keys_en = '''
        lab_modal_title: "Laboratory Quality & Purity Certificate",
        lab_modal_acidity_lbl: "Free Acidity:",
        lab_modal_peroxide_lbl: "Peroxide Value:",
        lab_modal_temp_lbl: "Cold Press Temperature:",
        lab_modal_yield_lbl: "Oil Extraction Yield:",
        mill_modal_title: "Record Pressing Batch & Issue Lab Certificate",
        mill_modal_tree_lbl: "Target Grove & Olive Tree:",
        mill_modal_weight_lbl: "Fruit Weight (kg):",
        mill_modal_oil_lbl: "Oil Output (Liters):",
        mill_modal_acidity_lbl: "Acidity Percentage %:",
        mill_modal_temp_lbl: "Pressing Temperature (°C):",
        invest_modal_title: "Purchase Share in Heritage Olive Tree",
        invest_modal_tree_lbl: "Selected Olive Tree:",
        invest_modal_share_lbl: "Choose Desired Share Size:",
        invest_modal_total_lbl: "Total Stewardship Cost:",
        invest_modal_oil_lbl: "Expected Extra Virgin Oil Yield:",
        invest_modal_cert_lbl: "GPS Verified Digital Certificate:",
        invest_modal_cert_val: "Included Instantly",
        invest_modal_pay_method_lbl: "Payment & Settlement Method:",
        pay_method_card_title: "International Card (Visa / MasterCard)",
        pay_method_local_title: "Local Syria Settlement (Syriatel Cash / BEMO / Al-Haram)",
        invest_modal_confirm_btn: "Confirm Stewardship & Buy Share Now",
        farmer_payout_modal_title: "Request Care Earnings Disbursement",
        farmer_payout_avail_lbl: "Balance Ready for Immediate Payout:",
        farmer_payout_method_lbl: "Preferred Payout Channel:",
        farmer_payout_phone_lbl: "Farmer Mobile (Syriatel Cash):",
        farmer_payout_confirm_btn: "Confirm Payout & Transfer Balance",
        emergency_modal_title: "Emergency Agricultural Voice Alert",
        emergency_modal_send_btn: "Broadcast Alert to Agronomist Immediately",
        farmer_guide_title: "Harvest & Pressing Seasonal Guidelines (Sept / Oct)",
        farmer_guide_sub: "Agronomist field tips to ensure highest oil yield and lowest acidity",
        farmer_guide_listen_btn: "Listen to Audio Guidance",
'''

if 'lab_modal_title' not in content:
    content = content.replace('btn_confirm: "تأكيد الاستثمار",', 'btn_confirm: "تأكيد الاستثمار",\n' + modal_keys_ar)
    content = content.replace('btn_confirm: "Confirm Investment",', 'btn_confirm: "Confirm Investment",\n' + modal_keys_en)

# 8. Fix JS renderDashboard container lookup to support owned-trees-list or my-shares-container
content = content.replace(
    "const container = document.getElementById('my-shares-container');",
    "const container = document.getElementById('my-shares-container') || document.getElementById('owned-trees-list');"
)

# 9. Fix selectSharePercent button lookup
content = content.replace(
    "const selectedBtn = document.getElementById(`pct-btn-${pct}`);",
    "const selectedBtn = document.getElementById(`pct-btn-${pct}`) || document.getElementById(`btn-share-${pct}`);"
)

# 10. Fix selectSharePercent text updates
content = content.replace(
    "document.getElementById('invest-summary-oil').innerText = `${estOil} ${t('calc_oil_unit')}`;\n        document.getElementById('invest-summary-carbon').innerText = `${estCarbon} ${t('carbon_label')}`;\n        document.getElementById('invest-summary-total').innerText = formatMoney(costUsd);",
    """const sTotal = document.getElementById('invest-summary-total') || document.getElementById('calc-total-price');
        if (sTotal) sTotal.innerText = formatMoney(costUsd);
        const sOil = document.getElementById('invest-summary-oil') || document.getElementById('calc-expected-oil');
        if (sOil) sOil.innerText = `~ ${estOil} ${t('calc_oil_unit')}`;
        const sCarbon = document.getElementById('invest-summary-carbon');
        if (sCarbon) sCarbon.innerText = `${estCarbon} ${t('carbon_label')}`;"""
)

# 11. Fix simulateUploadReceipt lookups
content = content.replace(
    "const previewCont = document.getElementById('receipt-preview-container');\n      const promptCont = document.getElementById('receipt-drop-prompt');",
    "const previewCont = document.getElementById('receipt-preview-container') || document.getElementById('receipt-upload-preview');\n      const promptCont = document.getElementById('receipt-drop-prompt') || document.getElementById('receipt-upload-prompt');"
)

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Upgrade all modals and JS fixes complete.")
