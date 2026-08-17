"""Host-side Caspar signalling client (deploy/administer creatures).

This is the *external* client protocol — the one a deployer/CLI on the node's
host uses to create creatures, deploy program entities and start VMs. It is a
different channel from the docker-host bridge gateway the creature itself speaks
(`caspar/bridge.mjs`): a container never opens this protocol, and this client
never opens the gateway.

It implements:

* the wire framing (no tag byte on requests; response frames are ACKed),
* RSA-PSS request signing (the scheme the node verifies for external callers),
* the creature lifecycle calls the deploy scripts need: ``login``,
  ``create_machine_creature``, ``create_program``, ``deploy``, ``run_entity``,
  ``stop_entity``, ``read_vm_logs``, and ``signal_entity_await`` for smoke tests.

RSA signing needs ``pycryptodome``; everything else is stdlib. Mirrors the proven
client the davinci agent deploys with, so it speaks to an unmodified node.
"""

from __future__ import annotations

import base64
import json
import socket
import struct
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

try:  # signing is only needed for authenticated external calls
    # pip's `pycryptodome` exposes the `Crypto` namespace; the Debian/Ubuntu apt
    # package `python3-pycryptodome` installs the identical API under
    # `Cryptodome`. Accept either so the client works with whichever is present.
    try:
        from Crypto.PublicKey import RSA
        from Crypto.Signature import pss
        from Crypto.Hash import SHA256
    except Exception:  # noqa: BLE001
        from Cryptodome.PublicKey import RSA
        from Cryptodome.Signature import pss
        from Cryptodome.Hash import SHA256
    _HAVE_CRYPTO = True
except Exception:  # pragma: no cover — exercised only without the dep
    _HAVE_CRYPTO = False


def _lp(s: str) -> bytes:
    """Length-prefixed UTF-8 string, as the node's framing expects."""
    b = s.encode("utf-8")
    return struct.pack(">I", len(b)) + b


def _normalize_pem(key: str) -> str:
    """Coerce a private key into a real PEM the parser accepts.

    A PEM stored as a JSON string or a CI secret is often single-line with
    literal ``\\n`` escapes (and sometimes wrapping quotes) rather than real
    newlines — feeding that straight to ``RSA.import_key`` fails with
    "Not a valid PEM pre boundary". Restore the line boundaries here so the
    env-injected operator key (``CASPAR_OPERATOR_PRIVATE_KEY``) works whether it
    was pasted with real or escaped newlines. Already-valid PEMs are unchanged
    (a base64 body never contains a backslash)."""
    if not key:
        return key
    k = key.strip()
    if len(k) >= 2 and k[0] == k[-1] and k[0] in ("'", '"'):
        k = k[1:-1].strip()
    # Turn escaped newlines (\r\n, \n) into real ones; no-op for real PEMs.
    k = k.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
    return k if k.endswith("\n") else k + "\n"


def sign_payload(priv_pem: str, payload_bytes: bytes) -> str:
    """RSA-PSS SHA256 signature, base64 — matches the node's verifier."""
    if not _HAVE_CRYPTO:
        raise RuntimeError("pycryptodome is required to sign Caspar requests")
    key = RSA.import_key(priv_pem)
    digest = SHA256.new(payload_bytes)
    return base64.b64encode(pss.new(key).sign(digest)).decode()


class CasparSignalingClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 8074, timeout: float = 60.0) -> None:
        self.host = host
        self.port = int(port)
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self.user_id: str = ""
        self.priv_pem: str = ""

    # -- connection ----------------------------------------------------------
    def connect(self) -> "CasparSignalingClient":
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect((self.host, self.port))
        return self

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def __enter__(self) -> "CasparSignalingClient":
        return self.connect()

    def __exit__(self, *_: Any) -> None:
        self.close()

    # -- low-level request ---------------------------------------------------
    def _recvall(self, n: int) -> bytes:
        assert self.sock is not None
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("socket closed while reading")
            buf.extend(chunk)
        return bytes(buf)

    def send(self, path: str, payload: Dict[str, Any], *, sign: bool = True) -> Dict[str, Any]:
        if self.sock is None:
            raise RuntimeError("not connected")
        payload_bytes = json.dumps(payload).encode("utf-8")
        signature = sign_payload(self.priv_pem, payload_bytes) if (sign and self.priv_pem) else ""
        pkt_id = str(uuid.uuid4())
        body = _lp(signature) + _lp(self.user_id) + _lp(path) + _lp(pkt_id) + payload_bytes
        self.sock.sendall(struct.pack(">I", len(body)) + body)

        while True:
            length = struct.unpack(">I", self._recvall(4))[0]
            if length == 0:
                return {}
            frame = self._recvall(length)
            if frame[0] != 0x02:  # update/signal frames are fire-and-forget
                continue
            off = 1
            pl = struct.unpack(">I", frame[off:off + 4])[0]
            off += 4 + pl  # skip packet id
            res_code = struct.unpack(">I", frame[off:off + 4])[0]
            off += 4
            payload_out = frame[off:]
            self.sock.sendall(struct.pack(">I", 1) + b"\x01")  # ACK
            result: Dict[str, Any] = {}
            if payload_out:
                try:
                    result = json.loads(payload_out)
                except json.JSONDecodeError:
                    result = {"raw": payload_out.decode("utf-8", "replace")}
            result.setdefault("_res_code", res_code)
            return result

    # -- creature lifecycle --------------------------------------------------
    def login(self, username: str) -> Dict[str, Any]:
        r = self.send("/creatures/login", {"username": username,
                                           "emailToken": f"{username}@dev.local",
                                           "metadata": {}}, sign=False)
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"login failed: {r}")
        self.user_id = r["user"]["id"]
        self.priv_pem = r["privateKey"]
        return r

    def authenticate(self, user_id: str, private_key: str) -> None:
        """Act as an already-known identity without a fresh ``/creatures/login``.

        Every request is signed with ``private_key`` and stamped with ``user_id``;
        the node verifies that against the creature's stored public key, exactly as
        it does after a login. This lets every deploy reuse the *same* persisted
        operator account run after run, so a redeploy always owns the creatures and
        programs it minted and never has to re-mint them."""
        if not user_id or not private_key:
            raise ValueError("authenticate requires both a user_id and a private_key")
        self.user_id = user_id
        self.priv_pem = _normalize_pem(private_key)

    def create_machine_creature(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        r = self.send("/creatures/create", {"type": "machine", "username": name[:32],
                                            "publicKey": "", "metadata": metadata or {}})
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"create machine creature failed: {r}")
        return r["creature"]["id"]

    def create_program(self, app_id: str, path: str, runtime: str, comment: str = "") -> str:
        r = self.send("/programs/create", {"appId": app_id, "path": path,
                                           "Comment": comment, "runtime": runtime, "publicKey": ""})
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"create program failed: {r}")
        return r.get("program", {}).get("id", "")

    def get_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        """The creature stored under ``username`` (``<name>@<source>``), or None.

        This is the deterministic way a redeploy re-finds the machine it created —
        the same lookup the Nest deployer uses for its WASM endpoints (which is why
        those never re-mint). The returned dict carries at least ``id`` and the
        owner (``ownerId``)."""
        r = self.send("/creatures/getByUsername", {"username": username})
        if r.get("_res_code", -1) != 0:
            # Only the action's explicit not-found result means absence. An
            # auth failure, timeout, malformed response, or unavailable node is
            # not evidence that creating another creature is safe.
            error = str(r.get("error") or r.get("message") or r.get("raw") or "").strip().lower()
            if error == "user not found":
                return None
            raise RuntimeError(f"getByUsername({username}) failed: {r}")
        user = r.get("user")
        if not isinstance(user, dict) or not user.get("id"):
            raise RuntimeError(f"getByUsername({username}) returned a malformed success response: {r}")
        return user

    def list_programs(self, offset: int = 0, count: int = 100000) -> List[Dict[str, Any]]:
        """Every program on the node as ``{id, machineId, …}`` rows.

        Used to resolve a machine creature's docker program by its ``machineId``,
        so a redeploy lands on the same program the machine already owns."""
        r = self.send("/programs/list", {"offset": offset, "count": count})
        if not isinstance(r, dict) or r.get("_res_code", -1) != 0:
            raise RuntimeError(f"list programs failed: {r}")
        rows = r.get("machines")
        if not isinstance(rows, list):
            raise RuntimeError(f"list programs returned a malformed success response: {r}")
        return rows

    def list_creatures(self, offset: int = 0, count: int = 100000) -> List[Dict[str, Any]]:
        """Every creature on the node as ``{id, username, ownerId}`` rows.

        ``getByUsername`` cannot reliably re-find a machine creature: the node
        stores the username qualified with its own ``source`` and enforces
        uniqueness on that qualified form, but ``getByUsername`` looks the raw
        argument up, so a redeploy misses the machine it created and then collides
        on create (``creature username already exists``). Enumerating and matching
        the unqualified local part sidesteps that — the same fix the Nest wasm
        deployer uses (see ``deployer.ts`` ``creatureNames``)."""
        r = self.send("/creatures/list", {"offset": offset, "count": count})
        if not isinstance(r, dict) or r.get("_res_code", -1) != 0:
            raise RuntimeError(f"list creatures failed: {r}")
        rows = r.get("creatures")
        if not isinstance(rows, list):
            raise RuntimeError(f"list creatures returned a malformed success response: {r}")
        return rows

    def deploy(self, program_id: str, entity_id: str, entity_type: str,
               primary_b64: str, files_b64: Optional[Dict[str, str]] = None,
               metadata: Optional[Dict[str, Any]] = None,
               downloadable: bool = False) -> Dict[str, Any]:
        """Deploy an entity onto a program.

        ``downloadable=True`` marks it as a client-side front-end script the node
        serves on demand via ``/programs/downloadEntity`` (never run on the node);
        this is how a tool's Victor mini-app front-end rides on the same program
        as its back-end creature.
        """
        meta = dict(metadata or {})
        if files_b64:
            meta["files"] = files_b64
        r = self.send("/programs/deploy", {"machineId": program_id, "entityId": entity_id,
                                           "entityType": entity_type, "downloadable": bool(downloadable),
                                           "payload": primary_b64, "metadata": meta})
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"deploy failed: {r}")
        return r

    def run_entity(self, program_id: str, entity_id: str, *, params: Optional[Dict[str, str]] = None,
                   ram_mb: int = 1024, disk_gb: int = 4, cpu_cores: int = 2,
                   max_exec_seconds: int = 120, force_restart: bool = False,
                   gateway_path: str = "") -> str:
        """Start the entity's standalone VM.

        ``force_restart`` is CRITICAL after a (re)deploy: the node's run_vm is
        idempotent by default — an existing container is *resumed* (its old
        writable layer, i.e. the OLD code) instead of being recreated from the
        freshly-built image. Passing it stops+removes the old container and
        creates a fresh one, so redeployed code actually runs. (The persistent
        per-VM /data mount survives either way.)

        ``gateway_path`` binds a deterministic custom VM-gateway route to *this*
        launched instance, so the entity's in-container HTTP server is reachable
        at the fixed ``/{creatureUsername}/{gateway_path…}`` node-ingress URL. The
        external URL never changes across redeploys — the node re-points the route
        at the fresh instance each run — which is what lets a tool register a
        single OAuth callback URL with the provider once (e.g. the github tool).
        """
        r = self.send("/programs/runEntity", {
            "programId": program_id, "machineId": program_id, "entityId": entity_id,
            "resources": {"ramMb": ram_mb, "diskGb": disk_gb, "cpuCores": cpu_cores,
                          "maxExecTimeSeconds": max_exec_seconds},
            "params": params or {},
            "forceRestart": force_restart,
            "gatewayPath": gateway_path,
        })
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"runEntity failed: {r}")
        return r.get("vmId", "")

    def stop_entity(self, program_id: str, entity_id: str) -> Dict[str, Any]:
        r = self.send("/programs/stopEntity", {
            "programId": program_id, "machineId": program_id, "entityId": entity_id,
        })
        if r.get("_res_code", -1) != 0:
            raise RuntimeError(f"stopEntity failed: {r}")
        return r

    def read_vm_logs(self, vm_id: str, log_type: str = "", count: int = 500, offset: int = 0) -> List[Any]:
        r = self.send("/machines/readVmLogs", {"vmId": vm_id, "logType": log_type,
                                               "count": count, "offset": offset})
        return r.get("logs", []) if isinstance(r, dict) else []

    def wait_for_vm_log(self, vm_id: str, marker: str, *, timeout: float = 90.0,
                        poll: float = 2.0, heartbeat: float = 30.0) -> Tuple[bool, List[Any]]:
        """Poll VM logs until a line containing ``marker`` appears, or time out.

        Prints a heartbeat while waiting: a container that is still booting (or an
        image the node is still building) can take minutes, and a wait that says
        nothing for that long reads as a hung deploy. The heartbeat also shows the
        container's own most recent line, so progress is visible as it happens
        rather than only in the post-mortem.
        """
        started = time.time()
        deadline = started + timeout
        next_beat = started + heartbeat
        logs: List[Any] = []
        while time.time() < deadline:
            logs = self.read_vm_logs(vm_id)
            if any(marker in log_text(entry) for entry in logs):
                return True, logs
            now = time.time()
            if heartbeat and now >= next_beat:
                lines = [log_text(entry).strip() for entry in logs]
                lines = [line for line in lines if line]
                latest = lines[-1][:160] if lines else "(no output from the container yet)"
                info(f"  … waiting for {marker} — {int(now - started)}s of {int(timeout)}s; last log: {latest}")
                next_beat = now + heartbeat
            time.sleep(poll)
        return False, logs

    # -- signalling ----------------------------------------------------------
    def signal_entity_await(self, *, creature_id: str, program_id: str, entity_id: str,
                            envelope: Dict[str, Any], timeout: float = 300.0) -> Dict[str, Any]:
        """Signal a *running* creature VM and await its correlated reply.

        This is how an external client hands work to a standalone creature: a
        ``/creatures/signal`` (pvp) carrying ``envelope`` is delivered by the node
        as a pushed signal onto the creature's live gateway connection; the
        creature processes it and signals a reply back to *this* client, matched
        by ``correlationId``. Streamed ``davinci/step`` chunks are collected and
        returned alongside the terminal result.
        """
        correlation_id = uuid.uuid4().hex
        data = json.dumps({**envelope, "correlationId": correlation_id, "reply_to": self.user_id})
        req = {"type": "pvp", "data": data, "creatureId": creature_id,
               "programId": program_id, "entityId": entity_id, "temp": False}
        return self._signal_await_result("/creatures/signal", req, correlation_id, timeout)

    def signal_wasm_endpoint(self, *, creature_id: str, program_id: str, action: str,
                             payload: Dict[str, Any], entity: str = "main",
                             timeout: float = 20.0) -> Dict[str, Any]:
        """Signal a **WASM per-route endpoint** (e.g. ``market/registerPlatform``) and
        await its correlated result.

        This is the exact envelope Nest's ``CasparService.*Action`` builds for a
        signal-compatible WASM endpoint (see the server's ``caspar-client.signal`` /
        ``openSignal``): a ``/creatures/signal`` (pvp) whose ``data`` double-wraps the
        action — ``{programId, entity, payload: JSON(inner)}`` where ``inner`` is
        ``{action, payload, correlationId}``. The endpoint peels it with the shared
        ``unwrapSignal`` ABI and signals a correlated ``creatures/signal/result`` back,
        matched here by ``correlationId``.

        Reuses the same correlated-response loop as ``signal_entity_await`` — only the
        request envelope differs — so there is no duplicated response handling. Returns
        ``{ok, result|error, steps}``; ``result`` is the endpoint's own output object.
        """
        correlation_id = uuid.uuid4().hex
        inner = {"action": action, "payload": dict(payload or {}), "correlationId": correlation_id}
        data = json.dumps({"programId": program_id, "entity": entity, "payload": json.dumps(inner)})
        req = {"type": "pvp", "creatureId": creature_id, "programId": program_id,
               "entityId": entity, "temp": False, "data": data}
        return self._signal_await_result("/creatures/signal", req, correlation_id, timeout)

    def _signal_await_result(self, path: str, payload: Dict[str, Any],
                             correlation_id: str, timeout: float) -> Dict[str, Any]:
        if self.sock is None:
            raise RuntimeError("not connected")
        payload_bytes = json.dumps(payload).encode("utf-8")
        signature = sign_payload(self.priv_pem, payload_bytes) if self.priv_pem else ""
        pkt_id = str(uuid.uuid4())
        body = _lp(signature) + _lp(self.user_id) + _lp(path) + _lp(pkt_id) + payload_bytes
        self.sock.sendall(struct.pack(">I", len(body)) + body)

        deadline = time.time() + timeout
        steps: List[Dict[str, Any]] = []
        ack: Dict[str, Any] = {}
        old_timeout = self.sock.gettimeout()
        try:
            while time.time() < deadline:
                self.sock.settimeout(max(0.5, deadline - time.time()))
                try:
                    hdr = self._recvall(4)
                except (socket.timeout, ConnectionError):
                    break
                length = struct.unpack(">I", hdr)[0]
                if length == 0:
                    continue
                frame = self._recvall(length)
                tag = frame[0]
                if tag == 0x02:  # response ack to our /creatures/signal
                    off = 1
                    pl = struct.unpack(">I", frame[off:off + 4])[0]
                    off += 4 + pl
                    res_code = struct.unpack(">I", frame[off:off + 4])[0]
                    off += 4
                    self.sock.sendall(struct.pack(">I", 1) + b"\x01")  # ACK
                    try:
                        ack = json.loads(frame[off:]) if frame[off:] else {}
                    except json.JSONDecodeError:
                        ack = {}
                    ack["_res_code"] = res_code
                    if res_code != 0:
                        return {"ok": False, "error": "signal rejected", "ack": ack, "steps": steps}
                    continue
                if tag == 0x01:  # pushed signal frame: [0x01][key][payload]
                    off = 1
                    klen = struct.unpack(">I", frame[off:off + 4])[0]
                    off += 4 + klen  # skip key
                    try:
                        msg = json.loads(frame[off:])
                    except json.JSONDecodeError:
                        continue
                    matched = find_correlated_signal(msg, correlation_id)
                    if matched is None:
                        continue
                    if matched.get("kind") == "davinci/step":
                        steps.append(matched)
                        continue
                    return {"ok": True, "result": matched, "steps": steps}
                # other tags: ignore and keep reading
        finally:
            try:
                self.sock.settimeout(old_timeout)
            except OSError:
                pass
        return {"ok": False, "error": "signal result timeout", "correlationId": correlation_id,
                "ack": ack, "steps": steps}


def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def find_correlated_signal(message: Any, correlation_id: str) -> Optional[Dict[str, Any]]:
    """Return the signal payload matching ``correlation_id`` across node shapes.

    Pushed signal updates arrive in a few compatible envelopes: sometimes the
    update payload *is* the packet, sometimes it is wrapped as ``{key, data}``,
    and a program-targeted signal adds a second ``data`` JSON string inside a
    StoresSend-style object. Unwrap those transport layers before deciding that
    no result arrived.
    """
    seen: set = set()

    def walk(value: Any) -> Optional[Dict[str, Any]]:
        value = _maybe_json(value)
        if not isinstance(value, dict):
            return None
        if id(value) in seen:
            return None
        seen.add(id(value))
        if value.get("correlationId") == correlation_id:
            return value
        for key in ("data", "packet", "payload", "result"):
            if key in value:
                found = walk(value.get(key))
                if found is not None:
                    return found
        return None

    return walk(message)


def info(message: str) -> None:
    print(f"\033[36m[deploy]\033[0m {message}", flush=True)


def log_text(entry: Any) -> str:
    """Flatten a VM-log row into its text line."""
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        return entry.get("data") or entry.get("text") or entry.get("line") or json.dumps(entry)
    return str(entry)
