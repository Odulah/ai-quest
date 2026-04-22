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

// ─── Progress Restore (Firestore → localStorage) ─────────────────────────────
//
// Called once at login. If a module's per-user localStorage key is missing or
// shows 0 done topics, but Firestore records that module as completed, we
// synthesise a full-completion entry so the user's progress is never lost
// just because they cleared their browser cache or switched devices.
//
// The restore is deliberately conservative:
//   • Only writes if the local key is absent OR has 0 topics done
//   • Never decreases progress already in localStorage
// ─────────────────────────────────────────────────────────────────────────────
window.restoreProgressFromFirestore = async function () {
  try {
    var userName = window.getCurrentUser();
    if (!userName) return;

    var fbApp = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    var fbFS  = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    var app = fbApp.getApps().length ? fbApp.getApps()[0] : fbApp.initializeApp(AQ_FIREBASE_CONFIG);
    var db  = fbFS.getFirestore(app);

    var ref  = fbFS.doc(db, 'users', userName);
    var snap = await fbFS.getDoc(ref);
    if (!snap.exists()) return;

    var data      = snap.data();
    var completed = Array.isArray(data.modulesCompleted) ? data.modulesCompleted : [];
    var AQ_TOTAL  = AQ_MODULE_REGISTRY.reduce(function (s, m) { return s + m.total; }, 0);

    // ── Pre-step: snapshot real per-user localStorage BEFORE any synthetic restore ──
    // This is the only reliable ground truth: what the user actually has on this device.
    // We capture it before step 1 writes synthetic entries, so step 2's correction
    // is based on real data — not the synthetic placeholders we're about to create.
    var preRestoreDone = 0;
    var preRestoreCompleted = [];
    AQ_MODULE_REGISTRY.forEach(function (mod) {
      try {
        var raw = localStorage.getItem(mod.key + '_' + userName);
        if (!raw) return;
        var s = JSON.parse(raw);
        if (s.user && s.user !== userName) return;
        if (s.synthetic) return;   // ignore synthetic placeholders from prior restores
        var d = s.done || {};
        var cnt = Object.keys(d).filter(function (k) { return d[k]; }).length;
        preRestoreDone += cnt;
        if (cnt >= mod.total) preRestoreCompleted.push(mod.id);
      } catch (e) { /* skip */ }
    });

    // ── Step 1: Restore completed-module localStorage entries ─────────────────
    // For any module marked complete in Firestore but absent (or empty) in
    // localStorage, synthesise a full-completion entry so the user never
    // perceives progress loss after clearing cache or switching devices.
    completed.forEach(function (modId) {
      var mod = AQ_MODULE_REGISTRY.filter(function (m) { return m.id === modId; })[0];
      if (!mod) return;

      var perUserKey = mod.key + '_' + userName;
      var existing   = localStorage.getItem(perUserKey);

      var state = null;
      try { state = existing ? JSON.parse(existing) : null; } catch (e) { state = null; }

      var localDone = state ? Object.keys(state.done || {}).filter(function (k) { return state.done[k]; }).length : 0;
      if (localDone >= mod.total) return;   // already complete locally — nothing to do

      // Placeholder keys t0…t(N-1); the module's own init() overwrites on next open.
      var done = {};
      for (var i = 0; i < mod.total; i++) { done['t' + i] = true; }
      var restoredXP = (state && state.xp && state.xp > 0) ? state.xp : mod.total * 50;

      localStorage.setItem(perUserKey, JSON.stringify({
        user:      userName,
        done:      done,
        xp:        restoredXP,
        qScores:   (state && state.qScores) || {},
        chDone:    (state && state.chDone)  || {},
        synthetic: true   // restored from Firestore — not from real module interaction
      }));
    });

    // ── Step 2: Correct inflated Firestore progress & modulesCompleted ──────────
    // We can ONLY safely auto-correct Firestore when the user has real per-user
    // localStorage data on this device (preRestoreDone > 0). That data is
    // authoritative: it was written by the user's actual module interactions with
    // the correct per-user key, so we know it is not legacy shared-key data.
    //
    // If preRestoreDone === 0 (empty localStorage — either cache cleared, or the
    // user never actually progressed), we CANNOT distinguish these two cases
    // automatically. Overwriting Firestore with 0 would wipe legitimate progress
    // for a user who simply cleared their cache. Leave Firestore untouched;
    // the manager can use the "Reset" button in the dashboard to fix specific users
    // whose Firestore data is known to be wrong.
    if (preRestoreDone > 0) {
      var recalcProgress = AQ_TOTAL > 0 ? Math.round(preRestoreDone / AQ_TOTAL * 100) : 0;
      var storedProg     = typeof data.progress === 'number' ? data.progress : 0;

      if (storedProg > recalcProgress || preRestoreCompleted.length < completed.length) {
        await fbFS.updateDoc(ref, {
          progress:         recalcProgress,
          modulesCompleted: preRestoreCompleted
        });
      }
    }

  } catch (e) {
    // Silently fail — localStorage remains source of truth
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
        // Only read the per-user key — never fall back to the shared legacy key.
        // The shared key has no `user` field, so any shared data would pass the
        // guard below and inflate progress for every user who logs in.
        var perUserKey = mod.key + '_' + userName;
        var raw = localStorage.getItem(perUserKey);
        if (!raw) return;
        var state    = JSON.parse(raw);
        // Guard: skip entries that belong to a different user
        if (state.user && state.user !== userName) return;
        // Guard: skip synthetic restore placeholders — they are not real user activity.
        // Once the user opens the module and marks a topic done, the synthetic flag
        // is cleared and the entry counts as real progress.
        if (state.synthetic) return;
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

    // ── 4. Merge: keep all completed modules; allow progress corrections ─────────
    var mergedMods = Array.from(new Set(existingMods.concat(completedMods)));

    // Floor progress at what's guaranteed by fully-completed modules.
    // Using the completed-modules floor (rather than existingProg) means that
    // if existingProg was inflated by the legacy shared-key bug, it can now
    // be corrected downward — while still protecting against a cache-clear on a
    // device that hasn't yet restored partial (non-complete) module progress.
    var completedTopics = mergedMods.reduce(function (sum, modId) {
      var entry = AQ_MODULE_REGISTRY.filter(function (m) { return m.id === modId; })[0];
      return sum + (entry ? entry.total : 0);
    }, 0);
    var completedFloor = AQ_TOTAL > 0 ? Math.round(completedTopics / AQ_TOTAL * 100) : 0;
    var mergedProg = Math.max(completedFloor, newProgress);

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
