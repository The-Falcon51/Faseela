# Faseela — Architektur, Build & Betrieb

Stand: 26.10.2026 (Supabase-Backend, CSP ohne `unsafe-inline`, Admin-Werkzeuge in der App). Gilt für Web (Firebase Hosting) und die Capacitor-Apps (Android/iOS); beide liefern dieselben Dateien aus `public/` aus.

## 1. Überblick

| Schicht | Technik | Ort |
|---|---|---|
| Frontend | `public/index.html` (Markup, AR/EN, RTL) + `public/app.js` (App-Logik) + `public/events.js` (Event-Delegation), Tailwind (vorgebaut), Lucide-Icons (lokal) | Firebase Hosting (Spark, kostenlos) / Capacitor `webDir: public` |
| Datenzugriff | `public/supabase-client.mjs` (Bundle aus `src/supabase-client.src.mjs`, `@supabase/supabase-js` 2.117.2) + `public/data-mappers.mjs` | Browser |
| Auth | Supabase Auth (E-Mail + Passwort mit Bestätigung, optional Google), PKCE | Supabase eu-central-1 (Frankfurt) |
| Rollen | Tabelle `private.user_roles` (nicht über die API erreichbar, nie `user_metadata`) | Supabase |
| Daten | Postgres 17, Projekt `faseela` (`riyvlhlhzxxerlwqoxsy`) | eu-central-1 |
| Dateien | Private Buckets `payment-proofs` (5 MB, JPG/PNG/PDF), `field-media` (10 MB, Bild/Audio) | eu-central-1 |
| Server-Logik | 18 RPCs (SECURITY DEFINER in `private`, Wrapper in `public`) + 2 `pg_cron`-Jobs | Supabase |

Die frühere Firebase-Backend-Variante (Firestore, Storage-Rules, Cloud Functions) liegt in `legacy/firebase/` und `functions/` (siehe `functions/README.md`). Sie wird nicht mehr deployt.

## 2. Vertrauensgrenzen & Datenfluss

```
Browser/App ──(JWT, publishable key)──► PostgREST ──► public.<rpc>() ──► private.<rpc>() [SECURITY DEFINER]
     │                                       └──► SELECT mit RLS (nur eigene Zeilen / Prüfer-Rolle)
     ├──(JWT)──► Storage API ──► storage.objects-Policies ──► private.can_upload_*() prüft Anfrage/Zuweisung
     └──(JWT)──► Realtime (wss) ──► nur Änderungen, die die SELECT-Policy erlaubt
pg_cron ──► private.expire_investment_requests() (alle 10 min) · private.flag_overdue_reviews() (alle 6 h)
```

- **Kein Schreibrecht für Clients:** `anon`/`authenticated` haben auf allen Tabellen nur `SELECT` (und auch das nur per RLS). Jede Änderung läuft über eine RPC, die Identität (`auth.uid()`), Rolle, Validierung und Geschäftsregeln prüft.
- **Beträge** rechnet nur die Datenbank (Minor Units, `bigint`). Die DB-Constraint `sold + reserved ≤ total` verhindert Überverkauf zusätzlich zur Logik.
- **Reservierungs-Limits:** max. 3 offene Anfragen, 8 offene Anteile, 1 offene Anfrage pro Baum; pro Nutzer serialisiert (`pg_advisory_xact_lock`), pro Baum per Zeilensperre.
- **Idempotenz:** Anfrage-ID = `sha256(uid:idempotencyKey)`; Wiederholungen liefern dieselbe Anfrage.
- **Vier-Augen-Prinzip:** Niemand entscheidet über eigene Zahlungen, Feldberichte, Pressdaten oder Rollenanträge, auch Admins nicht.
- **Uploads:** Ein Zahlungsbeleg darf nur in `payment-proofs/{uid}/{requestId}/` liegen, solange die eigene Anfrage `awaiting_payment` und nicht abgelaufen ist. Feldmedien nur in `field-media/{uid}/{treeId}/` eines zugewiesenen Baums. Überschreiben und Löschen durch Clients sind nicht erlaubt.
- **Fehlercodes:** RPC-Fehler haben SQLSTATE `P0001`, Text in `message` und einen stabilen Code in `hint` (z. B. `permission-denied`). Der Client legt den Code in `error.code` ab.

## 2a. Content-Security-Policy ohne `unsafe-inline`

Skripte laufen nur noch aus eigenen Dateien (`script-src 'self'`). Statt `onclick="…"` tragen Elemente `data-click="…"` (auch `data-change`, `data-input`, `data-submit`, `data-keydown`, `data-scroll`). `public/events.js` parst den Attributwert mit einer kleinen Whitelist-Grammatik (Aufrufliste, Argumente nur Literale, `event`, `this`, `this.value`, `this.checked`, `this.dataset.*`) und ruft die globale Funktion auf. Kein `eval`, keine Inline-Skripte mehr. Build-Guard: `scripts/check-frontend.cjs` bricht bei jedem `on*=`-Attribut, `javascript:`-Link oder `unsafe-inline` in `script-src` ab. Test: `npm run test:ui` prüft, dass jeder Handler parst und auf eine existierende Funktion zeigt.

## 2b. Admin-Werkzeuge im Freigabe-Pult

Unter „Nutzer“ → Nutzer verwalten (Server-Modus): Rolle setzen (`admin_set_user_role`), Konto sperren/aktivieren (`admin_set_user_status`, setzt `auth.users.banned_until`), Bäume an Landwirte und Mühlen an Betreiber zuordnen oder entziehen (`admin_assign`; Entzug = `revoked_at`, nichts wird gelöscht). Alles nur für Admins, nie für das eigene Konto, jede Änderung im Audit-Log. Profilfelder gehören dem Nutzer und sind hier schreibgeschützt.

## 2c. Transaktions-E-Mails (Outbox-Muster)

Geschäftliche RPCs schreiben im selben Transaktionskontext eine Zeile in `private.email_outbox` (`private.notify_user`, `private.notify_role`; Migration `20261026000300`). Kein Versand aus der Transaktion heraus, kein HTTP im Geschäftspfad — die Mail kann nicht ohne die Buchung existieren und umgekehrt. Vorlagen: `reservation_created`, `proof_received`, `review_needed`, `payment_approved/rejected`, `reservation_expired`, `review_overdue`, `role_approved/rejected`, `farmer_update_published/rejected`, `batch_certified/rejected`, `ops_alert`. Empfänger nur aktive, bestätigte Konten (kein Versand an `banned_until` oder unbestätigte Adressen).

Zustellung: pg_cron `faseela-send-emails` (jede Minute, nur wenn Zeilen offen sind) ruft per `pg_net` die Edge Function `send-emails` mit dem Header `x-outbox-token` (Vault-Secret `outbox_token`, Migration `20261026000220`). Die Funktion prüft das Token zeitkonstant gegen `public.outbox_token()` (nur `service_role`), holt bis zu 20 Zeilen über `public.outbox_claim`, rendert zweisprachig (AR/EN, HTML-escaped), liefert über **Brevo** (EU, Standard) oder Resend aus und quittiert über `public.outbox_mark`. Fehlschläge bleiben als `failed` mit Fehlertext stehen und erscheinen im Systemstatus; ohne gesetzte Secrets antwortet die Funktion 503 und die Zeilen bleiben `pending`.

Secrets der Edge Function (nur im Dashboard, nie im Repo): `EMAIL_PROVIDER` (`brevo`|`resend`), `EMAIL_API_KEY`, `EMAIL_FROM`, optional `EMAIL_REPLY_TO`, `APP_URL`. Auth-Mails (Bestätigung, Reset, Magic-Link, Adresswechsel) laufen weiter über Supabase Auth; HTML-Vorlagen in `supabase/email-templates/`.

## 2d. Monitoring

- **Client-Fehler:** `window.error`/`unhandledrejection` → RPC `report_client_error` (anon + authenticated, max. 5 je Seitenaufruf; serverseitig 20 je Fingerprint/h und 500/h gesamt, Migration `20261026000200`). Nur Nachricht, Quelle, Release, Sprache und Seite — keine PII, keine Tokens. `anon` erhält dafür `USAGE` auf `private` (nur Namensauflösung) und `EXECUTE` auf genau diese eine Funktion; alle anderen Funktionen und Tabellen in `private` sind für `anon` und `public` entzogen und über `alter default privileges` auch für künftige Objekte geschlossen (Migration `20261026000230`).
- **Systemstatus im Freigabe-Pult** (nur Admin): `admin_system_status` zeigt Outbox (offen/fehlgeschlagen/24 h gesendet, letzter Fehler), Client-Fehler (24 h, Top-Fingerprints), Prüf-Rückstände je Warteschlange und den letzten Lauf jedes Cron-Jobs.
- **Ops-Alarm:** pg_cron `faseela-ops-check` (stündlich) mailt Admins einmal je 6 h (`ops_alert`), wenn fehlgeschlagene Mails, >20 Client-Fehler/h oder ein nicht erfolgreicher Job-Lauf vorliegen.
- **Aufbewahrung:** `private.prune_monitoring()` löscht Client-Fehler > 30 Tage und gesendete Outbox-Zeilen > 90 Tage (Migration `20261026000210`, muss wegen `DELETE` einmalig manuell im SQL-Editor ausgeführt werden; danach läuft sie im Ops-Check mit).

## 2e. Profil, Einwilligung und Onboarding-Sequenz

- **Profil-Selbstbedienung:** Name, Telefon und Region werden über `update_my_profile` gespeichert (Validierung serverseitig, Audit-Eintrag `profile.updated`). Vorher blieben Änderungen im Server-Modus nur im Browser.
- **Einwilligung (Marketing):** `profiles.marketing_opt_in` (Standard `false`), gesetzt nur über `set_marketing_consent` — versioniert (`marketing_consent_version`), mit Zeitstempel, jederzeit widerrufbar; jede Änderung im Audit-Log (`consent.marketing.granted/revoked`). Transaktionsmails sind davon unabhängig.
- **Onboarding (Tag 1 / 3 / 7):** pg_cron `faseela-onboarding` (täglich 08:40 UTC) → `private.send_onboarding()`: nur bei Einwilligung, bestätigter E-Mail, ohne Anteil und ohne offene/genehmigte Anfrage, Konto jünger als 30 Tage; je Stufe und Empfänger höchstens einmal (Dedupe gegen die Outbox). Vorlagen `onboarding_one/three/seven` tragen `params.marketing=true`; die Edge Function hängt dann den Abmeldelink (`/?unsubscribe=marketing`) und den `List-Unsubscribe`-Header an. Der Link widerruft die Einwilligung nach Anmeldung — kein unauthentifizierter Token-Endpunkt nötig. [PLATZHALTER: Einwilligungstext in Datenschutzerklärung aufnehmen]

## 2f. Öffentliche Status-Seite

`public/status.html` + `status.mjs` (strikte CSP, kein Inline-Skript) fragt alle 60 s `public_status()` ab (anon). Die RPC liefert nur grobe Flags `ok|degraded` für API, Jobs und E-Mail-Zustellung plus den Zeitpunkt des letzten Ops-Checks — keine Zähler, keine Fehlertexte. Antwortet die RPC nicht binnen 8 s, zeigt die Seite „nicht erreichbar". Ersetzt keinen externen Uptime-Check (siehe Offene Punkte).

