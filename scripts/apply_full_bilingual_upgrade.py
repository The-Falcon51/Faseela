import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update Navigation Bar spans
content = content.replace(
    '<span>محفظتي</span>\n            <span id="user-shares-count"',
    '<span data-i18n="nav_dashboard">محفظتي</span>\n            <span id="user-shares-count"'
)
content = content.replace(
    '<i data-lucide="tractor" class="w-3.5 h-3.5 text-olive-600"></i>\n            <span>بوابة المزارع</span>',
    '<i data-lucide="tractor" class="w-3.5 h-3.5 text-olive-600"></i>\n            <span data-i18n="nav_farmer">بوابة المزارع</span>'
)
content = content.replace(
    '<i data-lucide="cog" class="w-3.5 h-3.5 text-amber-600"></i>\n            <span class="font-bold text-amber-950">بوابة المعاصر</span>',
    '<i data-lucide="cog" class="w-3.5 h-3.5 text-amber-600"></i>\n            <span class="font-bold text-amber-950" data-i18n="nav_mill">بوابة المعاصر</span>'
)

# 2. Hero Section
hero_h1_old = '''<h1 class="text-4xl sm:text-6xl font-black leading-tight tracking-tight">
                استثمر في <span class="text-terracotta-500 underline decoration-olive-600 underline-offset-8">شجرة زيتون</span><br>
                وشارك الأرض بركتها وثمارها
              </h1>'''
hero_h1_new = '''<h1 class="text-4xl sm:text-6xl font-black leading-tight tracking-tight" data-i18n="hero_title_full">
                استثمر في <span class="text-terracotta-500 underline decoration-olive-600 underline-offset-8">شجرة زيتون</span><br>
                وشارك الأرض بركتها وثمارها
              </h1>'''
content = content.replace(hero_h1_old, hero_h1_new)

hero_p_old = '''<p class="text-stone-300 text-base sm:text-lg font-normal leading-relaxed max-w-2xl">
                اشترِ حصة موثقة في شجرة زيتون عريقة في سوريا، تابع نموها ورعايتها، وراقب عصر ثمارها في أحدث المعاصر المعتمدة مع شهادات جودة مخبرية ونسب حموضة مضمونة، واستلم زيتك البكر أو عوائدك أينما كنت.
              </p>'''
hero_p_new = '''<p class="text-stone-300 text-base sm:text-lg font-normal leading-relaxed max-w-2xl" data-i18n="hero_desc">
                اشترِ حصة موثقة في شجرة زيتون عريقة في سوريا، تابع نموها ورعايتها، وراقب عصر ثمارها في أحدث المعاصر المعتمدة مع شهادات جودة مخبرية ونسب حموضة مضمونة، واستلم زيتك البكر أو عوائدك أينما كنت.
              </p>'''
content = content.replace(hero_p_old, hero_p_new)

# Hero Feature Card
content = content.replace(
    '<i data-lucide="flame" class="w-3.5 h-3.5"></i>\n                  <span>شجرة الموسم المميزة</span>',
    '<i data-lucide="flame" class="w-3.5 h-3.5"></i>\n                  <span data-i18n="hero_feat_badge">شجرة الموسم المميزة</span>'
)
content = content.replace(
    '<span class="text-xs font-bold text-olive-700 bg-olive-50 px-2.5 py-1 rounded-md">طرطوس • الدريكيش</span>',
    '<span class="text-xs font-bold text-olive-700 bg-olive-50 px-2.5 py-1 rounded-md" data-i18n="hero_feat_region">طرطوس • الدريكيش</span>'
)
content = content.replace(
    '<h3 class="text-xl font-black text-stone-900 mt-1">الشجرة المعمرة - حارسة الجبل</h3>',
    '<h3 class="text-xl font-black text-stone-900 mt-1" data-i18n="hero_feat_name">الشجرة المعمرة - حارسة الجبل</h3>'
)
content = content.replace(
    '<span class="text-xs font-semibold text-stone-500">/ الحصة</span>',
    '<span class="text-xs font-semibold text-stone-500" data-i18n="per_share_unit">/ الحصة</span>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 leading-relaxed">\n                    زيتون خضيري أصيل غرس عام 1948. معتمدة لدى معصرة الدريكيش الحديثة لإنتاج زيت فائق النقاء بحموضة 0.32%.\n                  </p>',
    '<p class="text-xs text-stone-600 leading-relaxed" data-i18n="hero_feat_desc">\n                    زيتون خضيري أصيل غرس عام 1948. معتمدة لدى معصرة الدريكيش الحديثة لإنتاج زيت فائق النقاء بحموضة 0.32%.\n                  </p>'
)
content = content.replace(
    '<span class="flex items-center gap-1 font-semibold text-amber-900"><i data-lucide="award" class="w-4 h-4 text-amber-600"></i> شهادة جودة مخبرية</span>',
    '<span class="flex items-center gap-1 font-semibold text-amber-900"><i data-lucide="award" class="w-4 h-4 text-amber-600"></i> <span data-i18n="hero_feat_lab">شهادة جودة مخبرية</span></span>'
)
content = content.replace(
    '<span class="font-bold text-olive-800">متاح 50% من الحصص</span>',
    '<span class="font-bold text-olive-800" data-i18n="hero_feat_avail">متاح 50% من الحصص</span>'
)
content = content.replace(
    '<i data-lucide="eye" class="w-3.5 h-3.5"></i>\n                      <span>معاينة الشجرة</span>',
    '<i data-lucide="eye" class="w-3.5 h-3.5"></i>\n                      <span data-i18n="btn_view_tree">معاينة الشجرة</span>'
)
content = content.replace(
    '<i data-lucide="shopping-cart" class="w-3.5 h-3.5"></i>\n                      <span>اشترِ حصة</span>',
    '<i data-lucide="shopping-cart" class="w-3.5 h-3.5"></i>\n                      <span data-i18n="btn_buy_share">اشترِ حصة</span>'
)

