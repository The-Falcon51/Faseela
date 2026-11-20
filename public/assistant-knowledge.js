// Faseela assistant knowledge: the topics the chat and voice assistant answers first, in Arabic, English and
// German, and the matching of a question to a topic. Split out of app.js (first module of the planned split).
//
// Loaded as a classic script next to app.js: the functions below are globals that app.js calls at run time
// (faseelaFaqAnswer, faseelaSpeechLang), and they use two globals of app.js when called (state, escapeHtml).
// Nothing here runs at load time.
'use strict';

// ============================================================
// Assistant knowledge layer (answers first, before the legacy keyword rules below)
// ============================================================
// Each topic states only what the platform does today. Offers that are switched off (land parcels,
// greenfield plots, resale between users, insurance, reinvestment) are answered as "not offered",
// so the older rule set can no longer describe them as available. Answers exist in Arabic, English
// and German; keywords of all three languages match regardless of the interface language.
const FASEELA_FAQ_ACTIONS = {
  market: (label) => `<button type="button" data-click="navigateTo('marketplace')" class="bg-olive-800 hover:bg-olive-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">${label}</button>`,
  dates: (label) => `<button type="button" data-click="navigateTo('marketplace'); setCropCategoryFilter('date')" class="bg-olive-800 hover:bg-olive-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">${label}</button>`,
  dashboard: (label) => `<button type="button" data-click="navigateTo('dashboard')" class="bg-olive-800 hover:bg-olive-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">${label}</button>`,
  signin: (label) => `<button type="button" data-click="openAuthModal()" class="bg-olive-800 hover:bg-olive-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">${label}</button>`,
  privacy: (label) => `<a href="legal/datenschutz.html" class="inline-block bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 px-3 py-1.5 rounded-lg text-xs font-bold">${label}</a>`,
  imprint: (label) => `<a href="legal/impressum.html" class="inline-block bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 px-3 py-1.5 rounded-lg text-xs font-bold">${label}</a>`,
  verify: (label) => `<a href="verify.html" class="inline-block bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 px-3 py-1.5 rounded-lg text-xs font-bold">${label}</a>`
};
const FASEELA_FAQ_LABELS = {
  market: { ar: 'تصفح الأشجار', en: 'Browse trees', de: 'Bäume ansehen' },
  dates: { ar: 'عرض أشجار النخيل', en: 'Show date palms', de: 'Dattelpalmen anzeigen' },
  dashboard: { ar: 'فتح لوحتي', en: 'Open my dashboard', de: 'Mein Bereich' },
  signin: { ar: 'تسجيل الدخول / إنشاء حساب', en: 'Sign in / Register', de: 'Anmelden / Registrieren' },
  privacy: { ar: 'سياسة الخصوصية', en: 'Privacy policy', de: 'Datenschutzerklärung' },
  imprint: { ar: 'بيانات الناشر', en: 'Legal notice', de: 'Impressum' },
  verify: { ar: 'التحقق من شهادة', en: 'Verify a certificate', de: 'Zertifikat prüfen' }
};
// claims-ratchet:off
const FASEELA_FAQ = [
  { id: 'dates', action: 'dates',
    k: ['dattel*', 'date palm*', 'dates', 'palme*', 'palm tree', 'khastawi', 'zahidi', 'barhi', 'palmyra', 'تمر', 'تمور', 'نخيل', 'نخله', 'نخل', 'خستاوي', 'زهدي', 'برحي', 'رطب'],
    a: {
      ar: ['نخيل التمر هو المحصول السادس في فسيلة. يُزرع في سوريا في واحة تدمر وعلى امتداد الفرات بين دير الزور والبوكمال، ومن أصنافه الخستاوي والزهدي والبرحي.', 'تمر الثمرة بمراحل الكمري ثم الخلال ثم الرطب ثم التمر. يُلقَّح النخل يدوياً في الربيع، وتُكيَّس العذوق صيفاً، ويبدأ القطاف من أيلول حتى تشرين الثاني.', 'تظهر أشجار النخيل في السوق عند إدراجها من فريق المنصة. تسليم محصول المحاصيل غير الزيتون قيد الإعداد وسيُعلن عنه قبل أول موسم.'],
      en: ['The date palm is the sixth crop on Faseela. In Syria it grows in the Palmyra oasis and along the Euphrates between Deir ez-Zor and Al-Bukamal; cultivars include Khastawi, Zahidi and Barhi.', 'The fruit passes through four stages: kimri, khalal, rutab and tamr. Palms are pollinated by hand in spring, bunches are bagged in summer, and picking runs from September to November.', 'Date palms appear in the market once the team has listed them. Harvest delivery for crops other than olives is still being set up and will be announced before the first season.'],
      de: ['Die Dattelpalme ist die sechste Kultur bei Faseela. In Syrien wächst sie in der Oase von Palmyra und entlang des Euphrat zwischen Deir ez-Zor und Al-Bukamal; angebaut werden unter anderem Khastawi, Zahidi und Barhi.', 'Die Frucht durchläuft vier Stufen: Kimri, Khalal, Rutab und Tamr. Bestäubt wird im Frühjahr von Hand, im Sommer werden die Fruchtstände eingehüllt, geerntet wird von September bis November.', 'Dattelpalmen erscheinen im Markt, sobald das Team sie freigeschaltet hat. Die Auslieferung der Ernte für andere Kulturen als Oliven wird noch eingerichtet und vor der ersten Saison bekannt gegeben.']
    } },
  { id: 'crops', action: 'market',
    k: ['which crops', 'what crops', 'welche kulturen', 'welche bäume', 'welche baeume', 'which trees', 'kinds of trees', 'pistazie*', 'pistachio*', 'mandel*', 'almond*', 'walnuss*', 'walnut*', 'granatapfel*', 'pomegranate*', 'اي محاصيل', 'انواع الاشجار', 'المحاصيل', 'فستق', 'لوز', 'جوز', 'رمان'],
    a: {
      ar: ['تضم فسيلة ستة محاصيل: الزيتون، الفستق الحلبي، اللوز، الرمان، نخيل التمر، والجوز. الزيتون هو المحصول المكتمل اليوم من الكفالة حتى استلام الزيت.', 'المحاصيل الأخرى تُدرج في السوق تباعاً، وطريقة تسليم محصولها قيد الإعداد. لكل محصول تقويم موسمي ودليل أصناف في الصفحة الرئيسية.'],
      en: ['Faseela covers six crops: olive, Aleppo pistachio, almond, pomegranate, date palm and walnut. Olive is the one that works end to end today, from sponsorship to receiving oil.', 'The other crops are listed step by step, and how their harvest is delivered is still being set up. Each crop has a seasonal calendar and a cultivar guide on the home page.'],
      de: ['Faseela umfasst sechs Kulturen: Olive, Aleppo-Pistazie, Mandel, Granatapfel, Dattelpalme und Walnuss. Vollständig von der Patenschaft bis zum Öl funktioniert heute die Olive.', 'Die übrigen Kulturen werden nach und nach freigeschaltet; wie ihre Ernte ausgeliefert wird, ist noch in Vorbereitung. Zu jeder Kultur gibt es auf der Startseite einen Saisonkalender und einen Sortenführer.']
    } },
  { id: 'how', action: 'market',
    k: ['how does it work', 'how it works', 'how does faseela', 'what is faseela', 'was ist faseela', 'wie funktioniert', 'how do i start', 'wie fange ich an', 'get started', 'ما هي فسيله', 'ما هو فسيله', 'كيف تعمل', 'كيف يعمل', 'كيف ابدا', 'شرح المنصه', 'فكره المنصه'],
    a: {
      ar: ['فسيلة تربطك مباشرةً بمزارع سوري معروف بالاسم: تكفل حصة من شجرة، يتابعها المزارع ويرسل تقارير من الحقل، وبعد القطاف والعصر تحصل على حصتك من المحصول.', 'الخطوات: اختر شجرة، أرسل طلب الكفالة، حوّل المبلغ بالطريقة المعروضة وارفع إيصال الدفع، وبعد مراجعة الفريق تُسجَّل الحصة باسمك وتحصل على شهادة.'],
      en: ['Faseela connects you directly with a named Syrian farmer: you sponsor a share of a tree, the farmer tends it and sends reports from the field, and after harvest and pressing you receive your share of the crop.', 'The steps: choose a tree, send a sponsorship request, transfer the amount by the method shown and upload the payment receipt; once the team has checked it, the share is recorded in your name and you receive a certificate.'],
      de: ['Faseela verbindet Sie direkt mit einem namentlich bekannten syrischen Landwirt: Sie übernehmen die Patenschaft für einen Anteil an einem Baum, der Landwirt pflegt ihn und berichtet vom Feld, und nach Ernte und Pressung erhalten Sie Ihren Anteil am Ertrag.', 'Der Ablauf: Baum auswählen, Patenschaft anfragen, den Betrag auf dem angezeigten Weg überweisen und den Zahlungsbeleg hochladen; nach der Prüfung durch das Team wird der Anteil auf Ihren Namen eingetragen und Sie erhalten ein Zertifikat.']
    } },
  { id: 'not_investment',
    k: ['investment*', 'invest*', 'return on', 'roi', 'profit*', 'dividend*', 'interest', 'guarantee*', 'geldanlage', 'rendite*', 'gewinn*', 'zinsen*', 'garantie*', 'investition*', 'استثمار', 'ارباح', 'ربح', 'عائد', 'عوائد', 'مضمون', 'فائده', 'فوائد'],
    a: {
      ar: ['كفالة الشجرة ليست استثماراً مالياً: لا فوائد ولا أرباح نقدية ولا عائد مضمون. ما تحصل عليه هو حصتك من محصول الشجرة.', 'كمية المحصول تتغير من موسم إلى آخر بحسب الطقس وحال الشجرة، وقد تكون أقل من المتوقع. الأرقام المعروضة تقديرات وليست وعوداً.'],
      en: ['Sponsoring a tree is not a financial investment: there is no interest, no cash profit and no guaranteed return. What you receive is your share of the tree\'s harvest.', 'The harvest varies from season to season with the weather and the condition of the tree, and it can be smaller than expected. Figures shown are estimates, not promises.'],
      de: ['Eine Baumpatenschaft ist keine Geldanlage: Es gibt keine Zinsen, keinen Geldgewinn und keine garantierte Rendite. Sie erhalten Ihren Anteil an der Ernte des Baumes.', 'Der Ertrag schwankt von Saison zu Saison mit dem Wetter und dem Zustand des Baumes und kann geringer ausfallen als erwartet. Angezeigte Mengen sind Schätzungen, keine Zusagen.']
    } },
  { id: 'land_off',
    k: ['land', 'parcel', 'plot', 'deed', 'tabu', 'cadastral', 'usufruct', 'grundstück*', 'grundstueck*', 'parzelle*', 'grundbuch', 'boden kaufen', 'ارض', 'مقسم', 'طابو', 'كاداستر', 'سند حيازه', 'ملكيه الارض', 'صك'],
    a: {
      ar: ['باقة «الشجرة مع قطعة أرض» غير متاحة حالياً. تقتصر الكفالة اليوم على حصص الشجرة ومحصولها.', 'من سبق أن سُجّلت له حصة تتضمن أرضاً يجدها كما هي في لوحته.'],
      en: ['The "tree with a land parcel" package is currently not offered. Sponsorship today covers shares of the tree and its harvest only.', 'If a share that includes land was already recorded for you, it stays visible in your dashboard as it is.'],
      de: ['Das Paket „Baum mit Grundstücksparzelle“ wird derzeit nicht angeboten. Die Patenschaft umfasst heute ausschließlich Anteile am Baum und an seiner Ernte.', 'Wurde für Sie bereits ein Anteil mit Parzelle eingetragen, bleibt er unverändert in Ihrem Bereich sichtbar.']
    } },
  { id: 'greenfield_off', action: 'market',
    k: ['greenfield', 'virgin', 'sapling*', 'new planting', 'neupflanzung', 'setzling*', 'jungpflanze', 'junge bäume', 'بكر', 'غراس', 'غرسه', 'شتله', 'ارض بكر', 'بستان جديد'],
    a: {
      ar: ['بساتين الغراس البكر مع الأرض غير متاحة حالياً. يمكنك كفالة حصص في الأشجار القائمة المعروضة في السوق.'],
      en: ['Greenfield groves with young saplings and land are currently not offered. You can sponsor shares of the established trees listed in the market.'],
      de: ['Neupflanzungen mit Setzlingen und Land werden derzeit nicht angeboten. Sie können Patenschaften für die bestehenden Bäume im Markt übernehmen.']
    } },
  { id: 'resale_off',
    k: ['p2p', 'secondary market', 'resell', 'sell my share', 'sell share', 'trade share', 'weiterverkauf*', 'verkaufen*', 'handel', 'zweitmarkt', 'سوق ثانوي', 'تداول', 'بيع حصه', 'بيع حصتي', 'اعاده بيع'],
    a: {
      ar: ['بيع الحصص أو تداولها بين المستخدمين غير متاح حالياً. يمكنك إهداء حصة إلى شخص آخر عبر رمز إهداء من لوحتك.'],
      en: ['Selling or trading shares between users is currently not available. You can give a share to someone else with a gift code from your dashboard.'],
      de: ['Der Verkauf oder Handel von Anteilen zwischen Nutzern ist derzeit nicht möglich. Sie können einen Anteil über einen Geschenkcode aus Ihrem Bereich an eine andere Person verschenken.']
    } },
  { id: 'payment', action: 'market',
    k: ['pay', 'payment*', 'bank transfer', 'receipt', 'credit card', 'paypal', 'visa', 'zahlen*', 'zahlung*', 'bezahlen*', 'überweisung*', 'ueberweisung*', 'kreditkarte', 'beleg', 'دفع', 'ادفع', 'سداد', 'تحويل', 'حواله', 'ايصال', 'بطاقه', 'فيزا'],
    a: {
      ar: ['الدفع يتم بتحويل إلى إحدى قنوات الدفع التي تظهر لك في نافذة طلب الكفالة. بعد التحويل ترفع صورة الإيصال في الطلب نفسه.', 'يراجع فريق المالية الإيصال، وعند اعتماده تُسجَّل الحصة باسمك. الدفع بالبطاقة مباشرةً داخل التطبيق غير متاح حالياً.'],
      en: ['You pay by transfer to one of the payment channels shown in the sponsorship request dialog. After the transfer you upload a picture of the receipt in the same request.', 'The finance team checks the receipt; once it is approved, the share is recorded in your name. Paying by card inside the app is currently not available.'],
      de: ['Bezahlt wird per Überweisung auf einen der Zahlungswege, die im Dialog der Patenschaftsanfrage angezeigt werden. Danach laden Sie in derselben Anfrage ein Bild des Zahlungsbelegs hoch.', 'Das Finanzteam prüft den Beleg; nach der Freigabe wird der Anteil auf Ihren Namen eingetragen. Kartenzahlung direkt in der App gibt es derzeit nicht.']
    } },
  { id: 'price', action: 'market',
    k: ['price', 'cost', 'how much', 'fee', 'fees', 'preis', 'kosten*', 'kostet', 'wie viel', 'wieviel', 'gebühr*', 'gebuehr*', 'سعر', 'اسعار', 'تكلفه', 'كم يكلف', 'بكم', 'رسوم', 'عموله'],
    a: {
      ar: ['سعر الحصة ظاهر على بطاقة كل شجرة، والمبلغ النهائي يؤكده الخادم عند إرسال الطلب ويظهر لك قبل الدفع.', 'تفاصيل الشحن وأي تكاليف مرتبطة به يوضحها لك الفريق قبل إرسال أي شيء.'],
      en: ['The price per share is shown on each tree card; the final amount is confirmed by the server when you send the request and is shown to you before you pay.', 'Shipping details and any related costs are clarified with you by the team before anything is sent.'],
      de: ['Der Preis je Anteil steht auf jeder Baumkarte; der endgültige Betrag wird beim Absenden der Anfrage vom Server bestätigt und Ihnen vor der Zahlung angezeigt.', 'Einzelheiten zum Versand und damit verbundene Kosten klärt das Team mit Ihnen, bevor etwas verschickt wird.']
    } },
  { id: 'oil', action: 'dashboard',
    k: ['olive oil', 'my oil', 'delivery', 'deliver*', 'shipping', 'ship', 'pickup', 'receive', 'olivenöl', 'olivenoel', 'lieferung*', 'liefern*', 'versand*', 'abholung*', 'abholen*', 'زيت', 'زيتي', 'استلام', 'توصيل', 'شحن', 'تسليم'],
    a: {
      ar: ['بعد القطاف تُعصر الثمار في المعصرة، وتُعتمد الدفعة بعد فحص الجودة، ثم تُخصَّص لك كمية الزيت بحسب حصتك وتظهر في لوحتك.', 'من اللوحة تطلب التسليم إلى عنوانك أو الاستلام، ويتواصل معك الفريق لترتيب التفاصيل.'],
      en: ['After the harvest the fruit is pressed at the mill and the batch is certified after a quality check; your oil is then allocated according to your share and appears in your dashboard.', 'From the dashboard you request delivery to your address or a pickup, and the team contacts you to arrange the details.'],
      de: ['Nach der Ernte werden die Früchte in der Mühle gepresst und die Charge nach der Qualitätsprüfung freigegeben; anschließend wird Ihnen das Öl entsprechend Ihrem Anteil zugeteilt und erscheint in Ihrem Bereich.', 'Dort beantragen Sie die Lieferung an Ihre Adresse oder die Abholung; das Team meldet sich, um die Einzelheiten abzustimmen.']
    } },
  { id: 'certificate', action: 'verify',
    k: ['certificate*', 'serial', 'verify', 'proof of', 'zertifikat*', 'urkunde', 'seriennummer', 'nachweis', 'prüfen', 'شهاده', 'شهادتي', 'رقم تسلسلي', 'تحقق', 'اثبات'],
    a: {
      ar: ['لكل حصة معتمدة شهادة بصيغة PDF تحمل رقماً تسلسلياً، وتجدها في لوحتك عند الحصة.', 'يمكن لأي شخص التحقق من صحة الشهادة بإدخال رقمها التسلسلي في صفحة التحقق.'],
      en: ['Every approved share comes with a PDF certificate carrying a serial number; you find it next to the share in your dashboard.', 'Anyone can check that a certificate is genuine by entering its serial number on the verification page.'],
      de: ['Zu jedem freigegebenen Anteil gibt es ein PDF-Zertifikat mit Seriennummer; Sie finden es in Ihrem Bereich beim jeweiligen Anteil.', 'Die Echtheit eines Zertifikats kann jeder prüfen, indem er die Seriennummer auf der Prüfseite eingibt.']
    } },
  { id: 'gift', action: 'dashboard',
    k: ['gift*', 'redeem*', 'referral', 'invite a friend', 'geschenk*', 'verschenken*', 'einlösen', 'einloesen', 'empfehlung', 'freunde werben', 'هديه', 'اهداء', 'اهدي', 'رمز', 'دعوه', 'احاله'],
    a: {
      ar: ['يمكنك إهداء حصة: تنشئ رمز إهداء من لوحتك وترسله إلى من تحب، فيسجّل حساباً ويُدخل الرمز لتنتقل الحصة إليه.', 'ولديك رابط دعوة شخصي تشاركه مع معارفك. من وصله رمز إهداء يُدخله بعد تسجيل الدخول.'],
      en: ['You can give a share as a gift: create a gift code in your dashboard and send it to the recipient, who signs up and enters the code to receive the share.', 'You also have a personal referral link to share. If you received a gift code, enter it after signing in.'],
      de: ['Sie können einen Anteil verschenken: Erstellen Sie in Ihrem Bereich einen Geschenkcode und senden Sie ihn der beschenkten Person; sie registriert sich und gibt den Code ein, um den Anteil zu erhalten.', 'Außerdem haben Sie einen persönlichen Empfehlungslink. Wer einen Geschenkcode erhalten hat, gibt ihn nach der Anmeldung ein.']
    } },
  { id: 'account', action: 'privacy',
    k: ['delete my account', 'delete account', 'export my data', 'my data', 'privacy', 'gdpr', 'konto löschen', 'konto loeschen', 'daten exportieren', 'meine daten', 'datenschutz', 'dsgvo', 'حذف حسابي', 'احذف حسابي', 'حذف الحساب', 'بياناتي', 'تصدير', 'خصوصيه'],
    a: {
      ar: ['من إعدادات ملفك الشخصي يمكنك تنزيل نسخة من بياناتك، وحذف حسابك نهائياً.', 'تفاصيل البيانات التي نعالجها وحقوقك موضحة في سياسة الخصوصية.'],
      en: ['In your profile settings you can download a copy of your data and delete your account permanently.', 'Which data is processed and what your rights are is explained in the privacy policy.'],
      de: ['In den Profileinstellungen können Sie eine Kopie Ihrer Daten herunterladen und Ihr Konto dauerhaft löschen.', 'Welche Daten verarbeitet werden und welche Rechte Sie haben, steht in der Datenschutzerklärung.']
    } },
  { id: 'signup', action: 'signin',
    k: ['register', 'sign up', 'create account', 'log in', 'login', 'password', 'registrier*', 'anmelden*', 'konto erstellen', 'passwort', 'تسجيل', 'انشاء حساب', 'دخول', 'كلمه المرور', 'كلمه السر'],
    a: {
      ar: ['تنشئ حساباً بالبريد الإلكتروني وكلمة مرور، ثم تؤكد بريدك عبر الرسالة التي تصلك. إن نسيت كلمة المرور فاستخدم «نسيت كلمة المرور» في نافذة الدخول.'],
      en: ['You create an account with an email address and a password and then confirm your email through the message you receive. If you forget your password, use "Forgot password" in the sign-in dialog.'],
      de: ['Sie legen ein Konto mit E-Mail-Adresse und Passwort an und bestätigen Ihre Adresse über die zugesandte Nachricht. Haben Sie Ihr Passwort vergessen, nutzen Sie „Passwort vergessen“ im Anmeldedialog.']
    } },
  { id: 'farmer', action: 'signin',
    k: ['i am a farmer', 'become a farmer', 'join as farmer', 'join as mill', 'my farm', 'landwirt werden', 'als landwirt', 'als bauer', 'meine bäume anbieten', 'ich bin landwirt', 'mühle anmelden', 'انا مزارع', 'كمزارع', 'انضمام مزارع', 'تسجيل مزارع', 'اشجاري للكفاله', 'تسجيل معصره', 'صاحب معصره'],
    a: {
      ar: ['إن كنت مزارعاً أو صاحب معصرة: أنشئ حساباً واختر الدور المناسب عند التسجيل. يراجع فريق المنصة الطلب، وبعد الاعتماد تُسنَد إليك أشجارك أو معصرتك.', 'المزارع يرسل تقارير حقلية بالنص والصور عن الأشجار المسندة إليه، وصاحب المعصرة يسجّل دفعات العصر؛ وكلاهما يُراجَع قبل النشر.'],
      en: ['If you are a farmer or a mill owner: create an account and choose that role when you register. The team reviews the application; after approval your trees or your mill are assigned to you.', 'Farmers send field reports with text and photos for their assigned trees, and mill owners record pressing batches; both are reviewed before they are published.'],
      de: ['Wenn Sie Landwirt oder Mühlenbetreiber sind: Legen Sie ein Konto an und wählen Sie bei der Registrierung die passende Rolle. Das Team prüft den Antrag; nach der Freigabe werden Ihnen Ihre Bäume oder Ihre Mühle zugeordnet.', 'Landwirte senden Feldberichte mit Text und Fotos zu den ihnen zugeordneten Bäumen, Mühlenbetreiber erfassen Presschargen; beides wird vor der Veröffentlichung geprüft.']
    } },
  { id: 'reports', action: 'market',
    k: ['field report', 'updates from', 'photos of my tree', 'how is my tree', 'who is the farmer', 'feldbericht', 'fotos', 'wie geht es meinem baum', 'wer ist der landwirt', 'neuigkeiten', 'تقرير', 'تقارير', 'صور شجرتي', 'من هو المزارع', 'اخبار الشجره', 'متابعه'],
    a: {
      ar: ['لكل شجرة صفحة عامة تعرض تقارير المزارع المنشورة وصورها، ونتائج فحص آخر دفعة عصر إن وُجدت.', 'يظهر اسم المزارع وصورته فقط إذا وافق على نشرهما.'],
      en: ['Every tree has a public page showing the farmer\'s published reports and photos, and the lab results of the latest pressing batch where available.', 'The farmer\'s name and photo are shown only if the farmer agreed to publish them.'],
      de: ['Zu jedem Baum gibt es eine öffentliche Seite mit den veröffentlichten Berichten und Fotos des Landwirts sowie, sofern vorhanden, den Laborwerten der letzten Presscharge.', 'Name und Foto des Landwirts erscheinen nur, wenn er der Veröffentlichung zugestimmt hat.']
    } },
  { id: 'risk',
    k: ['risk', 'insurance', 'what if', 'bad harvest', 'crop failure', 'frost', 'drought', 'tree dies', 'risiko*', 'versicherung*', 'was passiert wenn', 'ernteausfall', 'missernte', 'dürre', 'baum stirbt', 'مخاطر', 'خطر', 'تامين', 'ماذا لو', 'جفاف', 'صقيع', 'تلف المحصول', 'ماتت الشجره'],
    a: {
      ar: ['الزراعة مرتبطة بالطقس: قد يقل المحصول في موسم أو يغيب بسبب الجفاف أو الصقيع أو الآفات، وعندها تقل حصتك أو لا تُوزَّع.', 'لا تقدّم المنصة حالياً تأميناً على المحصول. اقرأ إقرار المخاطر في نافذة الطلب قبل الإرسال.'],
      en: ['Farming depends on the weather: in some seasons the harvest can be small or fail because of drought, frost or pests, and your share is then smaller or not distributed.', 'The platform does not currently offer crop insurance. Please read the risk notice in the request dialog before you send it.'],
      de: ['Landwirtschaft hängt vom Wetter ab: In manchen Jahren fällt die Ernte durch Dürre, Frost oder Schädlinge gering aus oder ganz weg; Ihr Anteil ist dann kleiner oder entfällt.', 'Eine Ernteversicherung bietet die Plattform derzeit nicht an. Bitte lesen Sie den Risikohinweis im Anfragedialog, bevor Sie absenden.']
    } },
  { id: 'reinvest_off',
    k: ['reinvest', 'compound', 'compounding', 'auto-reinvest', 'cash payout', 'cash out', 'wallet', 'wiederanlage', 'auszahlung', 'auszahlen', 'guthaben', 'اعاده استثمار', 'تراكمي', 'سحب نقدي', 'تسييل', 'محفظه ماليه'],
    a: {
      ar: ['لا توجد في المنصة محفظة نقدية ولا سحب نقدي ولا إعادة استثمار تلقائية. ما يُسجَّل لك هو حصصك في الأشجار وكميات الزيت المخصَّصة لك.'],
      en: ['The platform has no cash wallet, no cash payout and no automatic reinvestment. What is recorded for you are your tree shares and the oil allocated to you.'],
      de: ['Es gibt auf der Plattform kein Geldguthaben, keine Auszahlung und keine automatische Wiederanlage. Erfasst werden Ihre Baumanteile und das Ihnen zugeteilte Öl.']
    } },
  { id: 'language',
    k: ['language*', 'languages', 'german', 'english', 'arabic', 'currency', 'sprache*', 'sprachen', 'deutsch', 'englisch', 'arabisch', 'währung', 'waehrung', 'لغه', 'لغات', 'المانيه', 'انجليزيه', 'عمله'],
    a: {
      ar: ['المنصة متاحة بالعربية والإنكليزية والألمانية؛ تغيّر اللغة من الزر في الشريط العلوي. الأسعار بالدولار الأمريكي، ويمكن عرض قيمة تقريبية بالليرة السورية.'],
      en: ['The platform is available in Arabic, English and German; switch the language with the button in the top bar. Prices are in US dollars, with an approximate value in Syrian pounds available for display.'],
      de: ['Die Plattform gibt es auf Arabisch, Englisch und Deutsch; die Sprache wechseln Sie über die Schaltfläche in der oberen Leiste. Preise werden in US-Dollar geführt, ein ungefährer Wert in syrischen Pfund lässt sich anzeigen.']
    } },
  { id: 'notifications',
    k: ['notification*', 'push', 'email from', 'unsubscribe', 'benachrichtigung*', 'mitteilungen', 'abmelden vom newsletter', 'اشعار', 'اشعارات', 'تنبيه', 'تنبيهات', 'الغاء الاشتراك'],
    a: {
      ar: ['تصلك رسائل بريدية عن حالة طلباتك. في تطبيق الهاتف يمكنك تشغيل الإشعارات الفورية أو إيقافها من الإعدادات، وكذلك الموافقة على الرسائل التسويقية أو سحبها.'],
      en: ['You receive emails about the status of your requests. In the mobile app you can switch push notifications on or off in the settings, and give or withdraw consent to marketing messages there.'],
      de: ['Zum Stand Ihrer Anfragen erhalten Sie E-Mails. In der App können Sie Push-Mitteilungen in den Einstellungen ein- oder ausschalten und dort auch die Einwilligung in Werbenachrichten erteilen oder widerrufen.']
    } },
  { id: 'contact', action: 'imprint',
    k: ['contact', 'support', 'help me', 'complaint', 'reach you', 'who runs', 'kontakt', 'hilfe', 'beschwerde', 'erreichen', 'wer betreibt', 'ansprechpartner', 'تواصل', 'اتصال', 'دعم', 'مساعده', 'شكوى', 'من يدير'],
    a: {
      ar: ['بيانات الجهة المشغِّلة ووسائل التواصل موجودة في صفحة «بيانات الناشر». عند مراسلتنا بشأن طلب، اذكر رقم الطلب لتسريع المعالجة.'],
      en: ['The operator\'s details and contact channels are on the legal notice page. When you write about a request, include its number so it can be handled faster.'],
      de: ['Angaben zum Betreiber und die Kontaktwege stehen im Impressum. Wenn Sie zu einer Anfrage schreiben, nennen Sie bitte deren Nummer, damit sie schneller bearbeitet wird.']
    } }
];

