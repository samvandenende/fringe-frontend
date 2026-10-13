// Python code dialog: editor, console and preview for user-written functions that the server runs
// with its own Python (POST /api/python). Each kind (array layout, calibrator trajectory, transmit
// buffer) keeps its own editor, console, preview and saved code; the dialog shows one at a time.
import { CodeEditor } from './editor.js';
import { si } from './plot.js';

const $ = (id) => document.getElementById(id);

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * ctx: { api, available() → { ok, reason } }
 * kinds: { [kind]: {
 *   title, fn ('layout'), what ('antennas'), applyLabel, storageKey, examples: [{ name, code }],
 *   context() → object passed as ctx,
 *   decode?(response) → result (default: { positions }), count?(result) → rows returned,
 *   mountPreview(el) → { show(result | null) },
 *   apply(result, code),
 * } }
 */
export function createPythonDialog(ctx, kinds) {
  const panels = {};
  let active = null;

  function console(panel, parts) {
    const el = panel.console;
    el.innerHTML = '';
    for (const [text, cls] of parts) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text.endsWith('\n') ? text : text + '\n';
      el.appendChild(span);
    }
    el.scrollTop = el.scrollHeight;
  }

  function panelFor(kind) {
    if (panels[kind]) return panels[kind];
    const k = kinds[kind];
    const editorEl = Object.assign(document.createElement('div'), { className: 'py-editor' });
    const consoleEl = Object.assign(document.createElement('div'), { className: 'py-console' });
    consoleEl.setAttribute('aria-live', 'polite');
    const previewEl = Object.assign(document.createElement('div'), { className: 'py-preview-panel' });
    $('py-code').append(editorEl, consoleEl);
    $('py-preview').append(previewEl);
    let saved = null;
    try { saved = localStorage.getItem(k.storageKey); } catch { /* storage unavailable */ }
    const save = debounce((code) => { try { localStorage.setItem(k.storageKey, code); } catch { /* storage unavailable */ } }, 300);
    const panel = {
      kind, editorEl, console: consoleEl, previewEl, result: null, running: false,
      editor: new CodeEditor(editorEl, { value: saved || k.examples[0].code, onRun: run, onChange: save }),
      preview: k.mountPreview(previewEl),
    };
    panels[kind] = panel;
    panel.editor.ta.setSelectionRange(0, 0); // start at the top rather than after the last line
    const { ok, reason } = ctx.available();
    console(panel, ok ? [[`Press Run (Ctrl+Enter) to execute ${k.fn}(ctx).`, 'muted']] : [[reason || 'Python code is unavailable on this server.', 'err']]);
    return panel;
  }

  function show(kind) {
    const k = kinds[kind];
    active = kind;
    const panel = panelFor(kind);
    for (const p of Object.values(panels)) {
      const on = p === panel;
      p.editorEl.hidden = p.console.hidden = p.previewEl.hidden = !on;
    }
    $('py-title').textContent = k.title;
    $('py-fn').textContent = `${k.fn}(ctx)`;
    $('py-apply').textContent = k.applyLabel;
    $('py-apply').disabled = !panel.result;
    $('py-run').disabled = !ctx.available().ok || panel.running;
    const select = $('py-example');
    select.length = 1;
    k.examples.forEach((ex, i) => select.add(new Option(ex.name, String(i))));
    return panel;
  }

  async function run() {
    const panel = panels[active];
    const k = kinds[active];
    if (!panel || panel.running || !ctx.available().ok) return;
    panel.running = true;
    $('py-run').disabled = true;
    $('py-run').textContent = 'Running…';
    try {
      const res = await ctx.api('/python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: active, code: panel.editor.value, context: k.context() }),
      });
      const parts = res.stdout ? [[res.stdout, '']] : [];
      if (res.error) {
        panel.result = null;
        parts.push([res.error, 'err']);
      } else {
        const decoded = k.decode ? k.decode(res) : { positions: res.positions.map(([x, y, z]) => ({ x, y, z })) };
        panel.result = { ...decoded, code: panel.editor.value };
        const count = k.count ? k.count(panel.result) : panel.result.positions.length;
        parts.push([`✓ ${k.fn}() returned ${count.toLocaleString()} ${k.what} in ${si(res.elapsed_s, 3, 's')}`, 'ok']);
        panel.preview.show(panel.result);
      }
      console(panel, parts);
    } catch (e) {
      panel.result = null;
      console(panel, [[e.message, 'err']]);
    } finally {
      panel.running = false;
      if (active === panel.kind) {
        $('py-run').disabled = false;
        $('py-apply').disabled = !panel.result;
      }
      $('py-run').textContent = '▶ Run';
    }
  }

  $('py-example').addEventListener('change', (e) => {
    if (e.target.value === '' || !active) return;
    panels[active].editor.setValue(kinds[active].examples[+e.target.value].code); // undoable with Ctrl+Z
    e.target.value = '';
  });
  $('py-run').addEventListener('click', run);
  $('py-apply').addEventListener('click', () => {
    const panel = panels[active];
    if (!panel || !panel.result) return;
    kinds[active].apply(panel.result, panel.result.code);
    $('py-dialog').close();
  });
  $('py-close').addEventListener('click', () => $('py-dialog').close());

  return {
    /** Opens the dialog for a kind, running its code straight away the first time. */
    open(kind) {
      const panel = show(kind);
      $('py-dialog').showModal();
      panel.editor.ta.focus();
      if (!panel.result && ctx.available().ok) run();
      else panel.preview.show(panel.result);
    },
  };
}