# 3. Seasonal Calendar
content = content.replace(
    '<span class="bg-olive-200 text-olive-900 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">تقويم المواسم السورية</span>',
    '<span class="bg-olive-200 text-olive-900 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider" data-i18n="calendar_badge">تقويم المواسم السورية</span>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 mt-1">شاهد كيف تتكامل رعاية المزارع مع تقارير التوثيق وعمل المعاصر في كل فصل</p>',
    '<p class="text-xs text-stone-600 mt-1" data-i18n="calendar_subtitle">شاهد كيف تتكامل رعاية المزارع مع تقارير التوثيق وعمل المعاصر في كل فصل</p>'
)

# Q1
content = content.replace(
    '<span class="text-xs font-black text-olive-700 bg-olive-50 px-2.5 py-1 rounded-lg block w-fit mb-3">كانون الثاني – شباط</span>',
    '<span class="text-xs font-black text-olive-700 bg-olive-50 px-2.5 py-1 rounded-lg block w-fit mb-3" data-i18n="cal_q1_month">كانون الثاني – شباط</span>'
)
content = content.replace(
    '<h3 class="text-lg font-black text-stone-900 mb-1">التقليم الشتوي والتسميد</h3>',
    '<h3 class="text-lg font-black text-stone-900 mb-1" data-i18n="cal_q1_title">التقليم الشتوي والتسميد</h3>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 leading-relaxed">\n                تقليم الأغصان الجافة وتهوية قلب الشجرة مع إضافة التسميد العضوي البلدي لحفظ خصوبة التربة.\n              </p>',
    '<p class="text-xs text-stone-600 leading-relaxed" data-i18n="cal_q1_desc">\n                تقليم الأغصان الجافة وتهوية قلب الشجرة مع إضافة التسميد العضوي البلدي لحفظ خصوبة التربة.\n              </p>'
)
content = content.replace(
    '<i data-lucide="camera" class="w-3.5 h-3.5 text-olive-600"></i>\n                <span>تقرير وصور التقليم</span>',
    '<i data-lucide="camera" class="w-3.5 h-3.5 text-olive-600"></i>\n                <span data-i18n="cal_q1_badge">تقرير وصور التقليم</span>'
)

# Q2
content = content.replace(
    '<span class="text-xs font-black text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg block w-fit mb-3">نيسان – أيار</span>',
    '<span class="text-xs font-black text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg block w-fit mb-3" data-i18n="cal_q2_month">نيسان – أيار</span>'
)
content = content.replace(
    '<h3 class="text-lg font-black text-stone-900 mb-1">الإزهار والعقد الأولي</h3>',
    '<h3 class="text-lg font-black text-stone-900 mb-1" data-i18n="cal_q2_title">الإزهار والعقد الأولي</h3>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 leading-relaxed">\n                ظهور الأزهار البيضاء الكثيفة وتحولها إلى حبات زيتون صغيرة واعدة، مع مراقبة رطوبة الأرض.\n              </p>',
    '<p class="text-xs text-stone-600 leading-relaxed" data-i18n="cal_q2_desc">\n                ظهور الأزهار البيضاء الكثيفة وتحولها إلى حبات زيتون صغيرة واعدة، مع مراقبة رطوبة الأرض.\n              </p>'
)
content = content.replace(
    '<i data-lucide="sprout" class="w-3.5 h-3.5 text-emerald-600"></i>\n                <span>تقرير نسبة عقد الثمار</span>',
    '<i data-lucide="sprout" class="w-3.5 h-3.5 text-emerald-600"></i>\n                <span data-i18n="cal_q2_badge">تقرير نسبة عقد الثمار</span>'
)

