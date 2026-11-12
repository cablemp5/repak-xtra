"""Keeps one of the generator's helper programs (Blender's render server, the exporter with the game mounted) running
between preview runs, so a run started soon after another skips their start-up: about 4 s for Blender and 2 to 3 s to
mount the game, most of what a single plain preview took. speed.py `kept()` starts it and talks to it.

  python keeper.py <state file> <idle seconds> <command as JSON> <extra environment as JSON>

It starts the command with pipes, listens on a local port, and writes {"port", "token", "pid"} to the state file. One
generator at a time connects (first line: the token), then every line it sends goes to the program's input and every
line the program prints comes back, "O" before a line of its output and "E" before a line of its errors. What the
program printed before its first input (the exporter's READY) is sent again to each later generator.
The generator ends its turn with the line "\\0IDLE": the program stays. A connection that just drops (a Stop, a crash)
leaves the program in an unknown state, so it is ended. It also ends when nobody has used it for the idle time, when it
has run for half an hour and is idle (a slow leak never piles up), and when the state file is deleted (the app does
that when it closes, starts the game, or replaces the kit). Beside the state file sits <name>.alive for as long as
the program runs: the app waits for it to go before it replaces the kit, whose files the program has open."""
import json, os, secrets, socket, subprocess, sys, threading, time
from pathlib import Path

state, idle = Path(sys.argv[1]), float(sys.argv[2])
cmd, extra = json.loads(sys.argv[3]), json.loads(sys.argv[4])
OLD = 1800
child = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", creationflags=0x08000000, env={**os.environ, **extra})
alive = state.with_suffix(".alive")
state.parent.mkdir(parents=True, exist_ok=True)
alive.write_text(str(os.getpid()), encoding="utf-8")
lock = threading.Lock()
_log = state.with_suffix(".log") if os.environ.get("REPAKXTRA_KEEP_LOG") else None


def note(text):
    if _log:
        with open(_log, "a", encoding="utf-8") as f:
            f.write(f"{time.time():.2f} {text}\n")


client = None       # the connected generator's socket
greeting = []       # what the program printed before its first input
got_input = False


def send(tag, line):
    global client
    with lock:
        if tag == "O" and not got_input:
            greeting.append(line)
        if client is not None:
            try:
                client.sendall((tag + line).encode("utf-8"))
            except OSError:
                pass


def pump(pipe, tag):
    for line in pipe:
        note(f"out {tag} " + line[:120].rstrip())
        send(tag, line if line.endswith("\n") else line + "\n")
    note(f"end of {tag}")
    if tag == "O":   # the program ended by itself: the generator must see that now, not wait on an answer that never comes
        with lock:
            if client is not None:
                try:
                    client.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


threading.Thread(target=pump, args=(child.stdout, "O"), daemon=True).start()
threading.Thread(target=pump, args=(child.stderr, "E"), daemon=True).start()
server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen(1)
server.settimeout(1.0)
token = secrets.token_hex(16)
state.parent.mkdir(parents=True, exist_ok=True)
tmp = state.with_suffix(".tmp")
tmp.write_text(json.dumps({"port": server.getsockname()[1], "token": token, "pid": os.getpid()}), encoding="utf-8")
os.replace(tmp, state)
born = since = time.time()
clean = True
try:
    while child.poll() is None and state.exists() and time.time() - since < idle:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        conn.settimeout(5.0)
        lines = conn.makefile("r", encoding="utf-8", newline="\n")
        try:
            ok = lines.readline().strip() == token
        except OSError:
            ok = False
        if not ok:
            conn.close()
            continue
        conn.settimeout(None)
        with lock:
            conn.sendall("".join("O" + g for g in greeting).encode("utf-8") + b"K\n")   # K: connected, the greeting is through
            client = conn
        clean = False
        note("client in")
        try:
            for line in lines:
                if line == "\0IDLE\n":
                    clean = True
                    break
                got_input = True
                note("in  " + line[:120].rstrip())
                child.stdin.write(line)
                child.stdin.flush()
        except OSError:
            pass
        with lock:
            client = None
        try:
            conn.close()
        except OSError:
            pass
        note(f"client out, clean {clean}")
        since = time.time()
        if not clean or time.time() - born > OLD:
            break
finally:
    try:
        state.unlink()
    except OSError:
        pass
    try:
        if not clean:
            child.kill()
        child.stdin.close()
        child.wait(5)
    except Exception:
        child.kill()
    try:
        child.wait(5)
    except Exception:
        pass
    try:
        alive.unlink()
    except OSError:
        pass
