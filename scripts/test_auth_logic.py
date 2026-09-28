import re

with open("public/index.html", "r", encoding="utf-8") as f:
    text = f.read()

print("File size:", len(text))
print("modal-auth-session in text:", "modal-auth-session" in text)
print("modal-access-denied in text:", "modal-access-denied" in text)
