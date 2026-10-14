# framing.py — captured device link protocol, sender side
MAGIC = b"REA1"

def _checksum(msg: bytes) -> int:
    cs = 0
    for b in msg:
        cs = ((cs << 1) | (cs >> 7)) & 0xFF  # rotate left
        cs = (cs + b) & 0xFF
    return cs

def encode(msg: bytes) -> bytes:
    frame = bytearray()
    frame += MAGIC
    frame += len(msg).to_bytes(2, "big")
    frame += msg
    frame += _checksum(msg).to_bytes(1, "big")
    return bytes(frame)

def decode(buf: bytes):
    if buf[:4] != MAGIC:
        raise ValueError("bad magic")
    n = int.from_bytes(buf[4:6], "big")
    msg = buf[6:6 + n]
    if len(msg) != n:
        raise ValueError("truncated")
    if _checksum(msg) != buf[6 + n]:
        raise ValueError("bad checksum")
    return msg