# Q3
content = content.replace(
    '<span class="text-xs font-black text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg block w-fit mb-3">تموز – آب</span>',
    '<span class="text-xs font-black text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg block w-fit mb-3" data-i18n="cal_q3_month">تموز – آب</span>'
)
content = content.replace(
    '<h3 class="text-lg font-black text-stone-900 mb-1">الري التكميلي والمكافحة</h3>',
    '<h3 class="text-lg font-black text-stone-900 mb-1" data-i18n="cal_q3_title">الري التكميلي والمكافحة</h3>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 leading-relaxed">\n                ري تكميلي بمياه الينابيع خلال موجات الحر لحماية الحبات من الجفاف مع وضع مصائد فرمونية حيوية.\n              </p>',
    '<p class="text-xs text-stone-600 leading-relaxed" data-i18n="cal_q3_desc">\n                ري تكميلي بمياه الينابيع خلال موجات الحر لحماية الحبات من الجفاف مع وضع مصائد فرمونية حيوية.\n              </p>'
)
content = content.replace(
    '<i data-lucide="droplet" class="w-3.5 h-3.5 text-amber-600"></i>\n                <span>تسجيل صوتي للمزارع</span>',
    '<i data-lucide="droplet" class="w-3.5 h-3.5 text-amber-600"></i>\n                <span data-i18n="cal_q3_badge">تسجيل صوتي للمزارع</span>'
)

# Q4
content = content.replace(
    '<span class="text-xs font-black text-terracotta-600 bg-terracotta-500/10 px-2.5 py-1 rounded-lg block w-fit mb-3">تشرين الأول – تشرين الثاني</span>',
    '<span class="text-xs font-black text-terracotta-600 bg-terracotta-500/10 px-2.5 py-1 rounded-lg block w-fit mb-3" data-i18n="cal_q4_month">تشرين الأول – تشرين الثاني</span>'
)
content = content.replace(
    '<h3 class="text-lg font-black text-stone-900 mb-1">موسم القطاف والعصر البارد</h3>',
    '<h3 class="text-lg font-black text-stone-900 mb-1" data-i18n="cal_q4_title">موسم القطاف والعصر البارد</h3>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 leading-relaxed">\n                القطاف اليدوي ونقل الثمار فوراً إلى المعصرة الحديثة لإجراء العصر البارد وإصدار شهادات الجودة.\n              </p>',
    '<p class="text-xs text-stone-600 leading-relaxed" data-i18n="cal_q4_desc">\n                القطاف اليدوي ونقل الثمار فوراً إلى المعصرة الحديثة لإجراء العصر البارد وإصدار شهادات الجودة.\n              </p>'
)
content = content.replace(
    '<i data-lucide="award" class="w-3.5 h-3.5 text-amber-600"></i>\n                <span>شهادة الفحص المخبري وتوزيع الزيت</span>',
    '<i data-lucide="award" class="w-3.5 h-3.5 text-amber-600"></i>\n                <span data-i18n="cal_q4_badge">شهادة الفحص المخبري وتوزيع الزيت</span>'
)

# 4. ROI Calculator
content = content.replace(
    '<span class="bg-olive-100 text-olive-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">حاسبة الاستثمار والأثر التفاعلية</span>',
    '<span class="bg-olive-100 text-olive-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider" data-i18n="calc_badge">حاسبة الاستثمار والأثر التفاعلية</span>'
)
content = content.replace(
    '<h2 class="text-2xl sm:text-3xl font-black text-olive-950 mt-2">احسب عوائدك وأثرك البيئي المباشر في سوريا</h2>',
    '<h2 class="text-2xl sm:text-3xl font-black text-olive-950 mt-2" data-i18n="calc_title">احسب عوائدك وأثرك البيئي المباشر في سوريا</h2>'
)
content = content.replace(
    '<p class="text-xs text-stone-600 mt-1">حرك المؤشر لاختيار عدد الحصص واكتشف كمية زيت الزيتون البكر المتوقعة ومقدار الكربون الممتص سنوياً</p>',
    '<p class="text-xs text-stone-600 mt-1" data-i18n="calc_desc">حرك المؤشر لاختيار عدد الحصص واكتشف كمية زيت الزيتون البكر المتوقعة ومقدار الكربون الممتص سنوياً</p>'
)
content = content.replace(
    '<label class="text-sm font-bold text-stone-800">حجم الاستثمار (عدد الحصص):</label>',
    '<label class="text-sm font-bold text-stone-800" data-i18n="calc_shares_label">حجم الاستثمار (عدد الحصص):</label>'
)
content = content.replace(
    '<span>1 حصة</span>\n                    <span>شجرة كاملة (4 حصص)</span>\n                    <span>شجرتان (8 حصص)</span>',
    '<span data-i18n="calc_scale_1">1 حصة (25%)</span>\n                    <span data-i18n="calc_scale_4">شجرة كاملة (4 حصص)</span>\n                    <span data-i18n="calc_scale_8">شجرتان (8 حصص)</span>'
)
content = content.replace(
    '<i data-lucide="check-check" class="w-4 h-4 text-emerald-600"></i>\n                    <span>ماذا تشمل الحصة الواحدة؟</span>',
    '<i data-lucide="check-check" class="w-4 h-4 text-emerald-600"></i>\n                    <span data-i18n="calc_include_title">ماذا تشمل الحصة الواحدة؟</span>'
)
content = content.replace(
    '<p class="text-[11px] leading-relaxed text-stone-600">\n                    رعاية زراعية سنوية متكاملة (سقاية، تقليم، مكافحة حيوية) + عصر على البارد في معصرة معتمدة + شهادة ملكية وجودة رقمية موثقة بالـ GPS.\n                  </p>',
    '<p class="text-[11px] leading-relaxed text-stone-600" data-i18n="calc_include_desc">\n                    رعاية زراعية سنوية متكاملة (سقاية، تقليم، مكافحة حيوية) + عصر على البارد في معصرة معتمدة + شهادة ملكية وجودة رقمية موثقة بالـ GPS.\n                  </p>'
)

