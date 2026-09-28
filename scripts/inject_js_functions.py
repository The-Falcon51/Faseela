import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Enhanced applyI18n
new_applyI18n = """    function applyI18n() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = t(key);
        if (val) {
          if (el.tagName === 'OPTION') {
            el.innerText = val;
          } else {
            el.innerHTML = val;
          }
        }
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        const key = el.getAttribute('data-i18n-ph');
        const val = t(key);
        if (val) el.placeholder = val;
      });
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const val = t(key);
        if (val) el.title = val;
      });

      // Update Body Font Family
      document.body.style.fontFamily = state.currentLang === 'en' ? "'Plus Jakarta Sans', system-ui, sans-serif" : "'Cairo', system-ui, sans-serif";

      // Update Chat Quick Chips dynamically
      renderChatQuickChips();
    }

    function renderChatQuickChips() {
      const container = document.getElementById('chat-quick-chips');
      if (!container) return;
      const isEn = state.currentLang === 'en';

      const chips = isEn ? [
        { label: "💳 Syriatel Cash & Banks", query: "What payment methods are available in Syria and abroad?" },
        { label: "🫒 Oil Yields & Returns", query: "How many liters of olive oil does a share produce?" },
        { label: "🌿 Varieties (Sourani/Khodairi)", query: "What are the Syrian olive cultivars and differences?" },
        { label: "⚙️ Cold Mills & Acidity", query: "How do modern cold press mills verify oil purity and acidity?" },
        { label: "📦 Overseas Shipping", query: "Can olive oil be shipped to expatriates abroad?" },
        { label: "📍 GPS & Grove Visits", query: "Can I visit my tree in Syria or view its GPS coordinates?" }
      ] : [
        { label: "💳 الدفع بسيريتل كاش", query: "كيف أسدد عبر سيريتل كاش أو البنوك المحلية؟" },
        { label: "🫒 إنتاج الزيت والعوائد", query: "كم لتر زيت تنتج الشجرة المعمرة وما هي الحسابات المالية؟" },
        { label: "🌿 الأصناف (صوراني/خضيري)", query: "ما هي أصناف الزيتون السوري والفرق بينها؟" },
        { label: "⚙️ فحص المعاصر والجودة", query: "كيف تعمل المعاصر الحديثة وما هي شروط فحص الحموضة؟" },
        { label: "📦 شحن الزيت للخارج", query: "كيف يستلم المغترب حصته من زيت الزيتون في الخارج؟" },
        { label: "📍 زيارة الشجرة والـ GPS", query: "هل يمكنني زيارة الشجرة على أرض الواقع؟" }
      ];

      container.innerHTML = chips.map(c => `
        <button onclick="askFaseelaQuick('${c.query.replace(/'/g, "\\\\'")}')" class="bg-white hover:bg-olive-50 border border-stone-200 text-stone-800 px-2.5 py-1 rounded-full font-semibold transition-all shadow-2xs">
          ${c.label}
        </button>
      `).join('');
    }"""

# Replace applyI18n
old_apply_pattern = r'function applyI18n\(\)\s*\{[\s\S]+?\}\s*\n\s*// State'
m = re.search(old_apply_pattern, html)
if not m:
    print("Could not find applyI18n in html!")
    exit(1)

html = html[:m.start()] + new_applyI18n + "\n\n    // State" + html[m.end():]
print("applyI18n replaced successfully!")

