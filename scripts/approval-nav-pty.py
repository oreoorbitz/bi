"""approval-nav-pty.py — drive askApproval on a pty with grid snapshots.

Usage: approval-nav-pty.py <n_choices> <beats>
  beats: comma-separated of down,up,enter,esc,ctrlc,digit:N
Prints per-beat `STEP i <beat>: rows=a/b markers=m marked='<text>'`,
then `RESULT:<v|null|THREW:...> CODE:<c>`. Choices are
`choice-1..choice-N`; PROBE_CHOICES_JSON overrides. HOME from
DIAG_HOME (default /tmp/fakehome-approval-nav). Kitty query bursts
are answered like e2e-pty-spawn.py; the Screen emulator mirrors
paint-chain-pty.py (differential writes update cells, so a vanished
row reads back absent).
"""
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ROWS, COLS = 24, 100
N = int(sys.argv[1])
BEATS = sys.argv[2].split(",") if len(sys.argv) > 2 and sys.argv[2] else []
HOME = os.environ.get("DIAG_HOME", "/tmp/fakehome-approval-nav")
TIMEOUT = 60.0


class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.g = [[' '] * cols for _ in range(rows)]
        self.r, self.c = 0, 0
        self.top, self.bot = 0, rows - 1
        self.saved = (0, 0)
        self.wrap = False
        self.carry = b''

    def put(self, ch):
        if ch == '\r':
            self.c = 0
            self.wrap = False
        elif ch == '\n':
            self.wrap = False
            self.lf()
        elif ch == '\x07':
            pass
        else:
            if self.wrap:
                self.wrap = False
                self.c = 0
                self.lf()
            if self.c < self.cols:
                self.g[self.r][self.c] = ch
                self.c += 1
            if self.c >= self.cols:
                self.wrap = True

    def lf(self):
        if self.r == self.bot:
            del self.g[self.top]
            self.g.insert(self.bot, [' '] * self.cols)
        else:
            self.r = min(self.r + 1, self.rows - 1)

    def csi(self, params, final):
        self.wrap = False
        ps = params.decode().lstrip('?') if params else ''
        p = [int(x) for x in ps.split(';') if x.isdigit()]
        n = lambda d: p[0] if p else d
        if final == 'H' or final == 'f':
            r = (p[0] - 1) if len(p) > 0 and p[0] else 0
            c = (p[1] - 1) if len(p) > 1 and p[1] else 0
            self.r = min(max(r, 0), self.rows - 1)
            self.c = min(max(c, 0), self.cols - 1)
        elif final == 'A':
            self.r = max(self.r - n(1), 0)
        elif final == 'B':
            self.r = min(self.r + n(1), self.rows - 1)
        elif final == 'C':
            self.c = min(self.c + n(1), self.cols - 1)
        elif final == 'D':
            self.c = max(self.c - n(1), 0)
        elif final == 'G':
            self.c = min(max(n(1) - 1, 0), self.cols - 1)
        elif final == 'K':
            m = p[0] if p else 0
            if m == 0:
                self.g[self.r][self.c:] = [' '] * (self.cols - self.c)
            elif m == 1:
                self.g[self.r][:self.c + 1] = [' '] * (self.c + 1)
            elif m == 2:
                self.g[self.r] = [' '] * self.cols
        elif final == 'J':
            m = p[0] if p else 0
            if m == 2:
                self.g = [[' '] * self.cols for _ in range(self.rows)]
        elif final == 'r':
            if len(p) >= 2 and p[0] and p[1]:
                self.top, self.bot = p[0] - 1, p[1] - 1
            else:
                self.top, self.bot = 0, self.rows - 1
        elif final == 's':
            self.saved = (self.r, self.c)
        elif final == 'u':
            self.r, self.c = self.saved

    def feed(self, raw):
        raw = (self.carry + raw) if self.carry else raw
        self.carry = b''
        k = len(raw)
        if k and raw[k - 1] >= 0x80:
            j = k
            while j > 0 and raw[j - 1] & 0xC0 == 0x80:
                j -= 1
            if j == 0:
                self.carry = raw
                raw = b''
            else:
                lead = raw[j - 1]
                need = 1 if lead < 0x80 else (2 if lead < 0xE0 else (3 if lead < 0xF0 else 4))
                if len(raw) - (j - 1) < need:
                    self.carry = raw[j - 1:]
                    raw = raw[:j - 1]
        if not self.carry:
            m = re.search(b'\\x1b(\\[[0-9;:<=>? !\\"#$%&\'()*+,\\-./]*|\\][^\\x07]*|_[^\\x07]*|\\\\)?$', raw)
            if m:
                self.carry = raw[m.start():]
                raw = raw[:m.start()]
        text = raw.decode('utf-8', 'replace')
        pat = re.compile('\\x1b\\[([0-9;:<=>? !\\"#$%&\'()*+,\\-./]*)([a-zA-Z\\\\])')
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            nxt = text[i + 1:i + 2]
            if ch == '\x1b' and nxt == '[':
                m = pat.match(text, i)
                if m:
                    self.csi(m.group(1).encode(), m.group(2))
                    i = m.end()
                    continue
                i += 2
                continue
            elif ch == '\x1b' and nxt in (']', '_'):
                j = text.find('\x07', i)
                i = j + 1 if j != -1 else n
                continue
            elif ch == '\x1b':
                i += 2
                continue
            else:
                self.put(ch)
                i += 1

    def row(self, r):
        return ''.join(self.g[r]).rstrip()


