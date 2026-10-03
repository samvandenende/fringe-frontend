// Small dependency-free Python code editor: a transparent <textarea> over a highlighted <pre>.
// Edits go through execCommand('insertText') where possible so the browser's undo stack works.

const KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except ' +
  'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '));
const BUILTINS = new Set(('abs all any bool dict divmod enumerate filter float int isinstance len list map max min ' +
  'print range reversed round set sorted str sum tuple zip np numpy math self ctx').split(' '));

const TOKEN = new RegExp([
  /(#[^\n]*)/.source, // comment
  /((?:[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))/.source, // string
  /(\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?j?\b|\.\d+(?:[eE][+-]?\d+)?)/.source, // number
  /(@[\w.]+)/.source, // decorator
  /([A-Za-z_]\w*)/.source, // identifier
].join('|'), 'g');

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(code) {
  let out = '', last = 0, prevWord = '';
  for (const m of code.matchAll(TOKEN)) {
    out += escape(code.slice(last, m.index));
    last = m.index + m[0].length;
    const text = escape(m[0]);
    let cls = null;
    if (m[1]) cls = 'c';
    else if (m[2]) cls = 's';
    else if (m[3]) cls = 'n';
    else if (m[4]) cls = 'd';
    else if (prevWord === 'def' || prevWord === 'class') cls = 'f';
    else if (KEYWORDS.has(m[5])) cls = 'k';
    else if (BUILTINS.has(m[5])) cls = 'b';
    if (m[5]) prevWord = m[5]; else if (!m[1]) prevWord = '';
    out += cls ? `<span class="tk-${cls}">${text}</span>` : text;
  }
  return out + escape(code.slice(last));
}

const INDENT = '    ';

export class CodeEditor {
  /** root: empty element; options: { value, onRun, onChange } */
  constructor(root, { value = '', onRun, onChange } = {}) {
    root.classList.add('code-editor');
    root.innerHTML = '<div class="code-gutter" aria-hidden="true"></div>' +
      '<div class="code-stack"><pre class="code-hl" aria-hidden="true"><code></code></pre>' +
      '<textarea class="code-input" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Python code"></textarea></div>';
    this.gutter = root.querySelector('.code-gutter');
    this.code = root.querySelector('code');
    this.ta = root.querySelector('textarea');
    this.onRun = onRun;
    this.onChange = onChange;
    this.ta.value = value;
    this.ta.addEventListener('input', () => { this.refresh(); this.onChange?.(this.ta.value); });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.refresh();
  }

  get value() { return this.ta.value; }

  /** Replaces the whole text as one undoable edit. */
  setValue(text) {
    this.ta.focus();
    this.ta.select();
    this.insert(text);
    this.ta.setSelectionRange(0, 0);
    this.ta.scrollTop = 0;
  }

  refresh() {
    // Trailing newline needs a character after it to take up space in the <pre>.
    this.code.innerHTML = highlight(this.ta.value) + '\n';
    const lines = this.ta.value.split('\n').length;
    if (lines !== this.lines) {
      this.lines = lines;
      this.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
  }

  insert(text) {
    const ta = this.ta;
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  /** Applies fn to each full line touched by the selection, keeping the lines selected. */
  editLines(fn) {
    const ta = this.ta, v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n');
    const replaced = fn(lines).join('\n');
    ta.setSelectionRange(start, end);
    this.insert(replaced);
    ta.setSelectionRange(start, start + replaced.length);
  }

  onKey(e) {
    const ta = this.ta, v = ta.value;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); this.onRun?.(); return; }
    if (mod && e.key === '/') {
      e.preventDefault();
      this.editLines((lines) => {
        const active = lines.filter((l) => l.trim());
        const commented = active.length && active.every((l) => /^\s*#/.test(l));
        return lines.map((l) => (!l.trim() ? l : commented ? l.replace(/^(\s*)# ?/, '$1') : l.replace(/^(\s*)/, '$1# ')));
      });
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const multiline = v.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (e.shiftKey) this.editLines((lines) => lines.map((l) => l.replace(/^ {1,4}/, '')));
      else if (multiline) this.editLines((lines) => lines.map((l) => (l.trim() ? INDENT + l : l)));
      else {
        const col = ta.selectionStart - (v.lastIndexOf('\n', ta.selectionStart - 1) + 1);
        this.insert(' '.repeat(4 - (col % 4)));
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const before = v.slice(lineStart, ta.selectionStart);
      let indent = before.match(/^\s*/)[0];
      if (/:\s*(#.*)?$/.test(before)) indent += INDENT;
      else if (/^\s*(return|pass|break|continue|raise)\b/.test(before)) indent = indent.slice(0, Math.max(0, indent.length - 4));
      this.insert('\n' + indent);
      return;
    }
    if (e.key === 'Backspace' && ta.selectionStart === ta.selectionEnd) {
      const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const before = v.slice(lineStart, ta.selectionStart);
      if (before.length >= 4 && /^ +$/.test(before)) {
        e.preventDefault();
        const n = before.length % 4 || 4;
        ta.setSelectionRange(ta.selectionStart - n, ta.selectionStart);
        this.insert('');
      }
    }
  }
}
