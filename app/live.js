// Hearth realtime client.
//
// One connection per open channel. Every close is expected — Yard closes a
// WebSocket session after 24 hours, and `yard dev` restarts the runtime on
// every save — so the only correct client is one that always reconnects.
(function () {
  "use strict";

  var RETRY_MIN = 500;
  var RETRY_MAX = 8000;

  // Built relative to the page: the service can be mounted under any path and
  // a sandbox adds a segment, so a root-absolute URL would break both.
  function socketURL(channelId) {
    var url = new URL("api/channels/" + channelId + "/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  function connect(channelId, handlers) {
    var url = socketURL(channelId);
    var ws = null;
    var timer = null;
    var retry = RETRY_MIN;
    var stopped = false;

    function status(value) {
      if (handlers.status) handlers.status(value);
    }

    function schedule() {
      if (stopped || timer) return;
      timer = setTimeout(function () {
        timer = null;
        open();
      }, retry);
      retry = Math.min(RETRY_MAX, Math.round(retry * 1.8));
    }

    function open() {
      if (stopped) return;
      var socket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        schedule();
        return;
      }
      ws = socket;

      socket.onopen = function () {
        if (ws !== socket) return;
        retry = RETRY_MIN;
        status("open");
      };

      socket.onmessage = function (e) {
        if (ws !== socket) return;
        var event;
        try {
          event = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        // The channel was deleted out from under us: stop, do not reconnect.
        if (event.t === "gone") {
          stopped = true;
          if (handlers.event) handlers.event(event);
          return;
        }
        if (handlers.event) handlers.event(event);
      };

      socket.onclose = function () {
        if (ws !== socket) return;
        ws = null;
        status("closed");
        schedule();
      };

      socket.onerror = function () {
        try {
          socket.close();
        } catch (e) {
          // Already closing.
        }
      };
    }

    open();

    return {
      channelId: channelId,
      send: function (payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
          ws.send(JSON.stringify(payload));
          return true;
        } catch (e) {
          return false;
        }
      },
      close: function () {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        var socket = ws;
        ws = null;
        if (socket) {
          try {
            socket.close(1000, "leaving");
          } catch (e) {
            // Already gone.
          }
        }
      },
    };
  }

  window.HearthLive = { connect: connect };
})();
