"""paint-chain-pty.py — drive trust->picker->editor on a kitty-replying pty,
emulate the final grid, print one GEOM line. Invoked by paint-chain.mjs.
Usage: paint-chain-pty.py <rows> <cols> <home-dir> <cli-path>
Beats are timed (transport-friendly): trust accept, session pick, quit x2.
PC_REPLY_ON='<marker>' (bi#183): hold negotiation replies until the marker
bytes appear in the child's output (e.g. 'bi[0]>' = editor mounted), then
deliver them with the adversarial options — a split reply whose tail lands
after focus is the junk-glyph straggler class (proposals/14).
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

ROWS, COLS, HOME, CLI = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
TIMEOUT = float(os.environ.get('PC_TIMEOUT', '60'))


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
        # Lazy (pending) wrap: full-width print arms it; it executes on
        # the next printable char, while \r / \n discard it.
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
            self.r = max(self.r - n(1), self.top if False else 0)
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
        # Reads can split an escape OR a multibyte char across feed()
        # calls (pty trickle): carry a trailing partial sequence into the
        # next feed instead of leaking its bytes as text cells (once
        # faked residue rows) or replacement chars (column drift).
        raw = (self.carry + raw) if self.carry else raw
        self.carry = b''
        # Incomplete trailing UTF-8 takes precedence (ESC is ASCII, so a
        # tail can only be one kind of partial, whichever starts first).
        # This must also catch a trailing LEAD byte (split right after
        # it leaves zero continuation bytes behind).
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
            m = re.search(b'\x1b(\\[[0-9;:<=>? !\"#$%&\'()*+,\\-./]*|\\][^\x07]*|_[^\x07]*|\\\\?)$', raw)
            if m:
                self.carry = raw[m.start():]
                raw = raw[:m.start()]
        text = raw.decode('utf-8', 'replace')
        # Full CSI grammar (params + intermediates): kitty sequences
        # like \x1b[>1u (flags push) must not leak as text cells.
        pat = re.compile('\x1b\[([0-9;:<=>? !\"#$%&\'()*+,\\-./]*)([a-zA-Z\\\\])')
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
                # OSC (]) and APC (_) both terminate with BEL here; the
                # hardware cursor marker (\x1b_pi:c\x07) must never leak
                # as text cells (it once faked a lone-dash residue row).
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


def interior_text(row):
    """Editor-interior text minus bi#181 chrome: the rounded box's │
    side bars and the `>` prompt glyph at column 2 are frame, not buffer
    content — strip them so input= asserts measure the BUFFER."""
    t = row.strip()
    if t.startswith('│'):
        t = t[1:]
    if t.endswith('│'):
        t = t[:-1]
    t = t.strip()
    if t.startswith('>'):
        t = t[1:].lstrip()
    return t


pid, fd = pty.fork()
if pid == 0:
    os.environ['HOME'] = HOME
    os.environ['TERM'] = 'xterm-kitty'
    os.execvp('node', ['node', CLI])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
os.set_blocking(fd, False)

out = b''
scr = Screen(ROWS, COLS)
shot = None  # grid snapshot while the editor is still open (quit clears it)
code = 3
beats = [(4, b'\r'), (10, b'1\r'), (36, b'/quit\r'), (42, b'/quit\r')]
junk = os.environ.get('PC_JUNK', '')
if junk and ':' in junk:
    jb, jt = junk.rsplit(':', 1)
    beats.append((float(jt), jb.encode()))
    beats.sort()
t0, bi, seen = time.time(), 0, b''
last_byte_at = t0
shots = []
adv = {
    'delay': float(os.environ.get('PC_REPLY_DELAY', '0.03')),
    'split': os.environ.get('PC_SPLIT', '0') == '1',
    'gap': float(os.environ.get('PC_SPLIT_GAP', '0.12')),
    'bytewise': os.environ.get('PC_BYTEWISE', '0') == '1',
}
bg = os.environ.get('PC_BYTE_GAP', '')
bgap = [float(x) for x in bg.split(',')] if bg else [0.005, 0.03]
reply_on = os.environ.get('PC_REPLY_ON', '').encode()
armed = reply_on == b''
armed_at = 0.0
pending = []  # (reply bytes, queued at) — delivered once armed + delay
replies_sent = 0
while time.time() - t0 < TIMEOUT:
    while bi < len(beats) and time.time() - t0 >= beats[bi][0]:
        try:
            os.write(fd, beats[bi][1])
        except OSError:
            pass
        bi += 1
    if not armed and reply_on in out:
        armed = True
        armed_at = time.time()
    # Delay is measured from ARMING, not queueing: queries seen at the
    # first modal would otherwise be answered the instant the marker
    # paints, landing in the stdin-paused settle window and coalescing
    # into whole (harmless) replies in the kernel buffer.
    while pending and armed and time.time() - max(pending[0][1], armed_at) >= adv['delay']:
        rp = pending.pop(0)[0]
        replies_sent += 1
        try:
            if adv['bytewise']:
                import random as _r
                for byte in [rp[i:i + 1] for i in range(len(rp))]:
                    os.write(fd, byte)
                    time.sleep(_r.uniform(*bgap))
            elif adv['split'] and len(rp) > 4:
                os.write(fd, rp[:4])
                time.sleep(adv['gap'])
                os.write(fd, rp[4:])
            else:
                os.write(fd, rp)
        except OSError:
            pass
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        seen += chunk
        last_byte_at = time.time()
        scr.feed(chunk)
        for q, rp in [(b'\x1b[c', b'\x1b[?64;1;2;4;6;17;18;21;22;52c'),
                      (b'\x1b[?u', b'\x1b[?7u')]:
            j = seen.find(q)
            if j != -1:
                seen = seen[:j] + seen[j + len(q):]
                pending.append((rp, time.time()))
    if out.count(b'bi[0]>') >= 1 and time.time() - t0 > 18 and time.time() - last_byte_at > 2.5:
        # Snapshot a QUIET screen only, then demand stability: internal
        # timer-driven renders (async autocomplete open/close) emit no
        # pty bytes, so silence alone cannot prove settledness. Take up
        # to 4 shots 3s apart; a flickering interior means a transient
        # popup shell, a stable non-empty interior means real residue.
        cur = [list(row) for row in scr.g]
        shots.append(cur)
        last_byte_at = time.time()  # force 2.5s spacing between shots
        if shot is None:
            # Verdict comes from the FIRST quiet shot (idle editor). Later
            # shots may catch /quit teardown repaints; they stay in seq=
            # for diagnostics only.
            shot = cur
            shot_at_bytes = len(out)
    if bi >= len(beats) and out.count(b'session kept') >= 1:
        break
try:
    _, status = os.waitpid(pid, os.WNOHANG)
    if _ == 0:
        time.sleep(2)
        try:
            _, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            status = 0
        if _ == 0:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
            _, status = os.waitpid(pid, 0)
    import os as _os
    code = _os.waitstatus_to_exitcode(status)
except ChildProcessError:
    code = 0
try:
    os.close(fd)
except OSError:
    pass
interiors = []
for sh in shots:
    g = [''.join(sh[r]).rstrip() for r in range(ROWS)]
    pr = [r + 1 for r in range(ROWS) if 'bi[0]>' in g[r]]
    bx = [r + 1 for r in range(ROWS) if g[r].count('─') > 20]
    inn = ''
    if len(bx) >= 2:
        for r in range(bx[-2], bx[-1] - 1):
            t = interior_text(g[r])
            if t:
                inn = t[:40]
                break
    interiors.append(f'{pr}/{bx[-2:-1]}/{inn!r}')
if os.environ.get('PROBE_RAW'):
    open(os.environ['PROBE_RAW'], 'wb').write(out)
    print(f'SHOTAT {shot_at_bytes if shot is not None else -1} of {len(out)}')
grid = [''.join(shot[r]).rstrip() if shot else scr.row(r) for r in range(ROWS)]
prompt = [r + 1 for r in range(ROWS) if 'bi[0]>' in grid[r]]
box = [r + 1 for r in range(ROWS) if grid[r].count('─') > 20]
# The editor box is the LAST dash-row pair on the grid (bi#180's welcome
# box also has dash borders; it sits above in scrollback).
ebox = box[-2] if len(box) >= 2 else (box[0] if box else None)
gap = (ebox - prompt[-1] - 1) if prompt and ebox else -99
inner = ''
row1 = ''
if ebox:
    row1 = grid[ebox][:40]  # 0-based: first interior row, chrome intact
    for r in range(ebox, ROWS):
        if grid[r].count('─') > 20:
            break
        t = interior_text(grid[r])
        if t:
            inner = t[:40]
            break
print(f'GEOM prompt={prompt} boxtop={ebox} gap={gap} '
      f'foot1={grid[ROWS - 2][:60]!r} foot2={grid[ROWS - 1][:60]!r} code={code} '
      f'input={inner[:40]!r} row1={row1!r} shots={len(shots)} seq={interiors!r} replies={replies_sent}')
if os.environ.get('PC_DUMP_GRID'):
    # The quiet-snapshot grid (post-modal scrollback), one GRID| line per
    # row — drills assert frame survival (bi#180) against this, not the
    # byte stream (modal repaints erase rows from the stream, not the
    # screen).
    for r in range(ROWS):
        print(f'GRID|{grid[r]}')
