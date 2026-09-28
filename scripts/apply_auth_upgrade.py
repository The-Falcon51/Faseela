import re
import sys

print("Reading public/index.html...")
with open("public/index.html", "r", encoding="utf-8") as f:
    content = f.read()

# Locate the old modal-auth-session
old_modal_start = '<div id="modal-auth-session"'
old_modal_end = '<!-- 9. Access Denied Security Modal'

start_pos = content.find(old_modal_start)
end_pos = content.find(old_modal_end)

if start_pos == -1 or end_pos == -1:
    print("Error: Could not locate modal boundaries!", start_pos, end_pos)
    sys.exit(1)

print("Found modal slice:", start_pos, "to", end_pos)

new_modal_html = """<div id="modal-auth-session" class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm hidden flex items-center justify-center p-4">
    <div class="bg-white w-full max-w-lg rounded-3xl p-6 sm:p-8 shadow-2xl border border-stone-200 text-start space-y-5 max-h-[92vh] overflow-y-auto">
      
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100">
        <div class="flex items-center gap-2.5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-br from-olive-800 to-olive-950 text-white flex items-center justify-center shadow-md border border-olive-600/30">
            <i data-lucide="shield-check" class="w-5 h-5 text-emerald-300"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-black text-olive-950" id="auth-modal-title">تصريح الدخول والمصادقة على الهوية</h3>
            <p class="text-[11px] text-stone-500" id="auth-modal-subtitle">التعرف على البريد الإلكتروني ورقم الهاتف وتخويل الصلاحيات</p>
          </div>
        </div>
        <button onclick="closeModal('modal-auth-session')" class="w-8 h-8 rounded-full bg-stone-100 hover:bg-stone-200 flex items-center justify-center text-stone-600">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <!-- VIEW 1: Active Authenticated Session Profile (If Logged In) -->
      <div id="auth-view-profile" class="space-y-4">
        <div class="bg-gradient-to-br from-stone-900 to-olive-950 text-white p-5 rounded-2xl space-y-3 shadow-md">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-stone-300" id="auth-profile-status-label">الحساب المصرح له حالياً:</span>
            <span class="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1">
              <i data-lucide="check-circle" class="w-3 h-3"></i>
              <span id="auth-profile-badge-text">هوية موثقة ومصادق عليها</span>
            </span>
          </div>

          <div class="flex items-center gap-3.5 pt-1">
            <div id="auth-profile-avatar" class="w-12 h-12 rounded-2xl bg-olive-700 text-white font-black text-lg flex items-center justify-center border border-olive-500/40 shadow-sm">
              ط
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span id="auth-profile-name" class="text-base font-black text-white">طارق السوري</span>
                <span id="auth-profile-role" class="bg-olive-600/80 text-olive-200 text-[10px] font-bold px-2 py-0.5 rounded-md">مستثمر زراعي</span>
              </div>
              <div class="flex flex-wrap items-center gap-3 text-xs text-stone-300 font-mono mt-1">
                <span id="auth-profile-email" class="flex items-center gap-1">📧 tariq@faseela.sy</span>
                <span id="auth-profile-phone" class="flex items-center gap-1">📱 0933112233</span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2 pt-3 border-t border-stone-800 text-[10px] text-stone-300 font-mono">
            <div class="flex items-center gap-1.5">
              <i data-lucide="lock" class="w-3 h-3 text-emerald-400"></i>
              <span>تشفير الجلسة: AES-256</span>
            </div>
            <div class="flex items-center gap-1.5">
              <i data-lucide="fingerprint" class="w-3 h-3 text-amber-400"></i>
              <span>عزل البيانات: Multi-Tenant RLS</span>
            </div>
          </div>
        </div>

        <div class="bg-olive-50 border border-olive-200 p-3.5 rounded-2xl text-xs text-olive-950 space-y-1">
          <strong class="block font-black" id="auth-scope-title">نطاق التصريح الممنوح لك:</strong>
          <p class="text-[11px] text-stone-600 leading-relaxed" id="auth-scope-desc">
            مخوّل حصراً بمتابعة استثماراتك وحصصك وإيصالات دفعاتك. البيانات الأخرى للمزارعين والمعاصر محجوبة وفق ميثاق الأمان.
          </p>
        </div>

        <div class="flex gap-2.5 pt-2">
          <button type="button" onclick="goToUserAuthorizedSection()" class="flex-1 bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-xl font-bold text-xs shadow-md transition-all flex items-center justify-center gap-1.5">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
            <span id="auth-btn-goto-portal">الانتقال إلى مساحتي المصرح بها</span>
          </button>
          <button type="button" onclick="handleSignOut()" class="bg-stone-100 hover:bg-red-50 hover:text-red-700 text-stone-700 border border-stone-200 px-4 py-3 rounded-xl font-bold text-xs transition-all flex items-center justify-center gap-1">
            <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
            <span id="auth-btn-signout-text">تسجيل الخروج / تبديل الحساب</span>
          </button>
        </div>
      </div>

      <!-- VIEW 2: Two-Step Identification Form (Step 1: Enter Email & Phone) -->
      <div id="auth-view-identify" class="space-y-4 hidden">
        <!-- Tab Selector: Login vs Register -->
        <div class="grid grid-cols-2 gap-1.5 bg-stone-100 p-1 rounded-xl text-xs font-bold text-stone-600">
          <button type="button" onclick="switchAuthSubTab('login')" id="subtab-auth-login" class="py-2 rounded-lg bg-white text-olive-950 shadow-sm transition-all">
            تصريح دخول لحساب مسجل
          </button>
          <button type="button" onclick="switchAuthSubTab('register')" id="subtab-auth-register" class="py-2 rounded-lg hover:text-stone-900 transition-all">
            تسجيل مستخدم وتصريح جديد
          </button>
        </div>

        <!-- Form A: Existing User Sign-In by Email & Phone -->
        <form id="form-auth-login" onsubmit="handleInitiateAuth(event)" class="space-y-3.5">
          <div class="space-y-1 text-xs">
            <label class="font-bold text-stone-700 block">البريد الإلكتروني المعتمد:</label>
            <div class="relative">
              <i data-lucide="mail" class="w-4 h-4 text-stone-400 absolute start-3 top-1/2 -translate-y-1/2"></i>
              <input type="email" id="auth-login-email" required placeholder="tariq@faseela.sy" class="w-full bg-stone-50 border border-stone-200 rounded-xl ps-9 pe-3 py-2.5 text-xs focus:ring-2 focus:ring-olive-600 focus:bg-white transition-all font-mono">
            </div>
          </div>

          <div class="space-y-1 text-xs">
            <label class="font-bold text-stone-700 block">رقم الهاتف / الجوال المعتمد:</label>
            <div class="relative">
              <i data-lucide="phone" class="w-4 h-4 text-stone-400 absolute start-3 top-1/2 -translate-y-1/2"></i>
              <input type="tel" id="auth-login-phone" required placeholder="0933112233" class="w-full bg-stone-50 border border-stone-200 rounded-xl ps-9 pe-3 py-2.5 text-xs focus:ring-2 focus:ring-olive-600 focus:bg-white transition-all font-mono">
            </div>
          </div>

          <!-- Quick Test Credentials Chips -->
          <div class="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-1.5">
            <span class="text-[10px] font-bold text-stone-500 block">⚡ تجربة سريعة لهويات المنصة المعتمدة:</span>
            <div class="flex flex-wrap gap-1.5">
              <button type="button" onclick="fillDemoCredentials('investor')" class="bg-white hover:bg-olive-50 border border-stone-200 text-stone-800 text-[10px] font-semibold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1">
                <span>👤 مستثمر (طارق)</span>
              </button>
              <button type="button" onclick="fillDemoCredentials('farmer')" class="bg-white hover:bg-emerald-50 border border-stone-200 text-stone-800 text-[10px] font-semibold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1">
                <span>🌾 مزارع (أبو أحمد)</span>
              </button>
              <button type="button" onclick="fillDemoCredentials('mill')" class="bg-white hover:bg-amber-50 border border-stone-200 text-stone-800 text-[10px] font-semibold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1">
                <span>⚙️ معصرة (م. سمير)</span>
              </button>
            </div>
          </div>

          <button type="submit" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3 rounded-xl font-black text-xs shadow-md transition-all flex items-center justify-center gap-2">
            <i data-lucide="key" class="w-3.5 h-3.5 text-amber-300"></i>
            <span>إرسال رمز التحقق الأمني والمصادقة (Send OTP)</span>
          </button>
        </form>

        <!-- Form B: New User Registration -->
        <form id="form-auth-register" onsubmit="handleRegisterNewUser(event)" class="space-y-3.5 hidden">
          <div class="space-y-1 text-xs">
            <label class="font-bold text-stone-700 block">الاسم الكامل:</label>
            <input type="text" id="reg-input-name" required placeholder="مثال: يوسف الشامي" class="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-xs focus:ring-2 focus:ring-olive-600 focus:bg-white transition-all">
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div class="space-y-1">
              <label class="font-bold text-stone-700 block">البريد الإلكتروني:</label>
              <input type="email" id="reg-input-email" required placeholder="name@email.com" class="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-xs focus:ring-2 focus:ring-olive-600 focus:bg-white transition-all font-mono">
            </div>
            <div class="space-y-1">
              <label class="font-bold text-stone-700 block">رقم الهاتف:</label>
              <input type="tel" id="reg-input-phone" required placeholder="09xxxxxxxx" class="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-xs focus:ring-2 focus:ring-olive-600 focus:bg-white transition-all font-mono">
            </div>
          </div>
          <div class="space-y-1 text-xs">
            <label class="font-bold text-stone-700 block">تحديد نوع الحساب والصلاحيات:</label>
            <div class="grid grid-cols-3 gap-2">
              <label class="cursor-pointer border border-stone-200 rounded-xl p-2.5 text-center block hover:border-olive-600 has-[:checked]:border-olive-700 has-[:checked]:bg-olive-50">
                <input type="radio" name="reg-role" value="investor" checked class="hidden">
                <span class="font-black text-stone-900 block text-[11px]">مستثمر</span>
                <span class="text-[9px] text-stone-500 block">رعاية واستلام زيت</span>
              </label>
              <label class="cursor-pointer border border-stone-200 rounded-xl p-2.5 text-center block hover:border-emerald-600 has-[:checked]:border-emerald-700 has-[:checked]:bg-emerald-50">
                <input type="radio" name="reg-role" value="farmer" class="hidden">
                <span class="font-black text-stone-900 block text-[11px]">مزارع</span>
                <span class="text-[9px] text-stone-500 block">توثيق وسحب أتعاب</span>
              </label>
              <label class="cursor-pointer border border-stone-200 rounded-xl p-2.5 text-center block hover:border-amber-600 has-[:checked]:border-amber-700 has-[:checked]:bg-amber-50">
                <input type="radio" name="reg-role" value="mill_owner" class="hidden">
                <span class="font-black text-stone-900 block text-[11px]">صاحب معصرة</span>
                <span class="text-[9px] text-stone-500 block">عصر وفحص مخبري</span>
              </label>
            </div>
          </div>

          <button type="submit" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white py-3 rounded-xl font-black text-xs shadow-md transition-all flex items-center justify-center gap-2">
            <i data-lucide="user-plus" class="w-3.5 h-3.5"></i>
            <span>إنشاء الحساب والمصادقة على الهوية</span>
          </button>
        </form>
      </div>

      <!-- VIEW 3: OTP Code Verification Screen (Step 2: Enter 4-Digit Code) -->
      <div id="auth-view-otp" class="space-y-4 hidden">
        <div class="flex items-center justify-between">
          <button type="button" onclick="backToIdentifyView()" class="text-stone-500 hover:text-stone-800 text-xs font-bold flex items-center gap-1">
            <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
            <span>العودة لتعديل البريد أو الهاتف</span>
          </button>
          <span class="bg-amber-100 text-amber-900 text-[10px] font-black px-2 py-0.5 rounded-full">خطوة التأكد من الهوية</span>
        </div>

        <div class="bg-stone-50 border border-stone-200 p-4 rounded-2xl text-center space-y-1">
          <span class="text-xs text-stone-600 block">تم إرسال رمز التحقق الأمني المؤقت إلى:</span>
          <div class="font-mono font-bold text-olive-900 text-xs" id="otp-target-display">
            tariq@faseela.sy • 0933112233
          </div>
        </div>

        <!-- Simulated SMS & Email Live Banner with 1-Click Auto Fill -->
        <div class="bg-emerald-50 border border-emerald-200 p-3 rounded-2xl flex items-center justify-between text-xs text-emerald-950">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            <span>رمز المصادقة المرسل: <strong class="font-mono text-sm" id="simulated-otp-code">4826</strong></span>
          </div>
          <button type="button" onclick="autoFillOtp()" class="bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all">
            تعبئة تلقائية
          </button>
        </div>

        <!-- 4-Digit OTP Inputs -->
        <form onsubmit="handleVerifyOtp(event)" class="space-y-4">
          <div class="flex justify-center gap-3 dir-ltr" dir="ltr">
            <input type="text" maxlength="1" id="otp-digit-1" oninput="handleOtpInput(this, 'otp-digit-2')" onkeydown="handleOtpBackspace(event, this, null)" class="w-12 h-14 text-center font-mono font-black text-2xl bg-stone-50 border-2 border-stone-200 rounded-2xl focus:border-olive-700 focus:bg-white focus:outline-none transition-all" autofocus>
            <input type="text" maxlength="1" id="otp-digit-2" oninput="handleOtpInput(this, 'otp-digit-3')" onkeydown="handleOtpBackspace(event, this, 'otp-digit-1')" class="w-12 h-14 text-center font-mono font-black text-2xl bg-stone-50 border-2 border-stone-200 rounded-2xl focus:border-olive-700 focus:bg-white focus:outline-none transition-all">
            <input type="text" maxlength="1" id="otp-digit-3" oninput="handleOtpInput(this, 'otp-digit-4')" onkeydown="handleOtpBackspace(event, this, 'otp-digit-2')" class="w-12 h-14 text-center font-mono font-black text-2xl bg-stone-50 border-2 border-stone-200 rounded-2xl focus:border-olive-700 focus:bg-white focus:outline-none transition-all">
            <input type="text" maxlength="1" id="otp-digit-4" oninput="handleOtpInput(this, null)" onkeydown="handleOtpBackspace(event, this, 'otp-digit-3')" class="w-12 h-14 text-center font-mono font-black text-2xl bg-stone-50 border-2 border-stone-200 rounded-2xl focus:border-olive-700 focus:bg-white focus:outline-none transition-all">
          </div>

          <div class="flex items-center justify-between text-xs text-stone-500 pt-1">
            <span>صلاحية الرمز: <strong class="font-mono text-stone-800" id="otp-countdown-timer">00:59</strong></span>
            <button type="button" onclick="resendOtpCode()" class="text-olive-700 hover:text-olive-900 font-bold">إعادة إرسال الرمز</button>
          </div>

          <button type="submit" class="w-full bg-olive-800 hover:bg-olive-900 text-white py-3.5 rounded-xl font-black text-xs shadow-md transition-all flex items-center justify-center gap-2">
            <i data-lucide="check-circle" class="w-4 h-4 text-emerald-300"></i>
            <span>تأكيد الهوية وتخويل الدخول (Verify & Authorize)</span>
          </button>
        </form>
      </div>

      <!-- Security Notice Footer -->
      <div class="bg-amber-50/70 border border-amber-200 p-3 rounded-2xl text-[11px] text-amber-900 space-y-1">
        <div class="flex items-center gap-1.5 font-bold">
          <i data-lucide="shield-alert" class="w-3.5 h-3.5 text-amber-700"></i>
          <span>حماية وتخويل الوصول الصارم (Strict RBAC):</span>
        </div>
        <p class="leading-relaxed text-amber-800 text-[10px]">
          يتم التأكد من مطابقة البريد والهاتف وتخويل المستخدم بالوصول حصراً لما يملكه: المستثمر إلى محفظته وحصصه فقط، والمزارع إلى أشجاره وأتعابه، وصاحب المعصرة إلى دفعات العصر، لمنع أي اختراق أو كشف لبيانات المستخدمين الآخرين.
        </p>
      </div>
    </div>
  </div>\n\n  """

content = content[:start_pos] + new_modal_html + content[end_pos:]

# Update the navbar session button call to openAuthModal
content = content.replace(
    'onclick="openModal(\'modal-auth-session\')"',
    'onclick="openAuthModal()"'
)

with open("public/index.html", "w", encoding="utf-8") as f:
    f.write(content)

print("Modal HTML updated successfully! New file size:", len(content))