# Calculator Cards
content = content.replace(
    '<span class="text-xs text-stone-500 font-bold block">زيت زيتون بكر ممتاز</span>',
    '<span class="text-xs text-stone-500 font-bold block" data-i18n="calc_card1_title">زيت زيتون بكر ممتاز</span>'
)
content = content.replace(
    '<span class="text-[10px] text-stone-400">عصر بارد حموضة &lt; 0.4%</span>',
    '<span class="text-[10px] text-stone-400" data-i18n="calc_card1_sub">عصر بارد حموضة &lt; 0.4%</span>'
)
content = content.replace(
    '<span class="text-xs text-stone-500 font-bold block">امتصاص ثاني أكسيد الكربون</span>',
    '<span class="text-xs text-stone-500 font-bold block" data-i18n="calc_card2_title">امتصاص ثاني أكسيد الكربون</span>'
)
content = content.replace(
    '<span class="text-[10px] text-emerald-600">أثر بيئي ومكافحة تصحر</span>',
    '<span class="text-[10px] text-emerald-600" data-i18n="calc_card2_sub">أثر بيئي ومكافحة تصحر</span>'
)
content = content.replace(
    '<span class="text-xs text-stone-500 font-bold block">تكلفة الاستثمار الكلية</span>',
    '<span class="text-xs text-stone-500 font-bold block" data-i18n="calc_card3_title">تكلفة الاستثمار الكلية</span>'
)
content = content.replace(
    '<span class="text-[10px] text-stone-400">دفع محلي أو دولي</span>',
    '<span class="text-[10px] text-stone-400" data-i18n="calc_card3_sub">دفع محلي أو دولي</span>'
)
content = content.replace(
    '<span class="text-xs text-stone-500 font-bold block">العائد التقديري السنوي</span>',
    '<span class="text-xs text-stone-500 font-bold block" data-i18n="calc_card4_title">العائد التقديري السنوي</span>'
)
content = content.replace(
    '<span class="text-[10px] text-stone-400">قيمة الزيت أو المردود</span>',
    '<span class="text-[10px] text-stone-400" data-i18n="calc_card4_sub">قيمة الزيت أو المردود</span>'
)

# 5. CTA Footer Banner
content = content.replace(
    '<h2 class="text-3xl font-black mb-4">انضم إلى مجتمع مستثمري ومزارعي فسيلة</h2>',
    '<h2 class="text-3xl font-black mb-4" data-i18n="cta_title">انضم إلى مجتمع مستثمري ومزارعي فسيلة</h2>'
)
content = content.replace(
    '<p class="text-stone-300 text-sm mb-8">\n            أكثر من 2,400 شجرة زيتون موثقة بالـ GPS ومعاصر حديثة جاهزة لاستقبال مواسم الخير.\n          </p>',
    '<p class="text-stone-300 text-sm mb-8" data-i18n="cta_desc">\n            أكثر من 2,400 شجرة زيتون موثقة بالـ GPS ومعاصر حديثة جاهزة لاستقبال مواسم الخير.\n          </p>'
)
content = content.replace(
    '<button onclick="navigateTo(\'marketplace\')" class="bg-terracotta-500 hover:bg-terracotta-600 text-white px-8 py-3.5 rounded-2xl font-black text-sm shadow-xl transition-all">\n              استكشف الأشجار المتاحة\n            </button>',
    '<button onclick="navigateTo(\'marketplace\')" class="bg-terracotta-500 hover:bg-terracotta-600 text-white px-8 py-3.5 rounded-2xl font-black text-sm shadow-xl transition-all" data-i18n="cta_btn_market">\n              استكشف الأشجار المتاحة\n            </button>'
)
content = content.replace(
    '<i data-lucide="cog" class="w-4 h-4 text-amber-300"></i>\n              <span>بوابة أصحاب المعاصر</span>',
    '<i data-lucide="cog" class="w-4 h-4 text-amber-300"></i>\n              <span data-i18n="cta_btn_mill">بوابة أصحاب المعاصر</span>'
)

