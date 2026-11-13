# Umsetzung Review-Findings — 18.10.2026

Bezug: `docs/REVIEW_2026-10-17.md` · Scope: F-01, F-02, F-03, F-04

> **Verifikation:** 38 Tests ausgeführt · 1 Recency-Check (lucide-Version per npm-Registry) · 2 Annahmen · 1 Platzhalter · 0 ungetestete Code-Dateien

| Lauf | Ergebnis |
|---|---|
| `npm test` (functions, inkl. neuer `policy.test.js`) | [GETESTET] 21/21 |
| `npm run test:rules` | [GETESTET] 8/8 |
| `npm run test:functions:emulator` | [GETESTET] 1/1 |
| `npm run test:abuse:emulator` (umgedreht: Angriffe müssen scheitern) | [GETESTET] 4/4 |
| Browser-E2E mit Prod-CSP gegen Emulatoren (Login → Callable → Reservierung → Firestore-Read) | [GETESTET] signedIn ✓, 1 Baum, `awaiting_payment`, 1 eigene Anfrage, 0 CSP-Fehler |
| Playwright-Probe 390 px | [GETESTET] `firebaseReady: true`, 0 Fehler, 0 blockierte Requests; axe unverändert (keine neuen Verstöße) |
| Risiko-Gate | [GETESTET] Kauf ohne Haken → blockiert mit Hinweis |
| `node scripts/check-claims.cjs` | [GETESTET] 0 Treffer (vorher 320) |

## F-01 — CSP · erledigt
- `public/index.html` Meta-CSP: `script-src` + `https://www.gstatic.com https://apis.google.com`; `connect-src` von pauschal `https:` auf konkrete Firebase-Hosts eingeengt (+ Emulator-Ports auf 127.0.0.1, + `fonts.googleapis.com` solange Tailwind-Play-CDN läuft); `frame-src` für Google-Sign-in-Popup (`<project>.firebaseapp.com`, `accounts.google.com`); `media-src blob:` für Sprachaufnahmen.
- `lucide@latest` → `lucide@1.49.0` gepinnt (Release 29.09.2026, >2 Wochen alt; Quelle: npm-Registry).
- `scripts/check-frontend.cjs`: neuer CSP-Guard — Build bricht, wenn ein Script-/Modul-Import oder Firebase-Host von der CSP blockiert wird.

## F-03 — Inventar-Hortung · erledigt
- `functions/domain.js`: `assertReservationQuota()` + `DEFAULT_RESERVATION_LIMITS` (max. 3 offene Anfragen, max. 8 offene Anteile, 1 offene Anfrage pro Baum). „Offen“ = `awaiting_payment` **und** `under_review` (sonst hortbar per Fake-Beleg).
- `functions/index.js`: Prüfung **innerhalb** der Reservierungs-Transaktion (Query `userId + status in`), nach dem Idempotenz-Replay → doppelte Requests mit gleichem Key funktionieren weiter.
- Alle 13 Callables nutzen `CALLABLE_OPTIONS`; App Check per `ENFORCE_APP_CHECK=true` in `functions/.env` zuschaltbar. Default aus, weil die Clients noch keine App-Check-Tokens senden (sofortiges Erzwingen = Totalausfall, fail-closed).
- `firestore.indexes.json`: Index `investment_requests (userId, status)`.

## F-04 — Vier-Augen-Prinzip · erledigt
- `assertNotSelfReview()` in `reviewInvestmentRequest`, `reviewFarmerUpdate`, `certifyPressingBatch`, `reviewRoleApplication`.

## F-02 — Finanzversprechen · erledigt (Copy), Rechtsprüfung offen
Entscheidungen: kein Escrow vorhanden → neutralisieren · Prozent-Renditen → entfernen · Garantien → „dokumentiert/geplant“.
- 335 Zeilen geändert (`scratch/review-tools/f02-index.diff`), reproduzierbar per `scratch/review-tools/f02_claims.py` + `f02_risk.py`.
- Entfernt: alle „$425,000“-Reserve-Angaben (inkl. persönlicher Zusage des Gründers im Vertragstext), „100% Bank Secured/Backed/Solvency“, „45%/35%/25% ROI“, Rückkauf-„Garantie“ zu $9.50/L, „Garantie vereinbarter Renditen“ im arabischen Vertrag, „sovereign-backed insurance … 100% capital reimbursement“.
- Umformuliert: Escrow → „Payment Review / مراجعة الدفعات“ (tatsächlicher Ablauf: Überweisung → Belegprüfung → Bestätigung); Takaful-„Versicherung“ → „Solidaritätsreserve (geplant, keine Versicherung)“.
- Admin-Kachel „Live Assets“: Fake-Zahlen → „—“ + „Live data pending“.
- **Neu:** Risikohinweis (AR/EN) mit Pflicht-Checkbox vor „Investition bestätigen“; `confirmPurchase()` bricht ohne Haken ab.
- **Neu:** `scripts/check-claims.cjs` im `npm run build` — blockiert Wiedereinführung.

