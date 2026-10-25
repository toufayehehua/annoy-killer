(() => {
  if (globalThis.AnnoyKillerShortcuts) return;
  const defaultKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";
  const keys = ["Meta", "Control", "Alt", "Shift", " ",
    ..."abcdefghijklmnopqrstuvwxyz0123456789"];
  const modifiers = { Meta: "metaKey", Control: "ctrlKey", Alt: "altKey", Shift: "shiftKey" };
  const normalize = key => typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;
  const validKey = key => keys.includes(normalize(key)) ? normalize(key) : defaultKey;
  const label = key => ({ Meta: "Command", Alt: /Mac/.test(navigator.platform) ? "Option" : "Alt", " ": "Space" })[key]
    || (key.length === 1 ? key.toUpperCase() : key);

  function createDetector(getKey, onDoubleTap) {
    let downAt = null;
    let releasedAt = null;
    const reset = () => { downAt = null; releasedAt = null; };
    const handleKey = event => {
      const key = getKey();
      const editable = event.composedPath().some(node => node instanceof HTMLElement &&
        (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) ||
          node.getAttribute("role") === "textbox"));
      if (!event.isTrusted || event.isComposing || normalize(event.key) !== key ||
          (!modifiers[key] && editable) ||
          Object.entries(modifiers).some(([name, flag]) => name !== key && event[flag])) {
        reset();
        return;
      }
      const now = performance.now();
      if (event.type === "keydown") {
        if (event.repeat || downAt !== null) { reset(); return; }
        downAt = now;
        return;
      }
      if (downAt === null || now - downAt > 350) { reset(); return; }
      downAt = null;
      if (releasedAt !== null && now - releasedAt <= 400) {
        reset();
        event.preventDefault();
        event.stopImmediatePropagation();
        onDoubleTap();
      } else {
        releasedAt = now;
      }
    };
    return { handleKey, reset };
  }
  globalThis.AnnoyKillerShortcuts = { defaultKey, keys, validKey, label, createDetector };
})();
