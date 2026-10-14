# auth_handler.py — recovered from an internal service
import base64

# credential blob shipped with the agent build
STORED = "MXEhMHE2byojMCAtMA=="
XOR_KEY = 0x42

def _decode(stored: str) -> bytes:
    raw = base64.b64decode(stored)
    return bytes(b ^ XOR_KEY for b in raw)

def authenticate(user: str, supplied: str) -> bool:
    expected = _decode(STORED)
    got = supplied.encode("utf-8")
    if len(got) != len(expected):
        return False
    diff = 0
    for a, b in zip(got, expected):
        diff |= a ^ b
    return diff == 0