// claims-ratchet:on

/** Lower-case text with Arabic letter variants and German umlauts folded, so one keyword matches all spellings. */
function faseelaFaqNormalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function faseelaFaqLang(question) {
  if (/[؀-ۿ]/.test(question)) return 'ar';
  if (state.currentLang === 'de' || /[äöüß]|\b(wie|was|ist|ich|kann|der|die|das|und|nicht|meine?)\b/i.test(question)) return 'de';
  return 'en';
}
/**
 * Turns a keyword into a pattern over the normalized question (which is padded with spaces).
 * Latin keywords match whole words; a trailing * makes them a word stem ("dattel*" matches "dattelpalme").
 * Arabic keywords may carry the usual prefixes (و ف ب ل ك ال); short ones (up to 3 letters) must also end
 * the word, apart from common suffixes, so that "جوز" does not match "يجوز".
 */
function faseelaFaqPattern(keyword) {
  const stem = /\*$/.test(keyword);
  const k = faseelaFaqNormalize(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/[؀-ۿ]/.test(k)) {
    const tail = k.replace(/\s/g, '').length <= 3 ? '(?:ي|ك|ه|ها|ات|ين|نا)? ' : '';
    return new RegExp(` [وف]?[بلك]?(?:ال)?${k}${tail}`);
  }
  return new RegExp(` ${k}${stem ? '' : ' '}`);
}
let _faseelaFaqIndex = null;
/** Best-matching topic or null. Longer keywords weigh more, so the most specific topic wins. */
function faseelaFaqMatch(question) {
  if (!_faseelaFaqIndex) {
    _faseelaFaqIndex = FASEELA_FAQ.map(topic => ({ topic, keys: topic.k.map(keyword => ({ re: faseelaFaqPattern(keyword), weight: faseelaFaqNormalize(keyword).length })) }));
  }
  const q = ` ${faseelaFaqNormalize(question)} `;
  let best = null;
  let bestScore = 0;
  _faseelaFaqIndex.forEach(({ topic, keys }) => {
    const score = keys.reduce((sum, key) => sum + (key.re.test(q) ? key.weight : 0), 0);
    if (score > bestScore) { best = topic; bestScore = score; }
  });
  return best;
}
function faseelaFaqAnswer(question) {
  const topic = faseelaFaqMatch(question);
  if (!topic) return null;
  const lang = faseelaFaqLang(question);
  const paragraphs = topic.a[lang] || topic.a.en;
  const action = topic.action && FASEELA_FAQ_ACTIONS[topic.action]
    ? FASEELA_FAQ_ACTIONS[topic.action](escapeHtml(FASEELA_FAQ_LABELS[topic.action][lang] || FASEELA_FAQ_LABELS[topic.action].en))
    : '';
  return `
    <div class="space-y-2 text-start" lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-faq="${topic.id}">
      ${paragraphs.map(text => `<p class="text-stone-700 dark:text-stone-200 leading-relaxed">${escapeHtml(text)}</p>`).join('')}
      ${action}
    </div>
  `;
}
/** Speech language for a piece of answer or question text (Arabic script, German markers, else English). */
function faseelaSpeechLang(text, arabicCode) {
  if (/[؀-ۿ]/.test(String(text || ''))) return arabicCode;
  if (state.currentLang === 'de' && /[äöüß]|\b(der|die|das|und|ist|nicht|Sie|ein|eine)\b/.test(String(text || ''))) return 'de-DE';
  return 'en-US';
}

