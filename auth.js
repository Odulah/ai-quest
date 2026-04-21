// auth.js — shared session utility

/**
 * Returns the current logged-in user name from localStorage, or null if not logged in.
 * Checks both "aq_user" (primary) and "currentUser" (legacy) keys.
 */
window.getCurrentUser = function () {
  try {
    return localStorage.getItem("aq_user") || localStorage.getItem("currentUser") || null;
  } catch (e) {
    return null;
  }
};

/**
 * For module pages: redirect to login if no session exists.
 */
window.requireAuth = function () {
  if (!window.getCurrentUser()) {
    window.location.replace("../index.html");
  }
};

/**
 * For index.html: hide the login overlay immediately if session already exists.
 */
window.initIndexAuth = function () {
  if (window.getCurrentUser()) {
    var el = document.getElementById("aq-login-overlay");
    if (el) el.style.display = "none";
  }
};

// ─── Progress Sync ────────────────────────────────────────────────────────────
//
// Each module calls: window.syncProgressToFirestore()  after every save().
// This function:
//   1. Reads ALL module localStorage states to compute accurate overall progress.
//   2. Writes ONLY INCREASES to Firestore — never overwrites with lower values.
//   3. Silently fails — localStorage remains the authoritative local source.
//
// IMPORTANT: Never rename these localStorage keys or topic counts below.
// Changing them would break the mapping and could cause perceived progress loss.
// ─────────────────────────────────────────────────────────────────────────────

// IDs must match the MOD_LABELS keys in manager.html exactly.
// localStorage keys and total topic counts must NEVER be changed — doing so
// would break progress accounting for existing learners.
var AQ_MODULE_REGISTRY = [
  { id: 'agentic-workflows',   key: 'aw_v1',  total: 10 },
  { id: 'ai-fluency',          key: 'afl_v2', total: 10 },
  { id: 'ai-fundamentals',     key: 'aif_v1', total: 10 },
  { id: 'api-fundamentals',    key: 'api_v1', total:  8 },
  { id: 'claude-code-celonis', key: 'cc_v1',  total: 10 },
  { id: 'claude-mastery',      key: 'clm_v2', total: 17 },
  { id: 'context-engineering', key: 'ce_v1',  total: 10 },
  { id: 'git-version-control', key: 'git_v1', total: 10 },
  { id: 'prompt-engineering',  key: 'pe_v1',  total: 10 },
  { id: 'python-fundamentals', key: 'py_v3',  total: 10 },
  { id: 'sql-fundamentals',    key: 'sql_v1', total:  8 },
];

var AQ_FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA9ZCoaO03uVdZE0jnhO-jDtV3XqHomsp4",
  authDomain:        "ai-quest-977c3.firebaseapp.com",
  projectId:         "ai-quest-977c3",
  storageBucket:     "ai-quest-977c3.firebasestorage.app",
  messagingSenderId: "231396972103",
  appId:             "1:231396972103:web:af8d46cccf092331368362"
};

// Debounce so rapid saves don't flood Firestore
var _aqSyncTimer = null;

window.syncProgressToFirestore = function () {
  clearTimeout(_aqSyncTimer);
  _aqSyncTimer = setTimeout(function () { _aqDoSync(); }, 1500);
};

async function _aqDoSync() {
  try {
    var userName = window.getCurrentUser();
    if (!userName) return;

    // ── 1. Tally progress from all module localStorage states ──────────────
    var totalDone      = 0;
    var completedMods  = [];
    var AQ_TOTAL       = AQ_MODULE_REGISTRY.reduce(function(s,m){return s+m.total;}, 0); // 113

    AQ_MODULE_REGISTRY.forEach(function (mod) {
      try {
        // Use per-user key (mod.key + '_' + userName) — falls back to legacy shared key
        var perUserKey = mod.key + '_' + userName;
        var raw = localStorage.getItem(perUserKey) || localStorage.getItem(mod.key);
        if (!raw) return;
        var state    = JSON.parse(raw);
        // Only count progress that belongs to this user (guard against legacy shared data)
        if (state.user && state.user !== userName) return;
        var done     = state.done || {};
        var doneCnt  = Object.keys(done).filter(function(k){ return done[k]; }).length;
        totalDone   += doneCnt;
        if (doneCnt >= mod.total) completedMods.push(mod.id);
      } catch (e) { /* corrupt entry — skip */ }
    });

    var newProgress = AQ_TOTAL > 0 ? Math.round(totalDone / AQ_TOTAL * 100) : 0;

    // ── 2. Load Firebase SDK (dynamic import — no extra <script> tags needed) ──
    var fbApp  = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    var fbFS   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    var app = fbApp.getApps().length
      ? fbApp.getApps()[0]
      : fbApp.initializeApp(AQ_FIREBASE_CONFIG);
    var db  = fbFS.getFirestore(app);

    // ── 3. Read current Firestore values ──────────────────────────────────────
    var ref  = fbFS.doc(db, 'users', userName);
    var snap = await fbFS.getDoc(ref);
    if (!snap.exists()) return;          // user not in DB — skip silently

    var existing        = snap.data();
    var existingProg    = typeof existing.progress === 'number' ? existing.progress : 0;
    var existingMods    = Array.isArray(existing.modulesCompleted) ? existing.modulesCompleted : [];

    // ── 4. Merge: only ever increase — never decrease ─────────────────────────
    var mergedProg = Math.max(existingProg, newProgress);
    var mergedMods = Array.from(new Set(existingMods.concat(completedMods)));

    // Skip Firestore write if nothing changed
    if (mergedProg === existingProg && mergedMods.length === existingMods.length) return;

    await fbFS.updateDoc(ref, {
      progress:         mergedProg,
      modulesCompleted: mergedMods,
      lastActive:       new Date().toISOString()
    });
  } catch (e) {
    // Silently swallow — localStorage is the source of truth for the local experience.
    // Progress is safe; it'll sync next time.
  }
}
