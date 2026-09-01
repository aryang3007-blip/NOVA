"""
AURA :: Database Manager
========================
Manages SQLite database connections, configuration, WAL mode, integrity checks,
and safe backups.

Database location defaults to %LOCALAPPDATA%\\AURA\\aura.db on Windows (or ~/.aura/aura.db
on Unix), completely separating user data from application source code.
Can be overridden with the AURA_DB_PATH environment variable.
"""

import os
import sqlite3
import threading
import time
import shutil
from pathlib import Path

# Thread-local storage for SQLite connections
_local = threading.local()
_lock = threading.RLock()


def get_default_db_dir() -> Path:
    """Return the platform-appropriate AURA data directory."""
    if "AURA_DATA_DIR" in os.environ:
        p = Path(os.environ["AURA_DATA_DIR"])
    elif os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
        p = Path(local_app_data) / "AURA"
    else:
        p = Path(os.path.expanduser("~/.aura"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_db_path() -> Path:
    """Return the absolute path to aura.db."""
    if "AURA_DB_PATH" in os.environ:
        p = Path(os.environ["AURA_DB_PATH"]).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    return get_default_db_dir() / "aura.db"


class DatabaseManager:
    """
    Thread-safe SQLite connection and lifecycle manager.
    Enforces WAL mode, foreign keys, busy timeouts, and clean transactions.
    """

    def __init__(self, db_path: Path = None):
        self.db_path = Path(db_path) if db_path else get_db_path()
        self._initialized = False

    def get_connection(self) -> sqlite3.Connection:
        """
        Get a thread-local SQLite connection.
        Configures WAL journal mode, busy timeout, and row factory.
        """
        conn_attr = f"_conn_{id(self)}"
        conn = getattr(_local, conn_attr, None)
        if conn is None:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(
                str(self.db_path),
                timeout=10.0,
                check_same_thread=False
            )
            conn.row_factory = sqlite3.Row
            with conn:
                conn.execute("PRAGMA journal_mode = WAL;")
                conn.execute("PRAGMA busy_timeout = 5000;")
                conn.execute("PRAGMA foreign_keys = ON;")
                conn.execute("PRAGMA synchronous = NORMAL;")
            setattr(_local, conn_attr, conn)
        return conn

    def close_thread_connection(self):
        """Close thread-local connection if open."""
        conn_attr = f"_conn_{id(self)}"
        conn = getattr(_local, conn_attr, None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            setattr(_local, conn_attr, None)

    def initialize(self) -> dict:
        """
        Perform database readiness check, directory verification,
        and run schema migrations.
        """
        with _lock:
            print(f"[DB] Initializing database at {self.db_path}", flush=True)
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            
            conn = self.get_connection()
            cursor = conn.cursor()
            cursor.execute("PRAGMA integrity_check;")
            row = cursor.fetchone()
            status = row[0] if row else "unknown"
            if status != "ok":
                print(f"[DB] WARNING: Integrity check returned: {status}", flush=True)
            
            from .migrations.runner import MigrationRunner
            runner = MigrationRunner(self)
            applied = runner.run_pending()
            
            self._initialized = True
            version = runner.get_current_version()
            print(f"[DB] Database initialized successfully (schema version: {version})", flush=True)
            return {
                "ok": True,
                "path": str(self.db_path),
                "version": version,
                "appliedMigrations": applied,
                "integrity": status
            }

    def backup(self, destination: Path = None) -> Path:
        """
        Perform a safe online SQLite backup using the SQLite backup API.
        Does not risk WAL corruption.
        """
        with _lock:
            if not destination:
                ts = int(time.time())
                dest_dir = self.db_path.parent / "backups"
                dest_dir.mkdir(parents=True, exist_ok=True)
                destination = dest_dir / f"aura_backup_{ts}.db"
            else:
                destination = Path(destination)
                destination.parent.mkdir(parents=True, exist_ok=True)

            source_conn = self.get_connection()
            dest_conn = sqlite3.connect(str(destination))
            try:
                source_conn.backup(dest_conn)
                print(f"[DB] Backup created successfully at {destination}", flush=True)
            finally:
                dest_conn.close()
            return destination

    def restore(self, backup_path: Path) -> bool:
        """Restore database from a backup file."""
        with _lock:
            backup_path = Path(backup_path)
            if not backup_path.exists():
                raise FileNotFoundError(f"Backup file not found: {backup_path}")
            
            self.close_thread_connection()
            dest_conn = sqlite3.connect(str(self.db_path))
            src_conn = sqlite3.connect(str(backup_path))
            try:
                src_conn.backup(dest_conn)
                print(f"[DB] Database restored from {backup_path}", flush=True)
                return True
            finally:
                src_conn.close()
                dest_conn.close()


# Default singleton instance
db_manager = DatabaseManager()
