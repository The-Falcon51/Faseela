import re
import json

print("Starting complete bilingual build...")

with open("public/index.html", "r", encoding="utf-8") as f:
    content = f.read()

# Verify markers
print("File loaded. Length:", len(content))
