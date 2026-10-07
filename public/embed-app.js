/*
 * The widget page's script (/embed). requirement.md 9.4.
 *
 * Reads its configuration from the JSON block the server wrote, asks
 * /api/embed/ask one question at a time, and renders what comes back line by
 * line: the passages first (every one a page the visitor can open), then the
 * bound sentences, then the outcome. No history is sent -- each question
 * stands alone, as in the playground.
 *
 * Navigation is the parent page's to do: a source card posts
 * {type:'re0:navigate', url} to the loader (public/widget.js), which decides
 * between replacing the host page and opening a tab. This frame never touches
 * `top.location` itself.
 */
(function () {
  var configNode = document.getElementById('re0-config');
  if (!configNode) return;
  var config = JSON.parse(configNode.textContent || '{}');
  var s = config.strings || {};
  var parentOrigin = config.parent;

  var transcript = document.getElementById('re0-transcript');
  var form = document.getElementById('re0-form');
  var input = document.getElementById('re0-input');
  var send = document.getElementById('re0-send');
  var close = document.getElementById('re0-close');

  function tell(message) {
    if (!parentOrigin || window.parent === window) return;
    try {
      window.parent.postMessage(message, parentOrigin);
    } catch (e) {}
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollDown() {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function userBubble(text) {
    transcript.appendChild(el('div', 're0-msg re0-msg-user', text));
    scrollDown();
  }

  function botBubble() {
    var bubble = el('div', 're0-msg re0-msg-bot');
    transcript.appendChild(bubble);
    scrollDown();
    return bubble;
  }

  function note(bubble, text) {
    bubble.appendChild(el('p', 're0-note', text));
    scrollDown();
  }

  /* Footnote numbers follow the order passages were returned in. */
  function claimParagraph(bubble, text, chunkIds, indexOf) {
    var p = el('p');
    p.appendChild(document.createTextNode(text));
    for (var i = 0; i < chunkIds.length; i++) {
      var n = indexOf[chunkIds[i]];
      if (n === undefined) continue;
      p.appendChild(el('sup', 're0-cite', '[' + (n + 1) + ']'));
    }
    bubble.appendChild(p);
    scrollDown();
  }

  function sourceList(bubble, sources) {
    if (sources.length === 0) return;
    var wrap = el('div', 're0-sources');
    wrap.appendChild(el('p', 're0-sources-title', s.sources || 'Related pages'));
    sources.forEach(function (source, index) {
      var card = el('button', 're0-source');
      card.type = 'button';
      var text = el('span', 're0-source-text');
      text.appendChild(el('span', 're0-source-title', '[' + (index + 1) + '] ' + source.title));
      if (source.section && source.section !== source.title) {
        text.appendChild(el('span', 're0-source-section', source.section));
      }
      card.appendChild(text);
      card.appendChild(el('span', 're0-source-open', s.open || 'Open'));
      card.addEventListener('click', function () {
        tell({ type: 're0:navigate', url: source.url });
      });
      wrap.appendChild(card);
    });
    bubble.appendChild(wrap);
    scrollDown();
  }

  var busy = false;

  function setBusy(next) {
    busy = next;
    send.disabled = next;
    input.disabled = next;
  }

  async function ask(question) {
    userBubble(question);
    var bubble = botBubble();
    var thinking = el('p', 're0-thinking', s.thinking || 'Thinking');
    bubble.appendChild(thinking);
    setBusy(true);

    var sources = [];
    var indexOf = {};
    var pending = null;
    var claims = 0;

    function handle(line) {
      if (line.type === 'sources') {
        /* Shown at the end, after the sentences that cite them; kept now so
           the footnotes can resolve as claims arrive. */
        sources = line.sources || [];
        sources.forEach(function (source, index) {
          indexOf[source.chunkId] = index;
        });
        pending = sources;
      } else if (line.type === 'claim') {
        if (thinking.parentNode) thinking.remove();
        claims += 1;
        claimParagraph(bubble, line.text, line.chunkIds || [], indexOf);
      } else if (line.type === 'outcome') {
        if (thinking.parentNode) thinking.remove();
        if (line.kind === 'not_ready') note(bubble, s.notReady || 'This site is not ready yet.');
        else if (line.kind === 'unavailable') note(bubble, s.unavailable || 'The assistant is unavailable right now.');
        else if (line.kind === 'no_context') note(bubble, s.noContext || 'Nothing relevant was found.');
        else if (line.kind === 'degraded' && claims === 0) note(bubble, s.degraded || 'Here is what was found:');
        if (pending && !pending.shown) {
          sourceList(bubble, pending);
          pending.shown = true;
        }
      }
    }

    try {
      var response = await fetch('/api/embed/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: config.key, question: question, parent: parentOrigin }),
      });
      if (!response.ok) {
        var code = null;
        try {
          code = (await response.json()).error.code;
        } catch (e) {}
        if (thinking.parentNode) thinking.remove();
        note(
          bubble,
          code === 'quota_exceeded'
            ? s.limitReached || 'This site has used its questions for today.'
            : code === 'rate_limited'
              ? s.rateLimited || 'Too many questions; please wait a moment.'
              : s.error || 'Something went wrong.',
        );
        return;
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].trim()) handle(JSON.parse(lines[i]));
        }
      }
      if (buffer.trim()) handle(JSON.parse(buffer));
      /* A stream that ended without an outcome still owes the visitor
         whatever arrived, and must not leave the dots blinking. */
      if (thinking.parentNode) thinking.remove();
      if (pending && !pending.shown) sourceList(bubble, pending);
    } catch (e) {
      if (thinking.parentNode) thinking.remove();
      note(bubble, s.error || 'Something went wrong.');
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var question = input.value.trim();
    if (!question || busy) return;
    input.value = '';
    ask(question);
  });

  close.addEventListener('click', function () {
    tell({ type: 're0:close' });
  });

  window.addEventListener('message', function (event) {
    if (event.origin !== parentOrigin) return;
    if (event.data && event.data.type === 're0:open') input.focus();
  });

  var welcome = botBubble();
  welcome.appendChild(el('p', null, config.welcome || ''));
  if (!config.ready) note(welcome, s.notReady || '');

  tell({ type: 're0:config', accent: config.accent });
  tell({ type: 're0:ready' });
})();
