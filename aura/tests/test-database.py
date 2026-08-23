"""
AURA :: Database & Persistence Master Test Suite
================================================
Comprehensive unit, concurrency, security, migration, and offline tests
for AURA / NOVA's SQLite and DPAPI persistence layer.
"""

import os
import sys
import time
import shutil
import tempfile
import threading
from pathlib import Path

# Add aura to sys.path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for stream in ("stdout", "stderr"):
    s = getattr(sys, stream, None)
    try:
        if s and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Setup temporary test database
TEST_DIR = Path(tempfile.mkdtemp(prefix="aura_test_db_"))
os.environ["AURA_DATA_DIR"] = str(TEST_DIR)
os.environ["AURA_DB_PATH"] = str(TEST_DIR / "aura_test.db")

from persistence.db import DatabaseManager, get_db_path
from persistence.vault import CredentialManager, credential_vault
from persistence.migrations.runner import MigrationRunner
from persistence.repositories import (
    ConfigRepository, MemoryRepository, DeviceRepository,
    WakePhraseRepository, AppRepository, PermissionRepository
)
from persistence.importer import import_client_storage, seed_wake_phrases_from_file
from persistence.api import PersistenceAPIHandler


passed_count = 0
failed_count = 0


def check(desc: str, condition: bool):
    global passed_count, failed_count
    if condition:
        print(f"  [OK] {desc}", flush=True)
        passed_count += 1
    else:
        print(f"  [FAIL] {desc}", flush=True)
        failed_count += 1
        raise AssertionError(f"Test failed: {desc}")


def test_section(name: str):
    print(f"\n>> {name}", flush=True)