// ============================================================
// Answers outside the knowledge topics
// ============================================================
// Only two kinds of answer exist besides the topics above: the signed-in person's own data (account, own shares),
// read from the real session, and an honest fallback that points to the topics, the service description and the
// legal notice. Nothing here describes an offer; everything the platform offers is in FASEELA_FAQ.

const FASEELA_OWN_KEYS = {
  account: ['who am i', 'my account details', 'my profile', 'my role', 'wer bin ich', 'mein profil', 'meine rolle', 'meine kontodaten', 'من انا', 'ملفي', 'دوري', 'بيانات حسابي'],
  shares: ['my trees', 'my shares', 'my sponsorships', 'what do i own', 'meine baeume', 'meine anteile', 'meine patenschaften', 'اشجاري', 'حصصي', 'كفالاتي']
};
const FASEELA_ROLE_LABELS = {
  investor: { ar: 'كافل', en: 'Sponsor', de: 'Pate' },
  farmer: { ar: 'مزارع شريك', en: 'Partner farmer', de: 'Partner-Landwirt' },
  mill_operator: { ar: 'معصرة شريكة', en: 'Partner mill', de: 'Partner-Ölmühle' },
  mill_owner: { ar: 'معصرة شريكة', en: 'Partner mill', de: 'Partner-Ölmühle' },
  finance_admin: { ar: 'فريق المالية', en: 'Finance team', de: 'Finanzteam' },
  quality_auditor: { ar: 'فريق الجودة', en: 'Quality team', de: 'Qualitätsteam' },
  admin: { ar: 'إدارة المنصة', en: 'Platform administration', de: 'Plattform-Verwaltung' }
};
const FASEELA_OWN_TEXT = {
  signin: { ar: 'سجّل الدخول لعرض بيانات حسابك وكفالاتك.', en: 'Sign in to see your account and your sponsorships.', de: 'Melden Sie sich an, um Ihr Konto und Ihre Patenschaften zu sehen.' },
  account: { ar: 'بيانات حسابك', en: 'Your account', de: 'Ihr Konto' },
  name: { ar: 'الاسم', en: 'Name', de: 'Name' },
  email: { ar: 'البريد الإلكتروني', en: 'E-mail', de: 'E-Mail' },
  role: { ar: 'الصفة', en: 'Role', de: 'Rolle' },
  verified: { ar: 'تم تأكيد البريد الإلكتروني', en: 'E-mail confirmed', de: 'E-Mail bestätigt' },
  unverified: { ar: 'البريد الإلكتروني غير مؤكد بعد', en: 'E-mail not confirmed yet', de: 'E-Mail noch nicht bestätigt' },
  profile: { ar: 'إدارة الملف', en: 'Manage profile', de: 'Profil verwalten' },
  dashboard: { ar: 'لوحتي', en: 'My dashboard', de: 'Mein Bereich' },
  noShares: { ar: 'لا توجد لديك كفالة فعالة بعد.', en: 'You have no active sponsorship yet.', de: 'Sie haben noch keine aktive Patenschaft.' },
  sharesHead: { ar: 'كفالاتك الفعالة', en: 'Your active sponsorships', de: 'Ihre aktiven Patenschaften' },
  sharesUnit: { ar: 'حصة', en: 'share(s)', de: 'Anteil(e)' },
  browse: { ar: 'تصفح الأشجار', en: 'Browse trees', de: 'Bäume ansehen' },
  fallback: {
    ar: 'لا أملك جواباً موثوقاً على هذا السؤال. أجيب فقط عمّا تقدمه المنصة فعلاً: اختر أحد المواضيع في الأعلى، أو اقرأ وصف خدمة الكفالة، أو تواصل معنا عبر بيانات الناشر.',
    en: 'I do not have a reliable answer to this question. I only answer about what the platform really offers: pick one of the topics above, read the sponsorship service description, or contact us through the legal notice.',
    de: 'Darauf habe ich keine verlässliche Antwort. Ich antworte nur zu dem, was die Plattform wirklich anbietet: Wählen Sie oben ein Thema, lesen Sie die Leistungsbeschreibung der Patenschaft oder schreiben Sie uns über das Impressum.'
  },
  terms: { ar: 'وصف خدمة الكفالة', en: 'Service description', de: 'Leistungsbeschreibung' },
  contact: { ar: 'بيانات الناشر والتواصل', en: 'Legal notice and contact', de: 'Impressum und Kontakt' }
};

