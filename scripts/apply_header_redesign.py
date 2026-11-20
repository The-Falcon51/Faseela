import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Redesign Header HTML
old_header = re.search(r'<header class="sticky top-0 z-40[\s\S]*?</header>', content)
if not old_header:
    print("Could not find old header!")
    exit(1)

new_header = '''<header class="sticky top-0 z-40 bg-white/95 backdrop-blur-xl border-b border-stone-200/80 shadow-xs transition-all">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-20 gap-2 sm:gap-4">
        
        <!-- 1. Brand Logo (Start) -->
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer select-none group flex-shrink-0" onclick="navigateTo('home')">
          <div class="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-olive-700 via-olive-800 to-olive-950 text-white flex items-center justify-center shadow-md shadow-olive-900/15 group-hover:scale-105 transition-all">
            <i data-lucide="sprout" class="w-6 h-6 text-amber-300"></i>
          </div>
          <div>
            <span class="text-xl sm:text-2xl font-black text-olive-950 tracking-tight leading-none block" data-i18n="brand_title">فَسِيلَة</span>
            <span class="text-[10px] sm:text-[11px] font-semibold text-olive-700/90 tracking-wide mt-0.5 block" data-i18n="brand_subtitle">المنصة التشاركية لزيتون سوريا</span>
          </div>
        </div>

        <!-- 2. Main Navigation Bar (Center - Desktop) -->
        <nav class="hidden lg:flex items-center gap-1 bg-stone-100/90 p-1.5 rounded-full border border-stone-200/80 text-xs font-semibold shadow-2xs">
          <button onclick="navigateTo('home')" id="nav-home" class="px-3.5 py-1.5 rounded-full font-bold transition-all text-olive-950 bg-white shadow-xs" data-i18n="nav_home">
            الرئيسية
          </button>
          <button onclick="navigateTo('marketplace')" id="nav-marketplace" class="px-3.5 py-1.5 rounded-full transition-all text-stone-600 hover:text-olive-900 hover:bg-stone-200/50" data-i18n="nav_marketplace">
            سوق الأشجار
          </button>
          <button onclick="navigateTo('dashboard')" id="nav-dashboard" class="px-3.5 py-1.5 rounded-full transition-all text-stone-600 hover:text-olive-900 hover:bg-stone-200/50 flex items-center gap-1.5">
            <span data-i18n="nav_dashboard">محفظتي</span>
            <span id="user-shares-count" class="bg-olive-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">1</span>
          </button>
          <button onclick="navigateTo('farmer-portal')" id="nav-farmer" class="px-3.5 py-1.5 rounded-full transition-all text-stone-600 hover:text-olive-900 hover:bg-stone-200/50 flex items-center gap-1">
            <i data-lucide="tractor" class="w-3.5 h-3.5 text-olive-600"></i>
            <span data-i18n="nav_farmer">بوابة المزارع</span>
          </button>
          <button onclick="navigateTo('mill-portal')" id="nav-mill" class="px-3.5 py-1.5 rounded-full transition-all text-stone-600 hover:text-olive-900 hover:bg-stone-200/50 flex items-center gap-1">
            <i data-lucide="cog" class="w-3.5 h-3.5 text-amber-600"></i>
            <span class="font-bold text-amber-950" data-i18n="nav_mill">بوابة المعاصر</span>
          </button>
        </nav>

        <!-- 3. Right Action Controls (End) -->
        <div class="flex items-center gap-1.5 sm:gap-2.5">
          
          <!-- Ask Faseela Button (Compact Advisor Badge) -->
          <button onclick="toggleFaseelaChat()" class="hidden md:flex items-center gap-2 bg-gradient-to-r from-olive-50 to-emerald-50 hover:from-olive-100 hover:to-emerald-100 text-olive-950 border border-olive-300/80 px-3 py-2 rounded-2xl text-xs font-bold shadow-2xs hover:shadow-xs transition-all">
            <div class="relative flex items-center justify-center">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span class="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-75"></span>
            </div>
            <span data-i18n="nav_chat">تحدث مع فسيلة</span>
          </button>

          <!-- Unified Preferences Group (Currency & Language) -->
          <div class="flex items-center bg-stone-100/90 border border-stone-200/90 p-1 rounded-2xl gap-1 shadow-2xs">
            
            <!-- Currency Switcher Toggle -->
            <div class="flex items-center text-[11px] font-bold">
              <button onclick="setCurrency('USD')" id="btn-curr-usd" title="US Dollar" class="px-2 py-1 rounded-xl transition-all bg-white text-olive-950 shadow-2xs font-bold">
                USD
              </button>
              <button onclick="setCurrency('SYP')" id="btn-curr-syp" title="Syrian Pound" class="px-2 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold">
                SYP
              </button>
            </div>

            <div class="h-3.5 w-[1px] bg-stone-300/80"></div>

            <!-- Language Switcher Toggle -->
            <div class="flex items-center text-[11px] font-bold">
              <button onclick="setLanguage('ar')" id="btn-lang-ar" class="px-2 sm:px-2.5 py-1 rounded-xl transition-all bg-white text-olive-950 shadow-2xs font-bold">
                العربية
              </button>
              <button onclick="setLanguage('en')" id="btn-lang-en" class="px-2 sm:px-2.5 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold">
                English
              </button>
            </div>
          </div>

          <!-- Active User Session & Security Profile Pill -->
          <button onclick="openAuthModal()" id="btn-user-session" data-i18n-title="session_btn_title" title="تصريح الدخول والمصادقة على الهوية (RBAC)" class="bg-stone-50 hover:bg-stone-100 border border-stone-200/90 px-2 sm:px-2.5 py-1.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all shadow-2xs hover:shadow-xs text-stone-800 flex-shrink-0">
            <div class="w-6 h-6 rounded-xl bg-gradient-to-br from-olive-700 to-olive-900 text-white text-[11px] flex items-center justify-center font-black shadow-inner flex-shrink-0" id="session-user-avatar">
              ط
            </div>
            <div class="text-start leading-tight hidden sm:block">
              <span id="session-user-name" class="font-bold text-stone-900 text-xs block truncate max-w-[100px]">طارق السوري</span>
              <span id="session-user-role-badge" class="bg-olive-100 text-olive-800 border border-olive-300/60 text-[9px] px-1.5 py-0.2 rounded-md font-semibold inline-block">مستثمر</span>
            </div>
            <div class="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white flex-shrink-0"></div>
          </button>

          <!-- Mobile Hamburger Toggle Button (< lg) -->
          <button type="button" onclick="toggleMobileNavMenu()" id="mobile-nav-toggle" aria-label="Toggle Navigation" class="lg:hidden p-2 rounded-2xl border border-stone-200 bg-stone-100 hover:bg-stone-200 text-stone-700 transition-all flex items-center justify-center">
            <i id="mobile-nav-icon" data-lucide="menu" class="w-5 h-5"></i>
          </button>
        </div>

      </div>

      <!-- Mobile Dropdown Navigation Drawer -->
      <div id="mobile-nav-drawer" class="hidden lg:hidden border-t border-stone-200 py-3 space-y-1 text-xs">
        <button onclick="navigateTo('home'); toggleMobileNavMenu();" class="w-full text-start px-3 py-2 rounded-xl font-bold text-stone-800 hover:bg-stone-100 flex items-center gap-2">
          <i data-lucide="home" class="w-4 h-4 text-olive-700"></i>
          <span data-i18n="nav_home">الرئيسية</span>
        </button>
        <button onclick="navigateTo('marketplace'); toggleMobileNavMenu();" class="w-full text-start px-3 py-2 rounded-xl font-bold text-stone-800 hover:bg-stone-100 flex items-center gap-2">
          <i data-lucide="shopping-bag" class="w-4 h-4 text-olive-700"></i>
          <span data-i18n="nav_marketplace">سوق الأشجار</span>
        </button>
        <button onclick="navigateTo('dashboard'); toggleMobileNavMenu();" class="w-full text-start px-3 py-2 rounded-xl font-bold text-stone-800 hover:bg-stone-100 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <i data-lucide="wallet" class="w-4 h-4 text-olive-700"></i>
            <span data-i18n="nav_dashboard">محفظتي</span>
          </div>
          <span id="mobile-user-shares-count" class="bg-olive-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">1</span>
        </button>
        <button onclick="navigateTo('farmer-portal'); toggleMobileNavMenu();" class="w-full text-start px-3 py-2 rounded-xl font-bold text-stone-800 hover:bg-stone-100 flex items-center gap-2">
          <i data-lucide="tractor" class="w-4 h-4 text-olive-700"></i>
          <span data-i18n="nav_farmer">بوابة المزارع</span>
        </button>
        <button onclick="navigateTo('mill-portal'); toggleMobileNavMenu();" class="w-full text-start px-3 py-2 rounded-xl font-bold text-stone-800 hover:bg-stone-100 flex items-center gap-2">
          <i data-lucide="cog" class="w-4 h-4 text-amber-600"></i>
          <span data-i18n="nav_mill">بوابة المعاصر</span>
        </button>
        <button onclick="toggleFaseelaChat(); toggleMobileNavMenu();" class="w-full text-start px-3 py-2.5 rounded-xl font-bold text-olive-900 bg-olive-50 hover:bg-olive-100 flex items-center gap-2 mt-1">
          <i data-lucide="sprout" class="w-4 h-4 text-emerald-600"></i>
          <span data-i18n="nav_chat">تحدث مع فسيلة</span>
        </button>
      </div>

    </div>
  </header>'''

