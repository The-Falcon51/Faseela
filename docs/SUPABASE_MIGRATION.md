# Migration B: Firebase-Backend → Supabase (Stand 20.10.2026)

## Entscheidung

| Option | Kosten | Aufwand | Entscheidung |
|---|---|---|---|
| Firebase Blaze (Billing aktivieren) | nutzungsabhängig, Kreditkarte nötig | keiner | verworfen: der Nutzer wollte kein Google-Billing |
| **Supabase (wie Dr.Style) + Firebase Hosting (Spark)** | Free-Tier 0 €, für den Launch Pro empfohlen | Port von Auth, Daten, Storage und 18 Functions | **gewählt** |
| Eigener Server (Render/Docker) | Server und Betrieb | hoch, Altlasten in `legacy/` | verworfen |

Begründung: Postgres mit RLS erzwingt Mandanten- und Rollentrennung in der Datenbank selbst (Sicherheit). Transaktionen und Constraints ersetzen die Firestore-Transaktionen ohne Cold Starts (Latenz). Es gibt keine Kosten im Free-Tier, und das EU-Hosting liegt in Frankfurt (DSGVO). Die Logik ist SQL und testbar (Wartbarkeit).

## Projekt

- Organisation „The-Falcon51's Org“, Projekt `faseela`, ID `riyvlhlhzxxerlwqoxsy`, Region `eu-central-1`, Postgres 17.
- API: `https://riyvlhlhzxxerlwqoxsy.supabase.co`. Im Client steht nur der öffentliche Publishable Key.

## Abbildung Firebase → Supabase

| Firebase | Supabase |
|---|---|
| Custom Claims `role` | `private.user_roles` + `private.has_any_role()` |
| `users_private` | `public.profiles` (Trigger auf `auth.users`) |
| `trees` / `trees_public` | `private.trees` (Bestand, Parzelle) / `public.trees_public` (Listing) |
| `investment_requests`, `transactions`, `shares` | gleichnamige Tabellen in `public` |
| `farmer_assignments/{uid}/trees/{id}` | `public.farmer_assignments (farmer_uid, tree_id)` |
| `upload_grants` in `(default)` + `storage.rules` | entfällt: Storage-Policies prüfen die Tabellen direkt |
| 16 Callables | 15 RPCs (`getPaymentProofUrl` → signierte URL über die Storage-Policy) |
| 2 `onSchedule` | 2 `pg_cron`-Jobs |
| `deleteMyAccount` (Admin SDK) | `private.delete_my_account()` löscht `auth.users` (kaskadiert) |

## Migrationen (Reihenfolge)

1. `20261020000100_core_schema.sql`: Schema, RLS, SELECT-Policies, Realtime-Publikation
2. `20261020000200_rpc_core.sql`: Helfer, Profil, Rollenanträge, Investitionen, Jobs-Funktionen
3. `20261020000300_rpc_operations.sql`: Feldberichte, Pressdaten, Warteschlangen, Admin-Liste, Export, Zuweisungen
4. `20261020000305_operator_helpers.sql`: `admin_set_role`
5. `20261020000400_api_surface.sql`: SECURITY-INVOKER-Wrapper und endgültige Rechte
6. `20261020000410_storage.sql`: Buckets und Policies
7. `20261020000420_jobs.sql`: `pg_cron`
8. `20261020000500_account_deletion.sql`: Kontolöschung (angewendet am 20.10.2026)
9. `20261026000100_admin_tools.sql`: Admin-RPCs (Rollen, Sperren, Zuweisungen mit `revoked_at`), Upload-Obergrenzen
10. `20261026000200_notifications_monitoring.sql`: `private.email_outbox`, `notify_user/notify_role`, `outbox_claim/outbox_mark` (service_role), `client_errors` + `report_client_error`, `ops_state`, `admin_system_status`, `ops_check` + Cron
11. `20261026000210_monitoring_retention.sql`: `prune_monitoring()` (DELETE) — **manuell im SQL-Editor ausführen**, der MCP-Weg blockiert destruktive Statements
12. `20261026000220_outbox_trigger.sql`: Vault-Secret `outbox_token`, `public.outbox_token()`, Cron `faseela-send-emails` → Edge Function per `pg_net`
13. `20261026000230_anon_private_usage.sql`: `anon` erhält `USAGE` auf `private` für den Fehler-Reporter; alle übrigen Funktionen/Tabellen in `private` für `public`/`anon` entzogen, Default-Privilegien geschlossen
14. `20261026000240_pg_net_schema.sql`: pg_net von `public` nach `extensions` verschieben — **manuell im SQL-Editor** (enthält `drop extension`)
15. `20261026000300_notification_hooks.sql` (generiert durch `scratch-tools/gen_notify_migration.py`): Geschäfts-RPCs mit `notify_*`-Aufrufen im selben Transaktionskontext

