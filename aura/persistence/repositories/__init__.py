"""
AURA :: Repository Layer
========================
Domain repositories providing clean typed interfaces to SQLite and Credential Vault.
Higher-level subsystems interact with these repositories instead of executing raw SQL.
"""

from .config_repo import ConfigRepository, config_repo
from .memory_repo import MemoryRepository, memory_repo
from .device_repo import DeviceRepository, device_repo
from .wake_repo import WakePhraseRepository, wake_repo
from .app_repo import AppRepository, app_repo
from .permission_repo import PermissionRepository, permission_repo
from .usage_repo import UsageRepository, usage_repo

__all__ = [
    "ConfigRepository",
    "config_repo",
    "MemoryRepository",
    "memory_repo",
    "DeviceRepository",
    "device_repo",
    "WakePhraseRepository",
    "wake_repo",
    "AppRepository",
    "app_repo",
    "PermissionRepository",
    "permission_repo",
    "UsageRepository",
    "usage_repo",
]