## Beim Testen neu aufgefallen (nicht behoben)
- Zahlungsart „Visa / MasterCard“ wird angeboten, das Backend kennt aber nur Überweisung + Beleg → entfernen oder ausgrauen.
- Paketkarte „Baum + 5 m²“ zeigt Preis „00.“ (Formatierungsfehler).
- `watchMy*`-Listener in `firebase-client.mjs` haben keinen Error-Callback → Rules-Fehler bleiben still.
- Reservierungs-Limits (`DEFAULT_RESERVATION_LIMITS`) sind eine Geschäftsentscheidung [ANNAHME-1: 3 Anfragen / 8 Anteile].

## Markierungen
- [ANNAHME-1] Limits 3/8/1. [ANNAHME-2] App Check bleibt bis Client-Rollout aus.
- [PLATZHALTER] Rechtliche Freigabe der neuen Texte (Risikohinweis, Nießbrauch-Formulierung) durch Fachanwalt.

---

# Nachtrag 20.10.2026 — UI/UX (F-12, F-13 + Testfunde)

| Lauf | Ergebnis |
|---|---|
| Overflow 360 / 375 / 390 / 414 px + Landscape 844×390 | [GETESTET] `scrollWidth == clientWidth` überall (vorher 411 px) |
| axe WCAG 2.0/2.1 AA, Startseite + Marktplatz/Baum/Dashboard, hell + dunkel | [GETESTET] 0 Verstöße (vorher 4 Regeln / 25 Knoten) |
| Probe / Risiko-Gate / Claims-Guard | [GETESTET] keine Fehler · Gate greift · 0 Treffer |

- **Header < 640 px:** Sprache + Währung nur noch im Mobile-Drawer (dort schon vorhanden); Glocke und Menü-Button mit 44 px Touch-Fläche; `aria-controls` am Menü-Button.
- **Ernte-Kalender:** zentrierte Chips mit Overflow schnitten im RTL-Layout den ersten Chip ab → `justify-start` bis `md`, Scroll-Snap, `flex-shrink:0`.
- **Zoom wieder erlaubt** (`user-scalable=no` / `maximum-scale` entfernt, WCAG 1.4.4); globales `prefers-reduced-motion`; `touch-action: manipulation`.
- **Accessible Names:** ± Buttons, Anteil-Eingabe und Slider (zweisprachig über `data-i18n-aria`); Marktplatz-Filter-Labels per `for` verknüpft.
- **Kontrast:** nur die fehlerhaften Elemente angehoben (Quartal-Labels, Rechner-Untertitel, Regions-Untertitel, Status-Badges, Footer) — die globale Palette bleibt unverändert, weil `text-stone-400` auch auf dunklen Flächen genutzt wird.
- **Zahlungsart Karte:** deaktiviert + „قريباً / coming soon“; Überweisung ist vorausgewählt, Kontodaten sind direkt sichtbar. Footer entsprechend.
- **Preis „.00“:** Platzhalter → „—“ bis der Rechner füllt. Ursache: ein altes Shell-Skript hat `$80.00` als Variable expandiert; derselbe Fehler stand im EN-Text „rate of .50 per liter“ → als unverbindlicher Richtpreis neu formuliert.
- Reproduzierbar: `scratch/review-tools/ui_fixes.py`.

**Offen:** `simulateUploadReceipt()` (zeigt ein Demo-Überweisungsbild als „Beleg“) ist toter Code und sollte entfernt werden; Emojis als Struktur-Icons im Ernte-Kalender (🫒) → Lucide-Icons.

---

# Nachtrag 20.10.2026 (2) — F-05 Server-Daten, Backend, Build-Härtung

> **Verifikation:** 55 Tests + 1 Browser-E2E ausgeführt · 7 Recency-Checks (npm-Registry: tailwindcss 3.4.19, esbuild 0.28.2, firebase 12.19.0, lucide 1.49.0, @fontsource-variable 5.3.0, playwright 1.64.1, axe 4.14.0) · 3 Annahmen · 6 Platzhalter · 0 ungetestete Code-Dateien

