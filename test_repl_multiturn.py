#!/usr/bin/env python3
"""
PTY multi-turn test for codex provider.
Sends 3 simple messages and verifies each gets a response.
"""
import pexpect, sys, time, os

NODE = "/home/bjerome/.nvm/versions/node/v20.20.0/bin/node"
BIN  = "/home/bjerome/projects/ai/epam-cli/dist/epam.js"
TIMEOUT = 30

env = os.environ.copy()
env["EPAM_DANGEROUS_SKIP_APPROVAL"] = "1"
env["NO_COLOR"] = "1"          # disable chalk ANSI codes so patterns match cleanly
env["FORCE_COLOR"] = "0"

cmd = f"{NODE} {BIN} chat --provider codex"
print(f"CMD: {cmd}\n")

child = pexpect.spawn(cmd, env=env, encoding='utf-8', timeout=TIMEOUT)
child.logfile_read = sys.stdout

results = []
PROMPT_PAT = [r'epam \[', r'tokens\]', pexpect.EOF, pexpect.TIMEOUT]

def expect_prompt(label, timeout=20):
    """Wait for the REPL input prompt."""
    idx = child.expect(PROMPT_PAT, timeout=timeout)
    if idx >= 2:
        print(f"\n[{label}] No prompt (idx={idx})")
        return False
    return True

def send_and_wait(label, msg, timeout=TIMEOUT):
    """Send a message and wait for the NEXT prompt (= response received)."""
    t0 = time.time()
    print(f"\n{'='*50}")
    print(f"[{label}] Sending: {msg!r}")
    print(f"{'='*50}")
    child.sendline(msg)
    # Match token usage line to detect response done
    idx = child.expect([r'tokens\]', pexpect.EOF, pexpect.TIMEOUT], timeout=timeout)
    elapsed = time.time() - t0
    if idx > 0:
        print(f"\n[{label}] TIMEOUT/EOF after {elapsed:.1f}s")
        results.append((label, elapsed, 'HANG'))
        return False
    print(f"\n[{label}] ✓ Response in {elapsed:.1f}s")
    results.append((label, elapsed, 'OK'))
    # Consume the next `epam [` prompt so next send_and_wait starts fresh
    try:
        child.expect([r'epam \[', pexpect.TIMEOUT], timeout=5)
    except Exception:
        pass
    return True

# Wait for initial prompt
if not expect_prompt("INIT", timeout=20):
    print("Failed to get initial prompt")
    sys.exit(1)

# Turn 1 — already at prompt, send immediately
ok1 = send_and_wait("T1", "Reply with exactly one word: ALPHA")
ok2 = send_and_wait("T2", "Reply with exactly one word: BETA") if ok1 else False
ok3 = send_and_wait("T3", "Reply with exactly one word: GAMMA") if ok2 else False

try:
    child.sendline("/exit")
    child.expect(pexpect.EOF, timeout=5)
except:
    pass
child.close()

print("\n" + "="*60)
print("RESULTS:")
for label, elapsed, status in results:
    icon = "✓" if status == "OK" else "✗"
    print(f"  {icon} {label}: {elapsed:.1f}s — {status}")

all_ok = all(s == "OK" for _, _, s in results) and len(results) == 3
print(f"\n{'ALL PASS ✓' if all_ok else 'FAILURES ✗'}")
sys.exit(0 if all_ok else 1)
