"""
AURA :: File Organizer
======================
Sorts a folder into category subfolders — Images, Documents, Archives, and so
on — by file type.

WHY THIS IS BUILT "PLAN FIRST, THEN MOVE"
-----------------------------------------
Moving files is destructive in the way that matters most: it is silent. A user
who runs "organise my Downloads" and gets it wrong has no undo, and a bug that
mis-sorts 400 files is discovered days later.

So the module is split in two:

    plan(folder)                 -> exactly what WOULD move, and where
    apply(folder, plan_token)    -> performs that same plan

`plan()` touches nothing. `apply()` refuses unless it is handed the token from
a recent plan AND re-verifies that every source file is still where the plan
said it was. If anything changed underneath, it stops rather than guessing.

An undo journal is written next to the organised folder, so the whole operation
can be reversed exactly — including files that were renamed to avoid a clash.

SAFETY
------
 * Path jail: the folder, every source and every destination is resolved
   through bridge._resolve_path. Nothing outside the user's own folders.
 * Never recurses by default: only files directly in the folder are touched,
   so an already-organised tree is not re-shuffled.
 * Never moves a directory, a symlink, or a hidden/system file.
 * Never overwrites: a clash becomes "name-2.ext".
 * Skips the category folders it created, so running twice is a no-op.
"""

import os
import json
import time
import shutil
import secrets

MAX_FILES = 3000
JOURNAL_NAME = ".aura-organize.json"