## 2g. Secret-Rotation (Runbook)

| Secret | Wo | Rotation | Ausfallzeit |
|---|---|---|---|
| `outbox_token` (Vault) | Supabase → SQL-Editor | `select vault.update_secret((select id from vault.secrets where name = 'outbox_token'), encode(gen_random_bytes(32), 'hex'));` — Cron und Edge Function lesen das Token bei jedem Lauf neu | keine |
| Brevo-API-Key (`EMAIL_API_KEY`) | Brevo → SMTP & API → neuen Key erzeugen; Dashboard → Edge Functions → Secrets aktualisieren; alten Key in Brevo löschen | manuell | keine, Outbox puffert |
| `FIREBASE_SERVICE_ACCOUNT` (CI) | GCP → IAM → Service-Konto → neuen Schlüssel; GitHub → Settings → Secrets ersetzen; alten Schlüssel löschen | manuell, bei Verdacht sofort | keine |
| Supabase Service-Role-Key | Dashboard → Settings → API → „Rotate" (betrifft nur Edge Functions, die ihn automatisch erhalten) | nur bei Kompromittierung | kurz |
| Google-OAuth-Client-Secret | Google Cloud Console → neues Secret, in Supabase Auth eintragen, altes löschen | manuell | keine für bestehende Sitzungen |

Nach jeder Rotation: Freigabe-Pult → Systemstatus → „Outbox fehlgeschlagen" beobachten; ein `ops_alert` zeigt einen falschen Key innerhalb einer Stunde.

## 2h. Ernte & Öl-Zuteilung