16. `20261026000400_profile_onboarding_status.sql`: `update_my_profile`, `set_marketing_consent` (versioniert), `send_onboarding` + Cron `faseela-onboarding`, `public_status` (anon)

17. `20261101000100_harvest_oil.sql`: Vault-Schlüssel `pii_key`, `oil_allocations`, `oil_requests`, `private.oil_request_contacts` (verschlüsselt), `allocate_oil` in `certify_pressing_batch`, `request_oil`/`cancel_oil_request`/`review_oil_request`, `list_review_queue` + `oil_requests`/`oil_fulfilment`, `export_my_oil`
18. `20261101000200_certificates.sql`: `share_certificate` (Owner/Admin), `verify_certificate` (anon), Seriennummernformat
19. `20261102000100_tree_profiles.sql`: `tree_events_public.update_id`, `public.farmer_profiles` (RLS: öffentlich nur mit `consent_public`, Owner immer), `update_farmer_profile` (Bauer; Einwilligung versioniert + auditiert), `public_tree_profile` (anon; Baum, eingewilligter Bauer, 30 veröffentlichte Ereignisse, letzte Pressung, Statistik — keine UIDs, keine Medienpfade), `tree_media_paths` (nur service_role), `can_upload_field_media` erlaubt Ordner `profile`
20. `20261102000200_my_assignments.sql`: `my_assignments()` (authenticated; eigene Baum-/Mühlenzuweisungen für das mobile Schnellformular)
21. `service_role_private_usage` (per MCP angewendet, inhaltlich Teil von 19): `grant usage on schema private to service_role` — ohne diesen Grant scheitert der Wrapper `public.tree_media_paths` für die Edge Function