content = content[:old_header.start()] + new_header + content[old_header.end():]
print("New Header HTML inserted successfully.")

# 2. Update users avatar_en in state.users
content = content.replace(
    'avatar: "ط",',
    'avatar: "ط",\n          avatar_en: "T",'
)
content = content.replace(
    'avatar: "أ",',
    'avatar: "أ",\n          avatar_en: "A",'
)
content = content.replace(
    'avatar: "س",',
    'avatar: "س",\n          avatar_en: "S",'
)
content = content.replace(
    'avatar: "ز",',
    'avatar: "ز",\n          avatar_en: "G",'
)

# 3. Add session_btn_title to i18n
if 'session_btn_title' not in content:
    content = content.replace(
        'brand_title: "فَسِيلَة",',
        'brand_title: "فَسِيلَة",\n        session_btn_title: "تصريح الدخول والمصادقة على الهوية (RBAC)",'
    )
    content = content.replace(
        'brand_title: "FASEELA",',
        'brand_title: "FASEELA",\n        session_btn_title: "Identity Verification & Role Authorization (RBAC)",'
    )

# 4. Replace updateNavbarSecurityLocks implementation with enhanced bilingual and clean version
old_nav_fn = re.search(r'function updateNavbarSecurityLocks\(\)\s*\{[\s\S]*?\n\s*\}', content)
if old_nav_fn:
    new_nav_fn = '''function updateNavbarSecurityLocks() {
      const isAuth = !!state.currentUser && state.currentUser.role !== 'guest';
      const role = isAuth ? state.currentUser.role : 'guest';
      const isEn = state.currentLang === 'en';
      const locks = {
        'dashboard': isAuth && (role === 'investor' || role === 'admin'),
        'farmer': isAuth && (role === 'farmer' || role === 'admin'),
        'mill': isAuth && (role === 'mill_owner' || role === 'admin')
      };

      const lockTooltip = isEn ? "Role Protected - Click user session to switch" : "محمي بصلاحيات الدخول - اضغط لتبديل الحساب";

      const dashBtn = document.getElementById('nav-dashboard');
      if (dashBtn) {
        const myShares = isAuth ? state.userShares.filter(s => s.user_id === state.currentUser.id).length : 0;
        dashBtn.innerHTML = `<span data-i18n="nav_dashboard">${t('nav_dashboard')}</span> ${!locks.dashboard ? `<i data-lucide="lock" title="${lockTooltip}" class="w-3 h-3 text-stone-400"></i>` : `<span id="user-shares-count" class="bg-olive-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">${myShares}</span>`}`;
        const mobShares = document.getElementById('mobile-user-shares-count');
        if (mobShares) mobShares.innerText = myShares;
      }

      const farmerBtn = document.getElementById('nav-farmer');
      if (farmerBtn) {
        farmerBtn.innerHTML = `<i data-lucide="tractor" class="w-3.5 h-3.5 text-olive-600"></i> <span data-i18n="nav_farmer">${t('nav_farmer')}</span> ${!locks.farmer ? `<i data-lucide="lock" title="${lockTooltip}" class="w-3 h-3 text-stone-400"></i>` : ''}`;
      }

      const millBtn = document.getElementById('nav-mill');
      if (millBtn) {
        millBtn.innerHTML = `<i data-lucide="cog" class="w-3.5 h-3.5 text-amber-600"></i> <span class="font-bold text-amber-950" data-i18n="nav_mill">${t('nav_mill')}</span> ${!locks.mill ? `<i data-lucide="lock" title="${lockTooltip}" class="w-3 h-3 text-stone-400"></i>` : ''}`;
      }

      const homeBtn = document.getElementById('nav-home');
      if (homeBtn) homeBtn.innerText = t('nav_home');

      const marketBtn = document.getElementById('nav-marketplace');
      if (marketBtn) marketBtn.innerText = t('nav_marketplace');

      const sessAvatar = document.getElementById('session-user-avatar');
      const sessName = document.getElementById('session-user-name');
      const sessRole = document.getElementById('session-user-role-badge');
      const sessBtn = document.getElementById('btn-user-session');

      if (sessBtn) {
        sessBtn.title = isEn ? "Identity Verification & Role Authorization (RBAC)" : "تصريح الدخول والمصادقة على الهوية (RBAC)";
      }

      if (isAuth) {
        if (sessAvatar) sessAvatar.innerText = isEn ? (state.currentUser.avatar_en || state.currentUser.avatar) : state.currentUser.avatar;
        if (sessName) sessName.innerText = isEn ? (state.currentUser.name_en || state.currentUser.name) : state.currentUser.name;
        if (sessRole) {
          sessRole.innerText = isEn ? (state.currentUser.roleName_en || state.currentUser.roleName) : state.currentUser.roleName;
          sessRole.className = `${state.currentUser.badgeColor || 'bg-olive-100 text-olive-800 border border-olive-300/60'} text-[9px] px-1.5 py-0.2 rounded-md font-semibold inline-block`;
        }
      } else {
        if (sessAvatar) sessAvatar.innerText = isEn ? 'G' : '؟';
        if (sessName) sessName.innerText = isEn ? 'Sign In' : 'تصريح الدخول';
        if (sessRole) {
          sessRole.innerText = isEn ? 'Guest' : 'غير مسجل';
          sessRole.className = 'bg-stone-200 text-stone-700 text-[9px] px-1.5 py-0.2 rounded-md font-semibold inline-block';
        }
      }

      // Update Currency switcher button text based on language and active currency
      const btnUsd = document.getElementById('btn-curr-usd');
      const btnSyp = document.getElementById('btn-curr-syp');
      if (btnUsd) btnUsd.innerText = isEn ? 'USD' : 'USD';
      if (btnSyp) btnSyp.innerText = isEn ? 'SYP' : 'ل.س';

      if (state.currency === 'USD') {
        if (btnUsd) btnUsd.className = 'px-2 py-1 rounded-xl transition-all bg-white text-olive-950 font-bold shadow-2xs';
        if (btnSyp) btnSyp.className = 'px-2 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold';
      } else {
        if (btnSyp) btnSyp.className = 'px-2 py-1 rounded-xl transition-all bg-white text-olive-950 font-bold shadow-2xs';
        if (btnUsd) btnUsd.className = 'px-2 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold';
      }

      // Update Language switcher buttons
      const btnAr = document.getElementById('btn-lang-ar');
      const btnEn = document.getElementById('btn-lang-en');
      if (btnAr && btnEn) {
        if (isEn) {
          btnEn.className = 'px-2 sm:px-2.5 py-1 rounded-xl transition-all bg-white text-olive-950 font-bold shadow-2xs';
          btnAr.className = 'px-2 sm:px-2.5 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold';
        } else {
          btnAr.className = 'px-2 sm:px-2.5 py-1 rounded-xl transition-all bg-white text-olive-950 font-bold shadow-2xs';
          btnEn.className = 'px-2 sm:px-2.5 py-1 rounded-xl transition-all text-stone-500 hover:text-stone-900 font-semibold';
        }
      }

      lucide.createIcons();
    }

    function toggleMobileNavMenu() {
      const drawer = document.getElementById('mobile-nav-drawer');
      const icon = document.getElementById('mobile-nav-icon');
      if (drawer) {
        drawer.classList.toggle('hidden');
        if (icon) {
          const isOpen = !drawer.classList.contains('hidden');
          icon.setAttribute('data-lucide', isOpen ? 'x' : 'menu');
          lucide.createIcons();
        }
      }
    }'''
    content = content[:old_nav_fn.start()] + new_nav_fn + content[old_nav_fn.end():]
    print("Updated updateNavbarSecurityLocks and added toggleMobileNavMenu.")

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Header redesign and bilingual logic successfully applied.")
