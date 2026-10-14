# dropper.py — staged config loader (captured sample, defanged)
import base64

CFG = "aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXlsb2Fk"

def cfg_url() -> str:
    return base64.b64decode(CFG).decode("utf-8")

def drop():
    u = cfg_url()
    # stage-2 fetch removed for the sample; the URL is the artifact of interest
    return u