function faseelaOwnTopic(question) {
  const q = ` ${faseelaFaqNormalize(question)} `;
  return Object.keys(FASEELA_OWN_KEYS).find((topic) => FASEELA_OWN_KEYS[topic].some((key) => faseelaFaqPattern(key).test(q))) || null;
}

// Written out in full so the handler inventory test (tests/e2e/handlers.e2e.mjs) can check every data-click.
const FASEELA_OWN_CLICKS = {
  signin: 'data-click="openAuthModal()"',
  profile: `data-click="openAuthModal('identity')"`,
  dashboard: `data-click="navigateTo('dashboard')"`,
  market: `data-click="navigateTo('marketplace')"`
};
function faseelaButton(label, action) {
  return `<button type="button" ${FASEELA_OWN_CLICKS[action]} class="bg-olive-800 hover:bg-olive-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">${escapeHtml(label)}</button>`;
}

function faseelaWrap(lang, id, inner) {
  return `<div class="space-y-2 text-start" lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-faq="${id}">${inner}</div>`;
}

/** The signed-in person's own data: account facts and active shares, read from the real session only. */
function faseelaOwnDataAnswer(question, lang) {
  const topic = faseelaOwnTopic(question);
  if (!topic) return null;
  const T = (key) => FASEELA_OWN_TEXT[key][lang] || FASEELA_OWN_TEXT[key].en;
  const user = state.currentUser;
  if (!user || !state.serverMode) {
    return faseelaWrap(lang, `own_${topic}`, `<p class="text-stone-700 dark:text-stone-200">${escapeHtml(T('signin'))}</p>${faseelaButton(FASEELA_FAQ_LABELS.signin[lang] || FASEELA_FAQ_LABELS.signin.en, 'signin')}`);
  }
  if (topic === 'account') {
    const role = (FASEELA_ROLE_LABELS[user.role] || FASEELA_ROLE_LABELS.investor)[lang];
    const rows = [[T('name'), user.name || ''], [T('email'), user.email || ''], [T('role'), role], ['', user.email_verified === false ? T('unverified') : T('verified')]];
    return faseelaWrap(lang, 'own_account', `
      <p class="font-bold text-stone-900 dark:text-stone-100">${escapeHtml(T('account'))}</p>
      <ul class="text-stone-700 dark:text-stone-200 text-[11px] space-y-0.5">${rows.map(([k, v]) => `<li>${k ? `<strong>${escapeHtml(k)}:</strong> ` : ''}${escapeHtml(v)}</li>`).join('')}</ul>
      <div class="flex flex-wrap gap-1.5">${faseelaButton(T('profile'), 'profile')}${faseelaButton(T('dashboard'), 'dashboard')}</div>`);
  }
  const active = (state.userShares || []).filter((s) => s.source === 'server' && s.status === 'active' && s.user_id === user.id);
  if (!active.length) {
    return faseelaWrap(lang, 'own_shares', `<p class="text-stone-700 dark:text-stone-200">${escapeHtml(T('noShares'))}</p>${faseelaButton(T('browse'), 'market')}`);
  }
  const byTree = new Map();
  active.forEach((s) => byTree.set(s.tree_id, (byTree.get(s.tree_id) || 0) + (Number(s.shares_count) || 1)));
  const lines = [...byTree.entries()].map(([treeId, count]) => {
    const tree = (state.trees || []).find((t) => t.id === treeId);
    const name = tree ? (lang === 'ar' ? tree.name : (tree.name_en || tree.name)) : treeId;
    return `<li><strong>${escapeHtml(name || treeId)}</strong>: ${count} ${escapeHtml(T('sharesUnit'))}</li>`;
  }).join('');
  return faseelaWrap(lang, 'own_shares', `
    <p class="font-bold text-stone-900 dark:text-stone-100">${escapeHtml(T('sharesHead'))}</p>
    <ul class="text-stone-700 dark:text-stone-200 text-[11px] space-y-0.5">${lines}</ul>
    ${faseelaButton(T('dashboard'), 'dashboard')}`);
}

/** When no topic and no own-data question matches: say so, and point to what is reliable. */
function faseelaFallbackAnswer(lang) {
  const T = (key) => FASEELA_OWN_TEXT[key][lang] || FASEELA_OWN_TEXT[key].en;
  const link = (href, label) => `<a href="${href}" target="_blank" rel="noopener" class="inline-block bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 px-3 py-1.5 rounded-lg text-xs font-bold">${escapeHtml(label)}</a>`;
  return faseelaWrap(lang, 'fallback', `
    <p class="text-stone-700 dark:text-stone-200 leading-relaxed">${escapeHtml(T('fallback'))}</p>
    <div class="flex flex-wrap gap-1.5">${link('legal/patenschaft.html', T('terms'))}${link('legal/impressum.html', T('contact'))}</div>`);
}

/** The assistant's answer to a question: a knowledge topic, the person's own data, or the honest fallback. */
function generateFaseelaResponse(rawQ) {
  const question = String(rawQ || '').trim();
  const topicAnswer = faseelaFaqAnswer(question);
  if (topicAnswer) return topicAnswer;
  const lang = faseelaFaqLang(question);
  return faseelaOwnDataAnswer(question, lang) || faseelaFallbackAnswer(lang);
}
