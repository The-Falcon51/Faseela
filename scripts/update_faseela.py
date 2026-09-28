import re

# Read index.html
with open('public/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Verify no AI terms before starting
forbidden = ['الذكاء الاصطناعي', 'ذكاء اصطناعي']
for term in forbidden:
    if term in content:
        raise ValueError(f"Found forbidden term: {term}")

print("Initial check: No forbidden AI terms found.")
