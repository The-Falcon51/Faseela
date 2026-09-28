# دليل الإطلاق والاعتماد في متجري التطبيقات: Google Play & Apple App Store 📱🌿

يقدم هذا الدليل المرجع الفني والقانوني والتنظيمي الشامل لنشر تطبيق **فسيلة (Faseela)** على متجر **Google Play Store** (لأجهزة أندرويد) ومتجر **Apple App Store** (لأجهزة آيفون)، بما يضمن استيفاء أعلى معايير الجودة والامتثال لسياسات المطورين وتفادي أسباب الرفض الشائعة.

---

## 📌 1. بطاقة تعريف التطبيق (App Identity & Identifiers)

| البند | القيمة الرسمية المعتمدة |
|---|---|
| **اسم التطبيق (App Name)** | `فسيلة` (Faseela) |
| **عنوان المتجر (Store Title)** | `فسيلة | الاستثمار في أشجار الزيتون` (Faseela: Olive Tree Stewardship) |
| **المعرف الفريد (Package ID / Bundle ID)** | `com.faseela.app` |
| **الإصدار الأولي (Initial Version)** | `1.0.0` (Build `1`) |
| **التصنيف الأساسي (Primary Category)** | أعمال / زراعة تكنولوجية (Business / Agriculture) |
| **التصنيف الثانوي (Secondary Category)** | نمط حياة / خدمات مالية (Lifestyle / Utilities) |
| **الفئة العمرية (Content Rating)** | للجميع (4+ على آبل / 3+ PEGI على جوجل) |
| **الموقع الرسمي وسياسة الخصوصية** | `https://faseela.sy` / `https://faseela.sy/privacy.html` |

---

## 🤖 2. خطوات النشر على متجر جوجل بلاي (Google Play Store)

### أ. إنشاء مفتاح التوقيع الرقمي للإنتاج (Release Keystore):
من خلال الطرفية (Terminal)، يتم توليد مفتاح التوقيع الخاص بنسخة الإنتاج:
```bash
keytool -genkey -v -keystore faseela-release.keystore \
  -alias faseela-key -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Faseela Agritech, OU=Mobile, O=Faseela, L=Tartus, C=SY"
```
> [!IMPORTANT]
> احتفظ بملف `faseela-release.keystore` وكلمة المرور في مكان آمن ومشفّر، حيث يلزم لتوقيع أي تحديثات مستقبلية.

### ب. تكوين التوقيع في ملف `android/app/build.gradle`:
أضف إعدادات التوقيع داخل كتلة `android`:
```groovy
signingConfigs {
    release {
        storeFile file("faseela-release.keystore")
        storePassword "YOUR_STORE_PASSWORD"
        keyAlias "faseela-key"
        keyPassword "YOUR_KEY_PASSWORD"
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled true
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
}
```

### ج. بناء حزمة التطبيق المجمعة (Android App Bundle - AAB):
تفرض جوجل استخدام صيغة `AAB` بدلاً من `APK` للإصدارات الجديدة:
```bash
cd android
./gradlew bundleRelease
```
الملف الناتج سيكون في المسار:  
`android/app/build/outputs/bundle/release/app-release.aab`