| Lauf | Ergebnis |
|---|---|
| Unit (Functions) / Web-Mapper | [GETESTET] 25/25 · 9/9 |
| Firestore-Rules / Storage-Rules (Emulator) | [GETESTET] 9/9 · 4/4 |
| Functions-Emulator / Abuse / Datenschutz | [GETESTET] 1/1 · 4/4 · 3/3 |
| Browser-E2E (Prod-CSP, alle Emulatoren): Kauf mit Land → Beleg-Upload → Finance-Freigabe → Dashboard-KPIs → Export | [GETESTET] grün, 0 Seitenfehler |
| Probe 390 px | [GETESTET] DCL 416 ms (vorher 2.881 ms), LCP 228 ms (vorher 1.808 ms, lokal ohne Drosselung), 0 Drittanbieter-Skripte, axe 0 |
| Vorher/Nachher-Screenshots (12 Ansichten, hell/dunkel, 390/1280 px) | [GETESTET] ≤ 0,09 % Pixelabweichung (Uhr/Animationen) |

## Behoben
- **F-05 Dashboards:** Server-Modus ersetzt Demo-Daten; Mapper-Schicht `public/data-mappers.mjs`. Gefundene und behobene Fehler: Dashboard stürzte bei jeder Anfrage ab (`treeName` undefiniert), Firestore-Timestamps erzeugten `RangeError`, Katalog-Preise wurden nie übernommen (`pricePerShareCents` statt `pricePerShareMinor`), KPIs zählten Datensätze statt Anteile, Ablehnungsnotiz ging verloren (`reviewNote` statt `note`).
- **Freigabe-Pult:** alle vier Server-Warteschlangen; `finance_admin` / `quality_auditor` haben erstmals Zugang (nur Freigaben-Tab).
- **Portale:** Landwirte/Mühlen sehen ihre eingereichten Berichte/Pressdaten live; Vorschau-Banner auf Demo-Bereichen.
- **F-08:** Landpaket reserviert immer den ganzen Baum; nicht freigeschaltete Bäume sind nicht kaufbar; Server-Betrag wird angezeigt.
- **F-07 (kritisch, belegt):** Storage-Rules konnten `faseela-prod` nicht lesen → jeder Beleg-Upload wäre gescheitert. Lösung: Upload-Freigaben in `(default)/upload_grants`.
- **DSGVO:** `exportMyData`, `deleteMyAccount` (Pseudonymisierung, verweigert bei offenen Positionen), Self-Service im Sitzungsfenster; Impressum/Datenschutz-Seiten (mit Platzhaltern); `localStorage` nur Einstellungen; Google Fonts entfernt.
- **F-17:** `flagOverdueReviews` markiert Prüfungen > 72 h und schreibt Audit-Einträge.
- **F-18:** Feldberichte nur noch über die Function; Pressdaten nicht mehr öffentlich.
- **F-16:** Tests importieren echten Code; neue Emulator-Suiten.
- **F-06/F-09/F-14:** Tailwind/Lucide/Firebase/Fonts lokal, CSP ohne `unsafe-eval` und ohne Drittanbieter-Skripte, Security-Header in `firebase.json`, Bilder WebP (21,6 MB → 2,8 MB), Service Worker mit kleinem Shell-Cache.
- **F-15:** `backend/`, `render.yaml`, `docker-compose.yml` nach `legacy/` verschoben.
- **Weitere:** falsche „2FA/KYC Tier 3“-Behauptungen ersetzt (es gibt E-Mail-Verifizierung, kein MFA); CSV-Formel-Injection in Exporten neutralisiert; Demo-„Beleg“-Generator entfernt; Emoji-Icons → Lucide.

## Markierungen
- [ANNAHME-3] Ölschätzung 7,4 L pro Anteil (aus der bestehenden UI übernommen, als unverbindlich gekennzeichnet).
- [ANNAHME-4] Kontolöschung bei aktiven Anteilen verweigert (Übertragung/Abwicklung über Support).
- [ANNAHME-5] Bilder auf 960 px Breite reduziert (Karten zeigen ≤ 480 px).
- [PLATZHALTER] Impressum, Datenschutz, Aufbewahrungsfristen, Storage-Region, AVV/Drittland, Erlaubnispflicht.
- Restrisiken & Runbook: `docs/ARCHITECTURE_AND_OPERATIONS.md`.