# 6. Marketplace
content = content.replace(
    '<h1 class="text-3xl font-black text-olive-950" data-i18n="market_title">سوق أشجار الزيتون</h1>\n          <p class="text-stone-600 text-xs mt-1">تصفح الأشجار المتاحة مع تفاصيل المعاصر الشريكة وشهادات الجودة</p>',
    '<h1 class="text-3xl font-black text-olive-950" data-i18n="market_title">سوق أشجار الزيتون السورية</h1>\n          <p class="text-stone-600 text-xs mt-1" data-i18n="market_subtitle">تصفح الأشجار المتاحة مع تفاصيل المعاصر الشريكة وشهادات الجودة</p>'
)
content = content.replace(
    '<span class="text-xs font-bold text-stone-500">الأشجار المتاحة:</span>',
    '<span class="text-xs font-bold text-stone-500" data-i18n="market_available_label">الأشجار المتاحة:</span>'
)
# Filters
content = content.replace(
    '<label class="block text-xs font-bold text-stone-700 mb-1.5">المحافظة / المنطقة</label>',
    '<label class="block text-xs font-bold text-stone-700 mb-1.5" data-i18n="filter_region_lbl">المحافظة / المنطقة</label>'
)
content = content.replace(
    '<option value="all">جميع المحافظات</option>\n              <option value="طرطوس">طرطوس (الساحل)</option>\n              <option value="إدلب">إدلب (جبل الزاوية)</option>\n              <option value="درعا">درعا (سهل حوران)</option>',
    '<option value="all" data-i18n="filter_region_all">جميع المحافظات</option>\n              <option value="طرطوس" data-i18n="filter_region_tartus">طرطوس (الساحل)</option>\n              <option value="إدلب" data-i18n="filter_region_idlib">إدلب (جبل الزاوية)</option>\n              <option value="درعا" data-i18n="filter_region_daraa">درعا (سهل حوران)</option>'
)
content = content.replace(
    '<label class="block text-xs font-bold text-stone-700 mb-1.5">عمر الشجرة</label>',
    '<label class="block text-xs font-bold text-stone-700 mb-1.5" data-i18n="filter_age_lbl">عمر الشجرة</label>'
)
content = content.replace(
    '<option value="all">جميع الأعمار</option>\n              <option value="heritage">معمرة (أكثر من 50 سنة)</option>\n              <option value="prime">مثمرة بالغة (20 - 50 سنة)</option>\n              <option value="young">حديثة الإثمار (أقل من 20 سنة)</option>',
    '<option value="all" data-i18n="filter_age_all">جميع الأعمار</option>\n              <option value="heritage" data-i18n="filter_age_heritage">معمرة (أكثر من 50 سنة)</option>\n              <option value="prime" data-i18n="filter_age_prime">مثمرة بالغة (20 - 50 سنة)</option>\n              <option value="young" data-i18n="filter_age_young">حديثة الإثمار (أقل من 20 سنة)</option>'
)
content = content.replace(
    '<label class="block text-xs font-bold text-stone-700 mb-1.5">سعر الحصة</label>',
    '<label class="block text-xs font-bold text-stone-700 mb-1.5" data-i18n="filter_price_lbl">سعر الحصة</label>'
)
content = content.replace(
    '<option value="all">كافة الأسعار</option>\n              <option value="low">أقل من $25</option>\n              <option value="mid">$25 - $30</option>\n              <option value="high">أكثر من $30</option>',
    '<option value="all" data-i18n="filter_price_all">كافة الأسعار</option>\n              <option value="low" data-i18n="filter_price_low">أقل من $25</option>\n              <option value="mid" data-i18n="filter_price_mid">$25 - $30</option>\n              <option value="high" data-i18n="filter_price_high">أكثر من $30</option>'
)
content = content.replace(
    '<i data-lucide="rotate-ccw" class="w-4 h-4"></i>\n              <span>إعادة ضبط الفلاتر</span>',
    '<i data-lucide="rotate-ccw" class="w-4 h-4"></i>\n              <span data-i18n="filter_reset_btn">إعادة ضبط الفلاتر</span>'
)

# 7. Tree Details
content = content.replace(
    '<i data-lucide="arrow-right" class="w-4 h-4"></i>\n        <span>العودة إلى سوق الأشجار</span>',
    '<i data-lucide="arrow-right" class="w-4 h-4"></i>\n        <span data-i18n="tree_detail_back">العودة إلى سوق الأشجار</span>'
)