### د. إعدادات حساب Google Play Console:
1. تسجيل الدخول إلى [Google Play Console](https://play.google.com/console).
2. النقر على **Create App** وإدخال اسم التطبيق `Faseela`، وتحديد اللغة الافتراضية (العربية).
3. استكمال استبيانات أمان البيانات (**Data Safety Form**):
   - الموقع الجغرافي التقريبي والدقيق: لتحديد موقع محطة الرصد الزراعي (لا يتم مشاركتها مع أطراف ثالثة).
   - الميكروفون: لتسجيل التقارير الصوتية للمزارع الشريك (بيانات مشفرة أثناء النقل).
4. إطلاق مسار **Closed Testing**: دعوة 20 مختبراً على الأقل واستيفاء مدة الـ 14 يوماً الإلزامية للمطورين الجدد قبل التحويل إلى **Production**.

---

## 🍏 3. خطوات النشر على متجر آبل (Apple App Store)

### أ. اشتراك برنامج مطوري آبل (Apple Developer Program):
- التسجيل في [developer.apple.com](https://developer.apple.com) بحساب شركة أو فرد ($99/سنوياً).
- إنشاء **App ID**: `com.faseela.app` مع تفعيل إمكانيات الإشعارات (Push Notifications).

### ب. فتح المشروع في بيئة Xcode وضبط الشهادات:
من مجلد المشروع:
```bash
npx cap open ios
```
أو فتح الملف مباشرة:  
`ios/App/App.xcworkspace` (أو `App.xcodeproj`) داخل Xcode:
1. في تبويب **Signing & Capabilities**: اختر فريق التطوير الخاص بك (**Team**) ليقوم Xcode بإنشاء شهادات `Distribution Certificate` والـ `Provisioning Profile` تلقائياً.
2. التحقق من رقم الإصدار `1.0.0` ورقم البناء `1`.
3. التحقق من إدراج نصوص تبرير الأذونات في `Info.plist`:
   - `NSMicrophoneUsageDescription`: لتسجيل تقارير المزارع الصوتية.
   - `NSCameraUsageDescription`: لمسح رموز شهادات الجودة.
   - `NSLocationWhenInUseUsageDescription`: لعرض إحداثيات بساتين الزيتون.

### ج. أرشفة ورفع التطبيق عبر Xcode:
1. اختر الهدف: **Any iOS Device (arm64)**.
2. من القائمة العلوية: **Product ➔ Archive**.
3. بعد اكتمال الأرشفة في نافذة **Organizer**: انقر على **Distribute App ➔ App Store Connect ➔ Upload**.
4. سيتم فحص التطبيق ورفعه مباشرة إلى منصة **App Store Connect**.

### د. إدارة الإصدار في App Store Connect:
1. فتح [appstoreconnect.apple.com](https://appstoreconnect.apple.com) واختيار تطبيق **Faseela**.
2. تفعيل خدمة **TestFlight** لإجراء اختبارات تجريبية داخلية وخارجية.
3. الإجابة عن استبيان التشفير (**Export Compliance**): اختيار **No** (التطبيق لا يستخدم تشفيراً عسكرياً معقداً أو خاصاً، بل التشفير القياسي HTTPS/TLS).

---

## 🛡️ 4. استراتيجية اجتياز مراجعة آبل (Apple Review Guidelines)

> [!IMPORTANT]
> **تفادي عمولة الـ 30% لنظام الشراء داخل التطبيق (In-App Purchases):**
> تنص المادة **3.1.5 (Physical Goods and Services outside of the App)** من إرشادات مراجعة آبل على أن التطبيقات التي تتيح شراء سلع وبضائع مادية حقيقية أو خدمات تؤدى على أرض الواقع خارج العالم الافتراضي **يجب ألا تستخدم** نظام الدفع داخل التطبيق التابع لآبل (IAP)، بل يسمح لها باستخدام الدفع الخارجي والمحلي (مثل البطاقات، وسيريتل كاش، والهرم).
> 
> **نص التوضيح لفريق مراجعة آبل (App Review Note):**
> يتم إدراجه في خانة *Notes for Reviewer* في App Store Connect:
> ```text
> Note to App Review Team:
> Faseela is an agritech fractional stewardship platform for physical, real-world agricultural assets. 
> Users acquire legally recorded agricultural usufruct stewardship rights over living century-old olive trees rooted in Tartus and Idlib, Syria. 
> The platform facilitates tangible physical agricultural maintenance (pruning, irrigation, pest bio-control) executed by local partner farmers, and culminates in the physical cold-pressing and delivery of tangible bottles of Extra Virgin Olive Oil (EVOO) to investors or local monetization.
> In accordance with App Store Review Guideline 3.1.5 (Physical Goods and Services), all transactions relate strictly to real-world physical commodities and agrarian labor, and therefore do not utilize digital In-App Purchases (IAP).
> Demo credentials for testing:
> Username: investor_demo / Password: verified_otp
> ```

---

## 📝 5. بيانات ونصوص النشر الجاهزة للمتجرين (Store Copy & Metadata)

### باللغة العربية (Arabic Listing):
- **عنوان التطبيق:** `فسيلة | استثمار أشجار الزيتون`
- **العنوان الفرعي / الوصف القصير (80 حرفاً):**  
  `امتلك سندات حيازة أشجار الزيتون المعمرة في سوريا واستلم زيتك البكر الممتاز.`
- **الوصف الترويجي الكامل (Full Description):**
  ```text
  فسيلة (Faseela) هي المنصة الرقمية التشاركية الرائدة التي تربطك مباشرة بأعرق بساتين الزيتون في سوريا (طرطوس، إدلب، درعا، ريف دمشق). 
  
  من خلال فسيلة، يمكنك تملك حصص زراعية موثقة وسندات حيازة كاداسترية رسمية على أشجار زيتون معمرة تمتد جذورها لمئات السنين، متضمنة 5 أمتار مربعة من الأرض الزراعية الخصبة المحيطة بالشجرة.
  
  مميزات تطبيق فسيلة:
  🌿 سوق أشجار الزيتون: استكشف الأشجار التراثية المعمرة (الخضيري، الصوراني، القيسي) مع إحداثيات GPS وبيانات التربة والمناخ.
  📜 سندات حيازة رسمية: احصل على صكوك ملكية رقمية معتمدة برقم تسلسلي وكاداستري موثق يضمن حقوقك الزراعية.
  👨‍🌾 شراكة مع المزارع المحلي: تابع أعمال التقليم، والري بمياه الينابيع العذبة، والمكافحة الحيوية العضوية عبر تسجيلات وتقارير صوتية حقلية دورية.
  🫒 معاصر حديثة وشهادات جودة: متابعة دقيقة لمراحل العصر البارد الإيطالي مرحلتين (2-Phase) واستعراض شهادات الفحص المخبري لنسبة الحموضة (<0.32%) والبوليفينول.
  🚚 خيارات مرنة للمحصول: استلم زيت الزيتون البكر الممتاز معبأ بعبوات تنك مفحوصة إلى باب منزلك، أو قم بتسييل عوائدك النقدية فوراً.
  💳 وسائل دفع محلية ودولية ميسرة: دعم كامل للتحويلات عبر سيريتل كاش، وشركة الهرم، والبطاقات المصرفية، مع سجل مالي متكامل.
  
  فسيلة.. جذور عريقة تثمر في مستقبلك.
  ```
- **الكلمات المفتاحية (Keywords):**  
  `زيتون,استثمار زراعي,زيت زيتون,فسيلة,سوريا,طرطوس,بكر ممتاز,طابو زراعي,سيريتل كاش,شراكة زراعية,أشجار معمرة`

### باللغة الإنجليزية (English Listing):
- **App Title:** `Faseela: Olive Tree Invest`
- **Subtitle / Short Description (80 chars):**  
  `Own fractional heritage olive trees in Syria & receive certified extra virgin oil.`
- **Full Description:**
  ```text
  Faseela is the premier agritech stewardship platform connecting diaspora and local investors directly with ancient Syrian olive groves in Tartus, Idlib, and Daraa.

  Through Faseela, acquire verified fractional agricultural usufruct deeds on century-old olive trees, including 5 square meters of fertile cadastral land surrounding each tree.

  Key Features:
  🌿 Heritage Olive Marketplace: Browse historical Khodairi, Sourani, and Qaisi olive trees backed by live microclimate and soil telemetry.
  📜 Official Digital Usufruct Deeds: Receive cryptographically verified digital title deeds with unique cadastral registry references.
  👨‍🌾 Partner Farmer Stewardship: Listen to periodic voice logs and maintenance audio reports from our generational partner farmers.
  🫒 Cold-Press Mill & Lab Certificates: Access certified Italian 2-phase cold extraction metrics, acidity titration (<0.32%), and spectrophotometric UV lab analysis.
  🚚 Physical Oil Delivery or Cash Monetization: Receive your seasonal Extra Virgin Olive Oil delivered directly in food-grade tinplate containers, or monetize your share into cash.
  💳 Multi-Channel Local & Global Payments: Full support for Syriatel Cash, Al-Haram Exchange, and international cards with an authenticated transactions ledger.

  Invest in living Mediterranean heritage with Faseela.
  ```
- **Keywords:**  
  `olive tree,syria,evoo,olive oil,fractional,agritech,stewardship,tartus,agriculture,investment,faseela`

---

## 📐 6. متطلبات لقطات الشاشة (Screenshots Guidelines)

لضمان قبول التطبيق من المرة الأولى، يجب تجهيز 4 إلى 5 لقطات شاشة (Screenshots) بالمقاسات التالية:
1. **Apple iOS (App Store):**
   - شاشة 6.7 بوصة (iPhone 15/16 Pro Max): بدقة `1290 x 2796 pixels`.
   - شاشة 6.5 بوصة (iPhone 11 Pro Max / XS Max): بدقة `1242 x 2688 pixels`.
2. **Google Android (Play Store):**
   - شاشات الهواتف: بدقة `1080 x 2400 pixels` (نسبة 16:9 أو 20:9).
   - نسبة العرض لا تقل عن 320 بكسل ولا تزيد عن 3840 بكسل.

### اللقطات المقترحة:
- **اللقطة 1:** واجهة سوق الأشجار مع الشجرة المعمرة (حارسة الجبل) ونسبة العائد السنوي 24.8%.
- **اللقطة 2:** سند الحيازة الزراعي الرسمي الموثق برقم القيد الكاداستري والخاتم الأخضر.
- **اللقطة 3:** محطة الرصد المناخي للحقل وتقارير المزارع الصوتية المباشرة.
- **اللقطة 4:** شهادة التحليل المخبري لجودة زيت الزيتون البكر الممتاز (حموضة 0.24%).
- **اللقطة 5:** لوحة تحكم المستثمر وخيارات استلام وشحن الزيت والتسييل النقدي.