22. `20261108000100_audit_run1_fixes.sql` (angewendet): Audit run-1 Teil A — `require_user` weist gesperrte Konten (`banned_until`) ab; `enqueue_email` mit 40 Mails/Empfänger/Stunde (Überschuss in `private.email_skipped` gezählt); Realtime-Publikation nur `insert, update`; `farmer_profiles` nur noch Owner-lesbar (anon-Grant entzogen); `public_tree_profile`/`tree_media_paths` mit `status = 'listed'`; `review_farmer_update` mit Pflichtfeld `decision` und Medien-Bindung an existierende Objekte; `request_oil` zählt unter dem Lock; `farmer_has_tree`/`operator_has_mill` ohne Execute für authenticated
23. `20261108000110_audit_run1_fixes_manual.sql` (**manuell im SQL-Editor**, enthält DELETE): `delete_my_account` löscht Öl-Kontakte, unveröffentlichte Feldberichte, GPS/Medien veröffentlichter Berichte und alle `field-media`-Objekte des Kontos, verweigert bei offenen Ölanfragen und für den letzten Admin; `prune_monitoring` räumt zusätzlich `cron.job_run_details` (7 Tage), fehlgeschlagene Outbox-Zeilen (30 Tage) und `email_skipped` (7 Tage)
24. `20261109000100_gifts_referrals.sql` (angewendet): `profiles.referral_code`, Tabellen `gifts` (nur Code-Hash + Hint), `referrals`, `reward_credits`, `private.request_extras`; RPCs `my_referral_code`, `attach_request_extras`, `create_gift`, `cancel_gift`, `redeem_gift` (Fehlversuche auditiert, 10/h), `my_gifts`; Trigger `shares_created_rewards` (Geschenk aus Checkout-Extras, Empfehlungs-Belohnung 250 ml je Seite, max. 20/Jahr) und `investment_requests_closed` (Referral → void)
25. `20261109000110_gifts_referrals_oil_wrappers.sql` (angewendet): `request_oil` verrechnet Gutschriften (`creditMl`), `cancel_oil_request`/`review_oil_request` geben sie zurück, `export_my_rewards`, `public`-Wrapper + Grants (deny-by-default)
26. `20261110000100_delete_account_rewards.sql` (**manuell im SQL-Editor**, enthält DELETE): `delete_my_account` entfernt eigene `reward_credits`, pseudonymisiert Gegenseiten-Zeilen in `gifts`/`referrals` (Nil-UUID), setzt offene Codes `cancelled` und `pending`-Referrals `void`, bereinigt `private.request_extras`
27. `20261110000200_storage_purge_queue.sql` (angewendet): `private.storage_purge_queue`, `private.enqueue_storage_purge`, service-role-RPCs `storage_purge_claim/mark`, Cron `faseela-purge-storage` → Edge Function `purge-storage`
28. `20261110000210_delete_account_storage_queue.sql` (**manuell im SQL-Editor**, enthält DELETE): `delete_my_account` reiht `field-media/<uid>/` in die Purge-Queue ein statt `storage.objects` direkt zu löschen (Supabase `storage.protect_delete`); sonst identisch zu 26
29. `20261110000300_payment_instructions.sql` (angewendet): `private.app_settings`, `payment_instructions()` (authenticated), `admin_set_payment_instructions` (admin, validiert, auditiert) — Empfangskonten für den Checkout statt hartkodierter Demo-Werte
30. `20261111000100_rate_limits.sql` (angewendet): `private.rate_limits` (unlogged), Vault-Secret `rate_salt`, `private.rate_limit()`, Limiter in 8 `public`-Wrappern, Cron `faseela-rate-limits-reset`
31. `20261111000200_payment_four_eyes.sql` (angewendet): `clean_payment_instructions`, `apply_payment_instructions`, Vorschlag/Freigabe (`admin_set_payment_instructions`, `admin_review_payment_instructions`, `admin_payment_state`), Benachrichtigungen
32. `20261112000100_screening_finance_export.sql` (angewendet): `private.payment_screenings`, `record_payment_screening`, `payment_screening_state`, Freigabe-Sperre in `review_investment_request` (`screening-required` / `screening-blocked`), `finance_export`
33. `20261113000100_push_notifications.sql` (angewendet): `private.push_tokens`, `private.push_outbox`, `enqueue_push`, `notify_user` speist zusätzlich die Push-Queue, `register_push_token` / `unregister_push_token` / `push_state`, `push_claim` / `push_mark` (service_role), Cron `faseela-send-push`
34. `20261113000110_push_token_format_fix.sql` (angewendet): Token-Längenprüfung über `char_length` statt Regex-Wiederholung (PostgreSQL erlaubt höchstens 255), `private.push_token_arg`
35. `20261113000120_push_feature_flag.sql` (angewendet): Schalter `push_enabled` in `private.app_settings`, `push_state()` meldet `enabled`, `register_push_token` verweigert bei „aus"
36. `20261114000100_admin_cockpit.sql` (angewendet): `admin_dashboard`, `admin_list_investments`, `admin_list_trees`, `admin_set_tree_status`, `admin_list_client_errors`, `admin_set_push_enabled`
37. `20261114000110_admin_cockpit_paging_fix.sql` (angewendet): Paging-Werte in `admin_list_investments` werden vor dem Cast geprüft
38. `20261115000100_admin_operations.sql` (angewendet): Betriebsfunktionen des Admin-Panels — `admin_create_tree`, `admin_update_tree`, `admin_get_tree`, `admin_user_detail` (Einsicht wird auditiert), `admin_list_shares` (Besitzregister, auch Finanz-Admin), `admin_list_outbox` (Empfänger maskiert), `admin_retry_email`; Helfer `opt_num`, `opt_int`, `tree_text`, `tree_images`
39. `20261115000110_tree_catalogue_text_fix.sql` (angewendet): Datenkorrektur der drei Startbäume (englische Namen/Sorten standen auf Arabisch, Regionen waren leer); ändert nur Zeilen mit dem fehlerhaften Wert, kein Bestand, kein Preis
40. `20261115000120_public_status_mail_unverified.sql` (angewendet): `public_status().email` meldet `unverified`, solange noch nie eine E-Mail zugestellt wurde (vorher fälschlich `ok`)
41. `20261116000100_admin_control_center.sql` (angewendet): Leitstand — Tabellen `automation_rules`, `automation_log`, `kpi_daily`, `readiness_manual`; `admin_tasks`, `admin_automation_state`, `admin_set_automation_rule`, `admin_set_job_active`, `admin_readiness`, `admin_set_readiness`, `admin_search`, `admin_kpi_history`; Jobs `faseela-automations` (stündlich) und `faseela-kpi-snapshot` (täglich 23:50 UTC)
42. `20261116000110_admin_tree_mill.sql` (angewendet): `admin_set_tree_mill`, `admin_get_tree_mill`
43. `20261116000120_launch_hardening.sql` (live angewendet, aus dem Live-Projekt übernommen): Reservierungsfrist 48 Stunden statt 30 Minuten (`create_investment_request` wird an Ort und Stelle umgeschrieben; bereits laufende Reservierungen behalten ihre Frist); `require_role` verlangt `aal2`, sobald das Konto einen bestätigten TOTP-Faktor hat (`mfa-required`; Nr. 56 definiert `require_role` neu und behält diese Regel); Regel-Einträge `purge_unconfirmed` und `weekly_digest` (beide aus)
44. `20261116000130_sister_crops.sql` (angewendet): vier Schwesterkulturen als Katalogeinträge `tree_12` (Pistazie), `tree_14` (Mandel), `tree_15` (Granatapfel), `tree_16` (Walnuss), alle `unlisted`, je 4 Anteile; Check auf `crop_category`.
45. `20261116000140_harvest_kg_and_digest.sql` (live angewendet, übernommen): gewogene Ernte für Nicht-Oliven (`submit_harvest_batch`; Zeile in `pressing_batches` mit `mill_id = 'farm'`, `olives_weight_kg` = Bruttogewicht, `oil_yield_liters` = Nettogewicht in kg; Zuteilung in **Gramm** im Feld `oil_allocations.liters_ml`); Pressung und Mühlen-Pflicht nur noch für Olivenbäume; `tree_13` (ausgeblendet); `run_housekeeping()` versendet den Wochenbericht (Vorlage `admin_digest`), Job `faseela-automations` ruft es stündlich mit auf. Die Regel `purge_unconfirmed` hat keinen Ausführer und bewirkt nichts.
46. `20261116000150_oil_request_by_crop.sql` (live angewendet, übernommen): `request_oil` lehnt Anfragen ab, die Olivenöl und gewogene Ernte mischen; Empfehlungs-Gutschriften (Öl) hängen nur an Ölanfragen
47. `20261116000160_oil_request_unit.sql` (live angewendet, übernommen): Spalte `oil_requests.unit` (`l`/`kg`), `private.oil_request_unit()`; `request_oil` und `review_oil_request` geben die Einheit an Antwort und Mails (`params.unit`) weiter
48. `20261116000165_crops_and_countries.sql` (live angewendet, übernommen): Kultur `date` (Dattelpalme); Spalte `trees_public.country` (Standard `SY`); `admin_set_tree_class`, `admin_get_tree_class`. Spalte und Funktionen werden durch Nr. 51 abgelöst.
49. `20261116000170_country_registry.sql` (live angewendet als `20261114173919`, aus der Live-Migrationstabelle übernommen): `private.countries` (`open`/`closed`), Trigger `trees_public_country_gate`, `admin_list_countries`, `admin_set_country`. Abgelöst durch Nr. 51 und Nr. 59.
50. `20261116000180_payment_channels_by_country.sql` (live angewendet als `20261114174814`, übernommen): `private.payment_channels_for(code)`; Empfangskonten können je Kanal `countries: ["SY", …]` tragen (ohne Angabe gilt der Kanal für alle Länder)
51. `20261117000050_country_column_bridge.sql` (**live offen**): Brücke zwischen dem Live-Stand (Nr. 48–50) und den Stammdaten (Nr. 55). `trees_public.country` wird zu `country_code` (Werte bleiben); `admin_set_tree_class`/`admin_get_tree_class`, `admin_list_countries`/`admin_set_country` und der alte Trigger entfallen. Jeder Schritt prüft vorher, die Datei läuft auch auf einer Datenbank ohne Nr. 48–50.
52. `20261117000100_date_crop.sql` (**live offen**): Kultur `date` im Check (auf live bereits durch Nr. 48 vorhanden), `admin_set_tree_crop`, `admin_get_tree_crop`
53. `20261117000200_land_offer_gate.sql` (**live offen**): Schalter `land_offer_enabled` (aus); `create_investment_request` und `admin_create_tree` lehnen die Parzellen-Option ab, solange er aus ist
54. `20261117000300_reviewer_independence.sql` (**live offen**): `assert_not_self_review` – Prüfer und Einreicher gelten 7 Tage lang nicht als unabhängig, nachdem einer dem anderen eine prüfende Rolle gegeben hat
55. `20261118000100_master_data.sql` (**live offen**): `public.currencies`, `public.countries` (`active`/`planned`; `SY` aktiv, `ES`, `IT`, `GR`, `TN`, `TR`, `MA` geplant), `public.farms`, `public.mills`, `trees_public.country_code` (Fremdschlüssel) und `farm_id`, `profiles.locale`; `admin_list_master_data`, `admin_set_country_status`, `admin_upsert_farm`, `admin_upsert_mill`, `admin_set_tree_origin`, `admin_get_tree_origin`, `set_my_locale`; Ländercodes von Bäumen, die in `public.countries` noch fehlen, werden vor dem Fremdschlüssel als `planned` angelegt (Name = Code, USD)
56. `20261118000200_staff_mfa_mill_fk.sql` (**live offen**): Schalter `staff_mfa_required` (aus), `require_role` neu definiert (die Regel aus Nr. 43 bleibt: ein bestätigter Faktor verlangt `aal2`), `staff_security_state`, `admin_set_staff_mfa`; `mill_assignments.mill_id` verweist auf `public.mills`
57. `20261119000100_marketplace_core.sql` (**live offen**): Hofladen (Produkte, Bestellungen, Versandtarife, Hof-Konto, Screening). Der Laden ist geschlossen, bis ein Admin `shop_open` setzt.
58. `20261120000100_consent_records.sql` (**live offen**): `private.consent_records`, `consent_versions` in `private.app_settings`, `record_consent`, `my_consents`, `consent_versions()`; eine Patenschaft wird ohne Zustimmung zur aktuellen Fassung mit `consent-required` abgelehnt
59. `20261121000100_country_model_unified.sql` (**live offen**): ein Ländermodell. `public.countries` ist das einzige Register; ein Baum lässt sich nur in einem aktiven Land einblenden (Trigger `trees_public_country_gate`, `failed-precondition`); `admin_set_country_status` aktiviert ein Land nur, wenn mindestens ein Empfangskonto es abdeckt („Add a receiving account for this country before activating it.“); Ländercodes der Empfangskonten werden gegen `public.countries` geprüft, gespeicherte Kanäle (aktuelle Einstellung und offener Vorschlag) werden repariert: das eigene Element vor jedem Kanal (`{}` oder `{"countries":[...]}`) entfällt, eine Länderbeschränkung kommt zurück auf ihren Kanal, unbekannte Codes einer Beschränkung werden geplante Länder; `private.countries` entfällt
60. `20261121000200_consent_version_reservation.sql` (**live offen**): Zustimmungsfassung `sponsorship` = `2026-11-22`, weil die Leistungsbeschreibung jetzt 48 Stunden Reservierungsfrist nennt
61. `20261121000300_harvest_unique.sql` (**live offen**): eine Ernte je Baum und Saison auch in der Datenbank: eindeutiger Teilindex `pressing_batches_one_harvest_per_season` (`mill_id = 'farm'`, `pending_review`/`certified`; bricht mit Liste ab, falls schon Doppelte existieren), Sperre in `submit_harvest_batch`, Eindeutigkeitsverletzung → `already-exists`