# Replace updateROICalculator
new_roi = """    // ROI Calculator Widget
    function updateROICalculator(shares) {
      const s = parseInt(shares) || 1;
      const slider = document.getElementById('roi-slider');
      if (slider && slider.value != s) slider.value = s;

      const isEn = state.currentLang === 'en';
      const sliderVal = document.getElementById('calc-slider-val');
      if (sliderVal) {
        if (s === 1) sliderVal.innerText = isEn ? "1 Share (25%)" : "حصة واحدة (25%)";
        else if (s === 4) sliderVal.innerText = isEn ? "Whole Tree (4 Shares)" : "شجرة كاملة (4 حصص)";
        else if (s === 8) sliderVal.innerText = isEn ? "Two Trees (8 Shares)" : "شجرتان (8 حصص)";
        else sliderVal.innerText = isEn ? `${s} Shares (${s * 25}%)` : `${s} حصص (${s * 25}%)`;
      }

      const totalOil = (s * 3.65).toFixed(1);
      const totalCarbon = (s * 7.1).toFixed(1);
      const totalCost = s * 35.00;
      const totalReturn = s * 29.60;

      const oilEl = document.getElementById('calc-oil-liters');
      if (oilEl) oilEl.innerText = isEn ? `~ ${totalOil} L` : `~ ${totalOil} لتر`;

      const carbonEl = document.getElementById('calc-carbon-val');
      if (carbonEl) carbonEl.innerText = isEn ? `${totalCarbon} kg` : `${totalCarbon} كغ`;

      const investEl = document.getElementById('calc-invest-cost');
      if (investEl) investEl.innerText = formatMoney(totalCost);

      const marketEl = document.getElementById('calc-market-val');
      if (marketEl) marketEl.innerText = formatMoney(totalReturn);
    }"""

old_roi_pattern = r'// ROI Calculator Widget\s*\n\s*function updateROICalculator\(shares\)\s*\{[\s\S]+?\}\s*\n\s*// Marketplace Renderer'
m_roi = re.search(old_roi_pattern, html)
if not m_roi:
    print("Could not find updateROICalculator in html!")
    exit(1)

html = html[:m_roi.start()] + new_roi + "\n\n    // Marketplace Renderer" + html[m_roi.end():]
print("updateROICalculator replaced successfully!")

