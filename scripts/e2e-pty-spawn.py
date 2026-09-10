"""Transport for e2e-pty.mjs: pty-spawn argv, relay stdin<->pty and pty->stdout.

Usage: e2e-pty-spawn.py <reply-delay-ms> <timeout-s> <argv...>
Answers every kitty query burst (`[?u` tail) with flags + DA replies
(separated by 30ms, like a real terminal). Exits with the child's code;
exit 3 on timeout (child killed). Own diagnostics go to stderr; stdout
carries only the child's pty output.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

REPLY_FLAGS = b"\x1b[?7u"
REPLY_DA = b"\x1b[?64;1;2;4;6;17;18;21;22;52c"


class CursorTracker:
    """Minimal VT cursor tracker for --dsr (bi#208): answers ESC[6n.

    Tracks row/col over the child output stream: LF/VT/FF/IND/NEL,
    CR, BS, printables, CUP/H/f, CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA,
    CPR-style save/restore (s/u, 7/8), RI, RIS. Everything else
    (SGR, EL/ED, modes, kitty pushes, synchronized output, OSC)
    is skipped without moving. Unknown/partial sequences carry
    across chunks. Scroll clamps at the fold (no scroll region
    exists in the bi stack, bi#194).
    """

    def __init__(self, rows, cols):
        self.rows = rows
        self.cols = cols
        self.y = 0
        self.x = 0
        self.saved = []
        self.carry = b""

    def feed(self, chunk):
        data = self.carry + chunk
        self.carry = b""
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 0x1B:
                ni = self._esc(data, i)
                if ni is None:
                    self.carry = data[i:]
                    return
                i = ni
            elif b == 0x0A or b == 0x0B or b == 0x0C:  # LF VT FF
                self.y = min(self.y + 1, self.rows - 1)
                i += 1
            elif b == 0x0D:  # CR
                self.x = 0
                i += 1
            elif b == 0x08:  # BS
                self.x = max(self.x - 1, 0)
                i += 1
            elif b == 0x07 or b == 0x00:  # BEL NUL
                i += 1
            elif b < 0x20:
                i += 1  # other C0: no move
            else:
                self.x += 1  # printable (wrap ignored: next LF/CR resets)
                i += 1

    def _esc(self, data, i):
        n = len(data)
        if i + 1 >= n:
            return None
        c = data[i + 1]
        if c == ord("["):
            j = i + 2
            while j < n and not (0x40 <= data[j] <= 0x7E):
                j += 1
            if j >= n:
                return None  # partial CSI carries
            params = data[i + 2 : j].decode("ascii", "replace")
            final = chr(data[j])
            self._csi(params, final)
            return j + 1
        if c == ord("]"):  # OSC .. BEL|ESC\
            j = i + 2
            while j < n:
                if data[j] == 0x07:
                    return j + 1
                if data[j] == 0x1B and j + 1 < n and data[j + 1] == ord("\\"):
                    return j + 2
                j += 1
            return None
        if c in (ord("("), ord(")"), ord("#")):  # charset/designate
            return None if i + 2 >= n else i + 3
        if c == ord("7"):
            self.saved.append((self.y, self.x))
            return i + 2
        if c == ord("8"):
            if self.saved:
                self.y, self.x = self.saved.pop()
            return i + 2
        if c == ord("M"):  # RI
            self.y = max(self.y - 1, 0)
            return i + 2
        if c == ord("D"):  # IND
            self.y = min(self.y + 1, self.rows - 1)
            return i + 2
        if c == ord("E"):  # NEL
            self.y = min(self.y + 1, self.rows - 1)
            self.x = 0
            return i + 2
        if c == ord("c"):  # RIS
            self.y, self.x, self.saved = 0, 0, []
            return i + 2
        if c == ord("O"):  # SS3 + 1
            return None if i + 2 >= n else i + 3
        return i + 2  # lone ESC + char: no move

    def _csi(self, params, final):
        nums = [int(p) if p.isdigit() else None for p in params.lstrip("?>!\"$ ").split(";")]
        n1 = nums[0] if nums and nums[0] is not None else 1
        n2 = nums[1] if len(nums) > 1 and nums[1] is not None else 1
        if final in ("H", "f"):
            self.y = min(max((nums[0] or 1) - 1, 0), self.rows - 1)
            self.x = min(max((nums[1] or 1) - 1, 0), self.cols - 1)
        elif final == "A":
            self.y = max(self.y - n1, 0)
        elif final in ("B", "E"):
            self.y = min(self.y + n1, self.rows - 1)
        elif final == "e":
            self.y = min(self.y + n1, self.rows - 1)
        elif final in ("C", "F"):
            self.x = min(self.x + n1, self.cols - 1)
        elif final == "D":
            self.x = max(self.x - n1, 0)
        elif final == "G":
            self.x = min(max(n1 - 1, 0), self.cols - 1)
        elif final == "d":
            self.y = min(max(n1 - 1, 0), self.rows - 1)
        elif final == "s":
            self.saved.append((self.y, self.x))
        elif final == "u":
            if self.saved:
                self.y, self.x = self.saved.pop()
        # EL K / ED J / modes h,l / SGR m / regions r / R reply: no move.


def reap(pid):
    """Poll up to ~2s for the child exit; return exit code or 3."""
    import time as _t

    for _ in range(20):
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return 3
        if wpid != 0:
            return os.waitstatus_to_exitcode(status)
        _t.sleep(0.1)
    return 3


def main() -> int:
    args = sys.argv[1:]
    # bi#208: opt-in DSR answering (cursor tracker) + pty geometry.
    # Positional shape unchanged when both are absent.
    dsr = False
    if "--dsr" in args:
        dsr = True
        args = [a for a in args if a != "--dsr"]
    import os as _os

    pty_rows = int(_os.environ.get("BI_PTY_ROWS", "40"))
    pty_cols = int(_os.environ.get("BI_PTY_COLS", "160"))
    reply_delay = float(args[0]) / 1000.0
    timeout = float(args[1])
    argv = args[2:]
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", pty_rows, pty_cols, 0, 0))
        os.execvp(argv[0], argv)
        return 1

    out = bytearray()
    answered = 0
    dsr_answered = 0
    tracker = CursorTracker(pty_rows, pty_cols) if dsr else None
    pending = []  # (at, bytes)
    stdin_open = True
    os.set_blocking(0, False)
    t0 = time.time()
    code = 3
    try:
        while time.time() - t0 < timeout:
            if stdin_open:
                r, _, _ = select.select([fd, 0], [], [], 0.05)
            else:
                r, _, _ = select.select([fd], [], [], 0.05)
            now = time.time()
            if 0 in r:
                try:
                    chunk = os.read(0, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    try:
                        os.write(fd, chunk)
                    except OSError:
                        pass
                else:
                    stdin_open = False
            if fd in r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    # Slave closed: child is gone (or going) — reap to
                    # learn the real exit code instead of crying timeout.
                    code = reap(pid)
                    break
                out += chunk
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                bursts = bytes(out).count(b"[?u")
                if bursts > answered:
                    answered = bursts
                    pending.append((now + reply_delay, REPLY_FLAGS))
                    pending.append((now + reply_delay + 0.03, REPLY_DA))
                if tracker is not None:
                    tracker.feed(chunk)
                    queries = bytes(out).count(b"[6n")
                    while dsr_answered < queries:
                        dsr_answered += 1
                        reply = "\x1b[%d;%dR" % (tracker.y + 1, tracker.x + 1)
                        pending.append((now + reply_delay, reply.encode()))
            due, pending = [p for p in pending if p[0] <= now], [p for p in pending if p[0] > now]
            for _, b in due:
                try:
                    os.write(fd, b)
                except OSError:
                    pass
            _, status = os.waitpid(pid, os.WNOHANG)
            if _ != 0:
                code = os.waitstatus_to_exitcode(status)
                # Drain remaining output briefly.
                end = time.time() + 0.5
                while time.time() < end:
                    rr, _, _ = select.select([fd], [], [], 0.1)
                    if fd in rr:
                        try:
                            chunk = os.read(fd, 65536)
                        except OSError:
                            break
                        if not chunk:
                            break
                        out += chunk
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                break
        else:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
            code = 3
    finally:
        # Output already streamed chunk-by-chunk above; nothing to flush.
        pass
    return code


if __name__ == "__main__":
    raise SystemExit(main())
