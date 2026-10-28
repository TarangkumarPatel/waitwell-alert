// Watches the "Being Served" panel. When a rep accepts a ticket, the card gets a
// steady glow (until you click it) and background.js plays a chime / posts to Teams.
// Also mirrors Waiting Inside / Waiting Outside / Being Served to the dashboard
// (dashboard.html) and carries out its "move inside" and "clear glow" clicks.
// Everything stays inside this laptop's browser.
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
    // Glow can be switched off in the popup.
    let glowEnabled = true;
    try {
        chrome.storage.sync.get({ glow: true }).then((settings) => { glowEnabled = settings.glow; });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync' || !changes.glow) return;
            glowEnabled = changes.glow.newValue !== false;
            if (!glowEnabled) {
                glowing.clear();
                document.querySelectorAll('.waitwell-accepted-glow')
                    .forEach((card) => card.classList.remove('waitwell-accepted-glow'));
                saveState();
            }
        });
    } catch (error) { /* keep default */ }
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
            element.children.length <= 2 && /^being served\s*(\(\s*\d+(\s*\/\s*\d+)?\s*\))?$/i.test(textOf(element))
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
        if (!isShown(element)) return false;
        const text = textOf(element);
        if (!text || text.length > 100 || isTicketText(text)) return false;
        if (!/\(([^()]*[A-Za-z][^()]*)\)\s*$/.test(text)) return false;
        return ![...element.children].some((child) => textOf(child) === text);
    });

    // Only count what's actually on screen: Waitwell keeps hidden copies of ticket
    // details inside each card, and the glow must go on the visible card.
    const isShown = (element) => {
        if (element.checkVisibility && !element.checkVisibility()) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    };
    const visibleText = (element) => (element.innerText || '').replace(/\s+/g, ' ').trim();

    const ticketCards = (panel, headers) => {
        const candidates = [...panel.querySelectorAll('*')].filter((element) => {
            if (!isTicketText(element.textContent || '') || !isShown(element)) return false;
            const text = visibleText(element);
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


    // ---------------- Dashboard mirror ----------------

    // "Waiting Inside (2/20)" / "Waiting Outside (0)": grow up from the heading until
    // the next step would also swallow another panel.
    const waitingPanel = (which) => {
        const headingRe = new RegExp(`^waiting ${which}\\s*(\\(\\s*\\d+(\\s*\\/\\s*\\d+)?\\s*\\))?$`, 'i');
        const other = which === 'inside' ? 'outside' : 'inside';
        const stopRe = new RegExp(`being served|waiting ${other}`, 'i');
        const heading = [...document.querySelectorAll('body *')].find((element) => (
            element.children.length <= 2 && headingRe.test(textOf(element)) && isShown(element)
        ));
        if (!heading) return null;
        let panel = heading;
        while (panel.parentElement && panel.parentElement !== document.body &&
            !stopRe.test(textOf(panel.parentElement))) {
            panel = panel.parentElement;
        }
        return { panel, label: textOf(heading) };
    };

    const TAG_RE = /^(full[- ]?time|part[- ]?time|domestic|international|new|returning|online|in[- ]?person|virtual|appointment|walk[- ]?in|priority)$/i;
    const WAIT_RE = /^(\d+\s*h(r|rs|our|ours)?\s*)?\d+\s*(m|min|mins|minutes)$|^\d+\s*h(r|rs|our|ours)?$/i;

    const isTransparent = (color) => !color || color === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(color);

    // Average colour of a background image (Waitwell's textured card backgrounds).
    const imageColours = new Map(); // url -> 'rgb(...)' | '' (failed) | null (loading)
    const imageColour = (url) => {
        if (imageColours.has(url)) return imageColours.get(url);
        imageColours.set(url, null);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 24; canvas.height = 24;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 24, 24);
                const data = ctx.getImageData(0, 0, 24, 24).data;
                let r = 0; let g = 0; let b = 0; let a = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const w = data[i + 3] / 255;
                    r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; a += w;
                }
                imageColours.set(url, a ? `rgb(${Math.round(r / a)}, ${Math.round(g / a)}, ${Math.round(b / a)})` : '');
            } catch (error) { imageColours.set(url, ''); }
        };
        img.onerror = () => imageColours.set(url, '');
        img.src = url;
        return null;
    };

    // The colour a style paints: background colour, gradient or image.
    const paintedColour = (style) => {
        if (!isTransparent(style.backgroundColor)) return style.backgroundColor;
        const image = style.backgroundImage || '';
        if (image && image !== 'none') {
            const rgb = image.match(/rgba?\([^)]+\)/);
            if (rgb && !isTransparent(rgb[0])) return rgb[0];
            const url = image.match(/url\(["']?([^"')]+)["']?\)/);
            if (url) return imageColour(url[1]) || '';
        }
        return '';
    };

    // Card colour: the largest coloured box within the card (or the card itself).
    const cardColours = (card) => {
        const cardBox = card.getBoundingClientRect();
        const cardArea = Math.max(1, cardBox.width * cardBox.height);
        const fg = getComputedStyle(card).color;
        let queue = [[card, 0]];
        while (queue.length) {
            const next = [];
            for (const [element, depth] of queue) {
                const box = element.getBoundingClientRect();
                if (box.width * box.height >= cardArea * 0.5) {
                    for (const pseudo of [null, '::before', '::after']) {
                        const style = getComputedStyle(element, pseudo);
                        if (pseudo && (style.content === 'none' || style.content === 'normal')) continue;
                        const colour = paintedColour(style);
                        if (colour) return { bg: colour, fg: getComputedStyle(element).color || fg };
                    }
                }
                if (depth < 4) [...element.children].forEach((child) => next.push([child, depth + 1]));
            }
            queue = next;
        }
        return { bg: '', fg: '' };
    };

    // On-hold tickets: Waitwell greys them out (grey card, greyscale filter or faded),
    // or labels them "On hold".
    const isGreyish = (colour) => {
        const m = (colour || '').match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const max = Math.max(r, g, b); const min = Math.min(r, g, b);
        return max - min < 18 && max > 90 && max < 235;
    };
    const isOnHold = (card, lines, bg) => {
        if (lines.some((line) => /^(on\s*)?hold$|^on\s*hold\b/i.test(line))) return true;
        const style = getComputedStyle(card);
        if (/grayscale\((0\.[5-9]|1|[5-9]\d%|100%)|saturate\(0(\.[0-4])?\)/.test(style.filter)) return true;
        return isGreyish(bg);
    };

    // Name, queue, category, tags and wait time as shown on the card (no STU number or notes).
    const cardDetails = (card) => {
        const lines = linesOf(card);
        const stuIndex = lines.findIndex((line) => /STU\s*Number/i.test(line));
        const name = (stuIndex > 0 ? lines[stuIndex - 1] : lines[0] || 'Student').trim();
        const stu = (textOf(card).match(/STU\s*Number:?\s*(\d+)/i) || [])[1] || '';
        const after = lines.slice(stuIndex + 1);
        const queueLine = after.find((line) => /^queue\s*:/i.test(line));
        const programIndex = after.findIndex((line) => /^program code/i.test(line));
        const isInfo = (line) => line && !line.split(/\s+/).every((word) => TAG_RE.test(word)) && !/^((full|part)[- ]?time|domestic|international)+$/i.test(line.replace(/\s+/g, '')) && !WAIT_RE.test(line) && !/^queue\s*:/i.test(line) && line.length <= 70;
        let category = '';
        let queue = queueLine ? queueLine.replace(/^queue\s*:\s*/i, '') : '';
        if (programIndex >= 0) {
            const next = after[programIndex + 1];
            const nextNext = after[programIndex + 2];
            if (isInfo(next)) category = next;
            if (!queue && isInfo(nextNext)) queue = nextNext;
        }
        // Tags sit side by side ("Part-Time Domestic"), so split lines made only of tags.
        const isTagLine = (line) => line.split(/\s+/).every((word) => TAG_RE.test(word));
        // Prefer the pill elements themselves (their text can run together).
        const pillTags = [...card.querySelectorAll('*')]
            .filter((element) => TAG_RE.test(textOf(element)) && isShown(element) &&
                ![...element.children].some((child) => textOf(child) === textOf(element)))
            .map(textOf);
        const tags = [...new Set(pillTags.length ? pillTags : after.filter(isTagLine).flatMap((line) => line.split(/\s+/)))];
        const waits = after.filter((line) => WAIT_RE.test(line));
        const colour = cardColours(card);
        return {
            key: stu ? `stu:${stu}` : `name:${name}`,
            name, category, queue, tags, wait: waits[0] || '', ...colour,
            hold: isOnHold(card, lines, colour.bg)
        };
    };

    const DESK_RE = /table|private|triage|harvest|booth|room|desk|counter|kiosk|office|^\s*[A-Z]{0,3}\s*-?\d{3,5}\b/i;
    const parseHeader = (header) => {
        const match = textOf(header).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
        return match ? { table: match[1].trim(), rep: match[2].trim() } : null;
    };

    let servedForBoard = [];  // filled by scan()
    let lastBoardJson = '';
    let lastBoardSentAt = 0;

    const sendBoard = (force) => {
        const now = Date.now();
        const lists = {};
        ['inside', 'outside'].forEach((where) => {
            const found = waitingPanel(where);
            lists[where] = found
                ? { label: found.label, tickets: ticketCards(found.panel, []).map(cardDetails) }
                : { label: `Waiting ${where === 'inside' ? 'Inside' : 'Outside'}`, tickets: [], missing: true };
        });

        const served = servedPanel();
        let desks = [];
        if (served) {
            const headers = tableHeaders(served);
            const cards = ticketCards(served, headers);
            const seenDesk = new Set();
            headers.forEach((header) => {
                if (cards.some((card) => card.contains(header))) return;
                const desk = parseHeader(header);
                if (!desk || !DESK_RE.test(desk.table)) return;
                const id = `${desk.table}|${desk.rep}`;
                if (seenDesk.has(id)) return;
                seenDesk.add(id);
                desks.push(desk);
            });
        }

        const board = {
            inside: lists.inside,
            outside: lists.outside,
            desks,
            served: servedForBoard.map((ticket) => ({ ...ticket, glowing: glowing.has(ticket.key) })),
            servedFound: !!served
        };
        const json = JSON.stringify(board);
        if (force || json !== lastBoardJson || now - lastBoardSentAt > 10000) {
            lastBoardJson = json;
            lastBoardSentAt = now;
            try {
                chrome.runtime.sendMessage({ type: 'board-update', board: { ...board, at: now } });
            } catch (error) { /* extension reloaded */ }
        }
    };

    // Press a Waitwell button the way a person would.
    const press = (element) => {
        const target = element.closest('button, [role="button"], a') || element;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
            const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
            target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
        });
        target.click();
    };

    const isReddish = (color) => {
        const m = (color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return false;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        return r > 150 && g < 110 && b < 110;
    };

    const ARROW_HINT = /arrow|upward|move.?(in|up)|inside|north|chevron.?up|caret.?up|angle.?up|publish|upload|↑|⬆/i;

    // Small clickable things (icon buttons) inside root, outermost first.
    const iconButtons = (root, skip) => {
        const all = [...root.querySelectorAll('button, [role="button"], a, img, svg, i, span, div')]
            .filter((element) => {
                if (!isShown(element) || (skip && skip.some((card) => card.contains(element)))) return false;
                const box = element.getBoundingClientRect();
                if (box.width > 70 || box.height > 70 || box.width < 8 || box.height < 8) return false;
                if (textOf(element).replace(/[↑⬆]/g, '').length > 2) return false; // icon buttons have no words
                const style = getComputedStyle(element);
                return /^(button|a|img)$/i.test(element.tagName) || element.getAttribute('role') === 'button' ||
                    style.cursor === 'pointer' || element.tagName.toLowerCase() === 'svg';
            });
        return all.filter((element) => !all.some((other) => other !== element && other.contains(element)));
    };

    const describe = (element) => {
        const box = element.getBoundingClientRect();
        const cls = typeof element.className === 'string' ? element.className : (element.className && element.className.baseVal) || '';
        return `${element.tagName.toLowerCase()}.${cls.split(/\s+/).slice(0, 3).join('.')} ${Math.round(box.width)}x${Math.round(box.height)} bg=${getComputedStyle(element).backgroundColor}`;
    };

    const arrowScore = (element) => {
        const style = getComputedStyle(element);
        const html = (element.outerHTML || '').slice(0, 1500);
        let score = 0;
        if (ARROW_HINT.test(html)) score += 4;
        if (isReddish(style.backgroundColor) || isReddish(style.color) || isReddish(style.fill)) score += 2;
        [...element.querySelectorAll('*')].slice(0, 12).forEach((child) => {
            const cs = getComputedStyle(child);
            if (isReddish(cs.backgroundColor) || isReddish(cs.fill)) score += 1;
        });
        return score;
    };

    // The ↑ on an Outside ticket: the button that looks like an arrow; failing that,
    // the only icon button on the card.
    const ticketArrow = (card) => {
        const buttons = iconButtons(card);
        const scored = buttons.map((element) => ({ element, score: arrowScore(element) })).sort((a, b) => b.score - a.score);
        if (scored[0] && scored[0].score >= 4) return { button: scored[0].element };
        if (buttons.length === 1) return { button: buttons[0] };
        return { button: null, seen: buttons.map(describe) };
    };

    // The red ↑ in the Waiting Outside header (the other header button is the filter).
    const headerArrow = (panel, cards) => {
        const buttons = iconButtons(panel, cards);
        const scored = buttons.map((element) => ({ element, score: arrowScore(element) })).sort((a, b) => b.score - a.score);
        if (scored[0] && scored[0].score >= 2) return { button: scored[0].element };
        return { button: null, seen: buttons.map(describe) };
    };

    const moveInside = (key) => {
        const found = waitingPanel('outside');
        if (!found) return { ok: false, error: 'Waiting Outside not found' };
        const card = ticketCards(found.panel, []).find((candidate) => cardDetails(candidate).key === key);
        if (!card) return { ok: false, error: 'That ticket is no longer outside' };
        const { button, seen } = ticketArrow(card);
        if (!button) {
            console.info('[Waitwell alerts] Arrow not found on ticket. Icon buttons seen:', seen);
            return { ok: false, error: "Couldn't find the arrow on that ticket" };
        }
        press(button);
        return { ok: true };
    };

    const moveNextInside = () => {
        const found = waitingPanel('outside');
        if (!found) return { ok: false, error: 'Waiting Outside not found' };
        const cards = ticketCards(found.panel, []);
        if (!cards.length) return { ok: false, error: 'No one is waiting outside' };
        const { button, seen } = headerArrow(found.panel, cards);
        if (!button) {
            // The top ticket's own arrow does the same thing.
            const top = ticketArrow(cards[0]);
            if (top.button) { press(top.button); return { ok: true }; }
            console.info('[Waitwell alerts] Header arrow not found. Icon buttons seen:', seen);
            return { ok: false, error: "Couldn't find Waitwell's red button" };
        }
        press(button);
        return { ok: true };
    };

    const clearGlowByKey = (key) => {
        glowing.delete(key);
        document.querySelectorAll('.waitwell-accepted-glow').forEach((card) => {
            if (card.dataset.waitwellKey === key) card.classList.remove('waitwell-accepted-glow');
        });
        saveState();
    };

    try {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            let result = null;
            if (message.type === 'clear-glow') { clearGlowByKey(message.key); result = { ok: true }; }
            else if (message.type === 'move-inside') result = moveInside(message.key);
            else if (message.type === 'move-next-inside') result = moveNextInside();
            if (!result) return;
            sendResponse(result);
            setTimeout(() => sendBoard(true), 50);
        });
    } catch (error) { /* extension reloaded */ }

    const scan = () => {
        const panel = servedPanel();
        if (!panel) { servedForBoard = []; sendBoard(); return; }
        const headers = tableHeaders(panel);
        const now = Date.now();
        const present = new Set();
        const servedNow = [];

        ticketCards(panel, headers).forEach((card) => {
            const ticket = parseTicket(card, headers);
            const details = cardDetails(card);
            servedNow.push({ ...details, key: ticket.key, table: ticket.table, rep: ticket.rep });
            present.add(ticket.key);
            const isNew = !seen.has(ticket.key);
            seen.set(ticket.key, now);
            if (isNew && baselined) {
                if (glowEnabled) glowing.add(ticket.key);
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
        servedForBoard = servedNow;
        sendBoard();
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
        sendBoard(true);
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
