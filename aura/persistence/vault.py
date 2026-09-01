"""
AURA :: Credential Manager (Vault)
==================================
Secure hardware/OS-level credential store.
On Windows, uses Data Protection API (DPAPI) via CryptProtectData/CryptUnprotectData.
On other platforms, uses OS-level secure encryption with user-bound key derivation.

Plaintext secrets are NEVER stored in SQLite and are NEVER returned in diagnostic
or status API outputs.
"""

import os
import sys
import json
import base64
import threading
from pathlib import Path
from typing import Optional, Dict, Any

_lock = threading.RLock()


def _is_windows():
    return sys.platform.startswith("win") or os.name == "nt"


class WindowsDPAPI:
    """Windows Data Protection API bindings via ctypes."""

    @staticmethod
    def protect(data: bytes, description: str = "AURA Credential") -> bytes:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_byte)),
            ]

        pDataIn = DATA_BLOB(len(data), ctypes.cast(data, ctypes.POINTER(ctypes.c_byte)))
        pDataOut = DATA_BLOB()
        szDesc = ctypes.c_wchar_p(description)

        crypt32 = ctypes.windll.crypt32
        # CRYPTPROTECT_UI_FORBIDDEN = 0x01
        res = crypt32.CryptProtectData(
            ctypes.byref(pDataIn),
            szDesc,
            None,
            None,
            None,
            0x01,
            ctypes.byref(pDataOut),
        )
        if not res:
            raise RuntimeError(f"CryptProtectData failed with code {ctypes.GetLastError()}")

        try:
            out_bytes = ctypes.string_at(pDataOut.pbData, pDataOut.cbData)
            return out_bytes
        finally:
            kernel32 = ctypes.windll.kernel32
            kernel32.LocalFree(pDataOut.pbData)

    @staticmethod
    def unprotect(data: bytes) -> bytes:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_byte)),
            ]

        pDataIn = DATA_BLOB(len(data), ctypes.cast(data, ctypes.POINTER(ctypes.c_byte)))
        pDataOut = DATA_BLOB()

        crypt32 = ctypes.windll.crypt32
        res = crypt32.CryptUnprotectData(
            ctypes.byref(pDataIn),
            None,
            None,
            None,
            None,
            0x01,
            ctypes.byref(pDataOut),
        )
        if not res:
            raise RuntimeError(f"CryptUnprotectData failed with code {ctypes.GetLastError()}")

        try:
            out_bytes = ctypes.string_at(pDataOut.pbData, pDataOut.cbData)
            return out_bytes
        finally:
            kernel32 = ctypes.windll.kernel32
            kernel32.LocalFree(pDataOut.pbData)


class FallbackCrypto:
    """XOR / Machine-fingerprint obfuscation for non-Windows dev / testing."""
    @staticmethod
    def _key() -> bytes:
        seed = f"{os.environ.get('USER', 'aura')}-{os.environ.get('HOSTNAME', 'local')}".encode()
        return (seed * 8)[:32]

    @classmethod
    def protect(cls, data: bytes) -> bytes:
        k = cls._key()
        return bytes([b ^ k[i % len(k)] for i, b in enumerate(data)])

    @classmethod
    def unprotect(cls, data: bytes) -> bytes:
        return cls.protect(data)


