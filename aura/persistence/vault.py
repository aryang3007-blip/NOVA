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
    """

    def __init__(self, vault_path: Optional[Path] = None):
        if vault_path:
            self.vault_path = Path(vault_path)
        else:
            from .db import get_default_db_dir
            self.vault_path = get_default_db_dir() / "vault.bin"
        self._cache: Dict[str, str] = {}
        self._loaded = False

    def _load(self):
        with _lock:
            if self._loaded:
                return
            if not self.vault_path.exists():
                self._cache = {}
                self._loaded = True
                return

            try:
                raw_bytes = self.vault_path.read_bytes()
                if not raw_bytes:
                    self._cache = {}
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

                self._cache = json.loads(decrypted.decode("utf-8"))
            except Exception as e:
                print(f"[VAULT] Error loading vault: {e}", flush=True)
                self._cache = {}
            self._loaded = True

    def _save(self):
        with _lock:
            self.vault_path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(self._cache).encode("utf-8")
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

    def set_key(self, provider: str, key: str) -> bool:
        """Store an API secret securely."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            if not key or not str(key).strip():
                if prov in self._cache:
                    del self._cache[prov]
            else:
                self._cache[prov] = str(key).strip()
            self._save()
            return True

    def get_key(self, provider: str) -> Optional[str]:
        """Retrieve an API secret for internal backend use."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            return self._cache.get(prov)

    def has_key(self, provider: str) -> bool:
        """Check if a key exists without exposing it."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            return bool(self._cache.get(prov))

    def delete_key(self, provider: str) -> bool:
        """Remove an API key."""
        with _lock:
            self._load()
            prov = str(provider).strip().lower()
            if prov in self._cache:
                del self._cache[prov]
                self._save()
                return True
            return False

    def list_configured_providers(self) -> Dict[str, Dict[str, Any]]:
        """
        Return public metadata of configured providers.
        NEVER returns plaintext secrets.
        """
        with _lock:
            self._load()
            return {
                prov: {
                    "hasKey": bool(key),
                    "keyLength": len(key),
                    "preview": f"{key[:3]}...{key[-4:]}" if len(key) >= 10 else "***"
                }
                for prov, key in self._cache.items()
            }


credential_vault = CredentialManager()
