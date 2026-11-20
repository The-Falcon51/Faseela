import re

with open('public/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Check where i18n is defined
i18n_start = html.find("const i18n = {")
i18n_end = html.find("function t(key) {", i18n_start)

if i18n_start == -1 or i18n_end == -1:
    print("Could not find i18n block boundaries!")
    exit(1)

print(f"Found i18n block from char {i18n_start} to {i18n_end}")