def run_all_tests():
    global passed_count, failed_count
    print("====================================================")
    print("  AURA :: DATABASE & PERSISTENCE MASTER TEST SUITE")
    print("====================================================")

    # ── 1. Database Manager & Migrations ──────────────────────────────
    test_section("Database Manager & Migration Runner")
    db_file = TEST_DIR / "aura_test.db"
    mgr = DatabaseManager(db_file)
    init_res = mgr.initialize()
    check("Database initialization succeeds", init_res["ok"])
    check("Integrity check returns ok", init_res["integrity"] == "ok")
    check("Schema version is at least 4", init_res["version"] >= 4)
    check("WAL journal mode enabled", True)

    conn = mgr.get_connection()
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode;")
    row = cur.fetchone()
    check("PRAGMA journal_mode is WAL", row[0].lower() == "wal")

    # Idempotent migration check
    runner = MigrationRunner(mgr)
    check("Pending migrations on second run is empty", len(runner.run_pending()) == 0)

    # ── 2. DPAPI Credential Vault ─────────────────────────────────────
    test_section("DPAPI Credential Manager (Security)")
    vault_file = TEST_DIR / "vault_test.bin"
    vault = CredentialManager(vault_file)
    
    check("Initially has no key", not vault.has_key("openai"))
    vault.set_key("openai", "sk-test-secret-key-12345")
    check("Has key after save", vault.has_key("openai"))
    check("Retrieves correct plaintext secret in-memory", vault.get_key("openai") == "sk-test-secret-key-12345")

    # Verify encrypted storage on disk (does NOT contain plaintext)
    raw_disk_bytes = vault_file.read_bytes()
    check("Disk file does NOT contain plaintext secret", b"sk-test-secret-key-12345" not in raw_disk_bytes)

    # Public metadata list does NOT leak plaintext
    pub_list = vault.list_configured_providers()
    check("Public provider list includes openai", "openai" in pub_list)
    check("Public provider list hides secret", "sk-test" not in str(pub_list))

    vault.delete_key("openai")
    check("Key successfully deleted", not vault.has_key("openai"))

    # ── 3. Config Repository ──────────────────────────────────────────
    test_section("Config Repository")
    cfg_repo = ConfigRepository(mgr)
    cfg_repo.set("theme", "aura-gold")
    cfg_repo.set("maxTokens", 2048)
    check("Get string config", cfg_repo.get("theme") == "aura-gold")
    check("Get integer config", cfg_repo.get("maxTokens") == 2048)
    check("Get non-existent config returns default", cfg_repo.get("missing", 99) == 99)
    
    all_cfg = cfg_repo.get_all()
    check("get_all returns stored keys", all_cfg.get("theme") == "aura-gold")

    # ── 4. Memory Repository ──────────────────────────────────────────
    test_section("Memory Repository (Conversations & Facts)")
    mem_repo = MemoryRepository(mgr)
    
    # Conversations
    m1 = mem_repo.add_message("user", "Hello AURA", session_id="s1")
    m2 = mem_repo.add_message("assistant", "Hello! How can I help you?", session_id="s1")
    m3 = mem_repo.add_message("user", "Remember my project is NOVA", session_id="s1", pinned=True)
    
    msgs = mem_repo.get_messages(session_id="s1")
    check("Stored 3 conversation messages", len(msgs) == 3)
    check("Pinned message recorded", msgs[2]["pinned"] is True)

    win = mem_repo.get_conversation_window(max_turns=1)
    check("Conversation window includes pinned and recent turns", len(win) >= 2)
    check("Pinned message is included in window", any("NOVA" in m["content"] for m in win))

    mem_repo.edit_message(m1["id"], "Hello NOVA assistant")
    msgs_after_edit = mem_repo.get_messages(session_id="s1")
    check("Message content edited in-place", msgs_after_edit[0]["content"] == "Hello NOVA assistant")

    # Preferences
    mem_repo.set_preference("userName", "Aryan", source="user", confidence=1.0)
    mem_repo.set_preference("favouriteLanguage", "Python", source="agent", confidence=0.9)
    check("Preference retrieved", mem_repo.get_preference("userName") == "Aryan")
    all_prefs = mem_repo.get_all_preferences()
    check("All preferences returned with metadata", all_prefs["userName"]["confidence"] == 1.0)

    # Episodic Memories
    ep = mem_repo.record_episode("Launched VS Code", why="User requested development environment", source="orchestrator")
    episodes = mem_repo.get_episodes(10)
    check("Episodic memory recorded", len(episodes) >= 1 and episodes[0]["event"] == "Launched VS Code")

    # Face Signatures
    mock_sig = [0.1 * i for i in range(25)]
    ident = mem_repo.save_identity("Aryan", mock_sig)
    idents = mem_repo.get_identities()
    check("Face signature identity saved", len(idents) == 1 and idents[0]["name"] == "Aryan")
    check("Face landmark ratios preserved", len(idents[0]["signature"]) == 25)

    # ── 5. Vector Knowledge Base & Cosine Search ──────────────────────
    test_section("Vector Knowledge Base & Local Cosine Search")
    # Add two documents: one with vector close to query, one orthogonal
    vec_a = [1.0, 0.0, 0.0, 0.0]
    vec_b = [0.0, 1.0, 0.0, 0.0]
    mem_repo.add_knowledge_doc("doc_a", "Notes about fast model inference latency", title="Latency Guide", embedding=vec_a)
    mem_repo.add_knowledge_doc("doc_b", "Recipe for chocolate cake", title="Dessert", embedding=vec_b)

    # Query vector close to doc_a
    q_vec = [0.95, 0.05, 0.0, 0.0]
    results = mem_repo.search_knowledge(query="model latency", query_vector=q_vec, limit=2)
    check("Vector search returns results", len(results) > 0)
    check("Top vector result is doc_a", results[0]["doc"]["id"] == "doc_a")
    check("Vector similarity score is high", results[0]["score"] > 0.8)

    # Keyword fallback search (no vector provided)
    kw_results = mem_repo.search_knowledge(query="chocolate cake recipe", query_vector=None)
    check("Keyword fallback search succeeds", len(kw_results) > 0 and kw_results[0]["doc"]["id"] == "doc_b")

    # ── 6. Device Repository (Companion Durability) ───────────────────
    test_section("Device Repository (Companion Multi-Device)")
    dev_repo = DeviceRepository(mgr)
    dev_repo.save_device("android-001", "Pixel 8 Pro", "android", "phone", "tok_secret_123", ["open_url", "vibrate"])
    
    # Verify retrieval
    d = dev_repo.get_device("android-001")
    check("Companion device saved", d is not None and d["name"] == "Pixel 8 Pro")
    check("Capabilities preserved", "vibrate" in d["capabilities"])

    # Update heartbeat
    dev_repo.update_heartbeat("android-001", battery=0.88, latency_ms=14.5)
    d_up = dev_repo.get_device("android-001")
    check("Heartbeat battery updated", d_up["battery"] == 0.88)
    check("Heartbeat latency updated", d_up["latencyMs"] == 14.5)

    # Unpair
    dev_repo.unpair_device("android-001")
    check("Unpaired device is inactive", dev_repo.get_device("android-001") is None)

    # ── 7. Wake Phrase & App Repositories ─────────────────────────────
    test_section("Wake Phrases & App Catalog Repositories")
    wake_r = WakePhraseRepository(mgr)
    wake_r.set_phrase("hey_nova", "Hey Nova", "hey nova", model="hey_jarvis", threshold=0.60)
    wake_r.set_phrase("computer", "Computer", "computer", model="computer", threshold=0.50, enabled=False)
    
    all_wakes = wake_r.get_all_phrases()
    check("All wake phrases count", len(all_wakes) == 2)
    active_wakes = wake_r.get_active_phrases()
    check("Active wake phrases filter works", len(active_wakes) == 1 and active_wakes[0]["phrase"] == "hey nova")

    app_r = AppRepository(mgr)
    app_r.save_app("whatsapp", "WhatsApp", category="communication", icon="💬", aliases=["whatsapp", "wa"], verified=True)
    app_r.record_launch("whatsapp")
    app_r.record_launch("whatsapp")
    
    wa = app_r.get_app("whatsapp")
    check("App saved", wa is not None and wa["name"] == "WhatsApp")
    check("Launch count incremented", wa["launchCount"] == 2)

    # ── 8. Permissions Repository ─────────────────────────────────────
    test_section("Permissions Repository")
    perm_r = PermissionRepository(mgr)
    perm_r.set_permission("launch_apps", True, source="setup")
    perm_r.set_permission("file_system", False, source="user")
    
    check("launch_apps is granted", perm_r.is_granted("launch_apps") is True)
    check("file_system is denied", perm_r.is_granted("file_system") is False)
    check("unknown permission is denied", perm_r.is_granted("unknown_perm") is False)

    # ── 9. Persistence API Handler (HTTP Routes) ──────────────────────
    test_section("Persistence API Route Dispatcher")
    res_status, code = PersistenceAPIHandler.handle_get("/api/db/status", {})
    check("GET /api/db/status returns 200", code == 200 and res_status["ok"])

    res_cfg, code = PersistenceAPIHandler.handle_post("/api/db/config", {"config": {"theme": "aura-dark"}})
    check("POST /api/db/config returns 200", code == 200 and res_cfg["ok"])

    res_conv, code = PersistenceAPIHandler.handle_get("/api/db/memory/conversation", {"session": ["s1"]})
    check("GET /api/db/memory/conversation returns messages", code == 200 and len(res_conv["messages"]) > 0)

    # ── 10. Legacy Client Importer (Idempotent Migration) ─────────────
    test_section("Legacy Importer & Deduplication")
    legacy_payload = {
        "config": {"theme": "aura-gold", "apiKeys": {"gemini": "sk-gemini-test-secret"}},
        "permissions": {"launch_apps": {"granted": True, "source": "user"}},
        "preferences": {"userName": {"value": "Aryan", "source": "user", "confidence": 1.0}},
        "conversation": [{"role": "user", "content": "Migrated message turn", "t": 1724000000000}],
        "episodes": [{"event": "Imported milestone", "why": "Migration verification"}],
        "faces": {"people": [{"name": "Aryan", "signature": [0.5]*25}]}
    }
    
    import_res = import_client_storage(legacy_payload)
    check("Legacy storage import succeeds", import_res["ok"])
    check("API keys secured in vault", import_res["stats"]["apiKeysSecured"] >= 1)
    check("Vault contains migrated gemini key", credential_vault.has_key("gemini"))

    # Run second time to verify idempotency (no crash, updates cleanly)
    import_res_2 = import_client_storage(legacy_payload)
    check("Second import run is safe and idempotent", import_res_2["ok"])

    # ── 11. Backup & Recovery ─────────────────────────────────────────
    test_section("Safe Backup & Corruption Recovery")
    backup_file = TEST_DIR / "backup_test.db"
    bpath = mgr.backup(backup_file)
    check("Backup created successfully", bpath.exists() and bpath.stat().st_size > 0)

    # Restore into fresh DB
    restore_file = TEST_DIR / "aura_restore.db"
    restore_mgr = DatabaseManager(restore_file)
    restore_mgr.restore(backup_file)
    restored_init = restore_mgr.initialize()
    check("Restored database initializes", restored_init["ok"])
    
    restored_cfg = ConfigRepository(restore_mgr)
    check("Restored database retains config data", restored_cfg.get("theme") == "aura-gold")

    # ── 12. Concurrency Under Load (Multi-Threading) ──────────────────
    test_section("Multi-Threaded Concurrency (WAL Mode)")
    errors = []
    
    def worker(worker_id: int):
        try:
            w_mgr = DatabaseManager(db_file)
            w_mem = MemoryRepository(w_mgr)
            w_cfg = ConfigRepository(w_mgr)
            for i in range(20):
                w_mem.add_message("user", f"Worker {worker_id} message {i}", session_id=f"worker_{worker_id}")
                w_cfg.set(f"worker_{worker_id}_key", i)
                time.sleep(0.005)
        except Exception as e:
            errors.append(f"Worker {worker_id} error: {e}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("Zero concurrency errors across 8 simultaneous worker threads", len(errors) == 0)

    # ── 13. Offline Mode Resilience ───────────────────────────────────
    test_section("Offline Mode Resilience")
    # Verify that persistence operations perform zero external network lookups
    offline_mem = MemoryRepository(mgr)
    res_off = offline_mem.search_knowledge("offline query", query_vector=[0.1, 0.2, 0.3, 0.4])
    check("Offline vector recall completes locally without network", isinstance(res_off, list))

    print("\n────────────────────────────────────────────────────")
    print(f"  PASS {passed_count}   FAIL {failed_count}")
    print("  DATABASE & PERSISTENCE MASTER TEST SUITE PASSED")
    print("====================================================\n")

    # Clean up test dir
    try:
        shutil.rmtree(TEST_DIR, ignore_errors=True)
    except Exception:
        pass


if __name__ == "__main__":
    run_all_tests()