# Extension -> category. Deliberately explicit: a lookup table a user can read
# and argue with beats a clever heuristic they cannot predict.
CATEGORIES = {
    "Images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".heic",
               ".tif", ".tiff", ".ico", ".raw", ".cr2", ".nef"],
    "Documents": [".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".md",
                  ".tex", ".pages", ".epub", ".mobi"],
    "Spreadsheets": [".xls", ".xlsx", ".csv", ".ods", ".tsv", ".numbers"],
    "Presentations": [".ppt", ".pptx", ".odp", ".key"],
    "Audio": [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma", ".opus", ".aiff"],
    "Video": [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg"],
    "Archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso", ".tgz"],
    "Installers": [".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".appimage", ".apk"],
    "Code": [".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json", ".xml",
             ".yml", ".yaml", ".c", ".cpp", ".h", ".java", ".rs", ".go", ".rb",
             ".php", ".sh", ".bat", ".ps1", ".sql", ".ipynb"],
    "Fonts": [".ttf", ".otf", ".woff", ".woff2", ".eot"],
    "Torrents": [".torrent"],
}

_EXT_MAP = {ext: cat for cat, exts in CATEGORIES.items() for ext in exts}
OTHER = "Other"
ALL_CATEGORY_NAMES = set(CATEGORIES) | {OTHER}

# Never move these, whatever their extension.
SKIP_NAMES = {"desktop.ini", "thumbs.db", ".ds_store", JOURNAL_NAME}

# Plans expire: a stale plan describes a folder that may have changed.
PLAN_TTL = 300.0
_plans = {}


def categorise(filename):
    """Category for a filename. Unknown extensions land in 'Other'."""
    ext = os.path.splitext(str(filename or ""))[1].lower()
    return _EXT_MAP.get(ext, OTHER)


def _unique(dest):
    """A path that does not exist yet: name.ext -> name-2.ext."""
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(dest)
    n = 2
    while os.path.exists(f"{stem}-{n}{ext}") and n < 500:
        n += 1
    return f"{stem}-{n}{ext}"


def plan(folder, resolver, include_hidden=False):
    """
    Work out what WOULD move. Touches nothing.

    @returns {ok, folder, token, moves:[{name, from, to, category, bytes}],
              counts:{category: n}, skipped:[{name, why}], total}
    """
    if resolver is None:
        return {"ok": False, "message": "Internal: no path resolver supplied."}
    root, err = resolver(folder, must_exist=True)
    if err:
        return {"ok": False, "message": err}
    if not os.path.isdir(root):
        return {"ok": False, "message": f"Not a folder: {root}"}

    moves, skipped, counts = [], [], {}
    try:
        entries = sorted(os.listdir(root))
    except Exception as e:
        return {"ok": False, "message": f"Could not read {root}: {e}"}

    if len(entries) > MAX_FILES:
        return {"ok": False,
                "message": f"Refused: {len(entries)} entries exceeds the {MAX_FILES} cap."}

    for name in entries:
        src = os.path.join(root, name)
        low = name.lower()

        if low in SKIP_NAMES:
            continue
        if os.path.islink(src):
            skipped.append({"name": name, "why": "symlink"})
            continue
        if os.path.isdir(src):
            # A folder we previously created is left alone, so re-running is safe.
            if name in ALL_CATEGORY_NAMES:
                continue
            skipped.append({"name": name, "why": "folder"})
            continue
        if not include_hidden and name.startswith("."):
            skipped.append({"name": name, "why": "hidden"})
            continue
        if not os.path.isfile(src):
            skipped.append({"name": name, "why": "not a regular file"})
            continue

        cat = categorise(name)
        dest_dir = os.path.join(root, cat)
        dest = os.path.join(dest_dir, name)
        # Jail-check the destination too: a crafted filename must not escape.
        checked, derr = resolver(dest, must_exist=False)
        if derr:
            skipped.append({"name": name, "why": derr})
            continue
        try:
            size = os.path.getsize(src)
        except Exception:
            size = 0
        moves.append({"name": name, "from": src, "to": checked,
                      "category": cat, "bytes": size})
        counts[cat] = counts.get(cat, 0) + 1

    token = secrets.token_urlsafe(12)
    _plans[token] = {"root": root, "moves": moves, "at": time.time()}
    # Bound the cache; these are tiny but should not grow forever.
    if len(_plans) > 20:
        for k in sorted(_plans, key=lambda k: _plans[k]["at"])[:-20]:
            _plans.pop(k, None)

    return {"ok": True, "folder": root, "token": token, "moves": moves,
            "counts": counts, "skipped": skipped, "total": len(moves),
            "message": (f"{len(moves)} file(s) would move into "
                        f"{len(counts)} folder(s)." if moves
                        else "Nothing to organise — no loose files here.")}


def apply(folder, token, resolver):
    """
    Perform a plan produced by `plan()`.

    Refuses a missing, stale or mismatched token, and re-checks every source
    before moving it: the folder may have changed since the preview.
    """
    entry = _plans.get(token or "")
    if not entry:
        return {"ok": False, "needsPlan": True,
                "message": "No matching preview. Run the preview again, then confirm."}
    if time.time() - entry["at"] > PLAN_TTL:
        _plans.pop(token, None)
        return {"ok": False, "needsPlan": True,
                "message": "That preview expired. Preview again so you can see "
                           "the current contents before anything moves."}

    root, err = resolver(folder, must_exist=True)
    if err:
        return {"ok": False, "message": err}
    if os.path.realpath(root) != os.path.realpath(entry["root"]):
        return {"ok": False, "needsPlan": True,
                "message": "That preview was for a different folder."}

    moved, failed, journal = [], [], []
    for m in entry["moves"]:
        src, dest = m["from"], m["to"]
        if not os.path.isfile(src):
            failed.append({"name": m["name"], "why": "vanished since the preview"})
            continue
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            final = _unique(dest)
            shutil.move(src, final)
            moved.append({"name": m["name"], "to": final, "category": m["category"]})
            journal.append({"from": src, "to": final})
        except Exception as e:
            failed.append({"name": m["name"], "why": str(e)})

    _plans.pop(token, None)

    if journal:
        try:
            jpath = os.path.join(root, JOURNAL_NAME)
            prev = []
            if os.path.isfile(jpath):
                with open(jpath, "r", encoding="utf-8") as f:
                    prev = json.load(f).get("runs", [])
            prev.append({"at": time.time(), "moves": journal})
            with open(jpath, "w", encoding="utf-8") as f:
                json.dump({"runs": prev[-10:]}, f, indent=1)
        except Exception:
            pass          # the journal is a convenience, never a blocker

    cats = sorted({m["category"] for m in moved})
    return {"ok": True, "folder": root, "moved": len(moved), "failed": failed,
            "categories": cats, "details": moved[:200],
            "undoable": bool(journal),
            "message": (f"Moved {len(moved)} file(s) into {len(cats)} folder(s): "
                        f"{', '.join(cats)}." if moved
                        else "Nothing moved.")
                       + (f" {len(failed)} failed." if failed else "")}


def undo(folder, resolver):
    """Reverse the most recent organise run, using the journal."""
    root, err = resolver(folder, must_exist=True)
    if err:
        return {"ok": False, "message": err}
    jpath = os.path.join(root, JOURNAL_NAME)
    if not os.path.isfile(jpath):
        return {"ok": False, "message": "No organise history for this folder."}
    try:
        with open(jpath, "r", encoding="utf-8") as f:
            runs = json.load(f).get("runs", [])
    except Exception as e:
        return {"ok": False, "message": f"Could not read the history: {e}"}
    if not runs:
        return {"ok": False, "message": "No organise history for this folder."}

    last = runs.pop()
    restored, failed = 0, []
    for mv in reversed(last.get("moves", [])):
        src, dest = mv.get("to"), mv.get("from")
        if not src or not dest or not os.path.isfile(src):
            failed.append(os.path.basename(str(src or "?")))
            continue
        s, e1 = resolver(src, must_exist=True)
        d, e2 = resolver(dest, must_exist=False)
        if e1 or e2:
            failed.append(os.path.basename(src))
            continue
        try:
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.move(s, _unique(d))
            restored += 1
        except Exception:
            failed.append(os.path.basename(src))

    # Tidy up any category folders left empty by the undo.
    for cat in ALL_CATEGORY_NAMES:
        p = os.path.join(root, cat)
        try:
            if os.path.isdir(p) and not os.listdir(p):
                os.rmdir(p)
        except Exception:
            pass

    try:
        with open(jpath, "w", encoding="utf-8") as f:
            json.dump({"runs": runs}, f, indent=1)
    except Exception:
        pass

    return {"ok": True, "restored": restored, "failed": failed,
            "message": f"Put {restored} file(s) back." +
                       (f" {len(failed)} could not be restored." if failed else "")}


def capabilities():
    return {"ok": True, "categories": sorted(CATEGORIES),
            "extensions": sum(len(v) for v in CATEGORIES.values()),
            "maxFiles": MAX_FILES, "planTtl": PLAN_TTL,
            "note": "Preview first; nothing moves until you confirm. Every run "
                    "is journalled so it can be undone."}
