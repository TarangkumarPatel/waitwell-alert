// Watches the "Being Served" panel. When a rep accepts a ticket, the card gets a
// steady glow (until you click it) and background.js plays a chime / posts to Teams.
(() => {
    const STATE_KEY = 'waitwell-notifier-state';
    const GONE_GRACE_MS = 15000; // a card must be missing this long before it counts as "left"

    const textOf = (element) => (element.textContent || '').replace(/\s+/g, ' ').trim();
    const linesOf = (element) => (element.innerText || element.textContent || '')
        .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

    // key -> last time the card was seen in Being Served
    let seen = new Map();
    // keys of cards still glowing (student not yet walked to the desk)
    let glowing = new Set();
    let baselined = false;
    try {
        const stored = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null');
        if (stored && Date.now() - stored.at < 30 * 60 * 1000) {
            seen = new Map(stored.keys.map((key) => [key, Date.now()]));
            glowing = new Set(stored.glowing || []);
            baselined = true;
        }
    } catch (error) { /* start fresh */ }

    const saveState = () => {
        try {
            sessionStorage.setItem(STATE_KEY, JSON.stringify({ at: Date.now(), keys: [...seen.keys()], glowing: [...glowing] }));
        } catch (error) { /* ignore */ }
    };

    // The Being Served panel: grow up from its heading until the next step
    // would also swallow the Waiting panels.
    const servedPanel = () => {
        const heading = [...document.querySelectorAll('body *')].find((element) => (
            element.children.length <= 2 && /^being served(\s*\(\d+\))?$/i.test(textOf(element))
        ));
        if (!heading) return null;
        let panel = heading;
        while (panel.parentElement && panel.parentElement !== document.body &&
            !/waiting (inside|outside)/i.test(textOf(panel.parentElement))) {
            panel = panel.parentElement;
        }
        return panel;
    };

    const isTicketText = (text) => /STU\s*Number/i.test(text);

    // Group headers look like "X-Table 2 - B (Labiba Hasan)".
    const tableHeaders = (panel) => [...panel.querySelectorAll('*')].filter((element) => {
        const text = textOf(element);
        if (!text || text.length > 100 || isTicketText(text)) return false;
        if (!/\(([^()]*[A-Za-z][^()]*)\)\s*$/.test(text)) return false;
        return ![...element.children].some((child) => textOf(child) === text);
    });

    const ticketCards = (panel, headers) => {
        const candidates = [...panel.querySelectorAll('*')].filter((element) => {
            const text = textOf(element);
            return isTicketText(text) && (text.match(/STU\s*Number/gi) || []).length === 1 &&
                !headers.some((header) => element.contains(header));
        });
        // Outermost element holding exactly one ticket (and no table header) = the whole card.
        return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
    };

    const parseTicket = (card, headers) => {
        const lines = linesOf(card);
        const stuIndex = lines.findIndex((line) => /STU\s*Number/i.test(line));
        const student = (stuIndex > 0 ? lines[stuIndex - 1] : lines[0] || 'A student').trim();
        const stu = (textOf(card).match(/STU\s*Number:?\s*(\d+)/i) || [])[1] || '';

        const header = headers.filter((element) => (
            !element.contains(card) &&
            (element.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
        )).pop();
        let table = 'their desk';
        let rep = 'the rep';
        if (header) {
            const match = textOf(header).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
            table = match ? match[1] : textOf(header);
            rep = match ? match[2] : rep;
        }

        return { key: stu ? `stu:${stu}` : `name:${student}`, student, stu, rep, table };
    };

    const scan = () => {
        const panel = servedPanel();
        if (!panel) return;
        const headers = tableHeaders(panel);
        const now = Date.now();
        const present = new Set();

        ticketCards(panel, headers).forEach((card) => {
            const ticket = parseTicket(card, headers);
            present.add(ticket.key);
            const isNew = !seen.has(ticket.key);
            seen.set(ticket.key, now);
            if (isNew && baselined) {
                glowing.add(ticket.key);
                try {
                    chrome.runtime.sendMessage({ type: 'ticket-accepted', ticket });
                } catch (error) {
                    // Extension was reloaded; the page needs a refresh to reconnect.
                }
            }
            // Re-apply every scan so the glow survives Waitwell re-drawing the card.
            card.dataset.waitwellKey = ticket.key;
            card.classList.toggle('waitwell-accepted-glow', glowing.has(ticket.key));
        });

        // Forget cards that have been gone a while, so a re-served ticket alerts again.
        seen.forEach((lastSeen, key) => {
            if (!present.has(key) && now - lastSeen > GONE_GRACE_MS) {
                seen.delete(key);
                glowing.delete(key);
            }
        });

        baselined = true; // first scan after load only records what's already there
        saveState();
    };

    // Click or tap a glowing card once you've taken the student to the desk.
    // That press only clears the glow: we swallow it so Waitwell doesn't also open the
    // ticket actions (Details / Assign / Transfer...). The glow is cleared when the
    // press is released (pointerup), which fires for mouse, touchscreen and pen alike.
    // Once the glow is gone, the next click or tap on the card works normally.
    const glowingCardFrom = (event) => event.target.closest && event.target.closest('.waitwell-accepted-glow');
    const swallow = (event) => {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    };

    let pressedCard = null;      // glowing card the current press started on
    let justCleared = null;      // { card, until }: swallow the click that follows the release

    const clearGlow = (card) => {
        glowing.delete(card.dataset.waitwellKey);
        card.classList.remove('waitwell-accepted-glow');
        saveState();
    };

    const inJustCleared = (event) => justCleared && Date.now() < justCleared.until &&
        justCleared.card.contains(event.target);

    window.addEventListener('pointerdown', (event) => {
        const card = glowingCardFrom(event);
        pressedCard = card || null;
        if (card) swallow(event);
    }, { capture: true, passive: false });

    window.addEventListener('pointerup', (event) => {
        const card = glowingCardFrom(event);
        if (!card) return;
        swallow(event);
        if (card === pressedCard) {
            clearGlow(card);
            justCleared = { card, until: Date.now() + 800 };
        }
        pressedCard = null;
    }, { capture: true, passive: false });

    window.addEventListener('pointercancel', () => { pressedCard = null; }, true);

    // Legacy mouse/touch events and the click itself: block them while the card is
    // glowing, and for a moment after the release that cleared it.
    ['mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu'].forEach((type) => {
        window.addEventListener(type, (event) => {
            if (glowingCardFrom(event) || inJustCleared(event)) swallow(event);
        }, { capture: true, passive: false });
    });

    let pending = false;
    const scheduleScan = () => {
        if (pending) return;
        pending = true;
        // Hidden tabs get their timers throttled by Chrome, so scan straight away there.
        if (document.hidden) {
            queueMicrotask(() => { pending = false; scan(); });
        } else {
            setTimeout(() => { pending = false; scan(); }, 400);
        }
    };

    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(scan, 2000);
    // Give the dashboard a moment to render before taking the baseline.
    setTimeout(scan, 1500);

    // Ask Chrome not to put this tab to sleep (Memory Saver), or no alerts would fire.
    try { chrome.runtime.sendMessage({ type: 'keep-tab-awake' }); } catch (error) { /* ignore */ }
})();
