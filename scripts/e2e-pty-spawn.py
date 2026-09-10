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
    reply_delay = float(sys.argv[1]) / 1000.0
    timeout = float(sys.argv[2])
    argv = sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        os.execvp(argv[0], argv)
        return 1

    out = bytearray()
    answered = 0
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
