// Runs inside the Waitwell page itself (before Waitwell's own code loads).
// Chrome tells a page it's "hidden" when you switch to another app or minimise the
// window, and web apps often stop updating the screen while hidden. That meant new
// tickets weren't drawn, so notifier.js couldn't see them and no chime played.
// This makes Waitwell believe it's always visible and keeps its screen updates running.
(() => {
    const docProto = Document.prototype;
    const nativeHidden = Object.getOwnPropertyDescriptor(docProto, 'hidden').get;
    const reallyHidden = () => nativeHidden.call(document);

    // 1. Always report "visible".
    const define = (name, value) => {
        try {
            Object.defineProperty(docProto, name, { configurable: true, get: () => value });
        } catch (error) { /* ignore */ }
    };
    define('hidden', false);
    define('webkitHidden', false);
    define('visibilityState', 'visible');
    define('webkitVisibilityState', 'visible');
    try { docProto.hasFocus = () => true; } catch (error) { /* ignore */ }

    // 2. Keep screen updates going. Chrome stops requestAnimationFrame completely in
    //    hidden pages, so while hidden we run those callbacks on a timer instead.
    const nativeRAF = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map(); // our id -> { callback, rafId, timerId }
    let nextId = 1;

    const run = (id) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        nativeCancel(entry.rafId);
        clearTimeout(entry.timerId);
        try { entry.callback(performance.now()); } catch (error) { setTimeout(() => { throw error; }); }
    };

    window.requestAnimationFrame = (callback) => {
        const id = nextId++;
        const entry = { callback, rafId: 0, timerId: 0 };
        pending.set(id, entry);
        entry.rafId = nativeRAF(() => run(id));
        if (reallyHidden()) entry.timerId = setTimeout(() => run(id), 50);
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        nativeCancel(entry.rafId);
        clearTimeout(entry.timerId);
    };

    // 3. Hide the "you've been hidden" events from Waitwell, and flush any frame
    //    callbacks that were waiting when the page went into the background.
    const onVisibility = (event) => {
        if (reallyHidden()) {
            pending.forEach((entry, id) => {
                if (!entry.timerId) entry.timerId = setTimeout(() => run(id), 50);
            });
        }
        event.stopImmediatePropagation();
    };
    ['visibilitychange', 'webkitvisibilitychange'].forEach((type) => {
        window.addEventListener(type, onVisibility, true);
    });
    window.addEventListener('blur', (event) => {
        if (event.target === window) event.stopImmediatePropagation();
    }, true);
})();
