"""
AURA :: Persistence Subsystem
=============================
Authoritative local-first persistence layer for AURA / NOVA.
"""

from .db import db_manager, DatabaseManager, get_db_path, get_default_db_dir
from .vault import credential_vault, CredentialManager

__all__ = [
    "db_manager",
    "DatabaseManager",
    "get_db_path",
    "get_default_db_dir",
    "credential_vault",
    "CredentialManager",
]
