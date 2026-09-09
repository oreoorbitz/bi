"""paint-chain-pty.py — drive trust->picker->editor on a kitty-replying pty,
emulate the final grid, print one GEOM line. Invoked by paint-chain.mjs.
Usage: paint-chain-pty.py <rows> <cols> <home-dir> <cli-path>
Beats are timed (transport-friendly): trust accept, session pick, quit x2.
PC_REPLY_ON='<marker>' (bi#183): hold negotiation replies until the marker
bytes appear in the child's output (e.g. 'bi>' = editor mounted), then
deliver them with the adversarial options — a split reply whose tail lands
after focus is the junk-glyph straggler class (proposals/14).
"""

# bi#201: the footer prompt label is plain `bi>` (was `bi[N]>`). Both
# spellings count as "the prompt painted" so pre-201 recordings and
# drills keep working through the transition.
def _has_prompt(data):
    if isinstance(data, (bytes, bytearray)):
        return b'bi>' in data or b'bi[0]>' in data
    return 'bi>' in data or 'bi[0]>' in data
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
# bi#192: scripted scenarios replace the paint-chain beats outright.
# Each PC_BEATS entry is `WHEN:keys` (python escapes) where WHEN is an
# absolute time (`6:...`) or a marker gate (`@marker+N:...` — fire N
# seconds after `marker` first appears in the child's output; N
# defaults to 0). Gated beats fire IN LIST ORDER (a beat waits for all
# earlier beats), so boot-delay flakes disappear: keys land relative
# to observed paint, never wall-clock. Markers/keys must avoid literal
# ',' (entry separator) and markers must avoid ':'. The kitty reply
# machinery is untouched. PC_SNAP_AT takes the same WHEN forms for
# timed snapshots (SNAP lines at the end). Neither is set by
# paint-chain.mjs, so its geometry pins are unaffected.
def _parse_when(spec):
    if spec.startswith('@'):
        _body = spec[1:]
        if '+' in _body:
            _mk, _, _dl = _body.rpartition('+')
            return ('gate', _mk, float(_dl))
        return ('gate', _body, 0.0)
    return ('abs', float(spec), 0.0)


def _parse_keys(s):
    return s.encode().decode('unicode_escape').encode('latin-1')


beats = [
    {'when': ('abs', 4.0, 0.0), 'keys': b'\r', 'fired': False, 'seen_at': None},
    {'when': ('abs', 10.0, 0.0), 'keys': b'1\r', 'fired': False, 'seen_at': None},
    {'when': ('abs', 36.0, 0.0), 'keys': b'/quit\r', 'fired': False, 'seen_at': None},
    {'when': ('abs', 42.0, 0.0), 'keys': b'/quit\r', 'fired': False, 'seen_at': None},
]
_custom = os.environ.get('PC_BEATS', '')
if _custom:
    beats = []
    for _part in _custom.split(','):
        _w, _, _keys = _part.partition(':')
        beats.append({'when': _parse_when(_w), 'keys': _parse_keys(_keys), 'fired': False, 'seen_at': None})
_snaps_at = []
for _part in os.environ.get('PC_SNAP_AT', '').split(','):
    if not _part.strip():
        continue
    _w, _, _tag = _part.partition(':')
    _snaps_at.append({'when': _parse_when(_w), 'tag': _tag, 'done': False, 'seen_at': None})


def _due(entry, now):
    kind = entry['when'][0]
    if kind == 'abs':
        return now - t0 >= entry['when'][1]
    _mk, _dl = entry['when'][1], entry['when'][2]
    if entry['seen_at'] is None and _mk.encode() in out:
        entry['seen_at'] = now
    return entry['seen_at'] is not None and now - entry['seen_at'] >= _dl


snaps = []
junk = os.environ.get('PC_JUNK', '')
if junk and ':' in junk:
    jb, jt = junk.rsplit(':', 1)
    beats.append({'when': ('abs', float(jt), 0.0), 'keys': jb.encode(), 'fired': False, 'seen_at': None})
