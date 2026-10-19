/*
 * re0 website widget -- the loader. requirement.md 9.4.
 *
 * Pasted into a customer's page as
 *   <script src="https://re0.io/widget.js" data-site-key="mm_site_..." async></script>
 *
 * It does three things and nothing else: draws a launcher button in a corner,
 * opens the widget page (/embed) in an iframe when pressed, and carries the
 * iframe's navigation requests to the page it lives in. The chat itself runs
 * inside the iframe, where neither the host page's CSS nor its scripts can
 * reach it -- and where the server's frame-ancestors header decides whether
 * this site may show it at all.
 *
 * Messages from the iframe are accepted only from the origin this script was
 * loaded from and only from the frame this script created. A navigation to
 * the same origin as the host page replaces the page; anything else opens a
 * new tab, so a knowledge base that cites other sites never hijacks the one
 * the visitor is on.
 *
 * The widget page is loaded, hidden, as soon as the host page is idle rather
 * than on the first click: its config message carries the key's accent, and
 * the launcher should wear the owner's colour before anyone presses it, not
 * after. It also means a site that installed the snippet is seen by the
 * dashboard on the first visit, bubble opened or not.
 *
 * Optional attributes: data-position="left" (default right),
 * data-accent="#rrggbb" (the launcher's colour until the widget page has
 * loaded and sent the key's own), data-label="..." for the launcher's
 * accessible name.
 */
(function () {
  if (window.__re0Widget) return;
  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      return all[all.length - 1];
    })();
  if (!script) return;
  var key = script.getAttribute('data-site-key');
  if (!key) return;
  window.__re0Widget = true;

  var origin;
  try {
    origin = new URL(script.src, location.href).origin;
  } catch (e) {
    return;
  }
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var accent = script.getAttribute('data-accent') || '#0f9d77';
  var label = script.getAttribute('data-label') || 'Chat';

  var style = document.createElement('style');
  style.textContent =
    '.re0-launcher{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;width:56px;height:56px;border:0;border-radius:50%;background:' + accent + ';color:#fff;box-shadow:0 8px 24px rgba(15,23,42,.18);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s ease}' +
    '.re0-launcher:hover{transform:translateY(-1px)}' +
    '.re0-launcher svg{width:26px;height:26px}' +
    '.re0-panel{position:fixed;bottom:88px;' + side + ':20px;z-index:2147483000;width:380px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 112px);border:0;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.22);background:#fff;display:none;overflow:hidden}' +
    '.re0-panel[data-open="true"]{display:block}' +
    '@media (max-width:480px){.re0-panel{bottom:0;' + side + ':0;width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0}}';
  document.head.appendChild(style);

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 're0-launcher';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var frame = null;
  var open = false;

  function frameSrc() {
    var url = new URL('/embed', origin);
    url.searchParams.set('key', key);
    url.searchParams.set('parent', location.origin);
    url.searchParams.set('lang', document.documentElement.lang || navigator.language || '');
    return url.toString();
  }

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.className = 're0-panel';
    frame.title = label;
    frame.src = frameSrc();
    frame.setAttribute('referrerpolicy', 'origin');
    document.body.appendChild(frame);
    return frame;
  }

  function setOpen(next) {
    open = next;
    ensureFrame().setAttribute('data-open', next ? 'true' : 'false');
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next && frame && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage({ type: 're0:open' }, origin);
      } catch (e) {}
    }
  }

  button.addEventListener('click', function () {
    setOpen(!open);
  });

  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data || {};
    if (data.type === 're0:navigate' && typeof data.url === 'string') {
      var target;
      try {
        target = new URL(data.url, location.href);
      } catch (e) {
        return;
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return;
      if (target.origin === location.origin) {
        location.href = target.href;
      } else {
        window.open(target.href, '_blank', 'noopener');
      }
    } else if (data.type === 're0:close') {
      setOpen(false);
    } else if (data.type === 're0:config' && typeof data.accent === 'string') {
      button.style.background = data.accent;
    }
  });

  function mount() {
    document.body.appendChild(button);
    /* Preload once the host page has had its turn, so the accent arrives
       before the first click without competing with the page's own load. */
    var preload = function () {
      ensureFrame();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(preload, { timeout: 2000 });
    } else {
      setTimeout(preload, 0);
    }
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