Hinweise zur Liste: „angewendet“ heißt: im Live-Projekt angewendet. Die Nummern sind die Reihenfolge der Dateinamen; maßgeblich ist der Dateiname. Die Kopfzeilen der Dateien ab `20261117…` zählen selbst noch einmal ab „migration 45“, weil sie ohne Kenntnis der sieben Live-Migrationen geschrieben wurden. Nr. 21 ist keine Datei; der Ordner enthält mit Nr. 61 also 60 Dateien. Sie laufen in Dateinamen-Reihenfolge auf einer leeren Datenbank durch (`npm run test:db:local`, 20 Suiten).

## Live-Rollout (Live rollout): offene Migrationen, Stand 22.11.2026

**Ausgangslage im Live-Projekt**

- Die sieben übernommenen Migrationen (Nr. 43 und 45–50: `launch_hardening`, `harvest_kg_and_digest`, `oil_request_by_crop`, `oil_request_unit`, `crops_and_countries`, `country_registry`, `payment_channels_by_country`) sind live bereits angewendet, dort aber unter **eigenen Versionsnummern** eingetragen (zum Beispiel `20261114173919` und `20261114174814`). Sie dürfen **nicht noch einmal angewendet** werden. In der Migrationshistorie werden die Repository-Versionen stattdessen als angewendet markiert: `supabase migration repair --status applied 20261116000120 20261116000140 20261116000150 20261116000160 20261116000165 20261116000170 20261116000180`. Vorher mit `supabase migration list` (oder `select version, name from supabase_migrations.schema_migrations order by version;`) prüfen, welche Versionen live eingetragen sind; ohne diesen Abgleich kein `supabase db push`, sondern die offenen Dateien einzeln anwenden.
- `pg_net` liegt live noch im Schema `public`: `20261026000240_pg_net_schema.sql` ist nicht angewendet (enthält `drop extension`, nur im SQL-Editor). Das ist ein eigener offener Punkt und nicht Teil der Liste unten.