# 8. Dashboard
content = content.replace(
    '<p class="text-stone-600 text-xs mt-1">متابعة أداء أشجارك، الحصص المملوكة، والشهادات الرقمية المعتمدة</p>',
    '<p class="text-stone-600 text-xs mt-1" data-i18n="dash_subtitle">متابعة أداء أشجارك، الحصص المملوكة، والشهادات الرقمية المعتمدة</p>'
)
content = content.replace(
    '<i data-lucide="file-badge-2" class="w-4 h-4"></i>\n            <span>عرض شهادة الملكية الرقمية</span>',
    '<i data-lucide="file-badge-2" class="w-4 h-4"></i>\n            <span data-i18n="dash_btn_cert">عرض شهادة الملكية الرقمية</span>'
)
content = content.replace(
    '<i data-lucide="package" class="w-4 h-4"></i>\n            <span>طلب تسليم عبوات الزيت</span>',
    '<i data-lucide="package" class="w-4 h-4"></i>\n            <span data-i18n="dash_btn_order_oil">طلب تسليم عبوات الزيت</span>'
)
content = content.replace(
    '<span class="text-xs font-bold">إجمالي الاستثمار</span>',
    '<span class="text-xs font-bold" data-i18n="dash_stat_invest">إجمالي الاستثمار</span>'
)
content = content.replace(
    '<span class="text-[11px] text-olive-600 font-semibold">حصة 50% في شجرة معمرة</span>',
    '<span class="text-[11px] text-olive-600 font-semibold" data-i18n="dash_stat_invest_sub">حصة موثقة في شجرة معمرة</span>'
)
content = content.replace(
    '<span class="text-xs font-bold">إنتاج الزيت المتوقع</span>',
    '<span class="text-xs font-bold" data-i18n="dash_stat_oil">إنتاج الزيت المتوقع</span>'
)
content = content.replace(
    '<span class="text-[11px] text-stone-500 font-semibold">موسم خريف 2026</span>',
    '<span class="text-[11px] text-stone-500 font-semibold" data-i18n="dash_stat_oil_sub">موسم خريف 2026</span>'
)
content = content.replace(
    '<span class="text-xs font-bold">أثر امتصاص الكربون</span>',
    '<span class="text-xs font-bold" data-i18n="dash_stat_carbon">أثر امتصاص الكربون</span>'
)
content = content.replace(
    '<span class="text-[11px] text-emerald-600 font-semibold">مساهمة بيئية مستدامة</span>',
    '<span class="text-[11px] text-emerald-600 font-semibold" data-i18n="dash_stat_carbon_sub">مساهمة بيئية مستدامة</span>'
)
content = content.replace(
    '<span class="text-xs font-bold">الأشجار المملوكة</span>',
    '<span class="text-xs font-bold" data-i18n="dash_stat_trees">الأشجار المملوكة</span>'
)
content = content.replace(
    '<span class="text-[11px] text-stone-500 font-semibold">ريف طرطوس</span>',
    '<span class="text-[11px] text-stone-500 font-semibold" data-i18n="dash_stat_trees_sub">ريف طرطوس</span>'
)
content = content.replace(
    '<i data-lucide="trees" class="w-5 h-5 text-olive-700"></i>\n          <span>أشجاري في فسيلة</span>',
    '<i data-lucide="trees" class="w-5 h-5 text-olive-700"></i>\n          <span data-i18n="dash_tab_trees">أشجاري في فسيلة</span>'
)
content = content.replace(
    '<i data-lucide="receipt" class="w-5 h-5 text-olive-700"></i>\n          <span>سجل العمليات والمدفوعات</span>',
    '<i data-lucide="receipt" class="w-5 h-5 text-olive-700"></i>\n          <span data-i18n="dash_tab_txs">سجل العمليات والمدفوعات</span>'
)

# Dashboard Table Headers
content = content.replace(
    '<th class="py-3 px-4">رقم المرجع</th>\n                <th class="py-3 px-4">نوع العملية</th>\n                <th class="py-3 px-4">المبلغ</th>\n                <th class="py-3 px-4">وسيلة الدفع</th>\n                <th class="py-3 px-4">الحالة</th>\n                <th class="py-3 px-4">التاريخ</th>',
    '<th class="py-3 px-4" data-i18n="dash_tx_ref">رقم المرجع</th>\n                <th class="py-3 px-4" data-i18n="dash_tx_type">نوع العملية</th>\n                <th class="py-3 px-4" data-i18n="dash_tx_amount">المبلغ</th>\n                <th class="py-3 px-4" data-i18n="dash_tx_method">وسيلة الدفع</th>\n                <th class="py-3 px-4" data-i18n="dash_tx_status">الحالة</th>\n                <th class="py-3 px-4" data-i18n="dash_tx_date">التاريخ</th>'
)