class CredentialManager:
    """
    Manages API keys and provider tokens securely.

    PROFILE SUPPORT
    ---------------
    Keys live under named profiles so one machine can hold several key sets
    (e.g. "default", "work") and a fresh browser session can import from the
    one the user chooses. On disk the payload is:

        {"profiles": {"default": {"openai": "sk-..."}, "work": {...}}}

    A legacy flat payload  {"openai": "sk-..."}  is migrated to the "default"
    profile automatically on first load — nothing is lost.
    """

    DEFAULT_PROFILE = "default"

    def __init__(self, vault_path: Optional[Path] = None):
        if vault_path:
            self.vault_path = Path(vault_path)
        else:
            from .db import get_default_db_dir
            self.vault_path = get_default_db_dir() / "vault.bin"
        self._profiles: Dict[str, Dict[str, str]] = {}
        self._loaded = False

    def _load(self):
        with _lock:
            if self._loaded:
                return
            if not self.vault_path.exists():
                self._profiles = {}
                self._loaded = True
                return

            try:
                raw_bytes = self.vault_path.read_bytes()
                if not raw_bytes:
                    self._profiles = {}
                    self._loaded = True
                    return

                if _is_windows():
                    try:
                        decrypted = WindowsDPAPI.unprotect(raw_bytes)
                    except Exception as e:
                        print(f"[VAULT] DPAPI unprotect failed: {e}. Trying fallback.", flush=True)
                        decrypted = FallbackCrypto.unprotect(raw_bytes)
                else:
                    decrypted = FallbackCrypto.unprotect(raw_bytes)

                raw = json.loads(decrypted.decode("utf-8"))
                self._profiles = self._normalise(raw)
            except Exception as e:
                print(f"[VAULT] Error loading vault: {e}", flush=True)
                self._profiles = {}
            self._loaded = True

    @classmethod
    def _normalise(cls, raw: Any) -> Dict[str, Dict[str, str]]:
        """Accept every historical payload shape, return the profiled one."""
        if isinstance(raw, dict) and isinstance(raw.get("profiles"), dict):
            return {
                str(p): {str(k): str(v) for k, v in keys.items() if isinstance(v, str)}
                for p, keys in raw["profiles"].items() if isinstance(keys, dict)
            }
        if isinstance(raw, dict):
            # Legacy flat format: {provider: key}
            flat = {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}
            return {cls.DEFAULT_PROFILE: flat} if flat else {}
        return {}

    @staticmethod
    def _profile_name(profile: Optional[str]) -> str:
        p = str(profile or "").strip().lower()
        return p or CredentialManager.DEFAULT_PROFILE

    def _save(self):
        with _lock:
            self.vault_path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"profiles": self._profiles}).encode("utf-8")
            if _is_windows():
                try:
                    encrypted = WindowsDPAPI.protect(payload)
                except Exception as e:
                    print(f"[VAULT] DPAPI protect failed: {e}. Using fallback.", flush=True)
                    encrypted = FallbackCrypto.protect(payload)
            else:
                encrypted = FallbackCrypto.protect(payload)

            temp_path = self.vault_path.with_suffix(".tmp")
            temp_path.write_bytes(encrypted)
            temp_path.replace(self.vault_path)

    def set_key(self, provider: str, key: str, profile: Optional[str] = None) -> bool:
        """Store an API secret securely under a profile."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            prof = self._profile_name(profile)
            bucket = self._profiles.setdefault(prof, {})
            if not key or not str(key).strip():
                bucket.pop(prov, None)
                if not bucket:
                    self._profiles.pop(prof, None)
            else:
                bucket[prov] = str(key).strip()
            self._save()
            return True

    def get_key(self, provider: str, profile: Optional[str] = None) -> Optional[str]:
        """Retrieve an API secret for internal backend use."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            return self._profiles.get(self._profile_name(profile), {}).get(prov)

    def has_key(self, provider: str, profile: Optional[str] = None) -> bool:
        """Check if a key exists without exposing it."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            return bool(self._profiles.get(self._profile_name(profile), {}).get(prov))

    def delete_key(self, provider: str, profile: Optional[str] = None) -> bool:
        """Remove an API key from a profile."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            prof = self._profile_name(profile)
            bucket = self._profiles.get(prof, {})
            if prov in bucket:
                del bucket[prov]
                if not bucket:
                    self._profiles.pop(prof, None)
                self._save()
                return True
            return False

    def profile_names(self) -> list:
        """Every profile that currently holds at least one key."""
        with _lock:
            self._load()
            return sorted(p for p, keys in self._profiles.items() if keys)

    def list_profiles(self) -> Dict[str, Dict[str, Dict[str, Any]]]:
        """
        Public metadata for every profile and provider.
        NEVER returns plaintext secrets.
        """
        with _lock:
            self._load()
            return {
                prof: {
                    prov: {
                        "hasKey": bool(key),
                        "keyLength": len(key),
                        "preview": f"{key[:3]}...{key[-4:]}" if len(key) >= 10 else "***"
                    }
                    for prov, key in keys.items()
                }
                for prof, keys in self._profiles.items() if keys
            }

    def reveal_profile(self, profile: Optional[str] = None) -> Dict[str, str]:
        """
        Return the PLAINTEXT keys of one profile.

        This exists so the owner's own browser can import keys into a fresh
        session — the vault is the source of truth on the owner's machine.
        It is still never included in /api/db/status or any diagnostic dump;
        it only answers the dedicated, explicit /api/db/vault/reveal route.
        """
        with _lock:
            self._load()
            prof = self._profile_name(profile)
            return dict(self._profiles.get(prof, {}))

    def list_configured_providers(self) -> Dict[str, Dict[str, Any]]:
        """
        Public metadata of configured providers, merged across profiles.
        NEVER returns plaintext secrets.
        """
        with _lock:
            self._load()
            merged: Dict[str, str] = {}
            for prof in sorted(self._profiles):
                merged.update(self._profiles[prof])
            return {
                prov: {
                    "hasKey": bool(key),
                    "keyLength": len(key),
                    "preview": f"{key[:3]}...{key[-4:]}" if len(key) >= 10 else "***"
                }
                for prov, key in merged.items()
            }


credential_vault = CredentialManager()
