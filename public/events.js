// Faseela event delegation (CSP hardening, review F-16): replaces inline on* handlers.
//
// Markup: <button data-click="openInvestModal('tree_01', true)">, <form data-submit="handleX(event)">,
// <input data-input="setModalSharesCount(this.value)">. The attribute holds a tiny call list that is
// parsed here with a whitelist grammar (no eval, no Function()):
//   calls  := call (';' call)*
//   call   := IDENT '(' [arg (',' arg)*] ')'
//   arg    := 'string' | "string" | number | true | false | null | undefined
//           | event | this | this.value | this.checked | this.dataset.<key>
// IDENT must resolve to a global function (window[IDENT]). Anything else is rejected and logged.
(function () {
  'use strict';

  const EVENTS = ['click', 'change', 'input', 'submit', 'keydown', 'scroll'];
  const cache = new Map();

  function unescapeString(raw) {
    return raw.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r' }[c] || c));
  }

  function splitTopLevel(src, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        current += ch;
        if (ch === '\\') { current += src[i + 1] || ''; i += 1; } else if (ch === quote) { quote = null; }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === separator && depth === 0) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    return parts;
  }

  function parseArg(raw) {
    const text = raw.trim();
    let match;
    if ((match = /^'((?:[^'\\]|\\.)*)'$/.exec(text)) || (match = /^"((?:[^"\\]|\\.)*)"$/.exec(text))) {
      return { type: 'literal', value: unescapeString(match[1]) };
    }
    if (/^-?\d+(\.\d+)?$/.test(text)) return { type: 'literal', value: Number(text) };
    if (text === 'true') return { type: 'literal', value: true };
    if (text === 'false') return { type: 'literal', value: false };
    if (text === 'null') return { type: 'literal', value: null };
    if (text === 'undefined') return { type: 'literal', value: undefined };
    if (text === 'event') return { type: 'event' };
    if (text === 'this') return { type: 'this' };
    if (text === 'this.value') return { type: 'value' };
    if (text === 'this.checked') return { type: 'checked' };
    if ((match = /^this\.dataset\.([A-Za-z_$][\w$]*)$/.exec(text))) return { type: 'dataset', key: match[1] };
    throw new Error(`unsupported argument: ${text}`);
  }

  function parseCalls(src) {
    if (cache.has(src)) return cache.get(src);
    const calls = splitTopLevel(src, ';').map((s) => s.trim()).filter(Boolean).map((call) => {
      const match = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(call);
      if (!match) throw new Error(`unsupported call: ${call}`);
      const argSrc = match[2].trim();
      return { name: match[1], args: argSrc ? splitTopLevel(argSrc, ',').map(parseArg) : [] };
    });
    cache.set(src, calls);
    return calls;
  }

  function resolveArg(arg, element, event) {
    switch (arg.type) {
      case 'literal': return arg.value;
      case 'event': return event;
      case 'this': return element;
      case 'value': return element.value;
      case 'checked': return element.checked;
      case 'dataset': return element.dataset[arg.key];
      default: return undefined;
    }
  }

  function run(element, attribute, event) {
    let calls;
    try {
      calls = parseCalls(element.getAttribute(attribute));
    } catch (error) {
      console.error('[events] rejected handler:', error.message);
      return;
    }
    for (const call of calls) {
      const fn = window[call.name];
      if (typeof fn !== 'function') {
        console.error(`[events] ${attribute}: ${call.name} is not a global function`);
        return;
      }
      fn.apply(element, call.args.map((arg) => resolveArg(arg, element, event)));
    }
  }

  function dispatch(type) {
    const attribute = `data-${type}`;
    return (event) => {
      const start = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!start) return;
      const element = type === 'scroll' || type === 'input' || type === 'change'
        ? (start.hasAttribute(attribute) ? start : null)
        : start.closest(`[${attribute}]`);
      if (!element) return;
      if (type === 'click' && element.tagName === 'A' && element.getAttribute('href') === '#') event.preventDefault();
      run(element, attribute, event);
    };
  }

  for (const type of EVENTS) {
    // Capture phase so element-level scroll/input events (which do not bubble) are seen too.
    document.addEventListener(type, dispatch(type), type === 'scroll');
  }

  // Exposed for tests: parse without executing.
  window.FaseelaEvents = Object.freeze({ parseCalls });
})();