# 9. Farmer Portal
content = content.replace(
    '<h1 class="text-2xl sm:text-3xl font-black">أهلاً بك يا عم أبو أحمد الطرطوسي 🌿</h1>',
    '<h1 class="text-2xl sm:text-3xl font-black" data-i18n="farmer_welcome_title">أهلاً بك يا عم أبو أحمد الطرطوسي 🌿</h1>'
)
content = content.replace(
    '<p class="text-stone-300 text-xs sm:text-sm">\n            مزرعة كروم الكردي العريقة • الدريكيش، طرطوس • لست بحاجة للكتابة، يمكنك توثيق كل أعمالك بالصوت مباشرة!\n          </p>',
    '<p class="text-stone-300 text-xs sm:text-sm" data-i18n="farmer_welcome_sub">\n            مزرعة كروم الكردي العريقة • الدريكيش، طرطوس • لست بحاجة للكتابة، يمكنك توثيق كل أعمالك بالصوت مباشرة!\n          </p>'
)
content = content.replace(
    '<h2 class="text-lg font-black text-stone-900">محفظة مستحقات وأتعاب الرعاية الزراعية</h2>',
    '<h2 class="text-lg font-black text-stone-900" data-i18n="farmer_wallet_title">محفظة مستحقات وأتعاب الرعاية الزراعية</h2>'
)
content = content.replace(
    '<p class="text-xs text-stone-500 mt-0.5">بدلات العمل الميداني المعتمدة من مساهمات المستثمرين لهذا الموسم</p>',
    '<p class="text-xs text-stone-500 mt-0.5" data-i18n="farmer_wallet_sub">بدلات العمل الميداني المعتمدة من مساهمات المستثمرين لهذا الموسم</p>'
)
content = content.replace(
    '<i data-lucide="arrow-down-left" class="w-4 h-4 text-amber-300"></i>\n            <span>طلب سحب نقدي (سيريتل كاش / الهرم)</span>',
    '<i data-lucide="arrow-down-left" class="w-4 h-4 text-amber-300"></i>\n            <span data-i18n="farmer_btn_payout">طلب سحب نقدي (سيريتل كاش / الهرم)</span>'
)
content = content.replace(
    '<span class="text-[11px] font-bold text-stone-500 block mb-1">إجمالي مستحقات الرعاية المعتمدة</span>',
    '<span class="text-[11px] font-bold text-stone-500 block mb-1" data-i18n="farmer_stat_total">إجمالي مستحقات الرعاية المعتمدة</span>'
)
content = content.replace(
    '<span class="text-[11px] font-bold text-emerald-800 block mb-1">الدفعة الجاهزة للصرف الفوري</span>',
    '<span class="text-[11px] font-bold text-emerald-800 block mb-1" data-i18n="farmer_stat_ready">الدفعة الجاهزة للصرف الفوري</span>'
)
content = content.replace(
    '<span class="text-[11px] font-bold text-stone-500 block mb-1">الأشجار الموكلة لرعايتك</span>',
    '<span class="text-[11px] font-bold text-stone-500 block mb-1" data-i18n="farmer_trees_section">الأشجار الموكلة لرعايتك</span>'
)
content = content.replace(
    '<i data-lucide="tree-pine" class="w-5 h-5 text-olive-700"></i>\n            <span>الأشجار المسجلة والتقارير الميدانية المباشرة</span>',
    '<i data-lucide="tree-pine" class="w-5 h-5 text-olive-700"></i>\n            <span data-i18n="farmer_trees_section">الأشجار المسجلة والتقارير الميدانية المباشرة</span>'
)
content = content.replace(
    '<i data-lucide="mic" class="w-5 h-5 text-emerald-700"></i>\n            <span>سجل الرسائل الصوتية الحقلية المرسلة للمستثمرين مؤخراً</span>',
    '<i data-lucide="mic" class="w-5 h-5 text-emerald-700"></i>\n            <span data-i18n="farmer_audio_feed_title">سجل الرسائل الصوتية الحقلية المرسلة للمستثمرين مؤخراً</span>'
)

# 10. Mill Portal
content = content.replace(
    '<h1 class="text-3xl font-black">معصرة الدريكيش الإيطالية الحديثة</h1>\n          <p class="text-stone-300 text-xs mt-1">المهندس سمير الدريكيشي • تقنية العصر البارد مرحلتين • طرطوس</p>',
    '<h1 class="text-3xl font-black" data-i18n="mill_title">معصرة الدريكيش الإيطالية الحديثة</h1>\n          <p class="text-stone-300 text-xs mt-1" data-i18n="mill_subtitle">المهندس سمير الدريكيشي • تقنية العصر البارد مرحلتين • طرطوس</p>'
)
content = content.replace(
    '<i data-lucide="clipboard-check" class="w-5 h-5 text-amber-600"></i>\n            <span>سجل دفعات العصر وشهادات التحليل المخبري</span>',
    '<i data-lucide="clipboard-check" class="w-5 h-5 text-amber-600"></i>\n            <span data-i18n="mill_batches_title">سجل دفعات العصر وشهادات التحليل المخبري</span>'
)
content = content.replace(
    '<th class="py-3 px-4">رقم الشهادة المخبرية</th>\n                <th class="py-3 px-4">الشجرة والمزرعة</th>\n                <th class="py-3 px-4">وزن الزيتون</th>\n                <th class="py-3 px-4">ناتج الزيت</th>\n                <th class="py-3 px-4">الحموضة %</th>\n                <th class="py-3 px-4">درجة الحرارة</th>\n                <th class="py-3 px-4">التصنيف</th>\n                <th class="py-3 px-4">الإجراء</th>',
    '<th class="py-3 px-4" data-i18n="mill_th_serial">رقم الشهادة المخبرية</th>\n                <th class="py-3 px-4" data-i18n="mill_th_tree">الشجرة والمزرعة</th>\n                <th class="py-3 px-4" data-i18n="mill_th_weight">وزن الزيتون</th>\n                <th class="py-3 px-4" data-i18n="mill_th_oil">ناتج الزيت</th>\n                <th class="py-3 px-4" data-i18n="mill_th_acidity">الحموضة %</th>\n                <th class="py-3 px-4" data-i18n="mill_th_temp">درجة الحرارة</th>\n                <th class="py-3 px-4" data-i18n="mill_th_grade">التصنيف</th>\n                <th class="py-3 px-4" data-i18n="mill_th_cert">الإجراء</th>'
)

