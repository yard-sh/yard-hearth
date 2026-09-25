// Hearth landing page.
//
// Who is looking comes from Yard Auth, never from code in this repo. One
// session covers the page and every service of the project:
//   app/__yard/auth/me                always 200: { authenticated, user_id, email, ... }
//   __yard/auth/logout?return=/       ends the Hearth session, not the Yard
//                                     account, and comes back to this page
// Signing in needs no endpoint of its own: the app is access=authenticated, so
// following a link to app/ sends an anonymous visitor through Yard Auth and
// back into the app.
//
// window.yard.ownership() (injected by the edge through embed.js) adds the
// Yard avatar when there is one. Every URL is relative so the page works at
// <username>.yard.sh/hearth/, inside a /@sandbox/, and on a custom domain.
(function () {
  "use strict";

  // Resolve against the directory the page is served from, even when the URL
  // arrives without its trailing slash (/hearth rather than /hearth/).
  var base = location.href.split(/[?#]/)[0];
  if (!/\/$/.test(base) && !/\.html?$/.test(base)) base += "/";
  var APP = new URL("app/", base).href;
  var LOGOUT = new URL("__yard/auth/logout?return=/", base).href;

  var slot = document.getElementById("auth");
  var nav = document.getElementById("nav");

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(kid);
    });
    return node;
  }

  // Same hash and palette as the app, so a person's colour matches in both.
  function colorOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 8;
  }

  function avatar(who) {
    if (who.avatarUrl) {
      return el("img", { class: "me-av", src: who.avatarUrl, alt: "", width: "32", height: "32" });
    }
    return el("span", {
      class: "me-av av c" + colorOf(who.id || who.name),
      text: (who.name || "?").trim().charAt(0).toUpperCase() || "?",
      "aria-hidden": "true",
    });
  }

  async function getJSON(path) {
    try {
      var res = await fetch(new URL(path, APP), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        redirect: "error", // a gate redirect means "not signed in", not data
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  async function ownership() {
    try {
      if (window.yard && typeof window.yard.ownership === "function") {
        return await window.yard.ownership();
      }
    } catch (err) {}
    return null;
  }

  async function whoIsHere() {
    var results = await Promise.all([getJSON("__yard/auth/me"), ownership()]);
    var session = results[0];
    var yardState = results[1];
    var yardUser = yardState && yardState.signed_in ? yardState.user : null;

    if (!session || !session.authenticated) return null;

    // Signed in to Hearth: the app's own profile holds the username people
    // see on messages, so show that one.
    var profile = await getJSON("api/me");
    var name =
      (profile && profile.username) ||
      (yardUser && yardUser.username) ||
      (session.email ? session.email.split("@")[0] : "") ||
      "you";

    return {
      id: session.user_id || "",
      name: name,
      email: session.email || "",
      tier: session.tier || "",
      entitlement: session.entitlement || "none",
      avatarUrl: yardUser && yardUser.avatar_url ? yardUser.avatar_url : "",
    };
  }

  function renderSignedOut() {
    slot.replaceChildren(el("a", { class: "pill light small", href: APP, text: "Log in" }));
    slot.dataset.state = "out";
  }

  function renderSignedIn(who) {
    var menuId = "meMenu";
    var trigger = el(
      "button",
      {
        class: "me",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": menuId,
        title: who.email || who.name,
      },
      [avatar(who), el("span", { class: "me-name", text: who.name }), el("span", { class: "chev", "aria-hidden": "true" })],
    );

    var sub = who.entitlement === "owner" ? "Project owner" : who.tier || "";
    var menu = el("div", { class: "menu", id: menuId, role: "menu", hidden: "" }, [
      el("div", { class: "menu-head" }, [
        avatar(who),
        el("div", { class: "menu-id" }, [
          el("p", { class: "menu-name", text: who.name }),
          who.email ? el("p", { class: "menu-mail", text: who.email }) : null,
          sub ? el("p", { class: "menu-tier", text: sub }) : null,
        ]),
      ]),
      el("a", { class: "menu-item", role: "menuitem", href: APP, text: "Open Hearth" }),
      el("a", { class: "menu-item", role: "menuitem", href: "https://yard.sh/library/security", text: "Connected apps" }),
      el("a", { class: "menu-item quiet", role: "menuitem", href: LOGOUT, text: "Log out" }),
    ]);

    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        setOpen(false);
        trigger.focus();
      }
    });

    slot.replaceChildren(
      el("a", { class: "pill light small open", href: APP, text: "Open Hearth" }),
      el("div", { class: "me-wrap" }, [trigger, menu]),
    );
    slot.dataset.state = "in";

    // The rest of the page greets them too.
    var greet = document.getElementById("heroGreet");
    greet.textContent = "Welcome back, " + who.name + ".";
    greet.hidden = false;
    document.getElementById("heroPrimary").textContent = "Back to your servers";
    document.getElementById("closerCta").textContent = "Back to Hearth";
    var foot = document.getElementById("footAuth");
    foot.textContent = "Log out";
    foot.href = LOGOUT;
  }

  // Keep every "Open Hearth" link pointing at the resolved app URL.
  document.querySelectorAll('a[href="app/"]').forEach(function (a) {
    a.href = APP;
  });

  whoIsHere().then(function (who) {
    if (who) renderSignedIn(who);
    else renderSignedOut();
  });

  // The header gets a solid backdrop once the hero scrolls under it.
  var onScroll = function () {
    nav.classList.toggle("stuck", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