_now = time.monotonic  # bi#192: monotonic — wall-clock jumps (naps/NTP) must never fast-forward beats, snaps, or the exit grace
t0, seen = _now(), b''
_final_status = None  # reaped child status (loop break source of truth)
_kept_at = None  # first sighting of `session kept` (post-kept linger)
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
while _now() - t0 < TIMEOUT:
    # bi#192: beats fire in list order — a gated beat waits for every
    # earlier beat, so one slow modal cannot reorder the script.
    for _b in beats:
        if _b['fired']:
            continue
        if _due(_b, _now()):
            try:
                os.write(fd, _b['keys'])
            except OSError:
                pass
            _b['fired'] = True
        break
    if not armed and reply_on in out:
        armed = True
        armed_at = _now()
    # Delay is measured from ARMING, not queueing: queries seen at the
    # first modal would otherwise be answered the instant the marker
    # paints, landing in the stdin-paused settle window and coalescing
    # into whole (harmless) replies in the kernel buffer.
    while pending and armed and _now() - max(pending[0][1], armed_at) >= adv['delay']:
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
        last_byte_at = _now()
        scr.feed(chunk)
        for q, rp in [(b'\x1b[c', b'\x1b[?64;1;2;4;6;17;18;21;22;52c'),
                      (b'\x1b[?u', b'\x1b[?7u')]:
            j = seen.find(q)
            if j != -1:
                seen = seen[:j] + seen[j + len(q):]
                pending.append((rp, _now()))
    for _s in _snaps_at:
        if not _s['done'] and _due(_s, _now()):
            _s['done'] = True
            snaps.append((_s['tag'], [list(row) for row in scr.g]))
    if _has_prompt(out) and _now() - t0 > 18 and _now() - last_byte_at > 2.5:
        # Snapshot a QUIET screen only, then demand stability: internal
        # timer-driven renders (async autocomplete open/close) emit no
        # pty bytes, so silence alone cannot prove settledness. Take up
        # to 4 shots 3s apart; a flickering interior means a transient
        # popup shell, a stable non-empty interior means real residue.
        cur = [list(row) for row in scr.g]
        shots.append(cur)
        last_byte_at = _now()  # force 2.5s spacing between shots
        if shot is None:
            # Verdict comes from the FIRST quiet shot (idle editor). Later
            # shots may catch /quit teardown repaints; they stay in seq=
            # for diagnostics only.
            shot = cur
            shot_at_bytes = len(out)
    # bi#192: teardown needs the transport AFTER `session kept` — the
    # app's shutdown handshake (kitty pop/negotiation teardown) awaits
    # query replies, so breaking out instantly starves it and the exit
    # hangs intermittently (load widens the race). Linger servicing up
    # to 15s past kept, and reap promptly whenever the child is gone
    # (crash or clean) so `code` is the true status, not a stale kill.
    if _final_status is None:
        try:
            _wp, _wst = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            _wp, _wst = pid, 0
        if _wp != 0:
            _final_status = _wst
            break
    if all(_b['fired'] for _b in beats) and out.count(b'session kept') >= 1:
        if _kept_at is None:
            _kept_at = _now()
        if _now() - _kept_at >= 15:
            break
import os as _os
import subprocess as _sp
try:
    if _final_status is not None:
        # The loop already reaped the child (clean exit or crash) —
        # its true status stands, no grace poll, no kill.
        code = _os.waitstatus_to_exitcode(_final_status)
    else:
        # bi#192: loaded machines need more than a breath to tear down
        # node after `session kept` — poll up to 20s and report the lag
        # instead of racing a kill (a false code=-9 says nothing;
        # EXITLAG/EXITCPU name it).
        _lag_t0 = _now()
        _, status = os.waitpid(pid, os.WNOHANG)
        _cpu = []
        while _ == 0 and _now() - _lag_t0 < 20:
            time.sleep(0.5)
            try:
                _ps = _sp.run(['ps', '-o', '%cpu=', '-p', str(pid)], capture_output=True, text=True, timeout=5)
                _cpu.append(float((_ps.stdout or '0').strip() or 0))
            except Exception:
                pass
            try:
                _, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                status = 0
                _ = 1
        if _cpu:
            print(f'EXITCPU max={max(_cpu):.1f}% samples={len(_cpu)}')
        _lag = round(_now() - _lag_t0, 1)
        if _ == 0:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
            _, status = os.waitpid(pid, 0)
            print(f'EXITLAG killed-after-{_lag}s')
        elif _lag >= 2.0:
            print(f'EXITLAG clean-after-{_lag}s')
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
    pr = [r + 1 for r in range(ROWS) if _has_prompt(g[r])]
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
prompt = [r + 1 for r in range(ROWS) if _has_prompt(grid[r])]
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
# bi#192: undelivered beats / missed snapshots fail loudly with names,
# not a bare timeout kill (a gated marker that never paints is a dead
# script, and code=-9 alone says nothing about which step stuck).
_unfired = [i for i, _b in enumerate(beats) if not _b['fired']]
_unsnapped = [_s['tag'] for _s in _snaps_at if not _s['done']]
if _unfired or _unsnapped:
    print(f'UNFIRED beats={_unfired} snaps={_unsnapped}')
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
for _tag, _g in snaps:
    # bi#192: timed snapshots for scripted scenarios — the grid as it
    # stood mid-modal (headers, highlight, filtered state), which the
    # post-quit GEOM grid no longer shows.
    print(f'SNAP|{_tag}')
    for _r in range(ROWS):
        print(f'SNAPROW|{_tag}|{_r + 1}|{"".join(_g[_r]).rstrip()}')