**Zuerst ein Probelauf auf einem Supabase-Branch.** Branch vom Live-Projekt anlegen, die Liste unten in genau dieser Reihenfolge anwenden, `SUPABASE_DB_URL=<Branch> npm run test:db` ausführen, Checkout und Admin-Panel gegen den Branch prüfen. Erst danach live. [UNVERIFIZIERT: Branching setzt je nach Tarif den Pro-Plan voraus.]

**Reihenfolge (genau so, in einem Wartungsfenster):**

| # | Datei | Hinweis |
|---|---|---|
| 1 | `20261110000210_delete_account_storage_queue.sql` | **SQL-Editor**, enthält DELETE |
| 2 | `20261117000050_country_column_bridge.sql` | enthält `drop function`, `drop trigger`, `drop index`; blockiert der MCP-Weg das, im SQL-Editor ausführen. Ab hier bis Schritt 10 gibt es keine Ländersperre beim Einblenden: in dieser Zeit keine Bäume einblenden |
| 3 | `20261117000100_date_crop.sql` | |
| 4 | `20261117000200_land_offer_gate.sql` | |
| 5 | `20261117000300_reviewer_independence.sql` | |
| 6 | `20261118000100_master_data.sql` | |
| 7 | `20261118000200_staff_mfa_mill_fk.sql` | definiert `require_role` neu; die Faktor-Regel aus Nr. 43 bleibt |
| 8 | `20261119000100_marketplace_core.sql` | enthält DELETE-Anweisungen; blockiert der MCP-Weg das, im SQL-Editor ausführen. Laden bleibt geschlossen |
| 9 | `20261120000100_consent_records.sql` | ab hier verlangt jede Patenschaft eine gespeicherte Zustimmung |
| 10 | `20261121000100_country_model_unified.sql` | enthält `drop table private.countries`; blockiert der MCP-Weg das, im SQL-Editor ausführen |
| 11 | `20261121000200_consent_version_reservation.sql` | Fassung `sponsorship` = `2026-11-22` |
| 12 | `20261121000300_harvest_unique.sql` | vorher prüfen: `select tree_id, season_year, count(*) from public.pressing_batches where mill_id = 'farm' and status in ('pending_review','certified') group by 1, 2 having count(*) > 1;` muss leer sein |

