# Supabase Auth E-Mail-Vorlagen (AR/EN)

Einfügen unter **Authentication → Emails → Templates** (je Vorlage: Subject + Body „Source“):

| Vorlage | Datei | Betreff (Vorschlag) |
|---|---|---|
| Confirm signup | `confirm-signup.html` | `تأكيد بريدك الإلكتروني · Confirm your Faseela e-mail` |
| Reset password | `recovery.html` | `إعادة تعيين كلمة المرور · Reset your Faseela password` |
| Magic link | `magic-link.html` | `رابط تسجيل الدخول · Your Faseela sign-in link` |
| Change email address | `email-change.html` | `تأكيد البريد الجديد · Confirm your new e-mail` |

Platzhalter wie `{{ .ConfirmationURL }}`, `{{ .SiteURL }}`, `{{ .NewEmail }}` füllt Supabase. Die Fußzeile enthält
`[PLATZHALTER: Betreiber, Anschrift]`, der vor dem Launch ersetzt werden muss (Impressumspflicht in E-Mails).

Versand: Für den Launch einen eigenen SMTP-Anbieter in der EU eintragen (Authentication → Emails → SMTP Settings);
der Supabase-Standardversand ist auf wenige Mails pro Stunde begrenzt. [PLATZHALTER: Anbieter + AVV]
