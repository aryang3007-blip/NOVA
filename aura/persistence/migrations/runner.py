"""
AURA :: Migration Runner
========================
Discovers, executes, and logs versioned SQLite migrations in strict sequential order.
Every migration is executed within an atomic transaction.
"""

import os
import time
import sqlite3
from pathlib import Path
from typing import List, Tuple

MIGRATIONS_DIR = Path(__file__).parent


class MigrationRunner:
    def __init__(self, db_manager):
        self.db_manager = db_manager

    def ensure_migration_table(self, conn: sqlite3.Connection):
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at REAL NOT NULL,
                    description TEXT NOT NULL
                );
            """)

    def get_current_version(self) -> int:
        conn = self.db_manager.get_connection()
        self.ensure_migration_table(conn)
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(version) FROM schema_migrations;")
        row = cursor.fetchone()
        return row[0] if (row and row[0] is not None) else 0

    def discover_migrations(self) -> List[Tuple[int, str, Path]]:
        """Find all .sql files formatted as {version}_{description}.sql."""
        migrations = []
        for file in sorted(MIGRATIONS_DIR.glob("*.sql")):
            parts = file.stem.split("_", 1)
            try:
                version = int(parts[0])
                desc = parts[1] if len(parts) > 1 else ""
                migrations.append((version, desc, file))
            except ValueError:
                continue
        return sorted(migrations, key=lambda x: x[0])

    def run_pending(self) -> List[int]:
        """Apply all unapplied migrations transactionally."""
        conn = self.db_manager.get_connection()
        self.ensure_migration_table(conn)
        current = self.get_current_version()
        all_migrations = self.discover_migrations()
        applied = []

        for version, desc, sql_path in all_migrations:
            if version > current:
                print(f"[DB] Applying migration {version:03d} ({desc})...", flush=True)
                sql = sql_path.read_text(encoding="utf-8")
                try:
                    with conn:
                        conn.executescript(sql)
                        conn.execute(
                            "INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?);",
                            (version, time.time(), desc)
                        )
                    applied.append(version)
                    print(f"[DB] Migration {version:03d} applied successfully.", flush=True)
                except Exception as e:
                    print(f"[DB] FATAL: Migration {version:03d} failed: {e}", flush=True)
                    raise

        return applied