**Direkt danach, im selben Fenster**

1. Web-App veröffentlichen (`npm run build:web && npm run build && firebase deploy --only hosting --project gen-lang-client-0319369264`). Sie muss `CONSENT_VERSIONS.sponsorship = '2026-11-22'` und `public/legal/patenschaft.html` mit `data-version="2026-11-22"` enthalten; passt die Fassung nicht zur Datenbank, endet der Checkout mit `consent-outdated`. Das Admin-Panel der alten Fassung ruft Funktionen auf, die Schritt 2 entfernt.
2. Edge Function `send-emails` neu ausrollen (`supabase functions deploy send-emails --no-verify-jwt`): Die Vorlagen kennen jetzt `admin_digest`, die Einheit kg (`params.unit`) und die 48 Stunden. Ohne die neue Fassung scheitert der Wochenbericht in der Outbox an der unbekannten Vorlage; die Regel `weekly_digest` deshalb erst danach einschalten.
3. Kontrolle: `select public.consent_versions();` liefert `sponsorship` = `2026-11-22`; `select code, status from public.countries order by code;` zeigt `SY` als `active`; `select to_regclass('private.countries');` liefert `null`; ein eingeblendeter Baum lässt sich weiter reservieren.
Edge Functions (alle deployt): `supabase/functions/purge-storage/index.ts` (v1, `verify_jwt=false`, `x-outbox-token`, löscht Präfixe per Storage-API), `supabase/functions/send-emails/index.ts` + `templates.ts` (v5, Outbox-Versand inkl. Templates `gift_*`, `referral_rewarded`, `payment_change_pending`, `payment_accounts_changed`, Outbox-Versand, `verify_jwt=false`, eigene Token-Prüfung), `supabase/functions/certificate/index.ts` (v1, PDF, `verify_jwt=true`), `supabase/functions/tree-media/index.ts` (v1, `verify_jwt=false`, signiert nur die Pfade, die `tree_media_paths` als öffentlich liefert; 1 h gültig, max. 30 Bilder, 5 min cacheable; Secret `APP_ORIGINS` optional).