# 11. Chat Panel Chips Container ID and Launcher
content = content.replace(
    '<span class="text-xs font-black tracking-wide">تحدث مع فسيلة</span>',
    '<span class="text-xs font-black tracking-wide" data-i18n="chat_launcher_text">تحدث مع فسيلة</span>'
)
content = content.replace(
    '<div class="p-2.5 bg-stone-50 border-b border-stone-200 flex gap-1.5 overflow-x-auto text-[11px] whitespace-nowrap scrollbar-none flex-shrink-0">',
    '<div id="chat-quick-chips" class="p-2.5 bg-stone-50 border-b border-stone-200 flex gap-1.5 overflow-x-auto text-[11px] whitespace-nowrap scrollbar-none flex-shrink-0">'
)
content = content.replace(
    '<i data-lucide="arrow-down" class="w-3 h-3 text-amber-400"></i>\n        <span>النزول للرسائل الأحدث</span>',
    '<i data-lucide="arrow-down" class="w-3 h-3 text-amber-400"></i>\n        <span data-i18n="chat_scroll_down">النزول للرسائل الأحدث</span>'
)

# 12. Footer
content = content.replace(
    '<p class="text-xs leading-relaxed text-stone-400">\n            أول منظومة زراعية تشاركية رقمية متكاملة لربط المزارعين والمعاصر بالمستثمرين والمغتربين مع رفيقك "فسيلة".\n          </p>',
    '<p class="text-xs leading-relaxed text-stone-400" data-i18n="footer_tagline">\n            أول منظومة زراعية تشاركية رقمية متكاملة لربط المزارعين والمعاصر بالمستثمرين والمغتربين مع رفيقك "فسيلة".\n          </p>'
)
content = content.replace(
    '<h4 class="text-white text-sm font-bold mb-3">البوابات والخدمات</h4>',
    '<h4 class="text-white text-sm font-bold mb-3" data-i18n="footer_portals_title">البوابات والخدمات</h4>'
)
content = content.replace(
    '<h4 class="text-white text-sm font-bold mb-3">طرق الدفع والتسوية</h4>',
    '<h4 class="text-white text-sm font-bold mb-3" data-i18n="footer_payment_title">طرق الدفع والتسوية</h4>'
)
content = content.replace(
    '<h4 class="text-white text-sm font-bold mb-3">الجودة والتواصل</h4>\n          <p class="text-xs leading-relaxed text-stone-400">\n            تحليل مخبري لكل دفعة عصر لضمان حموضة أقل من 0.4% مع إمكانية التحدث مع "فسيلة" في أي وقت للمساعدة.\n          </p>',
    '<h4 class="text-white text-sm font-bold mb-3" data-i18n="footer_quality_title">الجودة والتواصل</h4>\n          <p class="text-xs leading-relaxed text-stone-400" data-i18n="footer_quality_desc">\n            تحليل مخبري لكل دفعة عصر لضمان حموضة أقل من 0.4% مع إمكانية التحدث مع "فسيلة" في أي وقت للمساعدة.\n          </p>'
)
content = content.replace(
    '<span>© 2026 فسيلة (Faseela). جميع الحقوق محفوظة لمنصة الاستثمار الزراعي التشاركي.</span>',
    '<span data-i18n="footer_rights">© 2026 فسيلة (Faseela). جميع الحقوق محفوظة لمنصة الاستثمار الزراعي التشاركي.</span>'
)

# 13. Fix slider call in setLanguage
content = content.replace(
    "updateROICalculator(parseInt(document.getElementById('calc-shares')?.value || 1));",
    "updateROICalculator(parseInt(document.getElementById('roi-slider')?.value || 1));"
)

# 14. Expand i18n keys with additional keys
extra_ar = '''
        mill_batches_title: "سجل دفعات العصر وشهادات التحليل المخبري",
        footer_portals_title: "البوابات والخدمات",
        footer_payment_title: "طرق الدفع والتسوية",
        footer_quality_title: "الجودة والتواصل",
        footer_quality_desc: "تحليل مخبري لكل دفعة عصر لضمان حموضة أقل من 0.4% مع إمكانية التحدث مع \\"فسيلة\\" في أي وقت للمساعدة.",
        role_investor: "مستثمر",
        role_farmer: "مزارع شريك",
        role_mill: "صاحب معصرة",
        role_admin: "مدير النظام",
'''

extra_en = '''
        mill_batches_title: "Pressing Batches Log & Lab Test Certificates",
        footer_portals_title: "Portals & Services",
        footer_payment_title: "Payment & Settlement Options",
        footer_quality_title: "Purity & Support",
        footer_quality_desc: "Certified lab testing for every batch ensuring acidity < 0.4%, with \\"Faseela\\" advisor available 24/7.",
        role_investor: "Investor",
        role_farmer: "Partner Farmer",
        role_mill: "Mill Owner",
        role_admin: "System Admin",
'''

if 'mill_batches_title' not in content:
    content = content.replace('mill_title: "بوابة أصحاب معاصر الزيتون الحديثة (Olive Mills)",', 'mill_title: "بوابة أصحاب معاصر الزيتون الحديثة (Olive Mills)",\n' + extra_ar)
    content = content.replace('mill_title: "Modern Olive Mills Portal",', 'mill_title: "Modern Olive Mills Portal",\n' + extra_en)

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Replacement pass 1 complete.")
