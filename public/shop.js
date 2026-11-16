// Faseela farm shop (marketplace core, migration 50).
//
// Customers: browse the products an admin listed, fill a basket with products of ONE farm, see goods, the service
// fee, shipping and the total as separate lines, order with a delivery address, pay by bank transfer and follow the
// order. Farm accounts: submit products for review, keep the stock, see paid orders without any customer data.
//
// All amounts come from the server: the basket shows an estimate with the same formula, the checkout shows the
// server's quote, and the order itself is priced again on the server. Everything is rendered with textContent;
// no markup is built from data.
(function () {
  'use strict';

  const TEXT = {
    en: {
      shop_tab: 'Farm shop',
      shop_title: 'Farm shop: products directly from the farms',
      shop_intro: "Every product is offered by a farm on Faseela. The price you see is the price you pay, plus shipping. Faseela keeps {fee} of the product price as its service fee; the rest goes to the farm.",
      shop_loading: 'Loading the shop …',
      shop_error: 'The shop could not be loaded.',
      shop_retry: 'Try again',
      shop_empty: 'No products are on offer yet.',
      shop_dest_label: 'Deliver to',
      shop_dest_none: 'No delivery country is available yet.',
      shop_farm: 'Farm',
      shop_per: 'per {unit}',
      shop_stock_low: 'Only {n} left',
      shop_sold_out: 'Sold out',
      shop_no_ship: 'Not delivered to the chosen country',
      shop_add: 'Add to basket',
      shop_qty: 'Quantity',
      shop_basket: 'Your basket',
      shop_basket_empty: 'Your basket is empty.',
      shop_remove: 'Remove',
      shop_goods: 'Goods',
      shop_shipping: 'Shipping to {country}',
      shop_total: 'Total',
      shop_estimate_note: 'The final amounts are confirmed in the next step.',
      shop_one_farm: 'A basket holds products of one farm. Finish or empty it before ordering from another farm.',
      shop_checkout: 'Continue to order',
      shop_signin_first: 'Please sign in to order.',
      shop_checkout_title: 'Delivery address',
      shop_f_name: 'Full name',
      shop_f_line1: 'Street and house number',
      shop_f_line2: 'Address addition (optional)',
      shop_f_postal: 'Postal code',
      shop_f_city: 'City',
      shop_f_country: 'Country',
      shop_f_phone: 'Phone for the courier (optional)',
      shop_pay_note: 'You pay by bank transfer. After ordering you receive a payment reference; transfer the total within 72 hours and confirm the transfer here. The parcel is sent once the payment has arrived.',
      shop_place_order: 'Place order for {total}',
      shop_back: 'Back to the basket',
      shop_address_missing: 'Please enter your name, street, city and country.',
      shop_price_changed: 'A price changed since you filled the basket. Please check the new total.',
      shop_ordered: 'Order placed. Please transfer the total with your payment reference.',
      shop_orders: 'Your orders',
      shop_order_ref: 'Payment reference',
      shop_pay_until: 'Transfer by {date}',
      shop_pay_accounts: 'Transfer to',
      shop_pay_accounts_missing: 'The bank details are not available right now. Please try again later.',
      shop_i_paid: 'I have made the transfer',
      shop_cancel: 'Cancel order',
      shop_cancelled: 'Order cancelled.',
      shop_reported: 'Thank you. We check the payment and confirm it by e-mail.',
      shop_tracking: 'Tracking code',
      shop_note: 'Note',
      shop_st_awaiting_payment: 'Waiting for your transfer',
      shop_st_under_review: 'Payment is being checked',
      shop_st_paid: 'Paid, being prepared',
      shop_st_shipped: 'On its way',
      shop_st_delivered: 'Delivered',
      shop_st_cancelled: 'Cancelled',
      shop_st_expired: 'Expired',
      shop_st_rejected: 'Payment not confirmed',
      shop_err_generic: 'That did not work. Please try again.',
      shop_err_out_of_stock: 'There is not enough of a product left. Please reduce the quantity.',
      shop_err_no_shipping_rate: 'This farm does not deliver to the chosen country yet.',
      shop_err_mixed_farms: 'One order can only hold products of a single farm.',
      shop_err_product_unavailable: 'A product in your basket is no longer offered.',
      shop_err_resource_exhausted: 'Please pay or cancel your open orders first, or wait a moment.',
      shop_err_failed_precondition: 'This is not possible right now. Is your e-mail address confirmed?',
      shop_err_unauthenticated: 'Please sign in again.',
      shop_err_invalid_argument: 'Please check your entries.',
      shop_farm_title: 'Your farm: {farm}',
      shop_farm_balance: "Credit from paid orders after fee and payouts",
      shop_farm_products: 'Your products',
      shop_farm_no_products: 'You have not submitted a product yet.',
      shop_farm_new: 'New product',
      shop_farm_edit: 'Edit',
      shop_farm_review_hint: 'New products and every change of text or price are checked by Faseela before they appear in the shop.',
      shop_p_category: 'Category',
      shop_p_name: 'Name (Arabic)',
      shop_p_name_en: 'Name (English)',
      shop_p_desc: 'Description (Arabic)',
      shop_p_desc_en: 'Description (English)',
      shop_p_unit: 'Unit, e.g. 500 ml bottle',
      shop_p_price: 'Price per unit',
      shop_p_currency: 'Currency',
      shop_p_stock: 'Units in stock',
      shop_p_submit: 'Submit for review',
      shop_p_cancel: 'Cancel',
      shop_p_missing: 'Please enter a name, a unit and a price.',
      shop_p_saved: 'Submitted. The product appears in the shop after the review.',
      shop_stock_save: 'Save stock',
      shop_stock_saved: 'Stock saved.',
      shop_unlist: 'Take out of the shop',
      shop_unlisted: 'The product is no longer in the shop.',
      shop_ps_pending_review: 'Being reviewed',
      shop_ps_listed: 'In the shop',
      shop_ps_unlisted: 'Not in the shop',
      shop_ps_rejected: 'Not accepted',
      shop_cat_oil: 'Oil', shop_cat_olives: 'Olives', shop_cat_dates: 'Dates', shop_cat_nuts: 'Nuts',
      shop_cat_fruit: 'Fruit', shop_cat_preserves: 'Preserves', shop_cat_other: 'Other',
      shop_split: "Included in the price: {feeAmount} service fee ({fee}) for Faseela, {farmAmount} for the farm.",
      shop_closed: "The farm shop is being prepared and does not take orders yet.",
      shop_st_refunded: "Cancelled, refund on its way",
      shop_err_shop_closed: "The farm shop does not take orders yet.",
      shop_p_net: "You receive {net} per unit; {feeAmount} ({fee}) is the Faseela service fee.",
      shop_farm_orders: 'Paid orders for your farm',
      shop_farm_no_orders: 'No paid orders yet.'
    },
    ar: {
      shop_tab: 'متجر المزارع',
      shop_title: 'متجر المزارع: منتجات مباشرة من المزارعين',
      shop_intro: "كل منتج تعرضه مزرعة على فسيلة. السعر المعروض هو ما تدفعه، يُضاف إليه الشحن فقط. تحتفظ فسيلة بنسبة {fee} من سعر المنتج رسمَ خدمة ويذهب الباقي إلى المزرعة.",
      shop_loading: 'جارٍ تحميل المتجر …',
      shop_error: 'تعذر تحميل المتجر.',
      shop_retry: 'إعادة المحاولة',
      shop_empty: 'لا توجد منتجات معروضة بعد.',
      shop_dest_label: 'التوصيل إلى',
      shop_dest_none: 'لا يوجد بلد توصيل متاح بعد.',
      shop_farm: 'المزرعة',
      shop_per: 'لكل {unit}',
      shop_stock_low: 'بقي {n} فقط',
      shop_sold_out: 'نفدت الكمية',
      shop_no_ship: 'لا يُشحن إلى البلد المختار',
      shop_add: 'أضف إلى السلة',
      shop_qty: 'الكمية',
      shop_basket: 'سلتك',
      shop_basket_empty: 'سلتك فارغة.',
      shop_remove: 'إزالة',
      shop_goods: 'البضاعة',
      shop_shipping: 'الشحن إلى {country}',
      shop_total: 'الإجمالي',
      shop_estimate_note: 'تُؤكَّد المبالغ النهائية في الخطوة التالية.',
      shop_one_farm: 'السلة تحمل منتجات مزرعة واحدة. أكمل الطلب أو أفرغ السلة قبل الطلب من مزرعة أخرى.',
      shop_checkout: 'متابعة الطلب',
      shop_signin_first: 'يرجى تسجيل الدخول للطلب.',
      shop_checkout_title: 'عنوان التوصيل',
      shop_f_name: 'الاسم الكامل',
      shop_f_line1: 'الشارع ورقم المنزل',
      shop_f_line2: 'تكملة العنوان (اختياري)',
      shop_f_postal: 'الرمز البريدي',
      shop_f_city: 'المدينة',
      shop_f_country: 'البلد',
      shop_f_phone: 'هاتف لشركة التوصيل (اختياري)',
      shop_pay_note: 'الدفع بالتحويل المصرفي. بعد الطلب تحصل على مرجع للدفع؛ حوّل المبلغ الإجمالي خلال 72 ساعة ثم أكّد التحويل هنا. يُرسل الطرد بعد وصول الدفعة.',
      shop_place_order: 'تأكيد الطلب بمبلغ {total}',
      shop_back: 'العودة إلى السلة',
      shop_address_missing: 'يرجى إدخال الاسم والشارع والمدينة والبلد.',
      shop_price_changed: 'تغيّر سعر منذ ملء السلة. يرجى مراجعة الإجمالي الجديد.',
      shop_ordered: 'تم تسجيل الطلب. يرجى تحويل المبلغ الإجمالي مع ذكر مرجع الدفع.',
      shop_orders: 'طلباتك',
      shop_order_ref: 'مرجع الدفع',
      shop_pay_until: 'التحويل قبل {date}',
      shop_pay_accounts: 'التحويل إلى',
      shop_pay_accounts_missing: 'بيانات الحساب المصرفي غير متاحة الآن. يرجى المحاولة لاحقاً.',
      shop_i_paid: 'أتممت التحويل',
      shop_cancel: 'إلغاء الطلب',
      shop_cancelled: 'تم إلغاء الطلب.',
      shop_reported: 'شكراً لك. نتحقق من الدفعة ونؤكدها بالبريد الإلكتروني.',
      shop_tracking: 'رقم التتبع',
      shop_note: 'ملاحظة',
      shop_st_awaiting_payment: 'بانتظار تحويلك',
      shop_st_under_review: 'الدفعة قيد التحقق',
      shop_st_paid: 'مدفوع وقيد التجهيز',
      shop_st_shipped: 'في الطريق',
      shop_st_delivered: 'تم التسليم',
      shop_st_cancelled: 'ملغى',
      shop_st_expired: 'انتهت المهلة',
      shop_st_rejected: 'لم تُؤكَّد الدفعة',
      shop_err_generic: 'لم تنجح العملية. يرجى المحاولة مجدداً.',
      shop_err_out_of_stock: 'الكمية المتبقية من أحد المنتجات لا تكفي. يرجى تقليل الكمية.',
      shop_err_no_shipping_rate: 'هذه المزرعة لا توصل إلى البلد المختار بعد.',
      shop_err_mixed_farms: 'الطلب الواحد يحمل منتجات مزرعة واحدة فقط.',
      shop_err_product_unavailable: 'أحد منتجات سلتك لم يعد معروضاً.',
      shop_err_resource_exhausted: 'يرجى دفع طلباتك المفتوحة أو إلغاؤها أولاً، أو الانتظار قليلاً.',
      shop_err_failed_precondition: 'غير ممكن الآن. هل تم تأكيد بريدك الإلكتروني؟',
      shop_err_unauthenticated: 'يرجى تسجيل الدخول مجدداً.',
      shop_err_invalid_argument: 'يرجى مراجعة البيانات المدخلة.',
      shop_farm_title: 'مزرعتك: {farm}',
      shop_farm_balance: "الرصيد من الطلبات المدفوعة بعد الرسم والتحويلات",
      shop_farm_products: 'منتجاتك',
      shop_farm_no_products: 'لم تقدّم أي منتج بعد.',
      shop_farm_new: 'منتج جديد',
      shop_farm_edit: 'تعديل',
      shop_farm_review_hint: 'المنتجات الجديدة وكل تغيير في النص أو السعر تراجعه فسيلة قبل ظهوره في المتجر.',
      shop_p_category: 'الفئة',
      shop_p_name: 'الاسم (بالعربية)',
      shop_p_name_en: 'الاسم (بالإنجليزية)',
      shop_p_desc: 'الوصف (بالعربية)',
      shop_p_desc_en: 'الوصف (بالإنجليزية)',
      shop_p_unit: 'الوحدة، مثلاً عبوة 500 مل',
      shop_p_price: 'السعر للوحدة',
      shop_p_currency: 'العملة',
      shop_p_stock: 'الكمية المتوفرة',
      shop_p_submit: 'إرسال للمراجعة',
      shop_p_cancel: 'إلغاء',
      shop_p_missing: 'يرجى إدخال الاسم والوحدة والسعر.',
      shop_p_saved: 'تم الإرسال. يظهر المنتج في المتجر بعد المراجعة.',
      shop_stock_save: 'حفظ الكمية',
      shop_stock_saved: 'تم حفظ الكمية.',
      shop_unlist: 'إخراج من المتجر',
      shop_unlisted: 'لم يعد المنتج في المتجر.',
      shop_ps_pending_review: 'قيد المراجعة',
      shop_ps_listed: 'في المتجر',
      shop_ps_unlisted: 'خارج المتجر',
      shop_ps_rejected: 'لم يُقبل',
      shop_cat_oil: 'زيت', shop_cat_olives: 'زيتون', shop_cat_dates: 'تمور', shop_cat_nuts: 'مكسرات',
      shop_cat_fruit: 'فواكه', shop_cat_preserves: 'مؤونة', shop_cat_other: 'أخرى',
      shop_split: "ضمن السعر: {feeAmount} رسم خدمة ({fee}) لفسيلة، و{farmAmount} للمزرعة.",
      shop_closed: "متجر المزارع قيد التجهيز ولا يستقبل الطلبات بعد.",
      shop_st_refunded: "ملغى والمبلغ في طريقه إليك",
      shop_err_shop_closed: "متجر المزارع لا يستقبل الطلبات بعد.",
      shop_p_net: "تحصل على {net} لكل وحدة؛ و{feeAmount} ({fee}) رسم خدمة فسيلة.",
      shop_farm_orders: 'الطلبات المدفوعة لمزرعتك',
      shop_farm_no_orders: 'لا توجد طلبات مدفوعة بعد.'
    }
  };
  // The dictionaries of the app are the single source for t(); the German strings live in src/i18n/de.json.
  if (typeof i18n === 'object' && i18n) {
    Object.assign(i18n.en, TEXT.en);
    Object.assign(i18n.ar, TEXT.ar);
  }

  const CATEGORIES = ['oil', 'olives', 'dates', 'nuts', 'fruit', 'preserves', 'other'];
  const DEST_KEY = 'faseela_shop_dest';
  const view = {
    status: 'idle',          // idle | loading | ready | error
    products: [], rates: [], farms: [], feeBps: 1500, shopOpen: false,
    dest: '',
    basket: new Map(),       // productId -> quantity
    step: 'basket',          // basket | checkout
    quote: null, orderKey: '', busy: false, formError: '',
    orders: [], channels: null,
    myFarms: [], editing: null   // editing: { farmId, product|null }
  };

  const api = () => window.FaseelaFirebase || null;
  const tr = (key, vars) => {
    let text = typeof t === 'function' ? t(key) : key;
    for (const [name, value] of Object.entries(vars || {})) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : 'en');
  const isArabic = () => typeof state === 'object' && state && state.currentLang === 'ar';
  const signedIn = () => typeof state === 'object' && state && !!state.currentUser && !!state.serverMode;
  const say = (message) => { if (typeof showToast === 'function') showToast(message); };
  /** Minor units per currency as Intl knows them (EUR 2, TND 3, JPY 0); amounts travel as whole minor units. */
  const unitFactor = (currency) => {
    try { return 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch (error) { return 100; }
  };
  const money = (minor, currency) => {
    const code = /^[A-Z]{3}$/.test(currency) ? currency : 'EUR';
    try {
      return new Intl.NumberFormat(locale(), { style: 'currency', currency: code }).format((Number(minor) || 0) / unitFactor(code));
    } catch (error) { return `${((Number(minor) || 0) / 100).toFixed(2)} ${currency || ''}`; }
  };
  const percent = (bps) => `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format((Number(bps) || 0) / 100)} %`;
  const countryName = (code) => {
    try { return new Intl.DisplayNames([locale()], { type: 'region' }).of(code) || code; } catch (error) { return code; }
  };
  const dateTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const errorMessage = (error) => {
    const code = String((error && error.code) || '').replace(/-/g, '_');
    const key = `shop_err_${code}`;
    const text = tr(key);
    return text === key ? tr('shop_err_generic') : text;
  };

  /** Tiny DOM builder: text is always set as text, never parsed as markup. */
  function h(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children || [])) if (child) node.append(child);
    return node;
  }
  const CLS = {
    card: 'bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-3xl p-5 shadow-xs text-start space-y-3',
    title: 'font-black text-stone-900 dark:text-white text-base leading-snug',
    h3: 'font-black text-stone-900 dark:text-white text-lg',
    muted: 'text-xs text-stone-600 dark:text-stone-300 leading-relaxed',
    primary: 'bg-olive-800 hover:bg-olive-900 text-white font-bold text-xs px-4 py-2.5 rounded-xl cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
    ghost: 'border border-stone-300 dark:border-stone-600 text-stone-800 dark:text-stone-100 font-bold text-xs px-4 py-2.5 rounded-xl cursor-pointer hover:bg-stone-100 dark:hover:bg-stone-700',
    input: 'w-full border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 rounded-xl px-3 py-2 text-sm',
    label: 'block text-xs font-bold text-stone-700 dark:text-stone-200 space-y-1',
    badge: 'inline-block bg-stone-100 dark:bg-stone-700 text-stone-800 dark:text-stone-100 text-[11px] font-bold px-2.5 py-1 rounded-full',
    row: 'flex flex-wrap items-center justify-between gap-3',
    alert: 'p-3 rounded-xl bg-red-50 border border-red-300 text-red-900 text-xs font-bold'
  };
  const button = (text, cls, handler, extra) => h('button', { type: 'button', class: cls, text, on: { click: handler }, ...(extra || {}) });
  const labelled = (text, control) => h('label', { class: CLS.label }, [h('span', { text }), control]);

  const productName = (p) => (isArabic() ? p.name : (p.nameEn || p.name));
  const productText = (p) => (isArabic() ? p.description : (p.descriptionEn || p.description));
  const farmOf = (farmId) => view.farms.find((farm) => farm.farmId === farmId) || null;
  const farmName = (farmId) => { const farm = farmOf(farmId); return farm ? (isArabic() ? farm.name : (farm.nameEn || farm.name)) || farmId : farmId; };
  const rateFor = (product) => {
    const farm = farmOf(product.farmId);
    return view.rates.find((rate) => farm && rate.originCountry === farm.countryCode && rate.destCountry === view.dest && rate.currency === product.currency) || null;
  };
  const basketLines = () => [...view.basket.entries()]
    .map(([id, quantity]) => ({ product: view.products.find((p) => p.id === id), quantity }))
    .filter((line) => line.product);

  /** Same formula as the server (private.order_quote); the server's numbers are the ones that count. */
  function estimate() {
    const lines = basketLines();
    if (!lines.length) return null;
    const rate = rateFor(lines[0].product);
    const items = lines.reduce((sum, line) => sum + line.product.priceMinor * line.quantity, 0);
    const fee = Math.round(items * view.feeBps / 10000);
    return { currency: lines[0].product.currency, itemsMinor: items, feeBps: view.feeBps, feeMinor: fee, farmNetMinor: items - fee,
      shippingMinor: rate ? rate.amountMinor : null, totalMinor: rate ? items + rate.amountMinor : null };
  }

  // ------------------------------------------------------------------------------------------------ loading

  async function load() {
    const backend = api();
    if (!backend || typeof backend.listProducts !== 'function') { view.status = 'idle'; updateTab(); return; }
    view.status = 'loading';
    render();
    try {
      const [shop, origins, config] = await Promise.all([
        backend.listProducts(),
        typeof backend.listOrigins === 'function' ? backend.listOrigins() : Promise.resolve({ farms: [] }),
        typeof backend.marketplaceConfig === 'function' ? backend.marketplaceConfig().catch(() => null) : Promise.resolve(null)
      ]);
      view.products = Array.isArray(shop.products) ? shop.products : [];
      view.rates = Array.isArray(shop.shippingRates) ? shop.shippingRates : [];
      view.farms = (Array.isArray(origins.farms) ? origins.farms : []).map((farm) => ({
        farmId: farm.farmId || farm.farm_id, countryCode: farm.countryCode || farm.country_code, name: farm.name, nameEn: farm.nameEn || farm.name_en
      }));
      const bps = config && config.data ? Number(config.data.feeBps) : NaN;
      if (Number.isFinite(bps)) view.feeBps = bps;
      view.shopOpen = !!(config && config.data && config.data.shopOpen === true);
      const destinations = [...new Set(view.rates.map((rate) => rate.destCountry))].sort();
      let saved = '';
      try { saved = localStorage.getItem(DEST_KEY) || ''; } catch (error) { saved = ''; }
      view.dest = destinations.includes(view.dest) ? view.dest : (destinations.includes(saved) ? saved : (destinations[0] || ''));
      for (const id of [...view.basket.keys()]) if (!view.products.some((p) => p.id === id)) view.basket.delete(id);
      view.status = 'ready';
    } catch (error) {
      console.warn('[faseela] shop not loaded:', error && (error.code || error.message));
      view.status = 'error';
    }
    await loadPersonal();
    updateTab();
    render();
  }

  /** Orders of the signed-in customer and, for farm accounts, their farm. Signed-out visitors simply have neither. */
  async function loadPersonal() {
    const backend = api();
    view.orders = [];
    view.myFarms = [];
    if (!backend || !signedIn()) return;
    const [orders, farms] = await Promise.all([
      typeof backend.listMyOrders === 'function' ? backend.listMyOrders().catch(() => null) : null,
      typeof backend.farmOverview === 'function' ? backend.farmOverview().catch(() => null) : null
    ]);
    view.orders = orders && orders.data && Array.isArray(orders.data.orders) ? orders.data.orders : [];
    view.myFarms = farms && farms.data && Array.isArray(farms.data.farms) ? farms.data.farms : [];
    if (view.orders.some((order) => order.status === 'awaiting_payment') && view.channels === null && typeof backend.paymentInstructions === 'function') {
      try {
        const { data } = await backend.paymentInstructions();
        view.channels = data && Array.isArray(data.channels) ? data.channels : [];
      } catch (error) { view.channels = []; }
    }
  }

  /** The tab exists only when there is something behind it: products on offer, own orders, or an own farm. */
  function updateTab() {
    const tab = document.getElementById('tab-market-shop');
    if (!tab) return;
    const useful = view.status === 'ready' && ((view.shopOpen && view.products.length > 0) || view.orders.length > 0 || view.myFarms.length > 0);
    tab.hidden = !useful;
    if (!useful && typeof state === 'object' && state && state.marketplaceTrack === 'shop' && typeof switchMarketplaceTrack === 'function') {
      switchMarketplaceTrack('mature');
    }
  }

  // ------------------------------------------------------------------------------------------------ rendering

  function render() {
    const root = document.getElementById('shop-container');
    if (!root) return;
    const parts = [h('div', { class: CLS.card }, [
      h('h2', { class: 'text-xl font-black text-stone-900 dark:text-white', text: tr('shop_title') }),
      h('p', { class: CLS.muted, text: tr('shop_intro', { fee: percent(view.feeBps) }) })
    ])];
    if (view.status === 'loading' || view.status === 'idle') parts.push(h('p', { class: CLS.muted, role: 'status', text: tr('shop_loading') }));
    else if (view.status === 'error') parts.push(h('div', { class: CLS.alert, role: 'alert' }, [h('p', { text: tr('shop_error') }), button(tr('shop_retry'), `${CLS.ghost} mt-2`, load)]));
    else {
      if (!view.shopOpen) parts.push(h('p', { class: CLS.muted, role: 'status', id: 'shop-closed', text: tr('shop_closed') }));
      else if (view.step === 'checkout' && view.quote) parts.push(renderCheckout());
      else parts.push(renderCatalogue(), renderBasket());
      if (view.orders.length) parts.push(renderOrders());
      for (const farm of view.myFarms) parts.push(renderFarm(farm));
    }
    root.replaceChildren(...parts.filter(Boolean));
  }

  function renderCatalogue() {
    const destinations = [...new Set(view.rates.map((rate) => rate.destCountry))].sort();
    const select = h('select', { class: `${CLS.input} max-w-xs`, id: 'shop-dest', on: { change: (event) => {
      view.dest = event.target.value;
      try { localStorage.setItem(DEST_KEY, view.dest); } catch (error) { /* private mode: the choice lasts for this visit */ }
      render();
    } } }, destinations.map((code) => h('option', { value: code, text: countryName(code), selected: code === view.dest })));
    const head = h('div', { class: CLS.row }, [
      destinations.length ? labelled(tr('shop_dest_label'), select) : h('p', { class: CLS.muted, text: tr('shop_dest_none') })
    ]);
    if (!view.products.length) return h('div', { class: 'space-y-4' }, [head, h('p', { class: CLS.muted, text: tr('shop_empty') })]);
    return h('div', { class: 'space-y-4' }, [head,
      h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6', id: 'shop-grid' }, view.products.map(renderProduct))]);
  }

  function renderProduct(product) {
    const stock = Number(product.stockUnits) || 0;
    const ships = !!rateFor(product);
    const inBasket = view.basket.get(product.id) || 0;
    const max = Math.min(50, stock);
    const quantity = h('input', { type: 'number', min: 1, max: Math.max(max, 1), value: Math.min(Math.max(inBasket, 1), Math.max(max, 1)), class: `${CLS.input} w-20`, inputmode: 'numeric', 'aria-label': `${tr('shop_qty')}: ${productName(product)}` });
    const hint = stock < 1 ? tr('shop_sold_out') : !ships ? tr('shop_no_ship') : stock <= 5 ? tr('shop_stock_low', { n: stock }) : '';
    return h('article', { class: `${CLS.card} flex flex-col justify-between`, 'data-product': product.id }, [
      h('div', { class: 'space-y-2' }, [
        h('span', { class: CLS.badge, text: tr(`shop_cat_${product.category}`) }),
        h('h3', { class: CLS.title, text: productName(product) }),
        productText(product) ? h('p', { class: CLS.muted, text: productText(product) }) : null,
        h('p', { class: CLS.muted, text: `${tr('shop_farm')}: ${farmName(product.farmId)}` })
      ]),
      h('div', { class: 'space-y-2' }, [
        h('p', {}, [h('span', { class: 'text-xl font-black text-olive-800 dark:text-olive-300', text: money(product.priceMinor, product.currency) }),
          h('span', { class: `${CLS.muted} ms-2`, text: tr('shop_per', { unit: product.unit }) })]),
        hint ? h('p', { class: 'text-xs font-bold text-amber-700 dark:text-amber-300', text: hint }) : null,
        h('div', { class: 'flex items-end gap-2' }, [quantity,
          button(tr('shop_add'), CLS.primary, () => addToBasket(product, Number(quantity.value)), { disabled: stock < 1 || !ships, 'aria-label': `${tr('shop_add')}: ${productName(product)}` })])
      ])
    ]);
  }

  function addToBasket(product, quantity) {
    const lines = basketLines();
    if (lines.length && lines[0].product.farmId !== product.farmId) { say(tr('shop_one_farm')); return; }
    const wanted = Math.max(1, Math.min(50, Number(product.stockUnits) || 0, Math.floor(quantity) || 1));
    view.basket.set(product.id, wanted);
    view.orderKey = '';
    render();
  }

  function summaryRows(sums, country) {
    const row = (label, value, strong) => h('div', { class: `flex justify-between gap-4 text-sm ${strong ? 'font-black text-stone-900 dark:text-white' : 'text-stone-700 dark:text-stone-200'}` },
      [h('span', { text: label }), h('span', { text: value })]);
    const farmNet = sums.farmNetMinor === undefined ? sums.itemsMinor - sums.feeMinor : sums.farmNetMinor;
    return h('div', { class: 'space-y-1', 'data-shop-summary': '' }, [
      row(tr('shop_goods'), money(sums.itemsMinor, sums.currency)),
      row(tr('shop_shipping', { country: countryName(country) }), sums.shippingMinor === null ? '–' : money(sums.shippingMinor, sums.currency)),
      row(tr('shop_total'), sums.totalMinor === null ? '–' : money(sums.totalMinor, sums.currency), true),
      h('p', { class: CLS.muted, 'data-shop-split': '', text: tr('shop_split', { fee: percent(sums.feeBps), feeAmount: money(sums.feeMinor, sums.currency), farmAmount: money(farmNet, sums.currency) }) })
    ]);
  }

  function renderBasket() {
    const lines = basketLines();
    const box = h('section', { class: CLS.card, id: 'shop-basket', 'aria-label': tr('shop_basket') }, [h('h3', { class: CLS.h3, text: tr('shop_basket') })]);
    if (!lines.length) { box.append(h('p', { class: CLS.muted, text: tr('shop_basket_empty') })); return box; }
    const sums = estimate();
    box.append(h('ul', { class: 'space-y-2' }, lines.map((line) => h('li', { class: CLS.row }, [
      h('span', { class: 'text-sm text-stone-800 dark:text-stone-100', text: `${line.quantity} × ${productName(line.product)} (${line.product.unit})` }),
      h('span', { class: 'flex items-center gap-3' }, [
        h('span', { class: 'text-sm font-bold text-stone-900 dark:text-white', text: money(line.product.priceMinor * line.quantity, line.product.currency) }),
        button(tr('shop_remove'), CLS.ghost, () => { view.basket.delete(line.product.id); view.orderKey = ''; render(); }, { 'aria-label': `${tr('shop_remove')}: ${productName(line.product)}` })
      ])
    ]))), summaryRows(sums, view.dest), h('p', { class: CLS.muted, text: tr('shop_estimate_note') }));
    if (view.formError) box.append(h('p', { class: CLS.alert, role: 'alert', text: view.formError }));
    box.append(button(tr('shop_checkout'), CLS.primary, startCheckout, { disabled: view.busy || sums.totalMinor === null, id: 'shop-checkout' }));
    return box;
  }

  const orderItems = () => basketLines().map((line) => ({ productId: line.product.id, quantity: line.quantity }));

  async function startCheckout() {
    if (!signedIn()) {
      say(tr('shop_signin_first'));
      if (typeof openAuthModal === 'function') openAuthModal();
      return;
    }
    view.busy = true; view.formError = ''; render();
    try {
      const { data } = await api().quoteOrder({ items: orderItems(), destCountry: view.dest });
      view.quote = data;
      view.step = 'checkout';
      if (!view.orderKey) view.orderKey = (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-shop-order`;
    } catch (error) {
      view.formError = errorMessage(error);
      if (error && ['out-of-stock', 'product-unavailable'].includes(error.code)) { view.busy = false; await load(); view.formError = errorMessage(error); }
    }
    view.busy = false;
    render();
  }

  const address = { name: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', phone: '' };

  function renderCheckout() {
    const quote = view.quote;
    const input = (key, autocomplete, required) => h('input', { type: key === 'phone' ? 'tel' : 'text', class: CLS.input, value: address[key], maxlength: key === 'postalCode' ? 20 : key === 'phone' ? 40 : 120,
      autocomplete, required, name: `shop-${key}`, on: { input: (event) => { address[key] = event.target.value; } } });
    const form = h('form', { class: CLS.card, id: 'shop-checkout-form', novalidate: true, on: { submit: placeOrder } }, [
      h('h3', { class: CLS.h3, text: tr('shop_checkout_title') }),
      h('ul', { class: 'space-y-1' }, (quote.lines || []).map((line) => h('li', { class: 'text-sm text-stone-800 dark:text-stone-100', text: `${line.quantity} × ${line.name} (${line.unit}) · ${money(line.lineMinor, quote.currency)}` }))),
      summaryRows(quote, quote.destCountry),
      h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
        labelled(tr('shop_f_name'), input('name', 'name', true)),
        labelled(tr('shop_f_phone'), input('phone', 'tel', false)),
        labelled(tr('shop_f_line1'), input('addressLine1', 'address-line1', true)),
        labelled(tr('shop_f_line2'), input('addressLine2', 'address-line2', false)),
        labelled(tr('shop_f_postal'), input('postalCode', 'postal-code', false)),
        labelled(tr('shop_f_city'), input('city', 'address-level2', true)),
        labelled(tr('shop_f_country'), h('input', { type: 'text', class: CLS.input, value: countryName(quote.destCountry), readonly: true }))
      ]),
      h('p', { class: CLS.muted, text: tr('shop_pay_note') }),
      view.formError ? h('p', { class: CLS.alert, role: 'alert', text: view.formError }) : null,
      h('div', { class: 'flex flex-wrap gap-3' }, [
        h('button', { type: 'submit', class: CLS.primary, disabled: view.busy, text: tr('shop_place_order', { total: money(quote.totalMinor, quote.currency) }) }),
        button(tr('shop_back'), CLS.ghost, () => { view.step = 'basket'; view.formError = ''; render(); })
      ])
    ]);
    return form;
  }

  async function placeOrder(event) {
    event.preventDefault();
    if (view.busy) return;
    const contact = Object.fromEntries(Object.entries(address).map(([key, value]) => [key, String(value).trim()]));
    if (contact.name.length < 2 || contact.addressLine1.length < 3 || contact.city.length < 2) { view.formError = tr('shop_address_missing'); render(); return; }
    view.busy = true; view.formError = ''; render();
    try {
      // Price the basket once more: the customer confirms exactly the total the order will carry.
      const fresh = (await api().quoteOrder({ items: orderItems(), destCountry: view.quote.destCountry })).data;
      if (fresh.totalMinor !== view.quote.totalMinor) {
        view.quote = fresh; view.formError = tr('shop_price_changed'); view.busy = false; render(); return;
      }
      await api().createOrder({ idempotencyKey: view.orderKey, items: orderItems(), contact: { ...contact, country: view.quote.destCountry } });
      view.basket.clear(); view.quote = null; view.step = 'basket'; view.orderKey = ''; view.channels = null;
      view.busy = false;
      say(tr('shop_ordered'));
      await load();
      const orders = document.getElementById('shop-orders');
      if (orders) orders.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    } catch (error) {
      view.formError = errorMessage(error);
    }
    view.busy = false;
    render();
  }

  function renderOrders() {
    const act = (order, call, message) => async () => {
      if (view.busy) return;
      view.busy = true;
      try { await call({ orderId: order.orderId }); say(message); } catch (error) { say(errorMessage(error)); }
      view.busy = false;
      await load();
    };
    return h('section', { class: CLS.card, id: 'shop-orders', 'aria-label': tr('shop_orders') }, [
      h('h3', { class: CLS.h3, text: tr('shop_orders') }),
      h('ul', { class: 'space-y-4' }, view.orders.map((order) => {
        const waiting = order.status === 'awaiting_payment';
        const channels = Array.isArray(view.channels) ? view.channels : [];
        return h('li', { class: 'border border-stone-200 dark:border-stone-700 rounded-2xl p-4 space-y-2', 'data-order': order.orderId }, [
          h('div', { class: CLS.row }, [
            h('span', { class: 'text-sm font-black text-stone-900 dark:text-white font-mono', text: order.paymentReference }),
            h('span', { class: CLS.badge, text: tr(`shop_st_${order.status}`) })
          ]),
          h('p', { class: CLS.muted, text: `${dateTime(order.createdAt)} · ${farmName(order.farmId)}` }),
          h('ul', {}, (order.lines || []).map((line) => h('li', { class: 'text-sm text-stone-800 dark:text-stone-100', text: `${line.quantity} × ${line.name} (${line.unit})` }))),
          summaryRows(order, order.destCountry),
          order.trackingCode ? h('p', { class: CLS.muted, text: `${tr('shop_tracking')}: ${order.trackingCode}` }) : null,
          order.reviewNote && (order.status === 'rejected' || order.status === 'refunded') ? h('p', { class: CLS.muted, text: `${tr('shop_note')}: ${order.reviewNote}` }) : null,
          waiting ? h('div', { class: 'bg-stone-50 dark:bg-stone-900 rounded-xl p-3 space-y-1' }, [
            h('p', { class: 'text-sm font-bold text-stone-900 dark:text-white', text: `${tr('shop_order_ref')}: ${order.paymentReference}` }),
            h('p', { class: CLS.muted, text: tr('shop_pay_until', { date: dateTime(order.expiresAt) }) }),
            channels.length
              ? h('div', {}, [h('p', { class: CLS.muted, text: `${tr('shop_pay_accounts')}:` }),
                h('ul', {}, channels.map((channel) => h('li', { class: 'text-sm text-stone-800 dark:text-stone-100', text: `${(isArabic() ? channel.titleAr : (channel.titleEn || channel.titleAr)) || ''}: ${channel.account || ''}` })))])
              : h('p', { class: CLS.alert, role: 'alert', text: tr('shop_pay_accounts_missing') })
          ]) : null,
          waiting ? h('div', { class: 'flex flex-wrap gap-3' }, [
            button(tr('shop_i_paid'), CLS.primary, act(order, api().reportOrderPayment, tr('shop_reported')), { disabled: !channels.length, 'aria-label': `${tr('shop_i_paid')}: ${order.paymentReference}` }),
            button(tr('shop_cancel'), CLS.ghost, act(order, api().cancelMyOrder, tr('shop_cancelled')), { 'aria-label': `${tr('shop_cancel')}: ${order.paymentReference}` })
          ]) : null
        ]);
      }))
    ]);
  }

  // ------------------------------------------------------------------------------------------------ farm accounts

  function renderFarm(farm) {
    const name = (isArabic() ? farm.name : (farm.nameEn || farm.name)) || farm.farmId;
    const editing = view.editing && view.editing.farmId === farm.farmId ? view.editing : null;
    const balances = Array.isArray(farm.balances) ? farm.balances : [];
    const products = Array.isArray(farm.products) ? farm.products : [];
    const orders = Array.isArray(farm.orders) ? farm.orders : [];
    const box = h('section', { class: CLS.card, 'data-farm': farm.farmId, 'aria-label': tr('shop_farm_title', { farm: name }) }, [
      h('div', { class: CLS.row }, [h('h3', { class: CLS.h3, text: tr('shop_farm_title', { farm: name }) }),
        editing ? null : button(tr('shop_farm_new'), CLS.primary, () => { view.editing = { farmId: farm.farmId, product: null }; render(); })]),
      h('p', { class: CLS.muted, text: `${tr('shop_farm_balance')}: ${balances.length ? balances.map((b) => money(b.amountMinor, b.currency)).join(' · ') : money(0, 'EUR')}` }),
      h('p', { class: CLS.muted, text: tr('shop_farm_review_hint') })
    ]);
    if (editing) box.append(renderProductForm(farm, editing.product));
    box.append(h('h4', { class: CLS.title, text: tr('shop_farm_products') }));
    if (!products.length) box.append(h('p', { class: CLS.muted, text: tr('shop_farm_no_products') }));
    else box.append(h('ul', { class: 'space-y-3' }, products.map((product) => {
      const title = productName(product);
      const stock = h('input', { type: 'number', min: 0, max: 1000000, value: product.stockUnits, class: `${CLS.input} w-24`, inputmode: 'numeric', 'aria-label': `${tr('shop_p_stock')}: ${title}` });
      const save = async (payload, message) => {
        try { await api().farmerSetProductStock({ productId: product.productId, ...payload }); say(message); } catch (error) { say(errorMessage(error)); }
        await load();
      };
      return h('li', { class: 'border border-stone-200 dark:border-stone-700 rounded-2xl p-4 space-y-2', 'data-own-product': product.productId }, [
        h('div', { class: CLS.row }, [h('span', { class: 'text-sm font-black text-stone-900 dark:text-white', text: `${title} · ${money(product.priceMinor, product.currency)} ${tr('shop_per', { unit: product.unit })}` }),
          h('span', { class: CLS.badge, text: tr(`shop_ps_${product.status}`) })]),
        product.reviewNote ? h('p', { class: CLS.muted, text: `${tr('shop_note')}: ${product.reviewNote}` }) : null,
        h('div', { class: 'flex flex-wrap items-end gap-2' }, [
          labelled(tr('shop_p_stock'), stock),
          button(tr('shop_stock_save'), CLS.ghost, () => {
            const units = Math.floor(Number(stock.value));
            if (!Number.isFinite(units) || units < 0) { say(tr('shop_err_invalid_argument')); return; }
            save({ stockUnits: units }, tr('shop_stock_saved'));
          }, { 'aria-label': `${tr('shop_stock_save')}: ${title}` }),
          button(tr('shop_farm_edit'), CLS.ghost, () => { view.editing = { farmId: farm.farmId, product }; render(); }, { 'aria-label': `${tr('shop_farm_edit')}: ${title}` }),
          product.status === 'listed' ? button(tr('shop_unlist'), CLS.ghost, () => save({ unlist: true }, tr('shop_unlisted')), { 'aria-label': `${tr('shop_unlist')}: ${title}` }) : null
        ])
      ]);
    })));
    box.append(h('h4', { class: CLS.title, text: tr('shop_farm_orders') }));
    if (!orders.length) box.append(h('p', { class: CLS.muted, text: tr('shop_farm_no_orders') }));
    else box.append(h('ul', { class: 'space-y-2' }, orders.map((order) => h('li', { class: 'text-sm text-stone-800 dark:text-stone-100' }, [
      h('span', { class: CLS.badge, text: tr(`shop_st_${order.status}`) }),
      h('span', { class: 'ms-2', text: `${dateTime(order.createdAt)} · ${(order.lines || []).map((line) => `${line.quantity} × ${line.name} (${line.unit})`).join(', ')} · ${money(order.farmNetMinor === undefined ? order.itemsMinor - order.feeMinor : order.farmNetMinor, order.currency)}` })
    ]))));
    return box;
  }

  function renderProductForm(farm, product) {
    const draft = product || {};
    const field = (key, extra) => h('input', { type: 'text', class: CLS.input, value: draft[key] || '', maxlength: 120, ...(extra || {}) });
    const f = {
      category: h('select', { class: CLS.input }, CATEGORIES.map((c) => h('option', { value: c, text: tr(`shop_cat_${c}`), selected: c === (draft.category || 'oil') }))),
      name: field('name', { dir: 'rtl', lang: 'ar' }), nameEn: field('nameEn', { dir: 'ltr', lang: 'en' }),
      description: h('textarea', { class: CLS.input, rows: 3, maxlength: 1000, dir: 'rtl', lang: 'ar', text: draft.description || '' }),
      descriptionEn: h('textarea', { class: CLS.input, rows: 3, maxlength: 1000, dir: 'ltr', lang: 'en', text: draft.descriptionEn || '' }),
      unit: field('unit', { maxlength: 40 }),
      price: h('input', { type: 'number', class: CLS.input, min: 0, step: 'any', inputmode: 'decimal', value: draft.priceMinor ? draft.priceMinor / unitFactor(draft.currency || 'EUR') : '' }),
      currency: h('input', { type: 'text', class: CLS.input, maxlength: 3, value: draft.currency || 'EUR' }),
      stock: h('input', { type: 'number', class: CLS.input, min: 0, max: 1000000, inputmode: 'numeric', value: draft.stockUnits === undefined ? 0 : draft.stockUnits })
    };
    const error = h('p', { class: CLS.alert, role: 'alert', hidden: true });
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    // What the farm keeps per unit, with the fee rate in force now (the server applies the rate of the order's day).
    const net = h('p', { class: CLS.muted, id: 'shop-product-net', 'aria-live': 'polite' });
    const readPrice = () => {
      const currency = f.currency.value.trim().toUpperCase();
      const price = Number(String(f.price.value).replace(',', '.'));
      if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(price) || price <= 0) return null;
      return { currency, minor: Math.round(price * unitFactor(currency)) };
    };
    const showNet = () => {
      const price = readPrice();
      const fee = price ? Math.round(price.minor * view.feeBps / 10000) : 0;
      net.textContent = price ? tr('shop_p_net', { net: money(price.minor - fee, price.currency), feeAmount: money(fee, price.currency), fee: percent(view.feeBps) }) : '';
    };
    f.price.addEventListener('input', showNet);
    f.currency.addEventListener('input', showNet);
    showNet();
    return h('form', { class: 'border border-stone-200 dark:border-stone-700 rounded-2xl p-4 space-y-3', id: 'shop-product-form', novalidate: true, on: { submit: async (event) => {
      event.preventDefault();
      const price = readPrice();
      const stock = Math.floor(Number(f.stock.value));
      if (f.name.value.trim().length < 2 || !f.unit.value.trim() || !price || price.minor < 1 || !Number.isFinite(stock) || stock < 0) { fail(tr('shop_p_missing')); return; }
      const payload = { farmId: farm.farmId, category: f.category.value, name: f.name.value.trim(), nameEn: f.nameEn.value.trim(), description: f.description.value.trim(),
        descriptionEn: f.descriptionEn.value.trim(), unit: f.unit.value.trim(), priceMinor: price.minor, currency: price.currency, stockUnits: stock };
      if (product) payload.productId = product.productId;
      try {
        await api().farmerUpsertProduct(payload);
        view.editing = null;
        say(tr('shop_p_saved'));
        await load();
      } catch (err) { fail(errorMessage(err)); }
    } } }, [
      h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
        labelled(tr('shop_p_category'), f.category), labelled(tr('shop_p_unit'), f.unit),
        labelled(tr('shop_p_name'), f.name), labelled(tr('shop_p_name_en'), f.nameEn),
        labelled(tr('shop_p_desc'), f.description), labelled(tr('shop_p_desc_en'), f.descriptionEn),
        labelled(tr('shop_p_price'), f.price), labelled(tr('shop_p_currency'), f.currency),
        labelled(tr('shop_p_stock'), f.stock)
      ]),
      net,
      error,
      h('div', { class: 'flex flex-wrap gap-3' }, [
        h('button', { type: 'submit', class: CLS.primary, text: tr('shop_p_submit') }),
        button(tr('shop_p_cancel'), CLS.ghost, () => { view.editing = null; render(); })
      ])
    ]);
  }

  // ------------------------------------------------------------------------------------------------ wiring

  let authTimer = null;
  window.addEventListener('faseela-auth-state', () => {
    // The app's own listener fills state.currentUser first; then orders and the farm of the new account are read.
    clearTimeout(authTimer);
    authTimer = setTimeout(() => { view.channels = null; view.step = 'basket'; view.quote = null; load(); }, 900);
  });

  window.FaseelaShop = Object.freeze({
    /** Called by switchMarketplaceTrack('shop') and after a language change. */
    show: () => { if (view.status === 'idle' || view.status === 'error') load(); else render(); },
    render,
    refresh: load
  });

  // The backend module loads after this script; wait for it, but not forever (offline start, blocked module).
  let waited = 0;
  const start = () => { if (api()) load(); else if ((waited += 1) < 50) setTimeout(start, 400); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