Rückweg: `supabase/rollback/20261020_all_down.sql`. Das Skript löscht alle Faseela-Daten; nur für Dev/Staging oder einen fehlgeschlagenen Erst-Deploy verwenden.

## Go-Live-Checkliste

1. **Migrationen:** 16 von 18 angewendet (Stand 01.11.2026). Den Stand vom 22.11.2026 und die Reihenfolge der offenen Migrationen nennt der Abschnitt „Live-Rollout“ oben. Offen, beide im SQL-Editor ausführen: `20261026000210_monitoring_retention.sql` und `20261026000240_pg_net_schema.sql`.
1a. **E-Mail-Versand:** Dashboard → Edge Functions → `send-emails` → Secrets: `EMAIL_PROVIDER=brevo`, `EMAIL_API_KEY=<Brevo-Key>`, `EMAIL_FROM=Faseela <no-reply@<domain>>`, `APP_URL=https://<domain>`. Absenderdomain bei Brevo verifizieren (SPF/DKIM). Ohne Secrets bleiben Mails `pending` und der Systemstatus zeigt es an. [PLATZHALTER: AVV mit Brevo]
2. **Auth konfigurieren** (Dashboard → Authentication):
   - URL Configuration: Site-URL = Hosting-Domain. Redirect-URLs = `https://<domain>/**`, für lokale Tests `http://localhost:8099/**`, für die nativen Apps `faseela://app/**`.
   - Providers → Email: „Confirm email“ an, Passwort-Mindestlänge ≥ 10, „Leaked password protection“ an.
   - SMTP: eigener EU-Versanddienst. Der Standardversand ist stark limitiert und nur für Tests gedacht. [PLATZHALTER: Anbieter + AVV]
   - E-Mail-Vorlagen (AR/EN) aus `supabase/email-templates/` unter Authentication → Emails → Templates einfügen.
   - Optional Google: Client-ID und Secret aus der Google Cloud Console eintragen und die Supabase-Callback-URL dort hinterlegen.
3. **Ersten Admin setzen** (SQL-Editor, nach der Registrierung): `select private.admin_set_role('<admin-email>', 'admin');` — weitere Rollen danach im Admin-Pult der App.
4. **Hosting deployen:** `npm run build:web && npm run build && firebase deploy --only hosting --project gen-lang-client-0319369264`
5. **Testdaten prüfen:** E2E-Läufe hinterlassen Konten `@faseela.test` und `tree_e2e` (unlisted). Vor dem Launch entfernen:
   ```sql
   delete from public.shares where tree_id = 'tree_e2e';
   delete from public.transactions where request_id in (select id from public.investment_requests where tree_id = 'tree_e2e');
   delete from public.investment_requests where tree_id = 'tree_e2e';
   delete from public.trees_public where tree_id = 'tree_e2e';
   delete from auth.users where email like '%@faseela.test';
   ```
6. **Tarif:** Pro-Plan vor dem Launch. Free-Projekte pausieren nach Inaktivität und haben keine Point-in-Time-Recovery.
7. **Firebase:** Firestore, Storage und Functions im Firebase-Projekt bleiben ungenutzt. Billing ist nicht nötig.