# Insert Missing 11 Functions
missing_functions_code = """
    // Missing Interactive Handlers (Payment, Voice Logs, Subsidies, Orders)
    function togglePayFields(type) {
      const localEl = document.getElementById('local-pay-details');
      if (type === 'local') {
        if (localEl) localEl.classList.remove('hidden');
      } else {
        if (localEl) localEl.classList.add('hidden');
      }
    }

    function simulateUploadReceipt() {
      const previewCont = document.getElementById('receipt-preview-container');
      const promptCont = document.getElementById('receipt-drop-prompt');
      const previewImg = document.getElementById('receipt-preview-img');
      if (previewImg) {
        previewImg.src = "images/syrian_transfer_receipt.jpg";
      }
      if (previewCont) previewCont.classList.remove('hidden');
      if (promptCont) promptCont.classList.add('hidden');
      playAcousticChime(600, 0.15);
      showToast(state.currentLang === 'en' ? 'Payment transfer receipt attached successfully' : 'تم إرفاق إشعار التحويل المالي بنجاح');
    }

    function simulateOrderOil() {
      playAcousticChime(650, 0.25);
      const msg = state.currentLang === 'en'
        ? 'Olive oil dispatch request submitted! Faseela logistics will coordinate packaging and shipping.'
        : 'تم استلام طلب تسليم عبوات زيت الزيتون البكر! سيتواصل معك فريق لوجستيات فسيلة لتنسيق الشحن أو استلام العوائد.';
      showToast(msg);
    }

    function speakMonthlyGuide() {
      const text = state.currentLang === 'en'
        ? "Seasonal guidance for Syrian olive growers: Prepare harvesting nets, clean ventilated wooden and plastic crates, avoid plastic sacks to preserve cold acidity under 0.4 percent, and schedule your modern mill pressing slot in advance."
        : "توجيهات الموسم لعموم مزارعي الزيتون في الساحل والداخل: فرش الشباك النظيفة تحت الأشجار، استعمال الصناديق البلاستيكية المهواة بدلاً من الأكياس المغلقة لحفظ نقاء الزيت وحموضته، والتنسيق المسبق مع المعصرة لعصر الثمار خلال 24 ساعة من قطافها.";
      speakVoiceGuidance(text);
    }

    function selectVisualTree(treeId) {
      farmerVoiceState.selectedTreeId = treeId;
      const inp = document.getElementById('log-tree-select');
      if (inp) inp.value = treeId;
      document.querySelectorAll('.vtree-btn').forEach(b => {
        b.classList.remove('border-olive-700', 'bg-olive-50/70', 'shadow-xs');
        b.classList.add('border-stone-200', 'bg-white');
      });
      const selected = document.getElementById(`vtree-${treeId}`);
      if (selected) {
        selected.classList.add('border-olive-700', 'bg-olive-50/70', 'shadow-xs');
        selected.classList.remove('border-stone-200', 'bg-white');
      }
      playAcousticChime(500, 0.1);
    }

    function selectVisualActivity(actName, btn) {
      farmerVoiceState.selectedType = actName;
      const inp = document.getElementById('log-type-select');
      if (inp) inp.value = actName;
      document.querySelectorAll('.vact-btn').forEach(b => {
        b.classList.remove('border-2', 'border-blue-600', 'bg-blue-50', 'text-blue-950', 'font-bold');
        b.classList.add('border', 'border-stone-200', 'bg-white', 'text-stone-800');
      });
      if (btn) {
        btn.classList.add('border-2', 'border-blue-600', 'bg-blue-50', 'text-blue-950', 'font-bold');
        btn.classList.remove('border-stone-200', 'bg-white', 'text-stone-800');
      }
      const notesEl = document.getElementById('log-notes');
      if (notesEl && (!notesEl.value || notesEl.value.startsWith('تم إنجاز') || notesEl.value.startsWith('Completed'))) {
        notesEl.value = state.currentLang === 'en' 
          ? `Completed ${actName} for the selected tree in optimal field conditions.` 
          : `تم إنجاز ${actName} للشجرة المباركة بحالة ممتازة.`;
      }
      playAcousticChime(540, 0.1);
    }

    function speakVoiceInstructions() {
      const text = state.currentLang === 'en'
        ? "Step 1: Tap your tree's photo. Step 2: Choose what work you did. Step 3: Press the big green microphone and speak naturally!"
        : "الخطوة الأولى: اضغط على صورة شجرتك. الخطوة الثانية: اختر نوع العمل. الخطوة الثالثة: اضغط زر الميكروفون الأخضر الكبير وسجّل صوتك بحرية!";
      speakVoiceGuidance(text);
    }

    let mainVoiceRecording = false;
    let mainVoiceTimer = null;
    let mainVoiceSeconds = 0;

    function toggleMainVoiceRecording() {
      const btn = document.getElementById('voice-main-record-btn');
      const timerDisp = document.getElementById('voice-timer-display');
      const statusTxt = document.getElementById('voice-status-text');
      const wave = document.getElementById('voice-active-wave');
      const ring = document.getElementById('voice-record-ring');
      const playbackBar = document.getElementById('voice-playback-bar');
      const notesEl = document.getElementById('log-notes');
      const badge = document.getElementById('transcription-badge');

      if (mainVoiceRecording) {
        // Stop recording
        mainVoiceRecording = false;
        clearInterval(mainVoiceTimer);
        playAcousticChime(480, 0.2);
        if (ring) ring.classList.add('hidden');
        if (wave) {
          wave.classList.add('hidden');
          wave.classList.remove('flex');
        }
        if (btn) btn.classList.remove('animate-pulse');
        if (statusTxt) statusTxt.innerHTML = `<span class="text-emerald-700 font-bold">${state.currentLang === 'en' ? 'Recording saved & transcription ready!' : 'تم حفظ التسجيل والتحويل إلى نص جاهز!'}</span>`;
        if (playbackBar) playbackBar.classList.remove('hidden');
        const durEl = document.getElementById('voice-recorded-duration');
        if (durEl) durEl.innerText = `${timerDisp ? timerDisp.innerText : '0:18'} ${state.currentLang === 'en' ? 'sec' : 'ثانية'}`;
        if (badge) badge.classList.remove('hidden');
        if (notesEl && !notesEl.value) {
          notesEl.value = state.currentLang === 'en'
            ? "Today we completed comprehensive orchard irrigation and summer aeration for the ancient olive tree. Soil moisture is optimal and fruit load is looking very healthy."
            : "قمنا اليوم بإنجاز أعمال السقاية والتهوية الصيفية للأغصان، التربة مروية ونسبة الحمل ممتازة والشجرة بحالة خضار يسر الخاطر.";
        }
      } else {
        // Start recording
        mainVoiceRecording = true;
        mainVoiceSeconds = 0;
        playAcousticChime(700, 0.2);
        if (ring) ring.classList.remove('hidden');
        if (wave) {
          wave.classList.remove('hidden');
          wave.classList.add('flex');
        }
        if (btn) btn.classList.add('animate-pulse');
        if (playbackBar) playbackBar.classList.add('hidden');
        if (statusTxt) statusTxt.innerHTML = `<span class="text-red-600 font-bold animate-pulse">${state.currentLang === 'en' ? '🔴 Recording in progress... speak now' : '🔴 جاري التسجيل الحي... تحدث الآن بعفويتك'}</span>`;

        mainVoiceTimer = setInterval(() => {
          mainVoiceSeconds++;
          const m = Math.floor(mainVoiceSeconds / 60);
          const s = mainVoiceSeconds % 60;
          if (timerDisp) timerDisp.innerText = `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
        }, 1000);
      }
    }

    function playCurrentRecordedAudio() {
      const notesEl = document.getElementById('log-notes');
      const text = notesEl && notesEl.value ? notesEl.value : (state.currentLang === 'en' ? "Field care completed successfully in good weather." : "تم إنجاز أعمال الرعاية الحقلية بنجاح والأرض بخير وبركة.");
      playAcousticChime(640, 0.2);
      speakVoiceGuidance(text);
    }

    function resetCurrentRecordedAudio() {
      const playbackBar = document.getElementById('voice-playback-bar');
      const timerDisp = document.getElementById('voice-timer-display');
      const statusTxt = document.getElementById('voice-status-text');
      const notesEl = document.getElementById('log-notes');
      const badge = document.getElementById('transcription-badge');

      if (playbackBar) playbackBar.classList.add('hidden');
      if (timerDisp) timerDisp.innerText = '00:00';
      if (statusTxt) statusTxt.innerText = state.currentLang === 'en' ? 'Tap the microphone and speak naturally' : 'اضغط على الميكروفون وتحدث بحرية';
      if (badge) badge.classList.add('hidden');
      if (notesEl) notesEl.value = '';
      showToast(state.currentLang === 'en' ? 'Ready to record again' : 'جاهز لإعادة التسجيل الصوتي');
    }

    function simulateFarmerPhotoAttach() {
      const promptEl = document.getElementById('farmer-photo-prompt');
      const previewEl = document.getElementById('farmer-photo-preview');
      if (promptEl) promptEl.classList.add('hidden');
      if (previewEl) previewEl.classList.remove('hidden');
      playAcousticChime(580, 0.15);
      showToast(state.currentLang === 'en' ? 'Field photo attached with voice report' : 'تم التقاط الصورة الحقلية وإرفاقها مع الصوت بنجاح');
    }
"""

# Insert missing functions before </script>
script_end_pos = html.rfind("</script>")
if script_end_pos == -1:
    print("Could not find </script>!")
    exit(1)

html = html[:script_end_pos] + missing_functions_code + "\n  " + html[script_end_pos:]
print("Missing functions injected successfully!")

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(html)