def choice_rows(scr):
    return [(r, scr.row(r)) for r in range(scr.rows) if re.search(r'\d\.\s+choice-', scr.row(r))]


def marked(rows):
    return [(r, t) for (r, t) in rows if re.match(r'\s*>\s*\d\.', t)]


def beat_key(b):
    if b == "down":
        return b"\x1b[B"
    if b == "up":
        return b"\x1b[A"
    if b == "enter":
        return b"\r"
    if b == "esc":
        return b"\x1b"
    if b == "ctrlc":
        return b"\x03"
    if b.startswith("digit:"):
        return b[6:].encode()
    raise SystemExit(f"unknown beat {b!r}")


os.makedirs(os.path.join(HOME, ".bi", "sessions"), exist_ok=True)
pid, fd = pty.fork()
if pid == 0:
    os.environ["HOME"] = HOME
    os.environ["TERM"] = "xterm-kitty"
    os.execvp("node", ["node", os.environ["PROBE_JS"]])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
os.set_blocking(fd, False)

scr = Screen(ROWS, COLS)
out = b""
seen = b""
pending = []
t0 = time.monotonic()
deadline = t0 + TIMEOUT
labels = [f"choice-{i+1}".encode() for i in range(N)]
alive = True


def pump(wait_s):
    global out, seen, alive
    end = time.monotonic() + wait_s
    while time.monotonic() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        now = time.monotonic()
        while pending and now - pending[0][1] >= 0.03:
            rp = pending.pop(0)[0]
            try:
                os.write(fd, rp)
            except OSError:
                pass
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                alive = False
                return
            if not chunk:
                alive = False
                return
            out += chunk
            seen += chunk
            scr.feed(chunk)
            for q, rp in [(b'\x1b[c', b'\x1b[?64;1;2;4;6;17;18;21;22;52c'),
                          (b'[?u', b'\x1b[?7u')]:
                j = seen.find(q)
                if j != -1:
                    seen = seen[:j] + seen[j + len(q):]
                    pending.append((rp, now))


while time.monotonic() < deadline:
    pump(0.2)
    if not alive:
        break
    if all(l in out for l in labels) and len(choice_rows(scr)) == N:
        break
else:
    print(f"OPEN-FAIL rows={len(choice_rows(scr))}/{N}")
print(f"OPEN rows={len(choice_rows(scr))}/{N}")
# Mount settle: the modal paints before focus + kitty settle complete;
# keys sent into that window are swallowed (no focused component yet).
# Production humans can't type that fast; the drill must not either.
pump(1.0)

for i, b in enumerate(BEATS):
    try:
        os.write(fd, beat_key(b))
    except OSError:
        pass
    pump(0.6)
    rows = choice_rows(scr)
    mk = marked(rows)
    print(f"STEP {i} {b}: rows={len(rows)}/{N} markers={len(mk)} marked={mk[0][1].strip() if mk else None}")

end = time.monotonic() + 8
code = None
while time.monotonic() < end and code is None:
    pump(0.2)
    try:
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            code = os.waitstatus_to_exitcode(st)
    except ChildProcessError:
        code = "gone"
        break
if code is None:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    code = "killed"
m = re.search(rb"RESULT:(null|\d+)", out)
t = re.search(rb"THREW:([^\r\n]*)", out)
print(f"RESULT:{m.group(1).decode() if m else ('THREW:' + t.group(1).decode() if t else None)}")
print(f"CODE:{code}")
