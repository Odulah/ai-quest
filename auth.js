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