Mit der Zertifizierung einer Pressdaten-Charge (`certify_pressing_batch`) erhält jeder aktive Anteil des Baums im selben Transaktionskontext seine anteilige Ölmenge in `public.oil_allocations` (ml, `floor`, Rest beim Betreiber; Migration `20261101000100`). Investoren sehen Zuteilungen im Dashboard („زيتي · My olive oil") und bündeln verfügbare Zuteilungen in eine Anfrage (`request_oil`): Lieferung, Abholung in der Mühle oder Spende. Kontaktdaten liegen nur in `private.oil_request_contacts`, mit `pgp_sym_encrypt` und Vault-Schlüssel `pii_key` verschlüsselt; entschlüsselt werden sie ausschließlich in `list_review_queue` (Finance, Warteschlangen `oil_requests` → genehmigen/ablehnen, `oil_fulfilment` → erledigt) und im Datenexport des Betroffenen. Ablehnung oder Storno gibt die Zuteilung frei; alle Schritte lösen Mails aus (`oil_allocated`, `oil_request_received/approved/fulfilled/rejected`) und landen im Audit-Log. Vier-Augen: Finance kann keine eigene Anfrage entscheiden. Limit: 3 offene Anfragen je Nutzer, 1–50 Zuteilungen je Anfrage.

## 2i. Anteilszertifikat (PDF) und öffentliche Verifikation

Edge Function `certificate` (`verify_jwt = true`): `GET /functions/v1/certificate?shareId=…` mit dem Nutzer-JWT. Die Funktion ruft `share_certificate` **als der Nutzer** auf (kein service_role), rendert mit pdf-lib 1.17.1 ein A4-Querformat-PDF (Latein-Typografie; pdf-lib-Standardfonts können kein Arabisch formen, daher arabischer Baumname nur in der App) mit QR-Code auf `/verify.html?serial=…`. Seriennummer `FSL-JJJJ-<16 Hex des Anteils>` (Migration `20261101000200`), identisch in App, PDF und Verifikation. `verify_certificate` (anon) gibt nur Baum, Anteile, Land, Ausgabedatum, Status und Initialen zurück — keine Namen, keine IDs. Dashboard-Karten zeigen im Server-Modus die echte Seriennummer und das Labor-Zertifikat der letzten Pressung statt Demo-Texten.

## 2j. Öffentliche Baumprofile, Bauernprofile und mobiles Schnellformular

`public/tree.html` + `tree.mjs` (strikte CSP, kein Inline-Skript) rendern pro Baum eine teilbare Seite (`tree.html?tree=<id>&lang=ar|en`): Hero, Fakten, eingewilligter Bauer, Zeitleiste der **veröffentlichten** Feldberichte mit Fotos, Anteile mit CTA (`./?tree=<id>#marketplace` → Deep Link öffnet die Baumdetails in der App), letzte zertifizierte Pressung (EVOO-Badge bei Säure ≤ 0,8 % und Peroxid ≤ 20), WhatsApp/Link-Teilen. Datenquellen: `public_tree_profile` (anon RPC, Migration `20261102000100`) liefert keine UIDs und keine Storage-Pfade; Fotos kommen ausschließlich als signierte URLs (1 h) von der Edge Function `tree-media`, die per service_role `tree_media_paths` fragt — die Datenbank entscheidet, was öffentlich ist (veröffentlichte Ereignisse + Profilfoto nur bei Einwilligung), die Funktion signiert nur. Bild-URLs werden im Client per Whitelist (`images/…` oder eigene Supabase-Domain) gefiltert.

Bauernprofil (`public.farmer_profiles`): Name, Dorf, Region, Jahre, Bio ar/en, Foto (`<uid>/profile/…` im privaten Bucket `field-media`). Sichtbar für Dritte **nur** mit `consent_public`; die Einwilligung ist versioniert (`farmer-public-v1`), zeitgestempelt, jederzeit widerrufbar und wird auditiert (`farmer_profile.published/withdrawn/updated`). Ohne Anzeigenamen keine Veröffentlichung.

Bauernportal (Server-Modus, Rolle `farmer`): Schnellformular — Baum aus `my_assignments()`, Tätigkeit (6 Typen), bis zu 5 Fotos (JPEG/PNG/WebP, 10 MB, `capture="environment"`), optionale Notiz, optional GPS (nur auf Wunsch, Browser-Geolocation) → Upload in den eigenen Ordner `<uid>/<treeId>/…`, dann `submit_farmer_update` mit den Pfaden; der Server akzeptiert nur Pfade mit genau diesem Präfix. Profilkarte mit Einwilligungs-Checkbox und Links auf die öffentlichen Baumseiten. Demo-Modus zeigt beides nicht.

## 2k. Security-Audit run-1 (2026-11-08) und Umsetzung

Vollaudit nach dem Cloudflare-Workflow (Profil `standard`, 38 Agenten-Aufrufe, 24 Coverage-Units, zwei saubere Critic-Durchläufe, quelltextbasiert ohne Zielausführung). Artefakte: `docs/security-audit/run-1/` (REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md, findings.json, coverage-ledger.json). Ergebnis: 4 bestätigte Findings (2× medium, 2× low), 6 Leads mit offenem Deployment-Fakt, 1 verworfen; keine kritische/hohe Schwachstelle.

| Nr. | Finding / Lead | Umsetzung |
|---|---|---|
| F1 medium | Kontolöschung ließ verschlüsselte Öl-Lieferkontakte (und Felddaten eines Bauern) stehen | Migration 23: Löschkaskade, Verweigerung bei offenen Ölanfragen, Letzter-Admin-Schutz. **Nachtrag 2026-11-10:** direkte `storage.objects`-Löschung wird von Supabase blockiert → Purge-Queue + Edge Function (Migrationen 27/28, §2l) |
| F2 medium | Freigabe-Pult veröffentlichte Notizen/Fotos, die der Prüfer nie sah | Mapper liefert volle Notizen, Medienpfade, GPS; Detail-Modal zeigt Inhalt + signierte Fotos (`signFieldMedia`, Policy quality_auditor); Approve erst nach Ansicht; serverseitig `decision` Pflicht und Medien nur, wenn Objekt existiert |
| F3 low | anon-SELECT auf `farmer_profiles` (UIDs, Pfade, Nicht-zugewiesene) | Grant entzogen, Policy Owner-only; öffentliche Seite nutzt ausschließlich `public_tree_profile` |
| F4 low | Definer-RPCs ignorierten `status = 'listed'` | Prädikat in `public_tree_profile` und `tree_media_paths`; Test „unlisted = not-found“ |
| L1 | Sperre (`banned_until`) wirkte nicht auf laufende Sitzungen | `require_user` weist gesperrte Konten ab (RPC-Ebene); JWT-Laufzeit bleibt Deployment-Fakt |
| L2 | Outbox ohne Mengenbegrenzung je Akteur | 40 Mails/Empfänger/h, Überschuss gezählt (`email_skipped`) |
| L3 | Realtime-DELETE-Events ohne RLS-Prüfung | Publikation `insert, update` |
| L4 | Reset-Seite akzeptierte jede Sitzung | Formular nur bei Recovery-Kontext (Marker aus `PASSWORD_RECOVERY` oder `type=recovery`); zusätzlich im Dashboard „Secure password change“ aktivieren [UNVERIFIZIERT: Dashboard-Einstellung] |
| L5 | Medien ohne Review signierbar | abgedeckt durch F2 (Existenzprüfung + Prüfer-Ansicht) + `tree-media` filtert `farmerPhoto` auf Bildendungen |
| L6 | Felddaten nach Löschung | Migration 23 (siehe F1) |

Nebenbefund (funktional): Qualitätsprüfer konnten im Freigabe-Pult nicht genehmigen/ablehnen (Client-Rollenfilter nur admin/finance) — behoben; die Server-Rollenprüfung je Queue ist maßgeblich.

## 2l. Geschenk-Kauf und Empfehlungsprogramm (2026-11-09)

Zwei Wachstumsfunktionen ohne Geldfluss: **Geschenk** (eine Anteilsposition wird per Einmal-Code übertragen) und **Empfehlung** (beide Seiten erhalten Öl-Gutschrift). Beide laufen vollständig in Supabase-RPCs (Migrationen 24/25), der Client zeigt nur an.

- **Geschenk-Code:** 12 Zeichen aus `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (`XXXX-XXXX-XXXX`, `extensions.gen_random_bytes`), 12 Monate gültig, ein offener Code je Anteil, max. 10 Codes/Tag/Käufer. Die Tabelle `public.gifts` speichert nur `code_hash` (SHA-256) + `code_hint` (letzte 4); der Klartext erscheint genau einmal in der RPC-Antwort und in der Mail `gift_created`. `create_gift` verlangt verifizierte E-Mail, aktiven eigenen Anteil und keine offene Ölanfrage auf dem Anteil. `redeem_gift` normalisiert (Groß/Klein, Trennzeichen), weist Selbst-Einlösung ab (`invalid-argument`) und liefert bei unbekannt/benutzt/abgelaufen `{status:'invalid'}` **ohne Exception**, damit die Audit-Zeile `gift.redeem_failed` bestehen bleibt — 10 Fehlversuche/Stunde → `resource-exhausted`. Erfolg: `shares.user_id` wechselt zum Empfänger (Zertifikat, Öl, Berichte folgen automatisch), Mails `gift_redeemed` (Käufer) und `gift_received` (Empfänger). `cancel_gift` nur für offene Codes.
- **Geschenk beim Kauf:** Checkout-Häkchen „Dieser Kauf ist ein Geschenk“ → `attach_request_extras` schreibt Empfängername/Nachricht nach `private.request_extras` (nur für offene Anfragen). Der Trigger `shares_created_rewards` (`AFTER INSERT ON public.shares`) erzeugt den Code erst, wenn der Anteil nach Zahlungsfreigabe existiert.
- **Empfehlung:** `my_referral_code()` erzeugt lazy einen 8-Zeichen-Code in `profiles.referral_code`; Link `?ref=CODE` landet in `sessionStorage` und füllt das Checkout-Feld vor (nur für Nutzer ohne Anteile). `attach_request_extras` prüft Format, Existenz, Selbstempfehlung und Erstkauf (keine Anteile, keine lebende Referral-Zeile) und legt `referrals(pending)` an. Beim Anteils-Insert → `rewarded` + je **250 ml** `reward_credits` für beide Seiten (max. 20 Belohnungen/Empfehler/Jahr, sonst `void`), Mail `referral_rewarded`. Ablehnung/Ablauf/Storno der Anfrage → Trigger `investment_requests_closed` setzt `void`.
- **Gutschrift einlösen:** `request_oil` addiert alle `granted`-Gutschriften zur nächsten Ölanfrage (`creditMl` in der Antwort) und markiert sie `redeemed`; `cancel_oil_request` und Ablehnung durch Finance geben sie zurück. Keine Auszahlung, kein Übertrag auf Dritte.
- **Isolation/Export:** RLS: `gifts` sichtbar für Käufer oder Einlöser, `referrals` für beide Parteien, `reward_credits` nur Owner; `private.request_extras` ohne Client-Zugriff. `export_my_rewards` (im DSGVO-Export unter `rewards`) enthält keine fremden UIDs. Realtime-Publikation um `gifts`, `reward_credits` erweitert.
- **Client:** `attachRequestExtras`, `createGift`, `cancelGift`, `redeemGift`, `myGifts`, `myReferralCode`, `referralLink`, Deep-Links `?ref=`/`?gift=` (aus der URL entfernt, in `sessionStorage`). Dashboard-Sektion „Geschenke & Empfehlungen“ (Einlösen, Empfehlungskarte mit WhatsApp-Teilen, Liste), „Verschenken“-Button auf Server-Anteilskarten, Geschenk-Modal mit einmaliger Code-Anzeige.
- **Tests:** `supabase/tests/gifts_referrals.test.sql` (55 Fälle, [GETESTET 2026-11-09: 55/55] gegen das Live-Schema mit Rollback) + Investor-Szenario in `tests/e2e/handlers.e2e.mjs`.
- **Kontolöschung (Migrationen 26–28):** eigene `reward_credits` werden entfernt; `gifts`/`referrals`-Zeilen, die eine Gegenseite betreffen, bleiben mit der Nil-UUID `00000000-…` pseudonymisiert (Gegenseite behält Historie, 20/Jahr-Kappung bleibt korrekt); offene eigene Codes → `cancelled`, `pending`-Referrals → `void`; `private.request_extras` verliert Freitext und Empfehler-Zeiger. Test: `supabase/tests/delete_account_rewards.test.sql` (20 Fälle, [GETESTET 2026-11-10: 20/20]).
- **Storage-Purge (Migration 27, Edge Function `purge-storage` v1):** Supabase verweigert direkte Löschungen in `storage.objects` (`storage.protect_delete`); die bisherige Löschkaskade (Migration 23) schlug damit für Konten mit Feldmedien fehl. Jetzt: `delete_my_account` reiht den Präfix `<uid>/` in `private.storage_purge_queue` ein; Cron `faseela-purge-storage` (alle 5 min, nur bei offenen Einträgen, `x-outbox-token`) ruft `purge-storage`, die rekursiv listet und per Storage-API löscht (Zeile **und** Blob, ≤5 000 Objekte je Lauf, Rest im Folgelauf, nach 5 Fehlversuchen `failed`). RPCs `storage_purge_claim/mark` nur für `service_role`. 🔲 Fehlgeschlagene Purges noch nicht im Systemstatus/Ops-Alarm sichtbar.
- **Grenzen:** Geschenk überträgt den Anteil erst beim Einlösen — bis dahin bleibt der Käufer wirtschaftlich Eigentümer (Öl bleibt bei ihm). Abgelaufene Codes werden beim nächsten Einlöseversuch auf `expired` gesetzt (kein Cron). [PLATZHALTER: steuerliche/vertragliche Einordnung der Übertragung und der Sachprämie 250 ml]

## 2m. Serverseitige Zahlungswege und Beta-Gating (2026-11-10)

- **Befund:** Der Checkout zeigte hartkodierte Empfängerkonten (Syriatel-Nummer, IBAN) und einen Demo-Referenz-Platzhalter. Im Produktivbetrieb hätten Nutzer an nicht verifizierte Konten überwiesen; jede Änderung hätte einen Deploy gebraucht.
- **Umsetzung (Migration 29):** `private.app_settings` (Key/Value) + `payment_instructions()` (authenticated; `null` solange unkonfiguriert) + `admin_set_payment_instructions` (Rolle admin; 1–6 Kanäle aus `syriatel_cash|mtn_cash|bank_iban|exchange_office|other`, Titel AR/EN, Konto `^[A-Za-z0-9 +./-]{3,60}$`, optionale Hinweise/Notiz; auditiert als `settings.payment_instructions`). Gründer-Pult: Abschnitt „Empfangskonten“ (`#fndr-payment-settings`, 3 Zeilen) — Änderungen wirken sofort ohne Deploy.
- **Checkout fail-closed:** `preparePaymentInstructions()` lädt beim Öffnen (5-min-Cache) und rendert `#local-pay-accounts` mit Kopier-Buttons; ohne konfigurierte Kanäle erscheint ein blockierender Hinweis und `confirmPurchase` verweigert **vor** der Reservierung. Demo-Modus zeigt klar markierte Beispielwerte („Beispieldaten“-Badge, `09XX …`).
- **Beta-Gating P2P:** `p2pEnabled()` = Demo-Modus. Im Server-Modus: Tab „Sekundärmarkt“ ausgeblendet, `switchInvestorSubTab('trade')` leitet auf Portfolio um, `openP2PListModal` verweigert mit Hinweis, Chatbot-Antwort zu P2P deaktiviert. Code bleibt für die Freigabe durch die Rechtsberatung erhalten [PLATZHALTER: aufsichtsrechtliche Einordnung des Anteilshandels].
- **Demo-Serien:** Zertifikats-Fallback „SYR-DEED-2026-VERIFIED“ im Server-Modus durch „—“ ersetzt; Referenz-Placeholder neutralisiert. Bundle-/Jungfern-Hain-Karten und Lab-Pass-Demo-Serien erscheinen nur mit Demo-Daten (Server-Shares haben diese Flags nicht).
- **Tests:** `supabase/tests/payment_instructions.test.sql` (10 Fälle, [GETESTET 2026-11-10: 10/10]); UI-Suite: Unkonfiguriert → Sperre vor Reservierung, Rendering nach Admin-Speichern, keine Demo-IBAN im DOM, P2P-Tab/Modal/Panel gesperrt, Admin-Formular (Leer-Validierung, Payload).
- **Offen (🔲):** Footer-/Deposit-Modal-Texte nennen weiterhin generische Kanalnamen (Bemo/Baraka/Al-Haram) als „akzeptierte Zahlungsarten“ — redaktionell anpassen, sobald die echten Kanäle feststehen.

## 2n. Rate-Limits und Vier-Augen-Prinzip für Empfangskonten (2026-11-10)

- **Rate-Limiter (Migration 30):** `private.rate_limit(bucket, max, fenster_s)` zählt in der UNLOGGED-Tabelle `private.rate_limits` pro Bucket und Subjekt — angemeldet `u:<uid>`, anonym `ip:<sha256(salt ‖ IP)>` (Salt im Vault `rate_salt`; keine Klartext-IP gespeichert; nächtliches `truncate` per Cron `faseela-rate-limits-reset`, 03:17 UTC). IP-Quelle: `cf-connecting-ip`, sonst erster `x-forwarded-for`-Eintrag. Überschreitung → `resource-exhausted`. Der Limiter sitzt in den `public`-Wrappern (volatile → Read/Write-Transaktion), die `private`-Implementierungen sind unverändert.

| RPC | Limit | Subjekt |
|---|---|---|
| `verify_certificate` | 20 / 60 s | IP bzw. Nutzer (Enumerationsschutz für Seriennummern) |
| `public_tree_profile` | 60 / 60 s | IP bzw. Nutzer |
| `public_status` | 30 / 60 s | IP bzw. Nutzer |
| `report_client_error` | 20 / 60 s | IP bzw. Nutzer (zusätzlich zur Stundenkappung) |
| `payment_instructions` | 60 / 60 s | Nutzer |
| `export_my_data` / `export_my_oil` / `export_my_rewards` | je 5 / 600 s | Nutzer |

  [GETESTET 2026-11-10: HTTP-Burst gegen die Live-API — 400 Anfragen → 30× `400 resource-exhausted`; mit gefälschtem `X-Forwarded-For` trotzdem geblockt, d. h. der Schlüssel folgt der Edge-IP.] Grenzen (🔲): direkte Tabellen-Reads über PostgREST (`trees_public`, `tree_events_public`) und Auth-Endpunkte sind davon nicht erfasst — dafür Supabase-Auth-Limits bzw. ein WAF/CDN vor der API; NAT-Nutzer teilen sich ein anonymes Budget.
- **Vier-Augen für Empfangskonten (Migration 31):** Ab zwei aktiven Admins ist `admin_set_payment_instructions` nur ein **Vorschlag** (`app_settings.payment_instructions_pending`, 7 Tage gültig); erst `admin_review_payment_instructions({decision:'approve'})` durch einen **anderen** Admin (`assert_not_self_review`) schaltet ihn live. Ablehnen/Zurückziehen darf jeder Admin. Mit nur einem Admin (Bootstrap) wirkt die Änderung sofort. In beiden Fällen: Audit (`…proposed`, `settings.payment_instructions` mit `fourEyes`, `…rejected`) und Mail an alle Admins + Finance (`payment_change_pending`, `payment_accounts_changed`) als Erkennungskontrolle gegen Payment-Diversion. `admin_payment_state()` liefert `{live, pending{…, proposedBySelf}, fourEyes, adminCount}` für das Gründer-Pult (Vorschlagsbox mit Freigeben/Ablehnen; Freigabe-Button für den Vorschlagenden deaktiviert).
- **Edge Function `send-emails` v5:** in `index.ts` (Versand) und `templates.ts` (reine Template-Funktionen) geteilt; zwei neue Templates.
- **Tests:** `supabase/tests/payment_instructions.test.sql` (33 Fälle, [GETESTET 2026-11-10: 33/33]; sperrt echte Admins nur innerhalb der zurückgerollten Transaktion, um die Admin-Zahl deterministisch zu machen); UI-Suite: Einzel-Admin-Hinweis, Vorschlag sichtbar, Live-Wert unverändert, Selbstfreigabe gesperrt, Freigabe durch zweiten Admin.
- **Empfehlung:** zweiten Admin anlegen (`private.admin_set_role`), damit das Vier-Augen-Prinzip tatsächlich greift — aktuell existiert genau ein Admin.

## 2o. Zahlungs-Timeline, Geschenk-Landing, Resync (2026-11-10, Paket 1/5)

- **Zahlungs-Timeline:** `investmentTimeline(req, now)` in `data-mappers.mjs` (rein, unit-getestet) liefert vier Schritte (reserviert → Beleg → Finance-Prüfung → Ergebnis) mit Zustand `done|current|todo|failed`, Fälligkeit (Beleg: `expiresAt`; Prüfung: `proofSubmittedAt` + 72 h = `REVIEW_SLA_MS`) und `overdue` (Server-Flag `sla_breached` oder Frist überschritten). `investmentTimelineHtml` rendert sie in jeder Anfragekarte des Dashboards als `<ol>` mit `aria-current="step"`, Hinweistext je Phase und Prüfnotiz bei Ablehnung. Nur im Server-Modus.
- **Geschenk-Landing:** Abgemeldete Besucher mit `?gift=CODE` sehen `#modal-gift-landing` (Erklärung, Code, „Konto anlegen / anmelden“). Der Code bleibt in `sessionStorage`; nach der Anmeldung springt die App ins Dashboard, scrollt zur Einlöse-Box (Code vorbefüllt) und fokussiert „Einlösen“. Bewusst keine Baum-Vorschau ohne Anmeldung — ein anonymer Code→Baum-Endpunkt wäre ein Enumerations-Orakel.
- **Resync nach Verbindungsverlust:** `watchOwnRows` registriert seine Loader; `resyncAll` lädt alle Live-Listen neu, wenn der Tab ≥ 30 s verborgen war, bei `online`, bei bfcache-Restore und wenn ein Realtime-Kanal nach einem Ausfall wieder `SUBSCRIBED` meldet (Polling-Fallback wird dann beendet). Event `faseela-sync-state` `{online, lastSyncAt, reason}`; UI zeigt offline eine Pille „Offline — Daten von HH:MM“ und beim Wiederverbinden einen Toast. Hintergrund: Realtime spielt verpasste Events nicht nach.
- **A11y-Fix:** Kontrast von Betrag und Metazeile in den Anfragekarten (axe `color-contrast`).
- **Tests:** `tests/data-mappers.test.mjs` (+1 Test, 10/10); UI-Suite 561 Handler inkl. Timeline (Schritte, aktueller Schritt mit SLA-Datum, Ablehnungsnotiz), Offline-Pille, Geschenk-Landing für abgemeldete Besucher (Code angezeigt, URL bereinigt, Übergang in den Anmeldedialog).

## 2p. Sanktions-/KYC-Screening und Finance-Export (2026-11-10, Paket 2/5)

- **Screening als Freigabe-Voraussetzung (Migration 32):** `private.payment_screenings` (append-only: Ergebnis `clear|hit|unclear`, geprüfte Listen, Referenz, Notiz, Prüfer, Zeit). `record_payment_screening` (Finance/Admin, nicht für eigene Anfragen, nur `under_review`; `hit`/`unclear` brauchen eine Notiz). `review_investment_request` verweigert **approve**, wenn das jüngste Screening fehlt oder älter als 30 Tage ist (`screening-required`) bzw. nicht `clear` ist (`screening-blocked`); Ablehnen bleibt ohne Screening möglich. Audit `payment_screening.<result>` ohne Freitext (kann Dritte nennen). Die Plattform dokumentiert, **dass** und **wogegen** geprüft wurde — welche Listen/Schwellen gelten, ist [PLATZHALTER: Compliance-Vorgabe der Kanzlei], ebenso Aufbewahrungsfrist und Auskunftsumfang (Screening-Daten sind bewusst nicht im Nutzer-Export).
- **UI:** „Freigeben“ einer Zahlung öffnet `#modal-screening`; `clear` → Screening speichern, dann Freigabe; `hit`/`unclear` → nur speichern, Hinweis „ablehnen oder klären“. Letztes Screening wird angezeigt.
- **Finance-Export:** `finance_export({from,to})` (Finance/Admin, ≤ 366 Tage, ≤ 5 000 Zeilen, 10 Aufrufe/10 min, Audit `finance.export`) liefert je Anfrage Zahler (Name, E-Mail, UID), Baum, Anteile, Betrag, Belegstatus (kein Storage-Pfad), Prüfer, Notiz und Screening. Das Gründer-Pult baut daraus eine CSV (UTF-8-BOM, RFC-4180-Quoting, Formel-Injection neutralisiert, Zusatzspalte `amountMajor`).
- **Tests:** `supabase/tests/screening_finance_export.test.sql` (24 Fälle, [GETESTET 2026-11-10: 24/24]); `security.test.sql` um 2 Fälle ergänzt (233; nicht erneut komplett gefahren); UI-Suite 564 Handler mit Screening-Ablauf und CSV-Prüfung; `flow.e2e.mjs` an den zweistufigen Ablauf angepasst (ungetestet, braucht Dev-Projekt).
- **Betriebshinweis:** Die Sperre wirkt serverseitig sofort. Ein noch nicht neu deploytes Frontend zeigt beim Freigeben die Server-Meldung statt des Screening-Dialogs — Hosting deployen.

## 2q. Deutsch als dritte Sprache (2026-11-11, Paket 3/5)

**Was:** Die Oberfläche läuft in Arabisch (Quelle), Englisch und Deutsch. Deutsch ist ein vollständiges Wörterbuch (2 621 Schlüssel, 1:1 zu `i18n.en`), kein Teil von `app.js`.

| Baustein | Ort | Zweck |
|---|---|---|
| Quelle | `src/i18n/de.json` | editierbares Wörterbuch, formelle Anrede („Sie") |
| Generator | `scripts/build-i18n-de.cjs` (Schritt in `npm run build:web`) | prüft leere Werte, schreibt `public/i18n-de.js` (`window.FASEELA_I18N_DE`, eingefroren) |
| Lazy-Load | `loadGermanDictionary()` in `public/app.js` | lädt die Datei erst bei `setLanguage('de')`; AR/EN-Besucher laden sie nie (172 KB roh, 57 KB gzip) |
| Fallback | `t()` | `de → en → ar`; fehlendes Deutsch zeigt Englisch, nie Arabisch in einer LTR-Seite |
| Sprachlogik | `SUPPORTED_LANGS`, `normalizeLang()`, `uiLocale()` | unbekannte gespeicherte Werte → Arabisch; Datumsformat `de-DE` |
| Umschalter | Navbar-Schnellwechsel (AR → EN → DE), Drawer `#drawer-lang-de`, Einstellungen `#panel-lang-de-btn` | `aria-pressed` markiert die aktive Sprache |

**Entscheidungen:**
- Lazy statt eingebettet: +0 Byte für die Mehrheit (AR/EN) gegen einen zusätzlichen Request für deutsche Nutzer; verworfen wurde das Einbetten in `app.js` (+172 KB für alle). Der Service Worker (Cache `v10`) legt die Datei nach dem ersten Laden network-first ab, danach funktioniert Deutsch auch offline.
- Die rund 975 Inline-Ternaries (`isEn ? … : …`) bedeuten jetzt „nicht Arabisch" (`state.currentLang !== 'ar'`). Im deutschen Modus erscheinen diese Texte auf Englisch. Das ist beabsichtigt (kein Arabisch in LTR), aber unvollständig – siehe offene Punkte.
- Fehlerfall: Lädt die Datei nicht, bleibt die Oberfläche auf Englisch benutzbar und ein Hinweis erscheint (`lang_de_load_failed`); ein erneuter Wechsel versucht den Download wieder.
- CSP unverändert (`script-src 'self'`), keine neue Abhängigkeit.

**Nebenbefund behoben:** Die Startseite hatte im hellen Modus Kontrastfehler (weiß auf `terracotta-500` 3,42:1; kleine `emerald-600`/`amber-600`-Labels). Buttons nutzen jetzt `terracotta-600` (4,7:1), Labels `emerald-700`/`amber-700` mit `dark:`-Varianten.

**Tests:** UI-Suite Abschnitt 2c – kein Download für arabische Besucher, englischer Fallback während des Ladens, Schlüssel-/Platzhalter-/Tag-Parität zu Englisch, kein Arabisch in `data-i18n`-Knoten, Persistenz über Reload, Sprachzyklus, ungültiger Wert → Arabisch, Fehlerfall (Datei blockiert), axe auf `header` + `main` (hell).

**Offen (🔲):**
- Inline-Texte (ca. 975 Stellen), Tabellen-/Toast-Texte aus `app.js` bleiben im deutschen Modus Englisch → mit dem Modul-Split (Paket 5) in Wörterbuch-Schlüssel überführen.
- E-Mails (`send-emails`), Zertifikat-PDF, `tree.html`, `verify.html`, `status.html` bleiben AR/EN.
- Zahlen behalten das englische Trennzeichenformat (`1,120`), nur Datumsangaben sind lokalisiert.
- Dunkler Modus der Startseite hat in EN/DE vorbestehende Kontrastfehler im Agrar-Telemetrie-Block (12 Knoten) → Paket 5.
- [PLATZHALTER: Wording-Prüfung Kanzlei] Die deutschen Texte übersetzen die englischen Rendite-/Investment-Formulierungen wörtlich („Investor", „Investitionsanfrage", ROI-Rechner). Vor öffentlicher deutscher Ansprache durch die Kanzlei prüfen lassen (Vermögensanlagengesetz, Werbung).
- Übersetzung ist maschinell erstellt und automatisch auf Struktur geprüft, nicht von einer Muttersprachlerin oder einem Muttersprachler gegengelesen.

## 2r. Push-Benachrichtigungen (2026-11-11, Paket 4/5)

**Was:** Die Android-App kann Nutzer per Push über Ereignisse informieren, für die sie bereits eine E-Mail erhalten (Zahlung bestätigt, Beleg eingegangen, Geschenk, Ölanfrage …). Push ist ein Zusatzkanal: Die E-Mail bleibt, Push ist pro Gerät und Konto freiwillig. Im Browser gibt es keinen Push.

**Datenfluss** (Trust-Boundaries mit ║ markiert):

`RPC (z. B. review_investment_request)` → `private.notify_user()` → `private.email_outbox` **und** `private.push_outbox` → pg_cron (jede Minute, nur bei offenen Zeilen) ║ `x-outbox-token` ║ Edge Function `send-push` → `push_claim` ║ OAuth2-Dienstkonto ║ FCM HTTP v1 ║ Gerät.

| Baustein | Ort | Zweck |
|---|---|---|
| `private.push_tokens` | Migration 33/34 | Gerätetoken je Konto, max. 10 aktive; RLS an, keine Policy, kein Client-Zugriff |
| `private.push_outbox` | Migration 33 | Warteschlange: nur `user_id` + Vorlagenname, **keine** Beträge, Namen oder IDs |
| `register_push_token` / `unregister_push_token` / `push_state` | RPC, `authenticated` | An-/Abmelden des eigenen Geräts; 20 Aufrufe / 10 min |
| `push_claim` / `push_mark` | RPC, nur `service_role` | Abholen und Ergebnis melden |
| `send-push` | Edge Function v1 | Versand über FCM; ohne Secret werden Zeilen als `skipped` geschlossen |
| App | `public/app.js` (Push-Block vor `handleSignOut`), Karte `#prefs-push-card` | Opt-in in den Einstellungen, nur in der nativen App sichtbar |

**Entscheidungen (je gegen Latenz · Sicherheit · Kosten · Wartbarkeit):**
- **Generische Texte statt Details:** Die Push-Nachricht läuft über Google-Server außerhalb der EU-Datenbank. Sie enthält deshalb nur einen festen Satz je Vorlage („Ihre Zahlung wurde bestätigt"), nie Betrag, Baum oder Name. Verworfen: personalisierte Texte (besserer Komfort, aber Personendaten beim Push-Dienst).
- **Outbox statt Direktversand:** Ein FCM-Ausfall darf keine Zahlungsfreigabe abbrechen; `enqueue_push` fängt Fehler ab und warnt nur. Kosten: bis zu einer Minute Verzögerung.
- **Opt-in an Konto gebunden:** Der Schalter speichert die Konto-ID. Meldet sich ein anderes Konto auf demselben Gerät an, wird es nicht stillschweigend angemeldet. Die App fragt die Systemberechtigung nie von selbst ab.
- **Abmelden gibt das Gerät frei:** `handleSignOut` ruft vor dem Sign-out `unregister_push_token` auf.
- **Tombstone statt Zeilenlöschung:** Ein abgemeldetes oder von FCM als ungültig gemeldetes Token wird mit `x:<id>` überschrieben; die Gerätekennung bleibt nicht liegen. Kontolöschung räumt beide Tabellen über den Fremdschlüssel ab.
- **Token wechselt das Konto:** Registriert ein anderes Konto dasselbe Token, wandert es dorthin (Gerät wurde weitergegeben) und wird auditiert.
- **`message.android` (FCM v1) statt `android_v2`:** `AndroidConfigV2` ist laut Firebase-Doku (Stand 2026-11-09) Preview mit EAP-Client-SDK. Der v1-Endpunkt hat kein Abschaltdatum. Umstieg später prüfen.
- **Wiederholung:** 404 `UNREGISTERED` und 400 mit „not a valid FCM registration token" → Token stilllegen. Alles andere (401/403, 429, 5xx) → nächster Cron-Lauf, nach 5 Versuchen `failed`. Pushes älter als 24 h verfallen.

**Abhängigkeit:** `@capacitor/push-notifications` 6.0.5 (npm-Tag `latest-6`, passend zu Capacitor 6; geprüft 2026-11-11). Begründung: offizielles Plugin, bringt das Firebase-SDK mit, kein eigener nativer Code.

**Tests:** `supabase/tests/push_notifications.test.sql` (47 Prüfungen, live ausgeführt, Rollback) · UI-Suite Abschnitt 2d (Browser ohne Push, abgelehnte Berechtigung, Aktivieren, Text statt Markup, Tippen öffnet Dashboard, fehlgeschlagenes Abschalten, ungültiges Token, Sign-out, stiller Refresh, fremdes Opt-in, axe) · HTTP: GET 405, ohne/mit falschem Token 401, mit Token 200 `configured:false`.

**Aktivierung (nur durch den Betreiber möglich):**
1. Firebase Console → Projekt `gen-lang-client-0319369264` → Projekteinstellungen → „Ihre Apps" → Android-App mit Paketname `com.faseela.app` hinzufügen → `google-services.json` herunterladen → nach `android/app/google-services.json` legen. Die Datei gehört nicht ins Git, wenn das Repository öffentlich ist.
2. Projekteinstellungen → „Cloud Messaging": Die „Firebase Cloud Messaging API (V1)" muss aktiviert sein.
3. Projekteinstellungen → „Dienstkonten" → neuen privaten Schlüssel erzeugen (JSON). Besser: in der Google Cloud Console ein eigenes Dienstkonto nur mit der Rolle „Firebase Cloud Messaging API Admin" anlegen und dessen Schlüssel verwenden.
4. Supabase Dashboard → Edge Functions → Secrets → `FCM_SERVICE_ACCOUNT` = vollständiger Inhalt der JSON-Datei. Danach die Datei lokal löschen.
5. Terminal im Projektordner: `npm install`, dann `npx cap sync android`, dann die App in Android Studio bauen.
6. Test: in der App anmelden → Profil → Einstellungen → „Push-Benachrichtigungen" einschalten → eine Testzahlung freigeben.

**Offen (🔲 / Platzhalter):**
- [PLATZHALTER: Datenschutzerklärung] Push als neue Verarbeitung aufnehmen: Zweck, Rechtsgrundlage (Einwilligung über den Schalter), Empfänger Google (Firebase Cloud Messaging), Drittlandtransfer, Widerruf über den Schalter. Rechtsgrundlage und Transferinstrument bitte durch die Kanzlei bestätigen lassen.
- [PLATZHALTER: Aufbewahrungsfrist] Erledigte Zeilen in `push_outbox` werden nicht automatisch entfernt (nur bei Kontolöschung).
- [UNVERIFIZIERT – Trainingsstand] OAuth2-JWT-Grant gegen `https://oauth2.googleapis.com/token`: Der Endpunkt wird aus dem Secret gelesen und auf diesen Wert geprüft; ein echter Versand ist erst mit dem Secret testbar.
- Echter Versand an ein Gerät ist ungetestet (kein FCM-Schlüssel, kein Gerät). Der native Teil (Plugin, `google-services.json`, Berechtigung) ist nur gegen ein nachgebildetes Plugin getestet.
- iOS (APNs-Schlüssel, Xcode-Capability), Web-Push, Push an Rollen/Admins (`notify_role`), Push-Texte auf Deutsch, Systemstatus-Kachel für fehlgeschlagene Pushes.

## 2s. Inbetriebnahme und Weg zur Veröffentlichung (Stand 2026-11-12)

**Live-Befund vor der Inbetriebnahme:** Hosting zeigt den Stand vor Paket 1 · 3 gelistete Bäume · 2 Konten (1 Admin, kein Finanz-Admin) · 0 Anfragen, 0 Anteile · keine Empfangskonten · noch nie eine E-Mail versendet (Mail-Anbieter nicht konfiguriert) · alle 8 Cron-Jobs laufen fehlerfrei.

**Erledigt am 2026-11-12:**
- 4 veraltete `ops_alert`-Mails aus Oktober geschlossen, damit sie nach dem Einrichten des Mail-Anbieters nicht nachträglich verschickt werden.
- Neu erzeugtes Android-Projekt geprüft (Capacitor-Template, Push-Plugin eingebunden, `google-services`-Block vorhanden). Manifest ergänzt: nur genutzte Berechtigungen (Netzwerkstatus, Vibration, Benachrichtigungen, Mikrofon, Standort), Hochformat, `allowBackup="false"` (Sitzungsdaten sollen nicht in Geräte-Backups landen).
- App-Icon und Startbildschirm für Android aus `public/images/icon-1024.png` erzeugt (15 Icons, 11 Splash-Grafiken, Hintergrundfarbe `#142A1C`); iOS-Icon ohne Transparenz abgelegt.
- Push auf iOS abgeschaltet (`pushPlugin()` liefert nur auf Android ein Plugin), weil der Server nur FCM-Token adressieren kann.
- `inbetriebnahme.command` im Projektordner: Prüfungen → Web-Deployment nach Rückfrage → Android-Sync → iOS-Projekt erzeugen und `Info.plist` mit wahrheitsgemäßen Berechtigungstexten füllen.

**Reihenfolge bis zum Start** (B = Betreiber, C = Claude):

| # | Schritt | Wer | Status |
|---|---|---|---|
| 1 | `inbetriebnahme.command` per Doppelklick ausführen (Deployment, Android-Sync, iOS-Projekt) | B | offen |
| 2 | Mail-Anbieter: Konto (Brevo oder Resend, EU), Absender-Domain bestätigen, Secrets `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `APP_URL` in Supabase setzen | B | offen |
| 3 | Supabase Auth: eigener SMTP-Versand für Bestätigungs- und Passwort-Mails | B | offen |
| 4 | Zweites Konto anlegen und als Finanz-Admin bzw. zweiten Admin freischalten | B + C | offen |
| 5 | Empfangskonten im Gründer-Pult eintragen | B | offen |
| 6 | Testkauf von Anfang bis Ende mit kleinem Betrag; C begleitet in der Datenbank | B + C | offen |
| 7 | Paket 5: `app.js` in Module, restliche deutsche Texte, Dunkelmodus-Kontraste, Kanzlei-Briefing, Platzhalter-Liste | C | offen |
| 8 | Android: `google-services.json`, FCM-Secret, signiertes Release-Bundle, Play-Konsole | B (C bereitet vor) | offen |
| 9 | iOS: Apple-Developer-Konto, Signierung in Xcode, TestFlight | B (C bereitet vor) | offen |
| 10 | Rechtsgutachten, Impressum/Datenschutz (23 Platzhalter), Sanktionslisten festlegen | B + Kanzlei | offen |
| 11 | Supabase-Bezahlplan, Wiederherstellungstest, Verfügbarkeitsüberwachung | B + C | offen |
| 12 | Geschlossene Beta, danach öffentlicher Start | B | offen |

**Offen (🔲):** iOS-Push (Firebase-iOS-SDK, APNs-Schlüssel) · Store-Einträge (Texte, Screenshots, Datenschutzangaben) · beide nativen Projekte sind auf keinem Gerät und in keinem Build getestet.

## 2t. Native Apps: erster Android-Build, iOS-Projekt, Push-Schalter (2026-11-12)

- **Android gebaut:** Das Projekt wurde in einer sauberen Linux-Umgebung gebaut (`gradle assembleDebug`, JDK 21, Gradle 8.14.3, SDK 34, Build-Tools 34.0.0) → `Faseela-1.0.0-test.apk`, 9,9 MB, Paket `com.faseela.app`, minSdk 22, targetSdk 34. Es ist eine **Debug-Version** (Debug-Zertifikat): zum Testen auf eigenen Geräten, nicht für den Play Store. Auf keinem Gerät gestartet.
- **APK-Größe:** `cap sync` kopiert auch die JPEG-Originale; die App nutzt nur WebP. `inbetriebnahme.command` entfernt JPEGs mit WebP-Zwilling aus den nativen Kopien (32 MB → 9,9 MB).
- **iOS-Projekt erzeugt:** `npx cap add ios` (Capacitor 6, iOS 13+, Bundle `com.faseela.app`, Version 1.0.0), `Info.plist` mit zutreffenden Berechtigungstexten, nur Hochformat auf dem iPhone, Icon und Startbild aus dem Logo. `pod install` und der Build laufen nur auf dem Mac mit Xcode. Der alte, unvollständige Ordner liegt in `ios-alt`.
- **Push-Schalter (Migration 35):** `private.app_settings.push_enabled` (Standard: aus). Solange aus, verweigert `register_push_token` die Anmeldung, `push_state()` meldet `enabled:false`, und die App zeigt die Push-Karte nicht und ruft das native Plugin nie auf. Grund: Ohne `google-services.json` kann das Plugin Firebase nicht initialisieren. Einschalten nach der FCM-Einrichtung per SQL: `insert into private.app_settings (key, value) values ('push_enabled', 'true'::jsonb) on conflict (key) do update set value = excluded.value;`
- **Zweiter Admin:** Das zweite Konto hat die Rolle `admin` (auditiert als `role.granted`). Damit greift das Vier-Augen-Prinzip für Empfangskonten.
- **Tests:** Schalter-Test live mit Rollback 8/8 · UI-Suite 566 Handler ok (neu: Schalter aus → Karte verborgen, Plugin unberührt; iOS → kein Push) · die 47er-Push-Suite wurde nach Migration 35 nicht erneut vollständig ausgeführt (Datei ist angepasst).

**Für die Store-Versionen fehlt (nur durch den Betreiber möglich):**
- Android: Upload-Schlüssel (Keystore) erzeugen und sicher verwahren, signiertes App-Bundle (`./gradlew bundleRelease`), Google-Play-Entwicklerkonto, Store-Eintrag, Datenschutzangaben.
- iOS: Apple-Developer-Konto, Team in Xcode wählen, Archiv hochladen, TestFlight, App-Review.
- Beide: Rechtstexte in der App erreichbar, Test auf echten Geräten.

**Befund für Paket 5:** `og:image` und `twitter:image` in `index.html` zeigen auf `https://faseela.sy/…`. Falls diese Domain nicht dem Betreiber gehört oder nicht erreichbar ist, haben geteilte Links kein Vorschaubild.

## 2u. Anmeldeproblem und eigenständiges Admin-Panel (2026-11-12)

**Anmeldeproblem (Ursache laut Auth-Log):**
1. Passwort-Anmeldung: `invalid_credentials` – das Passwort stimmte nicht.
2. Google-Anmeldung: `provider is not enabled` – Google ist in Supabase Auth nicht eingerichtet; die Weiterleitung endete auf einer Fehlerseite.
3. Magic Link aus dem Supabase-Dashboard: Supabase hat die Anmeldung bestätigt (`login_method: implicit`), liefert die Sitzung dabei aber im URL-Fragment. Die App akzeptiert aus Sicherheitsgründen nur PKCE und verwirft solche Links. Der zweite Klick scheiterte, weil der Link nur einmal gilt.

**Behoben:** Implizite Tokens werden sofort aus Adresszeile und Verlauf entfernt und der Nutzer bekommt einen Hinweis auf „Passwort vergessen?" (`src/supabase-client.src.mjs`, vor `createClient`). Die Google-Schaltflächen sind ausgeblendet, bis `GOOGLE_AUTH_ENABLED` zusammen mit dem Anbieter aktiviert wird. Der unterstützte Weg ist: Passwort, oder „Passwort vergessen?" → Link **im selben Browser** öffnen → neues Passwort setzen.

**Admin-Panel** (`public/admin/`: `index.html`, `admin.css`, `admin.mjs`; Adresse `/admin/`). Aufbau wie in Dr. Style: eigene Seite mit eigener Oberfläche neben der App, gleiche Backend-Schnittstelle. Das Panel hat keine eigenen Rechte; jede Aktion prüft die Datenbank (Rollen, Vier-Augen, Sanktionsprüfung).

| Bereich | Inhalt | Rollen |
|---|---|---|
| Übersicht | Kennzahlen offener Prüfungen, Mail-Warteschlange, App-Fehler; Warnung bei fehlendem Mail-Anbieter | Admin |
| Zahlungen | Beleg ansehen, Sanktionsprüfung erfassen, freigeben/ablehnen mit Bestätigung | Admin, Finanz-Admin |
| Rollenanträge | vergeben/ablehnen | Admin |
| Nutzer | Suche, Rolle ändern, sperren/entsperren; eigene Zeile gesperrt | Admin |
| Empfangskonten | gültige Konten, offener Vorschlag, Vier-Augen-Bestätigung, Änderungsformular | Admin |
| Finanz-Export | CSV für einen Zeitraum, Schutz gegen Formel-Injektion | Admin, Finanz-Admin |
| Audit-Log | letzte 150 Einträge (`adminListAuditLogs`, RLS: nur Admin) | Admin |
| System | öffentlicher Status, Warteschlangen, Hintergrundjobs | Admin |

**Sicherheit:** Server-Texte werden nur als Text gerendert (kein `innerHTML`) · eigene CSP ohne Inline-Stile, `form-action 'none'` · `noindex`, Hosting-Header `/admin/**`: `Cache-Control: no-store`, `X-Robots-Tag` · Beleg-Links nur zur Supabase-Storage-Herkunft · automatische Abmeldung nach 30 Minuten · nach dem Abmelden bleiben keine Admin-Daten im DOM · Konten ohne Admin-/Finanz-Rolle werden abgewiesen und abgemeldet.

**Tests:** `npm run test:admin` (`tests/e2e/admin.e2e.mjs`, Backend nachgebildet): Anmeldung, Rollen, alle acht Bereiche in hell und dunkel mit axe, Bestätigungsdialoge, Vier-Augen-Regel, CSV, Fehlerzustand mit „Erneut laden".

**Offen (🔲):** Das Panel ist nur Deutsch · gegen das echte Backend erst nach dem Deployment prüfbar · Bereiche aus Dr. Style ohne Faseela-Gegenstück (Inhalte/Bäume pflegen, Einstellungen mit Push-Schalter, Sicherheit, Support, Aufgaben) · das Gründer-Pult in der App besteht parallel weiter · die Demo-Anmeldemaske `modal-google-sso` in `index.html` enthält echt wirkende E-Mail-Adressen und sollte entfernt werden.

## 2v. Admin-Cockpit: Kennzahlen, Bestand, alle Prüfungen (2026-11-12)

Das Panel aus §2u ist zum Steuerungs-Dashboard ausgebaut. Adresse: `https://faseela.web.app/admin/` (mit Schrägstrich am Ende, Kleinschreibung; `/Admin/` gibt es nicht – dafür existiert jetzt eine eigene 404-Seite).

**Neue Server-Lesemodelle (Migrationen 36/37, live):**

| RPC | Rolle | Inhalt |
|---|---|---|
| `admin_dashboard()` | Admin | Konten, Rollen, Anfragen nach Status, Volumen, 12-Monats-Reihen, Bestand, Kauf-Trichter, Geschenke, Empfehlungen, Öl, Mail, Push, Fehler, Betrieb. Enthält keine E-Mail-Adressen. |
| `admin_list_investments({status, limit, offset})` | Admin, Finanz-Admin | Anfragen mit Zahler, seitenweise (max. 100) |
| `admin_list_trees()` | Admin, Finanz-Admin | Bestand je Baum: verkauft, reserviert, frei, Umsatz, Besitzer, Landwirte |
| `admin_set_tree_status({treeId, status})` | Admin | Baum im Katalog zeigen/ausblenden, auditiert |
| `admin_list_client_errors()` | Admin | App-Fehler der letzten 14 Tage, gruppiert, ohne Nutzer-IDs |
| `admin_set_push_enabled({enabled})` | Admin | Push-Schalter aus §2t, auditiert |

Alle Lese-RPCs teilen ein Limit von 240 Aufrufen pro Minute und Konto.

**Bereiche des Panels (13):** Übersicht · Zahlungen · Weitere Prüfungen (Feldberichte mit Fotos, Pressungen mit Zertifikatsnummer, Ölanfragen, Öl-Auslieferung) · Rollenanträge · Investitionen (Filter, Blättern) · Bäume · Nutzer · Empfangskonten · Finanz-Export · Fehler · Audit-Log · Einstellungen · System. Finanz-Admins sehen Zahlungen, Weitere Prüfungen (nur Öl), Investitionen, Bäume (ohne Schalter), Finanz-Export.

**Übersicht:** acht Kennzahlen · Handlungsempfehlungen nach Dringlichkeit mit Sprung in den passenden Bereich · drei Balkendiagramme (freigegebenes Volumen, neue Anfragen, Registrierungen je Monat) · Kauf-Trichter · Kurzstände zu Geschenken, Empfehlungen, Öl, Rollen.

**Entscheidungen:**
- **Handlungsempfehlungen sind regelbasiert, kein KI-Modell.** 13 feste Regeln über den Dashboard-Zahlen (z. B. keine Empfangskonten, überfällige Zahlung, nur ein Admin, ≤ 10 % Anteile frei). Das ist nachvollziehbar, kostet nichts und gibt keine Daten an Dritte. Ein Sprachmodell (Zusammenfassungen, Antwortentwürfe) wäre eine neue Verarbeitung mit eigenem Anbieter, Schlüssel, Kosten und Transparenzpflichten und ist bewusst nicht eingebaut.
- **Diagramme ohne Bibliothek:** eine Messgröße je Diagramm, eine Achse, ein Farbton; drei kleine Diagramme statt zwei Achsen in einem. Balken sind per Tastatur erreichbar und zeigen den Wert; jedes Diagramm hat eine Tabellenansicht. Keine zusätzliche Abhängigkeit, CSP unverändert streng.
- **Bäume: nur Sichtbarkeit schaltbar.** Preise, Stückzahlen und neue Bäume greifen in Bestand und laufende Reservierungen ein und bleiben geprüfte Migrationen.
- **Kein eigener Admin-Server-Teil** (anders als die Edge Function in Dr. Style): Die Admin-Funktionen sind geprüfte Datenbank-Aufrufe; ein zusätzlicher Dienst mit Service-Schlüssel wäre mehr Angriffsfläche ohne Gewinn.

**Tests:** `supabase/tests/admin_cockpit.test.sql` – live mit Rollback 29/31; die zwei Abweichungen: ein echter Fehler (nicht-numerisches Limit lieferte einen rohen Datenbankfehler → Migration 37, danach einzeln nachgeprüft) und ein Testfehler (Lesen unter RLS; Datei korrigiert). Die vollständige Suite wurde danach nicht erneut ausgeführt. · `npm run test:admin` grün: alle 13 Bereiche in hell und dunkel mit axe, Diagramme, Empfehlungen, Fotos nur von der Storage-Herkunft, Zertifikatspflicht, Blättern, Baum-Schalter, Push-Schalter, Teil-Ausfall einer Warteschlange.

**Offen (🔲):** Panel nur Deutsch · gegen das echte Backend erst nach Deployment und Anmeldung geprüft · Nutzer-Detailansicht (Historie eines Kontos) · Geschenke/Empfehlungen nur als Zahlen · Bäume anlegen und Preise ändern · KI-Assistent (Entscheidung des Betreibers nötig) · Export der Dashboard-Zahlen.

## 2w. Passwort-Zurücksetzen aus dem Admin-Panel, Prüfung von Anmeldung und Registrierung (2026-11-12)

**Fehler:** „Passwort vergessen?" im Admin-Panel schickte einen Link, der auf `/admin/auth/reset.html` führte. Diese Seite gibt es nicht (Firebase-404). Ursache: `webUrl()` löste Pfade relativ zur aufrufenden Seite auf statt zur App-Wurzel. Supabase hatte die Anmeldung jeweils bestätigt; der Einmal-Link war danach verbraucht. **Behoben:** Pfade werden gegen den Ordner des Client-Moduls aufgelöst (`APP_ROOT = new URL('./', import.meta.url)`), der Link führt von jeder Seite nach `/auth/reset.html`.

**Zusätzlich im Log:** Der eingebaute Supabase-Mailversand hat ein enges Stundenlimit (`email rate limit exceeded` um 12:59 UTC) und 60 Sekunden Sperre zwischen zwei Anfragen. Für den Betrieb braucht Auth einen eigenen SMTP-Anbieter.

**Befunde aus der Prüfung von Anmeldung und Registrierung (alle behoben):**

| Befund | Risiko | Korrektur |
|---|---|---|
| Zustimmungs-Häkchen zur Charta war vorangekreuzt | Eine vorangekreuzte Box ist keine wirksame Einwilligung | Standard: nicht angekreuzt; die Registrierung wird ohne Häkchen abgelehnt |
| Mindestlänge Passwort: Registrierung 8, Zurücksetzen 10 Zeichen | widersprüchliche Regeln | überall 10; die Meldung nennt die Zahl |
| Admin-Panel zeigte bei falschem Passwort nur „Das hat nicht funktioniert" | unklare Fehlermeldung | „E-Mail oder Passwort stimmt nicht." |
| Kontrast in der Anmeldemaske (inaktiver Reiter, Trenner, Hinweise, Sicherheitshinweis im Dunkelmodus) | WCAG AA verfehlt | Farben angehoben; axe: 0 Verstöße in 12 Kombinationen (hell/dunkel × AR/EN/DE × Anmelden/Registrieren) |
| Auswahlfeld „Region" ohne zugeordnete Beschriftung | Screenreader nennt das Feld nicht | `label for` ergänzt |

**Geprüft und in Ordnung:** Falsche Zugangsdaten lassen die Maske offen und zeigen eine Meldung · Zurücksetzen verrät nicht, ob ein Konto existiert · Registrierung prüft Name, E-Mail, Telefon, Passwort, Wiederholung in dieser Reihenfolge und sendet erst dann · gesendet werden nur E-Mail, Passwort und Profilangaben; die gewünschte Rolle ist nur ein Antrag · Google-Schaltflächen sind ausgeblendet.

**Vorgehen der Prüfung:** Lokaler Stand im echten Browser gegen das echte Backend; Aufrufe von `/recover` und `/signup` wurden abgefangen und lokal beantwortet, damit weder E-Mails verschickt noch Konten angelegt werden. Eine echte Registrierung und ein echter Reset-Durchlauf mit E-Mail sind damit **nicht** getestet.

**Offen (🔲):** Serverseitige Mindestlänge und Schutz vor geleakten Passwörtern stehen in Supabase Auth (Dashboard) · Der Sicherheitshinweis in der Anmeldemaske wirbt mit „Multi-Tenant Enterprise Security"; Wording in Paket 5 prüfen.

## 2x. Admin-Panel als Betriebswerkzeug, Fehlerdurchsicht der Plattform (2026-11-12)

**Neu im Admin-Panel (`public/admin/`, jetzt 15 Bereiche):**

| Bereich | Funktion | Server-RPC | Rolle |
|---|---|---|---|
| Bäume | „Neuer Baum" und „Bearbeiten" (Texte AR/EN, Sorte, Region, Anteilszahl, Preis, Bilder, Parzelle) | `admin_create_tree`, `admin_update_tree`, `admin_get_tree` | Admin |
| Nutzer → Details | Stammdaten, Anfragen, Anteile, Zähler; Bäume/Ölmühlen zuweisen und entziehen | `admin_user_detail`, `admin_assign` | Admin |
| Besitzregister | Wer hält welche Anteile, seitenweise, Filter nach Baum | `admin_list_shares` | Admin, Finanz-Admin |
| E-Mails | Warteschlange mit Zählern, letzter Fehler, erneutes Einreihen (einzeln oder alle der letzten 7 Tage) | `admin_list_outbox`, `admin_retry_email` | Admin |

**Regeln, die der Server durchsetzt (nicht das Formular):**
- Ein neuer Baum startet immer `unlisted`; sichtbar wird er erst über „Einblenden".
- Preisänderung gilt nur für künftige Anfragen. Offene Anfragen behalten ihren Betrag (er steht in `investment_requests.amount_minor`).
- Die Anteilszahl kann nicht unter `sold_shares + reserved_shares` sinken; `available_shares` wird bei jeder Änderung neu berechnet.
- Bilder nur als Pfad `images/<name>.(webp|png|jpg|jpeg)` — keine fremden URLs.
- Zahlen müssen JSON-Zahlen sein, Stückzahlen und Preise ganzzahlig (`opt_int` lehnt Brüche ab statt zu runden).
- Jede Änderung und jede Einsicht in ein Nutzerkonto steht im Audit-Log (`tree.created`, `tree.updated` mit Preis/Anteilen vorher-nachher, `user.viewed`, `outbox.retry`).
- Das E-Mail-Register zeigt Empfänger nur gekürzt (`a***@domain`).

**Behobene Fehler aus der Durchsicht:**

| Fund | Ursache | Behebung |
|---|---|---|
| Englische Baumnamen und Sorten auf Arabisch, Regionen leer | Seed hatte die falschen Felder kopiert | Migration 39 |
| Status meldete E-Mail „ok", obwohl nie eine Mail zugestellt wurde | `public_status` prüfte nur Fehler der letzten 24 h | Migration 40 (`unverified`) |
| 12 Kontrastfehler auf der Startseite im Dunkelmodus (EN/DE), 6 (AR) | Text wurde global aufgehellt, halbtransparente helle Flächen (`bg-emerald-100/60` …) blieben hell | Dunkle Gegenstücke für diese Flächen in `index.html`; neue Suite `npm run test:contrast` |
| Unerreichbares Demo-Fenster „Google-Konto wählen" mit fest eingetragenen E-Mail-Adressen im ausgelieferten HTML | Rest aus der Demo-Phase | Fenster und beide Handler entfernt; Adresse auch aus den Demo-Stammdaten in `app.js` ersetzt |
| `canonical`, `og:url`, `og:image`, `twitter:*` zeigten auf `faseela.sy` (Domain nicht in Betrieb) | Platzhalter-Domain | auf `https://faseela.web.app/` gestellt — bei eigener Domain wieder anpassen |
| Drei QR-Bilder wurden von `api.qrserver.com` geladen | Demo-Rest; Abruf bei einem Dritten ohne Hinweis in der Datenschutzerklärung | durch lokales Symbol ersetzt, kein Abruf bei Dritten mehr |
| Text „Prüfcode, ausgestellt vom Internationalen Olivenrat" im Öl-Pass | nicht belegte Aussage | Text neutralisiert („interner Faseela-Prüfcode, Beispiel") |

**Offen und bewusst nicht geändert:** Weitere Texte nennen „IOC" (Standards, Zertifikat, Labor). Ob Faseela damit werben darf, ist eine rechtliche Frage → `[PLATZHALTER: IOC-Aussagen juristisch prüfen]`.

**Tests:** `supabase/tests/admin_operations.test.sql` (43 Prüfungen, Rollback), `tests/e2e/admin.e2e.mjs` (Baum anlegen/bearbeiten, Nutzerdetails mit Zuweisungen, Besitzregister, E-Mails; axe hell/dunkel inkl. beider neuen Dialoge), `tests/e2e/home-contrast.e2e.mjs` (Startseite AR/EN/DE × hell/dunkel).

## 2y. Leitstand: Aufgaben, Automationen, Go-Live-Checkliste, Suche, Verlauf (2026-11-13)

Das Admin-Panel hat jetzt 18 Bereiche. Neu sind vier Werkzeuge, mit denen sich der Betrieb führen lässt, ohne jeden Bereich einzeln zu öffnen.

| Bereich | Zweck | Server-RPC | Rolle |
|---|---|---|---|
| Aufgaben (Startseite) | Alles, was eine Person braucht, nach Dringlichkeit; dazu die Suche über Konten, Bäume und Anfragen | `admin_tasks`, `admin_search` | Admin; Finanz-Admin sieht nur Finanzaufgaben, keine Suche |
| Automationen | Regeln ein-/ausschalten, Hintergrundjobs pausieren/fortsetzen, Protokoll der automatischen Aktionen | `admin_automation_state`, `admin_set_automation_rule`, `admin_set_job_active` | Admin |
| Go-Live | 9 Punkte prüft die Datenbank selbst, 8 bestätigt ein Mensch mit Notiz | `admin_readiness`, `admin_set_readiness` | Admin |
| Übersicht → Entwicklung | Kennzahlen heute gegen den Stand vor bis zu 7 Tagen | `admin_kpi_history` | Admin |
| Bäume → Bearbeiten | Ölmühle setzen oder entfernen | `admin_set_tree_mill` | Admin |

**Automationsregeln** (Tabelle `private.automation_rules`, Job `faseela-automations`, stündlich zur Minute 25):

| Regel | Wirkung | Standard |
|---|---|---|
| `review_reminder` | Liegt der älteste offene Eintrag einer Warteschlange (Rollenanträge, Feldberichte, Pressungen, Ölanfragen) länger als n Tage, geht einmal pro Tag und Warteschlange eine E-Mail (`review_needed`) an die zuständige Rolle und die Admins | aus, 2 Tage |
| `sold_out_unlist` | Ein vollständig verkaufter Baum ohne Reservierung wird nach n Tagen ausgeblendet; Anteile bleiben unberührt | aus, 14 Tage |

- Beide Regeln sind bewusst **aus**: Erinnerungen erzeugen E-Mails, und E-Mails schlagen fehl, solange kein Anbieter verbunden ist (das hatte am 11.11. eine Alarmschleife mit 360 fehlgeschlagenen Aufrufen ausgelöst).
- Eine fehlerhafte Regel stoppt die anderen nicht; ihr Fehler steht in `last_result` und im Panel.
- `private.automation_log` verhindert doppelte Aktionen (Schlüssel Regel + Gegenstand + Tag) und ist zugleich das Protokoll.
- Jobs lassen sich nur pausieren, wenn ihr Name mit `faseela-` beginnt. Das Panel warnt bei den drei Jobs, deren Pause Kunden trifft (Reservierungen freigeben, E-Mail-Versand, überfällige Prüfungen).
- Es entscheidet kein KI-Modell. Alle Regeln sind feste Bedingungen.

**Kennzahlen-Verlauf:** `private.kpi_snapshot()` schreibt täglich um 23:50 UTC eine Zeile nach `private.kpi_daily` (Konten, bestätigte Konten, Besitzer, freigegebenes Volumen, verkaufte Anteile, offene Anfragen). Der Verlauf beginnt am 2026-11-13; frühere Tage gibt es nicht.

**Suche:** Der Suchbegriff wird wörtlich verglichen (`%` und `_` werden maskiert), mindestens 2 Zeichen, je 8 Treffer, 60 Aufrufe pro Minute.

**Tests:** `supabase/tests/admin_control_center.test.sql` (37 Prüfungen), `supabase/tests/admin_tree_mill.test.sql` (7 Ergebnisse), `tests/e2e/admin.e2e.mjs` (Aufgaben, Suche, Entwicklung, Automationen, Go-Live; axe hell/dunkel auf allen 18 Bereichen).

## 2z. Katalog aus der Datenbank, Schwesterkulturen, Beispielwerte (2026-11-13)

**Katalog:** Die Web-App hatte ihren Baumkatalog als feste Liste in `app.js`; die Datenbank lieferte nur Preis und Verfügbarkeit. Jetzt ist `public.trees_public` die Quelle:

- Ein sichtbarer (`listed`) Baum, den es nur in der Datenbank gibt, bekommt in der App einen Eintrag (`buildServerTreeEntry`). Dafür wird ein eingebauter Eintrag derselben Kultur als Gerüst kopiert und alles Baumspezifische geleert (Hof, Mühle, Pflegeprotokoll, Erntestatus, Parzelle).
- Für jeden Baum ersetzen Name, Region, Sorte, Pflanzjahr, Ertrag und Bilder aus der Datenbank die eingebauten Werte (`applyServerCatalog`). Leere Datenbankwerte ändern nichts.
- `mapPublicTree` entfernt aus Server-Texten `<`, `>` und Steuerzeichen und lässt nur Bildpfade `images/<name>.(webp|png|jpg|jpeg)` durch.
- Ausgeblendete Bäume liefert die Datenbank an Besucher gar nicht aus (RLS); die App zeigt sie nicht.
- Grenze: Beschreibungstexte, Parzellendaten und Pflegeprotokolle neuer Bäume kommen noch nicht aus der Datenbank; ein nur dort angelegter Baum zeigt diese Bereiche leer.

**Schwesterkulturen (Migration 44):** `tree_12` Pistazie, `tree_14` Mandel, `tree_15` Granatapfel, `tree_16` Walnuss – je 4 Anteile, ausgeblendet, ohne Parzelle, Landwirt und Mühle. Die Ernte-Abrechnung (Pressung → Öl in Litern) ist olivenspezifisch; für diese Kulturen gibt es noch keinen Ablauf.

**Beispielwerte:** Der Abschnitt „Klima und Boden" auf der Startseite zeigt feste Zahlen. Er ist jetzt in allen drei Sprachen als Beispiel gekennzeichnet statt als Live-Messung.

**Vorbereitet, nicht angewendet (Migration 43 `launch_hardening`):** Reservierungsfrist 48 Stunden, zweiter Faktor für Konten mit eingerichtetem Authenticator, Regeln „unbestätigte Konten löschen" und „Wochenbericht". Die Datenbank verlangt dafür eine Bestätigung des Kontoinhabers, die zweimal ausblieb. Die Datei liegt deshalb nicht im Migrationsordner.

**Tests:** `npm run test:catalog` (`tests/e2e/catalog.e2e.mjs`), `tests/data-mappers.test.mjs` (11).

## 3. Server-Modus im Frontend

Sobald eine Supabase-Sitzung besteht (`state.serverMode = true`):

- Demo-Datensätze werden verworfen und durch Server-Daten ersetzt (`watchMyShares/Transactions/Investments`, `watchMyFarmerUpdates`, `watchMyPressingBatches`). Diese laden zuerst die Daten und hören dann auf Realtime-Änderungen; fällt Realtime aus, fragen sie alle 30 s neu ab.
- Die globale API heißt weiter `window.FaseelaFirebase`, zusätzlich `window.FaseelaBackend` mit `backend: 'supabase'`. Callables liefern `{ data }`, Listener geben eine Abmelde-Funktion zurück.
- `localStorage` enthält nur Einstellungen sowie die Supabase-Sitzung (Access- und Refresh-Token).
- Passwort-Reset läuft über `public/auth/reset.html` (eigene Seite, strikte CSP, kein Inline-Skript).
- Bereiche, die noch Beispieldaten zeigen, tragen ein sichtbares „Vorschau“-Banner.

## 4. Build

```bash
npm install                 # Root: Build-Werkzeuge + Capacitor
npm run build:web           # Tailwind-CSS, Supabase-Bundle, Lucide, Fonts -> public/
npm run sync                # public/ -> android/app/src/main/assets/public
npm run build               # Syntax, Sync-Drift, CSP-/Self-Hosting-/Secret-Guard, Claims-Guard
npm run seed:sql            # database/seed_data.json -> supabase/seed.sql
```

- **Quellcode des Clients:** `src/supabase-client.src.mjs` bearbeiten, nicht das Bundle in `public/`.
- Die Build-Guards brechen ab bei: Drittanbieter-Skripten oder -Fonts, `unsafe-eval`, fehlendem Supabase-Host in `connect-src`, Verweisen auf den alten Firebase-Client, einem Service- oder Secret-Key im Bundle, Rendite-, Garantie- oder Escrow-Aussagen.

## 5. Tests

| Befehl | Inhalt |
|---|---|
| `npm test` | Unit-Tests der Domänen-Referenz (`functions/domain.js`) |
| `npm run test:web` | Mapper Server → UI |
| `npm run test:admin` | Admin-Panel mit gemocktem Backend: Rollen, alle 18 Bereiche hell/dunkel (axe), Dialoge, Vier-Augen-Regeln, Baum anlegen/bearbeiten, Nutzerdetails, Besitzregister, E-Mails. Dauer ca. 3 Minuten |
| `npm run test:contrast` | Startseite in AR/EN/DE, hell und dunkel, mit axe (WCAG 2.x A/AA) |
| `npm run test:ui` | Browser-Suite ohne Konto: alle `data-*`-Handler lösen auf, Navigation/Modale per Delegation, gemockte Investor-, Admin- und Bauern-Sitzung (Geschenk-/Empfehlungsfluss, Schnellformular inkl. Foto-Validierung und Upload-vor-RPC, Profil mit Einwilligung), öffentliche Seiten `verify.html`, `status.html`, `tree.html` (gemockte RPCs, Bild-Whitelist), axe (WCAG A/AA) hell und dunkel |
| `npm run test:db` | `supabase/tests/security.test.sql` (233 Fälle) + `supabase/tests/gifts_referrals.test.sql` (55 Fälle: Geschenk-Codes, Einlöse-Limit, Empfehlungsregeln, Reward-Trigger, Öl-Gutschrift, RLS) + `supabase/tests/delete_account_rewards.test.sql` (20 Fälle: Löschkaskade/Pseudonymisierung/Purge-Queue) + `supabase/tests/payment_instructions.test.sql` (33 Fälle: Rollen, Validierung, Vier-Augen, Audit, Rate-Limits) + `supabase/tests/screening_finance_export.test.sql` (24 Fälle: Screening-Sperre, Export). `security.test.sql`: RLS, RPC-Rechte, Vier-Augen-Prinzip, Limits, Idempotenz, Storage-Policies, Upload-Obergrenzen, Admin-Werkzeuge, Outbox/Benachrichtigungen, Fehler-Reporter-Kappung, Systemstatus, Ops-Alarm, Profil-Selbstbedienung, Einwilligung/Onboarding, öffentlicher Status, Öl-Zuteilung/-Anfragen mit Verschlüsselung, Zertifikate/Verifikation, Baumprofile/Bauernprofile mit Einwilligung, `my_assignments`, `tree_media_paths` nur service_role, Audit-Fixes F2–F4/L1–L3, Jobs). Läuft als Transaktion mit vollständigem Rollback. Benötigt `SUPABASE_DB_URL` und `psql`. |
| `npm run test:load` | `tests/load/reserve.load.mjs`: 50 (oder `LOAD_USERS`) gleichzeitige Reservierungen auf einen 4-Anteile-Baum gegen **Staging**. Erwartung: genau 4 Erfolge, Rest `failed-precondition`, `available_shares` nie negativ, Replay mit gleichen Idempotency-Keys liefert gleiche IDs. Verweigert den Lauf gegen das Produktionsprojekt. Benötigt `SUPABASE_DB_URL` (Staging) und `psql`. |
| `npm run test:e2e` | Browser-Durchstich gegen ein **Dev-Projekt**: Kauf → Beleg-Upload → Freigabe durch Finance → Dashboard → Export. Legt Test-Identitäten `@faseela.test` und den Testbaum `tree_e2e` an. |

## 6. Deployment-Runbook

Siehe `docs/SUPABASE_MIGRATION.md`, Abschnitt „Go-Live-Checkliste“. Kurzform:

1. Migrationen in `supabase/migrations/` anwenden, in Dateinamen-Reihenfolge. Danach `supabase/seed.sql`.
2. Im Supabase-Dashboard unter Auth einstellen: Site-URL und Redirect-URLs (Hosting-Domain plus `/auth/reset.html`), E-Mail-Bestätigung an, Mindestlänge des Passworts, Schutz vor geleakten Passwörtern und eigenen SMTP-Versand.
3. Ersten Admin per SQL-Editor setzen: `select private.admin_set_role('<email>', 'admin');`. Zuweisungen: `private.admin_assign_farmer(email, tree_id)` / `private.admin_assign_mill(email, mill_id)`.
4. E-Mail-Versand aktivieren: Edge Function `send-emails` deployen (`supabase functions deploy send-emails --no-verify-jwt`) und im Dashboard unter Edge Functions → Secrets `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `APP_URL` setzen. Danach `supabase/migrations/20261026000210_monitoring_retention.sql` einmalig im SQL-Editor ausführen. Prüfung: Freigabe-Pult → Systemstatus → Outbox „fehlgeschlagen = 0“.
5. Hosting veröffentlichen: `cd <projektordner> && firebase deploy --only hosting --project gen-lang-client-0319369264`. Das geht ohne Blaze-Tarif.
6. Altlasten: Render-Service abschalten und `JWT_SECRET` dort widerrufen.

## 6a. CI/CD

`.github/workflows/ci.yml`: `npm ci` → gitleaks (blockiert bei Fund) → Build → Sync + Guards → Unit-Tests → `npm audit` (high) → DB-Suite (wenn `SUPABASE_DB_URL` als Secret gesetzt) → Browser-UI-Suite. Auf `main` danach atomarer Deploy nach Firebase Hosting (`FIREBASE_SERVICE_ACCOUNT`). Rollback: Firebase Console → Hosting → Release-Verlauf.

## 7. Offene Punkte

| Punkt | Art | Nächster Schritt |
|---|---|---|
| Impressum/Datenschutz | [PLATZHALTER] juristisch | Betreiberdaten, Fristen, Supabase-DPA und Drittlandgrundlage eintragen und prüfen lassen |
| Erlaubnispflicht des Produkts | [PLATZHALTER] juristisch | Kapitalmarkt- und Aufsichtsrecht klären |
| Sanktions-/KYC-Screening | [PLATZHALTER] juristisch | Technik erledigt (§2p: Pflichtschritt vor Freigabe). Offen: verbindliche Listen, Schwellen, Aufbewahrung durch Kanzlei; ggf. automatischer Listenabgleich über Anbieter |
| Google-Login in den nativen Apps | Technik | Client-Seite fertig (Deep Link `faseela://app/…`, Systembrowser). Offen: `faseela://app/**` als Redirect-URL in Supabase eintragen und auf einem Gerät testen [UNVERIFIZIERT] |
| Rate-Limits | Härtung | Erledigt für anonyme/teure RPCs (§2n). Offen: direkte Tabellen-Reads und DDoS-Schutz → WAF/CDN vor Hosting und API |
| Staging-Projekt | Betrieb | Free-Limit (2 aktive Projekte) erreicht: entweder `dr-style` pausieren oder Pro-Plan, dann `faseela-staging` (eu-central-1) anlegen, Migrationen anwenden, `npm run test:load` dort fahren |
| Externer Uptime-Check | Betrieb | pg_cron sieht keinen Hosting- oder API-Ausfall; Uptime-Kuma/Better Stack auf `/` und `/status.html` |
| Kostenloser Tarif pausiert nach Inaktivität | Betrieb | Vor dem Launch auf Pro wechseln (Backups mit PITR, kein Pausieren) |
| Capacitor 6 / Tailwind 3 (Build-Zeit-CVEs) | Wartung | Upgrades planen |
