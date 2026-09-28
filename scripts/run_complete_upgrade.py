import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Expand i18n block
with open('update_platform.py', 'r', encoding='utf-8') as f:
    platform_code = f.read()

m = re.search(r'(const i18n = \{[\s\S]+?\n    \};)', platform_code)
if not m:
    print("Failed to extract expanded i18n dictionary!")
    exit(1)

expanded_i18n = m.group(1)

# Replace old i18n in html
old_i18n_regex = r'const i18n = \{[\s\S]+?\n    \};\s*\n\s*function t\(key\)'
match = re.search(old_i18n_regex, html)
if not match:
    print("Could not find old i18n in html!")
    exit(1)

html = html[:match.start()] + expanded_i18n + "\n\n    function t(key)" + html[match.end() - len("function t(key)"):]
print("i18n dictionary successfully replaced!")

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(html)
